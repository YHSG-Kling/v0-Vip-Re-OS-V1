// lib/kernel/cron-logging.ts
//
// CRON EXECUTION LOGGING KERNEL — Layer 0 ownership
//
// Canonical commands for cron execution logging, failure tracking, records processing,
// and audit trail visibility. All cron jobs must use these commands to ensure
// silent failures are eliminated and correlation IDs enable debugging.
//
// Rules:
//   - Every cron job MUST call createCronRunContext() at start
//   - recordCronStart() must be called immediately after context creation
//   - recordCronSuccess() or recordCronFailure() must be called on completion
//   - Logging failures MUST NOT crash the cron job
//   - Correlation IDs persist across all log entries for trace correlation
//   - Error messages are truncated to 2000 chars for DB safety
//   - Records processed are tracked for audit trail
//   - Status enum: see CRON_SNAPSHOT_STATUSES below. This line used to claim a
//     fourth word, 'partial', that nothing in this module has ever written.
//
// Migration 1053: createCronRunContext() now immediately inserts into
// cron_execution_logs with cron_name + cron_path so the health dashboard
// can identify any cron without touching individual cron files.
// recordCronStart() becomes an UPDATE (not insert) on the same row.

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"
import { v4 as uuidv4 } from "uuid"

// ─── WHY THESE UPSERTS DO NOT NAME expected_interval_hours ───────────────────
//
// The opposite-missing census reports `cron_health_snapshot.expected_interval_hours`
// (and run_count_7d / failure_count_7d) as READ-BY-CODE, WRITTEN-BY-NOBODY —
// lib/platform/ai-ops.ts:34 cronHealth() reads the first to judge staleness.
// It is a FALSE POSITIVE, and the obvious "fix" is actively destructive.
// Measured 2026-08-22 against hrvaqgvukzxfskkcrwbt:
//
//   · scripts/1053-pl-truth-engine-cron-health.sql:110 SEEDS the column
//     per-cron, and all 64 live rows carry a real value (1, 24, 8760, …).
//   · The DDL is `expected_interval_hours int NOT NULL DEFAULT 24`, and
//     run_count_7d / failure_count_7d are `int NOT NULL DEFAULT 0`.
//
// So stamping a derived cadence here would (a) overwrite curated seed values
// and (b) refuse the ENTIRE upsert with 23502 the moment the derivation came
// back null for an unregistered path — and because both upserts below are
// `.then(() => {})` fire-and-forget, that refusal would reach no one and the
// health dashboard would simply stop updating. CLAUDE.md §3: a column written
// by a seed or a DEFAULT reads as writerless without being writerless.
//
// What IS genuinely one-sided is narrower and needs its own decision:
// failure_count_7d / run_count_7d are seeded 0 and NOTHING ever increments
// them, so the ops panel's "failures in 7d" figure is permanently 0. That is a
// rolling recompute, not a stamp, and it is left named rather than guessed at.
//
// ─── THAT DECISION IS NOW TAKEN — recomputeCronSevenDayCounts, below ─────────
//
// BUILT, not deleted: two superadmin surfaces read the STORED columns and both
// were reading a permanent zero —
//
//   · app/actions/superadmin/platform-overview.ts:244 counts a cron as failing
//     when `last_status === "failure" || failure_count_7d > 0`. The second
//     disjunct could never be true, so a cron that failed six times this week
//     and succeeded on its last run counted as healthy.
//   · lib/platform/ai-ops.ts:113 hands `failure7d` to the AI-ops console for
//     every failing/stale cron, and it was always 0.
//
// A THIRD reader, app/actions/pl-truth-engine.ts:379, derives the same two
// numbers at read time from `cron_execution_logs` and IGNORES these columns.
// That is NOT a duplicate to be merged away, and it is worth saying why: the
// pl-truth-engine board is TENANT-SCOPED (`.or(brokerage_id.is.null,
// brokerage_id.eq.…)` at :306), so its run_count_7d answers "runs THIS BROKER
// may see". The stored column is platform-wide, which is the only correct
// number for the two platform-staff surfaces above. Same words, two genuinely
// different questions — so both survive, and this comment is the record that
// the difference is deliberate rather than drift.

// ─── cron_health_snapshot.last_status — THE WHOLE VOCABULARY, IN ONE PLACE ───
//
// Written HERE and nowhere else. scripts/1053-pl-truth-engine-cron-health.sql:86
// claimed four words ('success'|'failure'|'partial'|'running') and the table has
// no CHECK to hold anyone to them (verified against pg_constraint 2026-08-23:
// cron_health_snapshot has ZERO check constraints), so the claim was decoration
// and two of the four words had no writer at all. Readers branched on both.
//
//   'running' — BUILT. createCronRunContext stamps it at the start choke below.
//   'partial' — DELETED at its two read sites; recordCronSuccess/recordCronFailure
//               are binary and no product ruling asks for a middle state.
//               Tombstones: app/dashboard/superadmin/platform/page.tsx.
//
// If a third word is ever wanted, it is written here first and read second.
export const CRON_SNAPSHOT_STATUSES = ["running", "success", "failure"] as const
export type CronSnapshotStatus = (typeof CRON_SNAPSHOT_STATUSES)[number]

// ─── INPUT / OUTPUT TYPES ─────────────────────────────────────────────────────

export interface CronLoggingActorContext {
  brokerageId?: string
}

export interface KernelCronLoggingResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

export interface CronRunContext {
  context_id: string
  cron_name: string
  cron_path: string
  brokerage_id?: string
  started_at: string
  params?: Record<string, any>
}

// ─── COMMAND 1: createCronRunContext ──────────────────────────────────────────

export interface CreateCronRunContextInput {
  cron_name: string      // e.g., "daily-briefing"
  cron_path: string      // e.g., "/app/api/cron/daily-briefing/route.ts"
  brokerage_id?: string  // optional, for scoped logging
  params?: Record<string, any> // input parameters for debugging
}

export async function createCronRunContext(
  input: CreateCronRunContextInput,
): Promise<KernelCronLoggingResult<CronRunContext>> {
  try {
    const context_id = uuidv4()
    const started_at = new Date().toISOString()

    const context: CronRunContext = {
      context_id,
      cron_name: input.cron_name,
      cron_path: input.cron_path,
      brokerage_id: input.brokerage_id,
      started_at,
      params: input.params,
    }

    // Persist immediately so cron_name is stored in cron_execution_logs
    // from the very first moment. recordCronStart() then re-stamps the same
    // row 'started' (NOT 'running' — that word is the SNAPSHOT's, and the
    // ledger's CHECK is started|completed|failed|timeout, which does not admit
    // it; the previous wording here named a status this module has never
    // written to this table).
    //
    // THE TENANT WAS ACCEPTED AND THEN DROPPED. `CreateCronRunContextInput`
    // has carried `brokerage_id?` since it was written, and the returned
    // `CronRunContext` reports it back — but the row itself never received it, so
    // a caller that passed one got no effect anywhere. Two things read the column
    // and both were reading a NULL that no caller could change:
    //
    //   · `app/actions/system-health.ts:getCronExecutionLogs` filters
    //     `.eq("brokerage_id", ctx.brokerageId)` for the broker health page, and
    //     `NULL = <uuid>` is NULL — so a scoped run could never appear on the
    //     surface of the brokerage it ran for.
    //   · `recordCronSuccess` / `recordCronFailure` below read `logEntry
    //     .brokerage_id` and fall back to the literal string `"system"` when it is
    //     null, which is what every kernel event from this module has carried.
    //
    // NULL IS STILL THE RIGHT ANSWER FOR A PLATFORM-WIDE SWEEP, and that is the
    // majority of this tree's crons: a run that iterates every brokerage belongs
    // to none of them, and filing it under one would put a platform outage inside
    // a single tenant's console. Those rows are NOT lost — two surfaces read this
    // ledger with NO brokerage predicate at all (`app/actions/pl-truth-engine.ts:
    // getCronHealth` and `lib/kernel/scraping.ts:loadScrapingDiagnostics`), which
    // is what makes an untenanted platform run readable rather than invisible.
    const supabase = createServiceClient()
    const { error: insertError } = await supabase
      .from("cron_execution_logs")
      .insert({
        id:           context_id, // correlation key (no context_id column; id is the key)
        brokerage_id: input.brokerage_id ?? null,
        cron_name:    input.cron_name,
        cron_path:    input.cron_path,
        status:       "started",
        started_at,
        metadata:     input.params ? { params: input.params } : {},
      })

    if (insertError) {
      // Log but don't fail — the cron should continue even if logging breaks
      console.error("[cron-kernel] createCronRunContext insert error:", insertError.message)
    }

    // ── THE 'running' HALF, BUILT AT THE START CHOKE ─────────────────────────
    //
    // Four surfaces already branch on `last_status === "running"` (the platform
    // totals tile and its badge) and NOTHING had ever written the word, so the
    // tile was hard-wired to 0 and the badge was unreachable markup.
    //
    // `last_run_at` IS DELIBERATELY NOT TOUCHED HERE, and that is the whole
    // safety of this stamp. Every staleness reader — pl-truth-engine.ts:364,
    // platform-overview.ts:222, ai-ops.ts cronHealth() — measures age from
    // `last_run_at`. Stamping it at START would make a cron that hangs and never
    // returns look FRESHER the longer it hangs, which is the exact inversion of
    // what a health board is for. So a run that dies without reaching
    // recordCronSuccess/recordCronFailure leaves the row at 'running' over a
    // stale `last_run_at`, and all three badge sites already gate their status
    // pill on `!is_stale` — the stale pill wins, which is the honest answer.
    //
    // Fire-and-forget with a READ error, not a swallowed one (CLAUDE.md §3):
    // supabase-js RESOLVES a refusal, so an undestructured call here would make
    // "the snapshot refused my write" indistinguishable from success.
    const { error: snapshotError } = await supabase
      .from("cron_health_snapshot")
      .upsert({
        cron_name:   input.cron_name,
        cron_path:   input.cron_path,
        last_status: "running" satisfies CronSnapshotStatus,
        updated_at:  started_at,
      }, { onConflict: "cron_name" })

    if (snapshotError) {
      console.error("[cron-kernel] createCronRunContext snapshot start-stamp refused:", snapshotError.message)
    }

    return { success: true, data: context }
  } catch (error) {
    console.error("[cron-kernel] createCronRunContext error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 2: recordCronStart ───────────────────────────────────────────────

export interface RecordCronStartInput {
  context_id: string
  input_count?: number  // optional: number of items to process
  /**
   * Optional tenant, for the FALLBACK INSERT path below only.
   *
   * That path runs when `createCronRunContext`'s row is missing, so it is
   * reconstructing a row from nothing — it already loses `cron_path` to the
   * literal "unknown". Without this, it also loses the tenant, and the
   * reconstructed row can never appear on the brokerage health page even when
   * the run was scoped. Callers that hold the context can pass
   * `context.brokerage_id` straight through; a platform-wide sweep passes
   * nothing and the row stays untenanted, which is correct for it.
   */
  brokerage_id?: string
}

export async function recordCronStart(
  input: RecordCronStartInput,
): Promise<KernelCronLoggingResult> {
  try {
    const supabase = createServiceClient()

    // Update the row created in createCronRunContext to 'running'.
    // Falls back to insert if the row doesn't exist (e.g. insert failed above).
    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        // 'started' is the only legal non-terminal status (CHECK: started|completed|failed|timeout)
        status:   "started",
        metadata: input.input_count != null ? { input_count: input.input_count } : {},
      })
      .eq("id", input.context_id)
      .eq("status", "started")

    if (updateError) {
      // Row may not exist if createCronRunContext insert failed — insert now
      const { error: insertError } = await supabase
        .from("cron_execution_logs")
        .insert({
          id:           input.context_id,
          brokerage_id: input.brokerage_id ?? null, // see RecordCronStartInput
          cron_path:    "unknown", // NOT NULL; original context lost on this fallback path
          status:       "started",
          started_at:   new Date().toISOString(),
          metadata:     { input_count: input.input_count },
        })
      if (insertError) {
        console.error("[cron-kernel] recordCronStart fallback insert error:", insertError.message)
        return { success: false, error: insertError.message }
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[cron-kernel] recordCronStart error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 3: recordCronProgress ────────────────────────────────────────────

export interface RecordCronProgressInput {
  context_id: string
  records_processed?: number
  metadata_delta?: Record<string, any>
}

export async function recordCronProgress(
  input: RecordCronProgressInput,
): Promise<KernelCronLoggingResult> {
  try {
    const supabase = createServiceClient()

    const { error } = await supabase
      .from("cron_execution_logs")
      .update({
        records_processed: input.records_processed,
        metadata:          input.metadata_delta,
      })
      .eq("id", input.context_id)
      .eq("status", "started")

    if (error) {
      console.error("[cron-kernel] recordCronProgress error:", error.message)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    console.error("[cron-kernel] recordCronProgress error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 4: recordCronSuccess ────────────────────────────────────────────

export interface RecordCronSuccessInput {
  context_id: string
  output_count?: number
  records_processed?: number
  metadata?: Record<string, any>
}

export interface RecordCronSuccessOutput {
  completed_at: string
  duration_ms: number
}

export async function recordCronSuccess(
  input: RecordCronSuccessInput,
): Promise<KernelCronLoggingResult<RecordCronSuccessOutput>> {
  try {
    const supabase = createServiceClient()
    const completed_at = new Date().toISOString()

    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("id", input.context_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (readError || !logEntry) {
      console.error("[cron-kernel] recordCronSuccess read error:", readError?.message)
      return { success: false, error: "Could not find cron log entry" }
    }

    const duration_ms = new Date(completed_at).getTime() - new Date(logEntry.started_at).getTime()

    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status:            "completed", // CHECK: started|completed|failed|timeout
        completed_at,
        duration_ms,
        records_processed: input.records_processed ?? logEntry.records_processed,
        metadata: {
          ...logEntry.metadata,
          output_count: input.output_count,
          ...input.metadata,
        },
      })
      .eq("id", input.context_id)

    if (updateError) {
      console.error("[cron-kernel] recordCronSuccess update error:", updateError.message)
      return { success: false, error: updateError.message }
    }

    // Upsert cron_health_snapshot so health dashboard sees the latest run
    if (logEntry.cron_name) {
      await supabase
        .from("cron_health_snapshot")
        .upsert({
          cron_name:              logEntry.cron_name,
          cron_path:              logEntry.cron_path ?? null,
          last_run_at:            completed_at,
          last_status:            "success",
          last_duration_ms:       duration_ms,
          last_records_processed: input.records_processed ?? logEntry.records_processed ?? 0,
          last_error_message:     null,
          updated_at:             completed_at,
        }, { onConflict: "cron_name" })
        .then(() => {}) // fire-and-forget; don't fail the cron
    }

    try {
      await processKernelEvent({
        event:      KernelEvent.CRON_COMPLETED_SUCCESS,
        brokerageId: logEntry.brokerage_id || "system",
        entityType: "cron",
        entityId:   input.context_id,
      })
    } catch { /* event failure must not crash logging */ }

    return { success: true, data: { completed_at, duration_ms } }
  } catch (error) {
    console.error("[cron-kernel] recordCronSuccess error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 5: recordCronFailure ────────────────────────────────────────────

export interface RecordCronFailureInput {
  context_id: string
  error: Error | string
  stage?: string
  context_snapshot?: Record<string, any>
}

export interface RecordCronFailureOutput {
  completed_at: string
  duration_ms: number
}

export async function recordCronFailure(
  input: RecordCronFailureInput,
): Promise<KernelCronLoggingResult<RecordCronFailureOutput>> {
  try {
    const supabase = createServiceClient()
    const completed_at = new Date().toISOString()

    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("id", input.context_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (readError || !logEntry) {
      console.error("[cron-kernel] recordCronFailure read error:", readError?.message)
      return { success: false, error: "Could not find cron log entry" }
    }

    const duration_ms   = new Date(completed_at).getTime() - new Date(logEntry.started_at).getTime()
    const errorMessage  = input.error instanceof Error ? input.error.message : String(input.error)
    const truncatedError = errorMessage.slice(0, 2000)
    const stack = input.error instanceof Error ? input.error.stack : undefined

    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status:        "failed", // CHECK: started|completed|failed|timeout
        completed_at,
        duration_ms,
        error_message: truncatedError,
        metadata: {
          ...logEntry.metadata,
          stage:            input.stage,
          context_snapshot: input.context_snapshot,
          error_stack:      stack?.slice(0, 1000),
        },
      })
      .eq("id", input.context_id)

    if (updateError) {
      console.error("[cron-kernel] recordCronFailure update error:", updateError.message)
      return { success: false, error: updateError.message }
    }

    // Upsert cron_health_snapshot with failure state
    if (logEntry.cron_name) {
      await supabase
        .from("cron_health_snapshot")
        .upsert({
          cron_name:              logEntry.cron_name,
          cron_path:              logEntry.cron_path ?? null,
          last_run_at:            completed_at,
          last_status:            "failure",
          last_duration_ms:       duration_ms,
          last_records_processed: logEntry.records_processed ?? 0,
          last_error_message:     truncatedError,
          updated_at:             completed_at,
        }, { onConflict: "cron_name" })
        .then(() => {})
    }

    try {
      await processKernelEvent({
        event:       KernelEvent.CRON_FAILED,
        brokerageId: logEntry.brokerage_id || "system",
        entityType:  "cron",
        entityId:    input.context_id,
      })
    } catch { /* event failure must not crash logging */ }

    return { success: true, data: { completed_at, duration_ms } }
  } catch (error) {
    console.error("[cron-kernel] recordCronFailure error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 6: recomputeCronSevenDayCounts ──────────────────────────────────
//
// THE ROLLING RECOMPUTE THE HEADER NOTE LEFT NAMED. `run_count_7d` and
// `failure_count_7d` are `int NOT NULL DEFAULT 0`, seeded 0 by
// scripts/1053-pl-truth-engine-cron-health.sql:110, and until this function no
// code path had ever moved either one. Two platform-staff surfaces read them
// (platform-overview.ts:232 / ai-ops.ts:113); both showed a permanent zero.
//
// WHY A RECOMPUTE AND NOT AN INCREMENT. A 7-day window has to DECAY. An
// increment in recordCronSuccess/recordCronFailure would only ever climb, so a
// cron that failed on Monday would still read "1 failure in 7d" in October. The
// counts are therefore derived from the ledger and OVERWRITTEN, never added to.
//
// WHY EXACT COUNTS AND NOT A PAGED SCAN. `cron_execution_logs` receives one row
// per run per cron and vercel.json runs the dispatcher every minute, so a 7-day
// window is tens of thousands of rows — well past PostgREST's default page. A
// paged scan that silently stopped at the first page would write an UNDERCOUNT
// and the surface would present it as truth, which is the same class of defect
// this function exists to close. `head: true, count: "exact"` is bounded by the
// number of crons instead of the number of runs and cannot truncate.
//
// TWO VOCABULARIES, AND THE LEDGER'S IS THE ONE USED HERE.
// `cron_execution_logs.status` CHECK = started|completed|failed|timeout
// (verified against pg_constraint 2026-08-23). `cron_health_snapshot
// .last_status` = running|success|failure. Counting the SNAPSHOT's word against
// the LEDGER's column is precisely the bug pl-truth-engine.ts:326 documents
// having already paid for once, so LEDGER_FAILURE_STATUSES is the ledger's
// spelling and a timeout counts as a failure: the run did not complete.
export const LEDGER_FAILURE_STATUSES = ["failed", "timeout"] as const

export interface RecomputeCronSevenDayCountsOutput {
  cronsExamined: number
  rowsUpdated:   number
}

export async function recomputeCronSevenDayCounts(
  now: Date = new Date(),
): Promise<KernelCronLoggingResult<RecomputeCronSevenDayCountsOutput>> {
  try {
    const supabase = createServiceClient()
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // PLATFORM-WIDE ON PURPOSE — no brokerage predicate. Both readers of these
    // columns are platform-staff-gated; the tenant-scoped answer to the same
    // question is pl-truth-engine.ts:379 and stays there.
    const { data: snapshots, error: snapshotError } = await supabase
      .from("cron_health_snapshot")
      .select("cron_name, run_count_7d, failure_count_7d")

    if (snapshotError) return { success: false, error: snapshotError.message }
    const rows = snapshots ?? []

    let rowsUpdated = 0

    // Batched so a 64-row snapshot does not open 128 simultaneous sockets.
    const BATCH = 8
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      const results = await Promise.all(batch.map(async (row: any) => {
        const name = row.cron_name as string

        const runQ = supabase
          .from("cron_execution_logs")
          .select("id", { count: "exact", head: true })
          .eq("cron_name", name)
          .gte("started_at", since)

        const failQ = supabase
          .from("cron_execution_logs")
          .select("id", { count: "exact", head: true })
          .eq("cron_name", name)
          .gte("started_at", since)
          .in("status", [...LEDGER_FAILURE_STATUSES])

        const [runR, failR] = await Promise.all([runQ, failQ])

        // A REFUSED COUNT IS NOT A ZERO. Writing 0 over a refusal would render
        // "the ledger would not answer" as "this cron is clean", which is the
        // failure mode CLAUDE.md §2 names: a guard that cannot see reports zero
        // and reads as a clean bill of health. Skip the row and keep the last
        // known-good number instead.
        if (runR.error || failR.error) {
          console.error(
            `[cron-kernel] recomputeCronSevenDayCounts refused for ${name}:`,
            runR.error?.message ?? failR.error?.message,
          )
          return false
        }

        const run7d  = runR.count ?? 0
        const fail7d = failR.count ?? 0
        if (run7d === row.run_count_7d && fail7d === row.failure_count_7d) return false

        const { error: writeError } = await supabase
          .from("cron_health_snapshot")
          .update({ run_count_7d: run7d, failure_count_7d: fail7d, updated_at: now.toISOString() })
          .eq("cron_name", name)

        if (writeError) {
          console.error(`[cron-kernel] recomputeCronSevenDayCounts write refused for ${name}:`, writeError.message)
          return false
        }
        return true
      }))
      rowsUpdated += results.filter(Boolean).length
    }

    return { success: true, data: { cronsExamined: rows.length, rowsUpdated } }
  } catch (error) {
    console.error("[cron-kernel] recomputeCronSevenDayCounts error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}
