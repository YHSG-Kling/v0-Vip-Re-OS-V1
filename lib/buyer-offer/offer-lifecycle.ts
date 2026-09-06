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
 *
 * ── ONE DERIVATION, TWO FETCH SHAPES ─────────────────────────────────────────
 * `deriveOfferStateFromActivities` (one offer) and
 * `deriveOfferStatesFromActivities` (many offers, ONE read) are not two
 * derivations. They differ only in the query; both hand their rows to the
 * private `reduceOfferLifecycleRows`, which is the only code in this repo that
 * turns activity rows into an `OfferState`. A state derived one at a time and a
 * state derived in a batch therefore cannot disagree — not by convention, but
 * because there is exactly one function that decides.
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

// UN-EXPORTED (§1.1, 2026-08-31, lane M4): its one reader is the disjointness
// assertion just below; external consumers pick named members of
// OFFER_AUDIT_EVENT directly (transaction-creation-gate, offer-flag-resolution,
// kernel/transactions), never the union.
type OfferAuditEvent = typeof OFFER_AUDIT_EVENT[keyof typeof OFFER_AUDIT_EVENT]

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

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `OFFER_ALL_EVENT_TYPES` deleted —
// built "for a reader that must recognise all of them", and no such reader
// ever existed: every live consumer reads a NAMED member of OFFER_EVENT or
// OFFER_AUDIT_EVENT (e.g. transaction-creation-gate.ts:244 keys on
// COMPLIANCE_PASSED; offer-flag-resolution.ts on COMPLIANCE_FLAGGED /
// COMPLIANCE_RESOLVED), because recognising an event means acting on it, and
// nothing acts on "any of the twenty". A future exhaustive reader should
// spread the two vocabularies at its own call site, where the compiler ties it
// to them.

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
 * The result of deriving MANY offers at once.
 *
 * TWO FAILURE MODES, AND THEY ARE ON DIFFERENT LEVELS ON PURPOSE.
 *
 *   · `{ ok: false }` at the TOP — the one `activities` read was REFUSED. That
 *     is a property of the CALL, not of any offer, so it is reported once. A
 *     caller that receives this knows nothing about any offer in the set and
 *     must refuse; there is no per-offer answer to sift for a usable one.
 *   · `{ ok: false }` INSIDE `states` — that particular offer has no lifecycle
 *     events. The trail was read successfully and this offer's part of it is
 *     genuinely empty.
 *
 * Folding a refusal into per-offer absence is the exact defect this module
 * exists to prevent: it turns "the count did not run" into "the count is zero",
 * and a limit gate that reads zero pending for a buyer at the cap fails OPEN.
 *
 * `states` carries an entry for EVERY id passed in (de-duplicated). An id with
 * no rows gets `{ ok: false, reason: "Offer has no lifecycle events" }` — it is
 * never silently dropped, because a missing key and a key meaning "nothing
 * here" read differently at every call site.
 */
export type BatchDerivedOfferStates =
  | { ok: true; states: Map<string, DerivedOfferState> }
  | { ok: false; reason: string }

/**
 * ONE projection, read by BOTH derivations.
 *
 * `entity_id` is selected even on the single-offer path, where it is redundant,
 * so that the two reads cannot differ in what they fetch. The batch needs it to
 * fold rows back onto their offer.
 */
const OFFER_LIFECYCLE_SELECT = "entity_id, activity_type, created_at, agent_id, notes"

/** The row shape both derivations reduce. */
interface OfferActivityRow {
  entity_id: string | null
  activity_type: string
  created_at: string
  agent_id: string | null
  notes: string | null
}

/**
 * ONE refusal sentence. Shared so that a refusal derived singly and a refusal
 * derived in a batch cannot be worded differently — a caller must never have to
 * tell them apart, and a proof must never be able to pass on one wording while
 * the other drifts.
 */
function refusedRead(message: string): { ok: false; reason: string } {
  return { ok: false, reason: `Could not read offer lifecycle: ${message}` }
}

/**
 * THE ONE REDUCTION: rows (ascending, already filtered to this offer) → state.
 *
 * This is the whole reason `deriveOfferStatesFromActivities` is not a second
 * derivation. The single-offer export and the batch export differ ONLY in how
 * they fetch rows; every row-to-state decision — the `EVENT_TO_STATE` lookup,
 * the ascending history, `parseReason` over `notes`, `actorAgentId` from
 * `activities.agent_id`, "latest event wins", and both empty-set answers — lives
 * here and nowhere else. A state derived one at a time and a state derived in a
 * batch therefore cannot disagree: there is only one function that decides.
 *
 * NOT exported. An exported reducer is an invitation to fetch rows some third
 * way and fold them independently, which is how this module ended up with three
 * rival derivations the first time.
 */
function reduceOfferLifecycleRows(rows: OfferActivityRow[]): DerivedOfferState {
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

/**
 * Derive one offer's current state from its activity trail.
 *
 * THE SINGLE-OFFER FACE OF THE BATCH, not a rival of it: it fetches this offer's
 * rows and hands them to `reduceOfferLifecycleRows`, which is the same function
 * `deriveOfferStatesFromActivities` folds every offer through.
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
    .select(OFFER_LIFECYCLE_SELECT)
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .in("activity_type", OFFER_LIFECYCLE_EVENT_TYPES as string[])
    .order("created_at", { ascending: true })

  if (error) return refusedRead(error.message)

  return reduceOfferLifecycleRows((data ?? []) as unknown as OfferActivityRow[])
}

/**
 * Derive MANY offers' states from ONE `activities` read.
 *
 * WHY THIS LIVES HERE AND NOT AT THE CALL SITE. Every reader that needs states
 * for a SET of offers — the pending-offer cap, the duplicate scan, the buyer's
 * active-offer list — was issuing one read per offer, plus a preceding probe
 * read purely to tell "refused" apart from "no events" at the set level. Folding
 * the rows at those call sites instead would have minted a second derivation of
 * "what state is this offer in", which is the class of defect this whole module
 * was built to delete. So the batch entry point belongs on the canonical module,
 * sharing the canonical reducer.
 *
 * THE READ: ONE query, `entity_type = 'offer'` AND `entity_id IN (…)`, filtered
 * to the canonical event vocabulary, ordered `created_at` ascending — the same
 * key, the same filter and the same order as the single-offer path. Postgres
 * returns them interleaved across offers; grouping preserves each offer's
 * relative order, so every bucket is still ascending when it reaches the
 * reducer.
 *
 * THE EMPTY LIST IS NOT A QUERY. `.in("entity_id", [])` is a trap — it is a
 * pointless round trip whose result is indistinguishable from a refusal-shaped
 * empty set, and PostgREST has historically been inconsistent about it. An empty
 * request is answered with an empty map, locally, having read nothing.
 *
 * `error` is destructured for the same reason it is on the single-offer path,
 * and the refusal is reported ONCE for the whole call (see
 * `BatchDerivedOfferStates`) rather than as N offers that happen to have no
 * events.
 */
export async function deriveOfferStatesFromActivities(
  client: SupabaseClient,
  offerIds: string[],
): Promise<BatchDerivedOfferStates> {
  const uniqueIds = Array.from(new Set(offerIds))
  if (uniqueIds.length === 0) return { ok: true, states: new Map() }

  const { data, error } = await client
    .from("activities")
    .select(OFFER_LIFECYCLE_SELECT)
    .eq("entity_type", "offer")
    .in("entity_id", uniqueIds)
    .in("activity_type", OFFER_LIFECYCLE_EVENT_TYPES as string[])
    .order("created_at", { ascending: true })

  if (error) {
    return refusedRead(error.message)
  }

  const rows = (data ?? []) as unknown as OfferActivityRow[]
  const byOffer = new Map<string, OfferActivityRow[]>()
  for (const row of rows) {
    const key = row.entity_id
    if (!key) continue
    const bucket = byOffer.get(key)
    if (bucket) bucket.push(row)
    else byOffer.set(key, [row])
  }

  // EVERY requested id gets an entry, including the ones with no rows. A caller
  // that asked about an offer and got no key back cannot tell that from a bug in
  // this function.
  const states = new Map<string, DerivedOfferState>()
  for (const id of uniqueIds) {
    states.set(id, reduceOfferLifecycleRows(byOffer.get(id) ?? []))
  }

  return { ok: true, states }
}
