// lib/storage/orphan-sweeper.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND HALF OF THE COMPENSATING DELETE.
//
// `put-and-sign.ts` undoes a failed upload immediately. Only when that UNDO is
// ITSELF refused does a row land on the `storage_orphaned_objects` worklist
// (m387) — so the worklist is not a log of every hiccup, it is the short list of
// objects that are genuinely still sitting in a bucket with nothing pointing at
// them. This module retries those removes.
//
// WHY THE RETURN SHAPE LOOKS LIKE THIS. Pre-rollout the buckets are EMPTY and so
// is the worklist. "The sweep found nothing" is therefore not evidence of health
// — and supabase-js RESOLVES a refused query, so a `const { data }` read of a
// service-role-only table under the wrong credential comes back as `[]` and
// looks exactly like a clean worklist. The two are distinguished here by
// CONSTRUCTION: `outcome` is a required discriminant and a refused read can only
// produce `"read_refused"`, never `"nothing_to_sweep"`. A caller cannot report
// health it did not observe without ignoring the field.
//
// No session anywhere in this module: the caller passes the client, and the cron
// passes a SERVICE client. A `"use server"` module with a cookie-session gate
// cannot be driven from a cron — that exact mistake made the earnest-money
// watchdog return Unauthorized on every iteration for its whole life.

import type { SupabaseClient } from "@supabase/supabase-js"

/** One worklist row the sweeper acted on. */
export interface SweptOrphan {
  id:         string
  bucket:     string
  objectPath: string
  /** null = the object is gone from the bucket and the row is stamped clean. */
  error:      string | null
  /** WHY the object was orphaned in the first place — the recorder's own
   *  classification (put-and-sign.ts:150). Written since m387 and read by
   *  nothing until wave H5: an object the storage layer will not let go of
   *  came back as a bare bucket/path with no way to tell a signing failure
   *  from a refused delete, which is the one fact a human needs to triage it. */
  reason:     string | null
  /** the recorder's free-text detail, including the message the ORIGINAL
   *  remove was refused with. null when the row predates the stamp. */
  detail:     string | null
}

export type OrphanSweepResult =
  /** The worklist could not be READ. Nothing is known — this is NOT "clean". */
  | { outcome: "read_refused"; error: string; examined: 0; cleaned: 0; stillFailing: 0; swept: [] }
  /** The read SUCCEEDED and returned no uncleaned rows. */
  | { outcome: "nothing_to_sweep"; error: null; examined: 0; cleaned: 0; stillFailing: 0; swept: [] }
  /** Rows were found and acted on. */
  | {
      outcome: "swept"
      error: null
      examined: number
      cleaned: number
      stillFailing: number
      swept: SweptOrphan[]
      /** Removes that worked but whose bookkeeping write was refused — the
       *  object is gone yet the row still reads uncleaned, so the next sweep
       *  will try again. Reported rather than swallowed. */
      bookkeepingErrors: string[]
    }

/**
 * Retry the removes on the worklist.
 *
 * Ordered by attempt count first: an object the storage layer will never let go
 * of must not starve orphans that have never been tried. Nothing is ever
 * abandoned — a row that keeps failing keeps its `cleanup_error` and is counted
 * in `stillFailing` every run, so it stays visible instead of ageing out.
 */
export async function sweepStorageOrphans(
  client: SupabaseClient,
  options: { limit?: number } = {},
): Promise<OrphanSweepResult> {
  const limit = options.limit ?? 200

  // Uncleaned rows only. A refused read RESOLVES with data null, which is why
  // the error is destructured and returned rather than treated as an empty list.
  // The table is named as a LITERAL here, not through the constant. The
  // write-only-ledger sweep (scripts/orphan-write-sweep.ts) matches `.from("<t>")`
  // on raw source, so a variable made this — the ledger's ONLY reader — invisible
  // to it, and the guard correctly reported a table that is written and never
  // read. A ledger nothing reads is exactly the defect that guard exists to catch;
  // hiding the reader from it would have been the wrong way to go green.
  const { data: rows, error: readError } = await client
    .from("storage_orphaned_objects")
    .select("id, bucket, object_path, cleanup_attempts, reason, detail")
    .is("cleaned_at", null)
    .order("cleanup_attempts", { ascending: true })
    .order("detected_at", { ascending: true })
    .limit(limit)

  if (readError) {
    return { outcome: "read_refused", error: readError.message, examined: 0, cleaned: 0, stillFailing: 0, swept: [] }
  }

  const worklist = (rows ?? []) as Array<{
    id: string
    bucket: string
    object_path: string
    cleanup_attempts: number | null
    reason: string | null
    detail: string | null
  }>

  if (worklist.length === 0) {
    return { outcome: "nothing_to_sweep", error: null, examined: 0, cleaned: 0, stillFailing: 0, swept: [] }
  }

  const swept: SweptOrphan[] = []
  const bookkeepingErrors: string[] = []
  let cleaned = 0
  let stillFailing = 0

  for (const row of worklist) {
    const nowIso = new Date().toISOString()
    const { error: removeError } = await client.storage.from(row.bucket).remove([row.object_path])

    // The bookkeeping payload is built ABOVE the query chain on purpose:
    // scripts/tenant-scope-guard.ts reads raw source in a fixed window after a
    // `.from(...)`, and a long literal inside the chain pushes the scoping
    // evidence out of it.
    const stamp = removeError
      ? {
          cleanup_attempts: (row.cleanup_attempts ?? 0) + 1,
          last_attempt_at:  nowIso,
          cleanup_error:    removeError.message,
        }
      : {
          cleanup_attempts: (row.cleanup_attempts ?? 0) + 1,
          last_attempt_at:  nowIso,
          cleaned_at:       nowIso,
          cleanup_error:    null,
        }

    const { error: writeError } = await client
      .from("storage_orphaned_objects")
      .update(stamp)
      .eq("id", row.id)

    if (writeError) {
      bookkeepingErrors.push(`${row.bucket}/${row.object_path}: ${writeError.message}`)
    }

    if (removeError) {
      stillFailing += 1
      swept.push({
        id: row.id, bucket: row.bucket, objectPath: row.object_path,
        error: removeError.message, reason: row.reason ?? null, detail: row.detail ?? null,
      })
    } else {
      cleaned += 1
      swept.push({
        id: row.id, bucket: row.bucket, objectPath: row.object_path,
        error: null, reason: row.reason ?? null, detail: row.detail ?? null,
      })
    }
  }

  return {
    outcome: "swept",
    error: null,
    examined: worklist.length,
    cleaned,
    stillFailing,
    swept,
    bookkeepingErrors,
  }
}
