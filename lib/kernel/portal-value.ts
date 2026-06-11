// lib/kernel/portal-value.ts
//
// PORTAL VALUE CARD — the shared primitive behind the owner's contract:
//
//   "if the person is a contact, then they have a portal and there should always be a
//    push to their portal where they will always have some type of value so they
//    continue to use it ... portal has to be valuable."
//
// Every contact-touch play (Client Pulse, Referral Radar, Reverse Prospecting, …) should
// leave something FRESH and REAL in the contact's portal every run, so the portal is always
// worth returning to. The portal reads `transparency_updates` as its "what's happening" feed
// (the same table the Offer Net Sheet and the event fan-out write to). This module is the one
// place that knows HOW to push such a card correctly:
//
//   · is_visible_to_client = true        — else the card is invisible and the point fails.
//   · idempotent per (contact, update_type, day) — re-running a play the same day must NOT
//     stack duplicate cards. Before inserting we SELECT for an equivalent VISIBLE card for the
//     same (contact_id, update_type) within a dedupe window (default 24h) and skip if found.
//   · HONESTY OVER NOISE — the caller only calls this when the play computed REAL value for
//     that contact this run. This primitive never fabricates; it just shapes + writes what the
//     caller already earned. If a play has nothing real to say, it does NOT call this.
//
// Column shape is the SAME canonical insert the production cards use (see
// lib/kernel/offer-net-sheet.ts ~L428 and lib/kernel/event-fanout.ts writePortalUpdate):
//   brokerage_id, contact_id, listing_id (nullable), title (NOT NULL), plain_language_summary,
//   message, update_type (snake_case), is_visible_to_client (DEFAULT false → we set true),
//   metadata (jsonb), created_at. The deployed partial unique index
//   transparency_updates_dedupe_idx (contact_id, update_type, md5(title), minute) is the atomic
//   backstop for truly-concurrent writes; this SELECT-then-INSERT collapses the common case.
//
// Dependency-light: only the supabase service-client TYPE, exactly like offer-net-sheet imports
// it (no server-only chain) so client components, cron, and the simulator can all import it.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Default idempotency window: one card per (contact, update_type) per day. */
export const PORTAL_VALUE_DEDUPE_MS = 24 * 60 * 60 * 1000

export interface PortalValueInput {
  /** Tenant — the same brokerage_id the play already resolved. NOT NULL on the row. */
  brokerageId: string
  /** The contact whose portal receives the card — the same contact_id the play resolved. */
  contactId: string
  /** Optional listing context (nullable on the row). Pass when the value is about a listing. */
  listingId?: string | null
  /** Card headline — NOT NULL. Keep it contact-safe and warm. */
  title: string
  /** Plain-language value sentence drawn from REAL computed values. Becomes BOTH
   *  plain_language_summary AND message (the two text columns the portal renders). */
  summary: string
  /** Snake_case play tag, e.g. "client_pulse" | "referral_radar" | "reverse_prospecting".
   *  Half of the idempotency key. */
  updateType: string
  /** Optional structured context (real values only — no fabrication). */
  metadata?: Record<string, unknown>
  /** Clock injection for deterministic tests; defaults to now. */
  now?: Date
  /** Override the dedupe lookback window (ms). Defaults to PORTAL_VALUE_DEDUPE_MS (24h). */
  dedupeWindowMs?: number
}

export interface PortalValueResult {
  /** true = a new visible card was written; false = skipped (see reason). */
  pushed: boolean
  /** Why a push was skipped (e.g. "duplicate_within_window", "missing_required", "insert_error"). */
  reason?: string
  /** The id of the card that was written (only when pushed). */
  id?: string
}

/**
 * Pure helper: the dedupe boundary for a given run. Returns the ISO lower-bound timestamp —
 * an equivalent visible card for the same (contact, update_type) at/after this instant means
 * "already pushed in this window, skip." Exported so callers/tests can reason about the window
 * without a DB round-trip.
 */
export function portalValueDedupeSince(now: Date, windowMs: number = PORTAL_VALUE_DEDUPE_MS): string {
  return new Date(now.getTime() - windowMs).toISOString()
}

/**
 * Push ONE portal value card for a contact, idempotently.
 *
 * Inserts a single transparency_updates row with is_visible_to_client = true. Before writing,
 * it checks for an equivalent VISIBLE card for the same (contact_id, update_type) within the
 * dedupe window and skips if one exists (so re-running the play the same day is a no-op).
 *
 * Returns {pushed, reason?, id?}. Never throws — a play's portal push must never break the
 * play's primary (gated) work.
 */
export async function pushPortalValueCard(
  input: PortalValueInput,
  client?: Svc,
): Promise<PortalValueResult> {
  // Guard: the row's NOT NULL columns must be present. Honesty over a broken insert.
  if (!input.brokerageId || !input.contactId || !input.title?.trim() || !input.updateType) {
    return { pushed: false, reason: "missing_required" }
  }

  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = input.now ?? new Date()
  const since = portalValueDedupeSince(now, input.dedupeWindowMs ?? PORTAL_VALUE_DEDUPE_MS)

  // Idempotency — has an equivalent VISIBLE card for this (contact, update_type) already gone
  // out inside the window? If so, the portal already has this value today; skip.
  const { data: existing } = await supabase
    .from("transparency_updates")
    .select("id")
    .eq("contact_id", input.contactId)
    .eq("update_type", input.updateType)
    .eq("is_visible_to_client", true)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle()
  if (existing) return { pushed: false, reason: "duplicate_within_window" }

  const { data: inserted, error } = await supabase
    .from("transparency_updates")
    .insert({
      brokerage_id: input.brokerageId,
      contact_id: input.contactId,
      listing_id: input.listingId ?? null,
      title: input.title.trim(),
      plain_language_summary: input.summary,
      message: input.summary,
      update_type: input.updateType,
      is_visible_to_client: true, // MUST be true — an invisible card defeats the whole point.
      metadata: { ...(input.metadata ?? {}), portal_value_card: true },
      created_at: now.toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error || !inserted) return { pushed: false, reason: "insert_error" }
  return { pushed: true, id: (inserted as { id: string }).id }
}
