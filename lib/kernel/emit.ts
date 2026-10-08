/**
 * lib/kernel/emit.ts
 *
 * THE single canonical kernel-event emitter — does BOTH the lifecycle_events insert AND fans the
 * event into the reactor (staff notifications + canonical campaign_sequences enrollment +
 * client-portal cards + every reactor handler). Direct `.from("lifecycle_events").insert(...)`
 * writes are banned outside this file: the audit row lands, and nothing downstream ever hears it
 * (the owner's ruling: an event that reaches the audit table but never the reactor is a broken
 * cooperation between managers).
 *
 * ONE VOCABULARY (CLAUDE.md §6). Four spellings of "fire a kernel event" used to coexist and were
 * folded onto this one on 2026-09-03:
 *   · `fanOutKernelEvent` (lib/kernel/event-fanout.ts) — a thin forwarder to processKernelEvent
 *     for callers that had ALREADY inserted their own row. Retired; those callers now pass
 *     `skipInsert: true` here. Tombstone at lib/kernel/event-fanout.ts (search "TOMBSTONE").
 *   · `processKernelEvent` (lib/kernel/notification-engine.ts) — the funnel this function feeds.
 *     It stays as the reactor's INTERNAL entry (staff bell → dispatchKernelEvent); it never
 *     inserts a row, so a product module calling it directly is audit-less. New code calls
 *     emitKernelEvent; the remaining direct callers are the funnel's own kernel neighbours.
 *   · `dispatchKernelEvent` (lib/kernel/event-reactor.ts) — reactor internals; one caller
 *     (processKernelEvent). Never called from product code.
 *
 * What the merge added to this function that the others had and it lacked:
 *   · `suppressEnrollment` was declared on the input and NEVER forwarded (the sequence engine's
 *     feedback-loop guard silently did nothing through this path). Forwarded now.
 *   · `actorUserId` / `agentId` / `source` / `createdAt` — the audit columns direct inserters were
 *     writing (lifecycle_events.actor_user_id FKs users(id); agent_id is agents-class; source has a
 *     CHECK of ui|webhook|system|cron, default 'system'). Without them a converted inserter would
 *     have lost the "who" of its own audit row.
 *   · `skipInsert` + `lifecycleEventId` — the row-already-written entry point (the old
 *     fanOutKernelEvent contract). `complianceEventId` / `activityId` pass through unchanged.
 *   · `dedupeKey` now writes the live `dedupe_key` column (indexed: idx_le_dedupe) instead of a
 *     second spelling inside metadata — lib/events/event-helpers.ts and app/actions/orchestrator.ts
 *     already keyed on the column, so the two dedupe vocabularies are one.
 *
 * THE FAN-OUT GATE. Only typed KernelEvent values fan out. A free-form lifecycle string (an
 * audit-only "ai_isa_contact_email_sent", a dotted orchestrator event) is persisted and stops
 * there: processKernelEvent has NO such guard of its own — its defaultRulesForEvent would bell
 * the assigned agent for any string it is handed — so the guard the header used to CLAIM lived
 * "in the reactor" lives here, where it can be read.
 *
 * Idempotency:
 *   - `dedupeKey` (when provided) — short-window soft dedupe so a re-run within the window doesn't
 *     re-insert the same event row. The reactor's downstream side (sequence cooldown,
 *     transparency-update window, portal idempotency) handles the rest. No DB-level unique index
 *     because lifecycle_events is intentionally append-only (audit log).
 *
 * AUDIT-ONLY TYPED EVENTS (wave 100, lane 100B). Some product modules write a typed KernelEvent
 * row as a pure audit echo — either the module fans the event out ITSELF right after (with a
 * different metadata shape the reactor reads), or the owner has never ruled that the event should
 * bell anyone. Moving those onto this emitter without a switch would START a fan-out (or double
 * one). `auditOnly: true` writes the row WITH lineage (causation/correlation from the scope) and
 * skips the reactor — one emitter, one more option, never a second emitter (LAW 2).
 * `asWriteResult` adapts the result to the supabase `{ data, error }` shape so a moved inserter
 * keeps its sentinelWrite / bestEffort wrapper (which ledgers the loss) unchanged.
 *
 * Never throws — emitters are usually inside scoring/coaching/detection paths where a fan-out
 * failure must not break the primary write. The insert's own refusal IS reported (supabase-js
 * resolves refusals, §3): `error` carries it and `inserted` is false.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "./notification-engine"
import { KernelEvent } from "./events"
import { currentCausation } from "./causation"
import { redactSecretValues } from "@/lib/security/export-credential-scan"

/** lifecycle_events.source — live CHECK `lifecycle_events_source_check`. */
export type LifecycleEventSource = "ui" | "webhook" | "system" | "cron"

/** KernelEvent string values — the only events that reach the reactor. */
const VALID_KERNEL_EVENTS = new Set<string>(Object.values(KernelEvent))

export function isKernelEventValue(event: string): event is KernelEvent {
  return VALID_KERNEL_EVENTS.has(event)
}

export interface EmitKernelEventInput {
  event:        KernelEvent | string
  brokerageId:  string | null
  entityType:   string
  /** NULL only for a run-level audit with no single entity owner (lifecycle_events.entity_id is
   *  nullable — UNKNOWN_SENDER_DROPPED, SCRAPE_SOURCE_RUN_STARTED). A null-entity event never
   *  fans out: the reactor needs a subject. */
  entityId:     string | null
  metadata?:    Record<string, unknown> | null
  // ── Audit-row identity (the columns direct inserters used to write) ──────────────────────
  /** users.id of the human/actor who caused the event → lifecycle_events.actor_user_id (FK users). */
  actorUserId?:  string | null
  /** agents.id → lifecycle_events.agent_id (agents-class column; NOT a users.id). */
  agentId?:      string | null
  /** lifecycle_events.source; defaults to the column default ('system'). */
  source?:       LifecycleEventSource
  /** Explicit row timestamp (e.g. the archivedAt the outcome already carries); defaults to now(). */
  createdAt?:    string
  // ── Optional contact-side context — when present, the reactor uses these directly instead of
  //    re-resolving from the entity (saves a query and avoids resolution misses). ───────────────
  contactId?:        string
  buyerContactId?:   string
  sellerContactId?:  string
  transactionId?:    string
  listingId?:        string
  /** users.id of the acting agent for portal attribution; defaults to actorUserId. Explicit `null`
   *  = the reactor gets NO agent attribution even though the row names an actor (wave 101C: a merged
   *  "audit row + separate processKernelEvent" pair whose fan-out never carried one keeps its
   *  reactor path byte-identical — enrolled_by / portal attribution unchanged). */
  agentUserId?:      string | null
  /** Set by sequence-engine-internal emits to break enrollment feedback loops. */
  suppressEnrollment?: boolean
  /** Optional soft dedupe — same (event, entity, dedupeKey) within `dedupeWindowSec` seconds is
   *  silently treated as a no-op. Default 60s (tight loops, per-run repeats); a sweep whose key
   *  is day-grained (`…:${day}`) on an hourly cadence MUST pass a window at least as long as its
   *  cadence — the first such caller (task-overdue) shipped without one and re-fired every hour
   *  (lane L5, 2026-09-03). Capped at 7 days. Written to the `dedupe_key` column. */
  dedupeKey?:        string
  dedupeWindowSec?:  number
  // ── Causation (wave 97, m687) ───────────────────────────────────────────────────────────────
  /** The parent lifecycle_events.id that caused this event → lifecycle_events.causation_id.
   *  Defaults to the event the kernel is processing right now (lib/kernel/causation.ts), so a
   *  reactor that emits a child threads parent → child without passing anything. */
  causationId?:      string | null
  /** The chain root → lifecycle_events.correlation_id. Defaults to the enclosing scope's root. */
  correlationId?:    string | null
  // ── Row-already-written entry point (the retired fanOutKernelEvent contract) ─────────────────
  /** The caller has ALREADY inserted its lifecycle_events row (a kernel command that writes the
   *  row inside a Promise.all, a wrapper that owns its own insert). Skip the insert and only fan
   *  out. Pass `lifecycleEventId` when you have it so the reactor can cross-link. */
  skipInsert?:       boolean
  lifecycleEventId?: string
  complianceEventId?: string
  activityId?:        string
  // ── Audit-only (wave 100, lane 100B) ─────────────────────────────────────────────────────────
  /** Write the row (with lineage) and DO NOT fan out, even for a typed KernelEvent. For audit echoes
   *  whose caller fans out separately, or that the owner has never ruled should notify anyone. */
  auditOnly?:         boolean
  /** The client the row is written (and dedupe-read) through. Defaults to the service client.
   *  For a command that was HANDED its verified client (agent-books, agent-deactivation,
   *  managing-broker, unknown-sender-identification) — the audit row rides the same client as the
   *  write it records, and an in-memory proof sees both. Never a request-body-derived client. */
  client?:            unknown
}

export interface EmitKernelEventResult {
  inserted:        boolean
  lifecycleEventId: string | null
  fanOutOk:        boolean
  error:           string | null
}

/**
 * Insert a lifecycle_events row AND fan it through the reactor. This is the ONLY function
 * non-kernel modules should use to emit a kernel event — direct INSERTs are banned (the
 * 2026-09-03 sweep found 40+ modules silently dropping notifications / sequences / portal).
 */
export async function emitKernelEvent(input: EmitKernelEventInput): Promise<EmitKernelEventResult> {
  // "Never throws" includes a missing service credential: a moved inserter that used to resolve
  // a refusal must not start throwing into its caller.
  let svc: ReturnType<typeof createServiceClient>
  try {
    // THE CLIENT SEAM (wave 101C): a caller that already holds the VERIFIED client its whole
    // command writes through (an injected service client, an in-memory proof client) passes it,
    // so its audit row lands on the same client as the write it records. Default: service client.
    svc = (input.client as ReturnType<typeof createServiceClient> | undefined) ?? createServiceClient()
  } catch (e) {
    return { inserted: false, lifecycleEventId: null, fanOutOk: false, error: (e as Error).message }
  }
  // Audit sink: a secret by name or shape never lands in lifecycle_events.metadata (wave 139E).
  const metadata: Record<string, unknown> = redactSecretValues({ ...(input.metadata ?? {}) })

  let lifecycleEventId: string | null = input.lifecycleEventId ?? null
  let inserted = false

  if (!input.skipInsert) {
    // Soft dedupe — short-window check on the dedupe_key column so tight loops can't re-fire the
    // same event. The reactor's downstream gates (transparency_updates window, sequence cooldown,
    // portal dedupe) cover the longer-term cases.
    if (input.dedupeKey) {
      const windowSec = Math.max(1, Math.min(7 * 86_400, input.dedupeWindowSec ?? 60))
      const since = new Date(Date.now() - windowSec * 1000).toISOString()
      try {
        const { data: existing, error: dedupeErr } = await svc
          .from("lifecycle_events")
          .select("id")
          .eq("event_type", input.event as string)
          .eq("entity_type", input.entityType)
          .eq("entity_id", input.entityId)
          .eq("dedupe_key", input.dedupeKey)
          .gte("created_at", since)
          .limit(1)
        if (dedupeErr) {
          // Best-effort by design — but a refused read is said, not silently treated as "no prior".
          console.warn("[emitKernelEvent] dedupe read refused; inserting anyway:", dedupeErr.message)
        }
        if (existing && existing.length > 0) {
          return { inserted: false, lifecycleEventId: existing[0].id as string, fanOutOk: true, error: null }
        }
      } catch {
        // dedupe is best-effort — fall through and insert
      }
    }

    // Only the columns the caller supplied are written, so the database defaults (created_at
    // now(), source 'system', payload '{}') apply exactly as they did for the direct inserters.
    const row: Record<string, unknown> = {
      brokerage_id: input.brokerageId,
      entity_type:  input.entityType,
      entity_id:    input.entityId,
      event_type:   input.event as string,
      metadata,
    }
    // SYSTEM ACTOR → NULL, NEVER "". offer-bridge emits OFFER_ACCEPTED and BUYER_UNDER_CONTRACT with
    // actorUserId: "" (no human actor); Postgres refuses "" as a uuid (22P02), the insert returned
    // early above the fan-out, and so every offer-created transaction lost its staff notification,
    // portal card and sequence enrollment — proven live in the wave-93c walk. Same normalisation
    // as transitionLifecycle (lib/kernel/lifecycle.ts).
    if (input.actorUserId !== undefined) row.actor_user_id = input.actorUserId?.trim() ? input.actorUserId : null
    if (input.agentId     !== undefined) row.agent_id      = input.agentId
    if (input.source      !== undefined) row.source        = input.source
    if (input.createdAt   !== undefined) row.created_at    = input.createdAt
    if (input.dedupeKey   !== undefined) row.dedupe_key    = input.dedupeKey
    // Causation columns only when there IS a cause — a root event writes neither, so an
    // unapplied m687 costs a root event nothing.
    const scope = currentCausation()
    const causationId = input.causationId ?? scope.causationId
    const correlationId = input.correlationId ?? scope.correlationId
    if (causationId)   row.causation_id   = causationId
    if (correlationId) row.correlation_id = correlationId

    try {
      let { data, error } = await svc
        .from("lifecycle_events")
        .insert(row)
        .select("id")
        .single()
      // DEGRADE, DO NOT DROP: before m687 is applied the causation columns are absent and
      // PostgREST refuses the WHOLE row (PGRST204, CLAUDE.md §3). Losing the event to save its
      // lineage is the wrong trade — say so, and write the event without the lineage.
      if (error && (error.code === "PGRST204" || error.code === "42703") && ("causation_id" in row || "correlation_id" in row)) {
        console.warn("[emitKernelEvent] causation columns absent (m687 not applied?) — writing the event without lineage:", error.message)
        delete row.causation_id
        delete row.correlation_id
        ;({ data, error } = await svc.from("lifecycle_events").insert(row).select("id").single())
      }
      if (error) {
        return { inserted: false, lifecycleEventId: null, fanOutOk: false, error: error.message }
      }
      lifecycleEventId = (data?.id as string) ?? null
      inserted = true
    } catch (e) {
      return { inserted: false, lifecycleEventId: null, fanOutOk: false, error: (e as Error).message }
    }
  }

  // THE GATE — see the header. Free-form lifecycle strings are audit-only; typed KernelEvents
  // reach staff notifications, sequence enrollment, portal cards and every reactor handler.
  let fanOutOk = true
  if (shouldFanOut(input)) {
    try {
      await processKernelEvent({
        event:             input.event as KernelEvent,
        brokerageId:       input.brokerageId as string, // shouldFanOut proved it non-null
        entityType:        input.entityType,
        entityId:          input.entityId as string, // shouldFanOut proved it non-null
        lifecycleEventId:  lifecycleEventId ?? undefined,
        complianceEventId: input.complianceEventId,
        activityId:        input.activityId,
        contactId:         input.contactId,
        buyerContactId:    input.buyerContactId,
        sellerContactId:   input.sellerContactId,
        transactionId:     input.transactionId,
        listingId:         input.listingId,
        agentUserId:       input.agentUserId === null ? undefined : (input.agentUserId?.trim() || input.actorUserId?.trim() || undefined),
        metadata,
        suppressEnrollment: input.suppressEnrollment,
      })
    } catch (e) {
      fanOutOk = false
      console.error("[emitKernelEvent] fan-out failed:", e)
    }
  }

  return { inserted, lifecycleEventId, fanOutOk, error: null }
}

/** THE GATE as one predicate: a tenant, an entity, a typed KernelEvent, and not audit-only. (Executed by
 *  scripts/action-ledger-guard.ts §13b through emitKernelEvent itself, against a fake PostgREST.) */
function shouldFanOut(input: Pick<EmitKernelEventInput, "brokerageId" | "event" | "auditOnly" | "entityId">): boolean {
  return !!input.brokerageId && !!input.entityId && !input.auditOnly && isKernelEventValue(input.event as string)
}

/**
 * emitKernelEvent's result in the supabase write shape (`{ data, error }`), so a moved inserter keeps
 * its `sentinelWrite(svc, …)` / `bestEffort(…)` wrapper — the loss ledger — byte-for-byte.
 */
export function asWriteResult(r: EmitKernelEventResult): { data: { id: string } | null; error: { message: string } | null } {
  return {
    data: r.lifecycleEventId ? { id: r.lifecycleEventId } : null,
    error: r.error ? { message: r.error } : null,
  }
}
