/**
 * lib/buyer-offer/offer-lifecycle.ts
 *
 * THE offer lifecycle: one vocabulary, one key, one derivation.
 *
 * NOT a `"use server"` file — nothing here is an HTTP endpoint. It is imported
 * by the session-gated action path AND by the unattended (cron / service
 * credential) path, so neither can drift from the other.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Before this module there were THREE derivations of "what state is this offer
 * in", over TWO vocabularies, on TWO different keys:
 *
 *   D1  lib/buyer-offer/lifecycle-event-map.ts:deriveOfferState
 *       22 UNDERSCORE constants (buyer.offer.draft_created, .submitted_to_seller,
 *       .seller_accepted, …), keyed on `metadata->>offer_id`. DEAD: no writer in
 *       the tree ever emitted any of them, and its two functions had no callers
 *       outside the lib/buyer-offer/index.ts barrel.
 *
 *   D2  app/actions/buyer-offer/track-offer-lifecycle.ts:getOfferLifecycleState
 *       7 DOT events, keyed on entity_type='offer' + entity_id. Correct key,
 *       incomplete vocabulary.
 *
 *   D3  lib/buyer-offer/status-sync.ts:syncOfferStatus
 *       9 DOT events (adds .signature.requested, .sent.to.listing.agent,
 *       .counter.received, .voided), same correct key, mapping to the
 *       `offers.status` operational index rather than to a state.
 *
 * …plus a fourth inline copy of D2's table in lib/buyer-offer/expire-offers.ts.
 *
 * D2 and D3 are NOT rival machines. D3's extra events are SUB-STATES of D2's
 * seven, and both are preserved here: `EVENT_TO_STATE` is the machine, and
 * `EVENT_TO_STATUS` is the operational index the screens read. Every mapping D3
 * already had is carried over verbatim; the ones added are the events D2 already
 * knew, mapped to the status literal the UI already renders (verified against
 * app/portal/[contactId]/offers/page.tsx and
 * app/dashboard/listings/[id]/offers/offers-manager-client.tsx, which between
 * them read accepted / countered / expired / pending / rejected / submitted /
 * under_review / withdrawn). Nothing here is invented.
 *
 * ── THE KEY ──────────────────────────────────────────────────────────────────
 * `activities.entity_type = 'offer'` AND `activities.entity_id = <offers.id>`.
 *
 * Already named as canonical in five places before this module existed
 * (track-offer-lifecycle.ts, lib/kernel/transactions.ts, status-sync.ts,
 * compliance-gate.ts, expire-offers.ts) — and violated by most WRITERS, which is
 * the actual bug this consolidation exists to close. A writer that omits
 * `entity_id`, or files an offer event under `entity_type: 'contact'`, produces
 * a row no reader can find: the write succeeds, the lifecycle never moves.
 *
 * `activities.brokerage_id` is NOT NULL with no default. A writer that omits it
 * writes ZERO rows. Both facts were verified against the live schema.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** The state machine. Seven states — D2's set, unchanged. */
export type OfferState =
  | "DRAFT"
  | "PENDING"
  | "COUNTERED"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "WITHDRAWN"

/**
 * The canonical event names. Every writer MUST use these constants rather than
 * a string literal — the whole class of defect this replaces was two writers of
 * one event spelling it differently (`buyer.offer.accepted` vs
 * `buyer.offer.seller_accepted`).
 */
export const OFFER_EVENT = {
  DRAFT_CREATED:       "buyer.offer.draft.created",
  SIGNATURE_REQUESTED: "buyer.offer.signature.requested",
  SUBMITTED:           "buyer.offer.submitted",
  SENT_TO_LISTING:     "buyer.offer.sent.to.listing.agent",
  COUNTER_RECEIVED:    "buyer.offer.counter.received",
  COUNTER_SUBMITTED:   "buyer.offer.counter.submitted",
  COUNTER_ACCEPTED:    "buyer.offer.counter.accepted",
  COUNTER_REJECTED:    "buyer.offer.counter.rejected",
  COUNTERED:           "buyer.offer.countered",
  ACCEPTED:            "buyer.offer.accepted",
  REJECTED:            "buyer.offer.rejected",
  EXPIRED:             "buyer.offer.expired",
  WITHDRAWN:           "buyer.offer.withdrawn",
  VOIDED:              "buyer.offer.voided",
} as const

export type OfferEvent = typeof OFFER_EVENT[keyof typeof OFFER_EVENT]

/**
 * THE AUDIT EVENTS — the other half of this lane's vocabulary.
 *
 * These are things that HAPPENED and must be on the record: a gate refused, a
 * packet passed compliance, a provider was asked for a signature and failed. They
 * are NOT transitions, and their absence from `EVENT_TO_STATE` is deliberate and
 * correct — an offer does not change state because someone was told "no". Waves
 * 7 and 11 both recorded that leaving them as bare string literals was the
 * remaining gap, and named this const as the fix rather than a state mapping.
 *
 * Why a SIBLING const rather than more keys on OFFER_EVENT: `EVENT_TO_STATE` and
 * `EVENT_TO_STATUS` are typed `Record<OfferEvent, …>`, so every name added to
 * OFFER_EVENT is a name the compiler DEMANDS a state for. Putting an audit event
 * there would force somebody to invent a transition for it — which is exactly the
 * mistake this separation prevents.
 */
export const OFFER_AUDIT_EVENT = {
  /** A gate refused. The offer is unchanged; the refusal is the record. */
  BLOCKED:                    "buyer.offer.block",
  /** The compliance audit gate's verdicts. */
  COMPLIANCE_PASSED:          "buyer.offer.compliance.passed",
  COMPLIANCE_FLAGGED:         "buyer.offer.compliance.flagged",
  COMPLIANCE_RESOLVED:        "buyer.offer.compliance.resolved",
  /** Signature evidence, ours and the provider's. */
  BUYER_SIGNED:               "buyer.offer.buyer_signed",
  SIGNATURE_SENT_TO_CONTACT:  "buyer.offer.signature.sent_to_contact",
  SIGNATURE_ATTESTED:         "buyer.offer.signature.attested",
  PROVIDER_SIGNATURE_REQUESTED: "buyer.offer.provider.signature.requested",
  PROVIDER_SIGNATURE_FAILED:  "buyer.offer.provider.signature.failed",
  ESIGN_COMPLETED:            "buyer.offer.esign.completed",
  /** Counter paperwork moving, as distinct from the counter being ACCEPTED. */
  COUNTER_SELLER_SIGNED:      "buyer.offer.counter.seller_signed",
  COUNTER_FULLY_EXECUTED:     "buyer.offer.counter.fully_executed",
  COUNTER_EXTERNAL_RECEIVED:  "buyer.offer.counter.external_received",
  /** Bookkeeping the lifecycle tracker writes about itself. */
  LIFECYCLE:                  "buyer.offer.lifecycle",
  TERMINAL:                   "buyer.offer.terminal",
} as const

export type OfferAuditEvent = typeof OFFER_AUDIT_EVENT[keyof typeof OFFER_AUDIT_EVENT]

/**
 * THE TWO VOCABULARIES ARE DISJOINT, AND THE COMPILER ENFORCES IT.
 *
 * Not a comment promising it — a type that fails to compile the moment a name
 * appears in both. Without this, the separation above is a convention, and a
 * convention is what the whole `OFFER_EVENT` const exists because we did not
 * have.
 */
type _AuditIsNeverALifecycleEvent =
  Extract<OfferAuditEvent, OfferEvent> extends never ? true : never
const _auditVocabularyIsDisjoint: _AuditIsNeverALifecycleEvent = true
void _auditVocabularyIsDisjoint

/** Every name this lane writes, for a reader that must recognise all of them. */
export const OFFER_ALL_EVENT_TYPES: readonly string[] = [
  ...Object.values(OFFER_EVENT),
  ...Object.values(OFFER_AUDIT_EVENT),
]

/**
 * Event → state.
 *
 * `SIGNATURE_REQUESTED` is deliberately DRAFT, not PENDING: asking the buyer to
 * sign is not the same as the offer being in front of the seller, and PENDING is
 * what the expiry sweep and the multi-offer cap key on. `VOIDED` collapses to
 * WITHDRAWN — D1 made the same call and nothing distinguishes them downstream.
 */
export const EVENT_TO_STATE: Record<OfferEvent, OfferState> = {
  [OFFER_EVENT.DRAFT_CREATED]:       "DRAFT",
  [OFFER_EVENT.SIGNATURE_REQUESTED]: "DRAFT",
  [OFFER_EVENT.SUBMITTED]:           "PENDING",
  [OFFER_EVENT.SENT_TO_LISTING]:     "PENDING",
  [OFFER_EVENT.COUNTER_RECEIVED]:    "COUNTERED",
  [OFFER_EVENT.COUNTER_SUBMITTED]:   "PENDING",
  [OFFER_EVENT.COUNTER_ACCEPTED]:    "ACCEPTED",
  [OFFER_EVENT.COUNTER_REJECTED]:    "REJECTED",
  [OFFER_EVENT.COUNTERED]:           "COUNTERED",
  [OFFER_EVENT.ACCEPTED]:            "ACCEPTED",
  [OFFER_EVENT.REJECTED]:            "REJECTED",
  [OFFER_EVENT.EXPIRED]:             "EXPIRED",
  [OFFER_EVENT.WITHDRAWN]:           "WITHDRAWN",
  [OFFER_EVENT.VOIDED]:              "WITHDRAWN",
}

/**
 * Event → `offers.status`, the OPERATIONAL INDEX. It reflects lifecycle and
 * never drives it (status-sync.ts's original rule, kept).
 *
 * Live schema: `offers.status` has no CHECK constraint (verified in
 * pg_constraint), so these literals are load-bearing only through the screens
 * that compare against them.
 *
 * The first nine rows are status-sync.ts's map verbatim. The rest are the events
 * D2 already knew, mapped to the literal the UI already renders.
 */
export const EVENT_TO_STATUS: Record<OfferEvent, string> = {
  [OFFER_EVENT.DRAFT_CREATED]:       "draft",
  [OFFER_EVENT.SIGNATURE_REQUESTED]: "submitted",
  [OFFER_EVENT.SENT_TO_LISTING]:     "under_review",
  [OFFER_EVENT.COUNTER_RECEIVED]:    "countered",
  [OFFER_EVENT.ACCEPTED]:            "accepted",
  [OFFER_EVENT.REJECTED]:            "rejected",
  [OFFER_EVENT.WITHDRAWN]:           "withdrawn",
  [OFFER_EVENT.EXPIRED]:             "expired",
  [OFFER_EVENT.VOIDED]:              "voided",
  // Added — same literals the screens already compare against.
  [OFFER_EVENT.SUBMITTED]:           "pending",
  [OFFER_EVENT.COUNTER_SUBMITTED]:   "pending",
  [OFFER_EVENT.COUNTER_ACCEPTED]:    "accepted",
  [OFFER_EVENT.COUNTER_REJECTED]:    "rejected",
  [OFFER_EVENT.COUNTERED]:           "countered",
}

/** States from which no further offer motion is possible. */
export const TERMINAL_OFFER_STATES: readonly OfferState[] = [
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "WITHDRAWN",
]

export function isTerminalOfferState(state: OfferState): boolean {
  return TERMINAL_OFFER_STATES.includes(state)
}

/** Every canonical event name, for `.in(...)` filters. */
export const OFFER_LIFECYCLE_EVENT_TYPES: readonly string[] =
  Object.values(OFFER_EVENT)

export interface OfferHistoryEntry {
  event: OfferEvent
  state: OfferState
  at: string
  /** `activities.agent_id` — agents-class, may be null for an unattended sweep. */
  actorAgentId: string | null
  /**
   * The human reason, parsed ONCE from the `notes` JSON blob the writers record
   * (`withdrawOffer` stores `reason`; the seller-response path stores
   * `response_type`). The previous derivation surfaced this as `history[].reason`
   * and every caller re-parsed the blob itself. Parsing it here means no reader
   * ever touches raw `notes` again — `null` when absent or unparseable, never a
   * thrown error, because a malformed audit note must not break a state read.
   */
  reason: string | null
}

/**
 * Pull the human reason out of an activity's `notes` JSON.
 *
 * The writers are not uniform about the field name — `withdrawOffer` writes
 * `reason`, the seller-response path writes `response_type` — so both are read,
 * in that order. Anything unparseable yields null: `notes` is free text on the
 * live schema, and a state read must never fail because an audit note is
 * malformed.
 */
function parseReason(notes: string | null): string | null {
  if (!notes) return null
  try {
    const parsed = JSON.parse(notes) as Record<string, unknown>
    const value = parsed?.reason ?? parsed?.response_type
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

export type DerivedOfferState =
  | { ok: true; state: OfferState; at: string; history: OfferHistoryEntry[] }
  | { ok: false; reason: string }

/**
 * Derive one offer's current state from its activity trail.
 *
 * Takes a client rather than making one, so the session path passes its
 * RLS-scoped client and the cron passes a service client — same logic, no fake
 * identity either way.
 *
 * `error` is destructured on purpose: supabase-js RESOLVES a refused query, so
 * `const { data }` renders "refused" and "no rows" identically. Here that would
 * turn a permissions refusal into "offer not found", which a sweep would then
 * skip silently forever.
 */
export async function deriveOfferStateFromActivities(
  client: SupabaseClient,
  offerId: string,
): Promise<DerivedOfferState> {
  const { data, error } = await client
    .from("activities")
    .select("activity_type, created_at, agent_id, notes")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .in("activity_type", OFFER_LIFECYCLE_EVENT_TYPES as string[])
    .order("created_at", { ascending: true })

  if (error) return { ok: false, reason: `Could not read offer lifecycle: ${error.message}` }

  const rows = (data ?? []) as Array<{
    activity_type: string
    created_at: string
    agent_id: string | null
    notes: string | null
  }>
  if (rows.length === 0) return { ok: false, reason: "Offer has no lifecycle events" }

  const history: OfferHistoryEntry[] = []
  for (const row of rows) {
    const state = EVENT_TO_STATE[row.activity_type as OfferEvent]
    // Unreachable while the `.in(...)` filter and the map share one source, but
    // a future event added to OFFER_EVENT without a state mapping must not be
    // silently read as "no change".
    if (!state) continue
    history.push({
      event: row.activity_type as OfferEvent,
      state,
      at: row.created_at,
      actorAgentId: row.agent_id ?? null,
      reason: parseReason(row.notes),
    })
  }

  if (history.length === 0) return { ok: false, reason: "Offer has no readable lifecycle events" }

  const current = history[history.length - 1]
  return { ok: true, state: current.state, at: current.at, history }
}
