// ─── COMPLIANCE GATE ──────────────────────────────────────────────────────────
export {
  checkCompliancePassed,
  emitCompliancePassed,
  validateAcceptanceEligibility,
} from './compliance-gate'
export type { ComplianceCheckResult } from './compliance-gate'

// ─── CREDENTIALS HELPER ───────────────────────────────────────────────────────
export {
  getAgentProviderCredentials,
  hasProviderCredentials,
} from './credentials-helper'
export type { ProviderCredentials } from './credentials-helper'

// ─── OFFER LIFECYCLE — one vocabulary, one key, one derivation ────────────────
//
// DELETED: `./lifecycle-event-map` in its entirety —
//   · `OFFER_LIFECYCLE_EVENTS` (22 UNDERSCORE constants: buyer.offer.draft_created,
//     .submitted_to_seller, .seller_accepted, .counter_received, …). No writer in
//     the tree ever emitted one under that spelling through this constant — every
//     writer used a string literal — and no file outside this barrel ever imported
//     it. SURVIVOR: ./offer-lifecycle:OFFER_EVENT, whose names are the DOT spellings
//     the live writers and all three readers actually use.
//   · `deriveOfferState` — keyed on `metadata->>offer_id`, a key NO reader and NO
//     writer in this repo shares, so it derived state from rows that do not exist.
//     SURVIVOR: ./offer-lifecycle:deriveOfferStateFromActivities, on the canonical
//     `entity_type='offer'` + `entity_id` key.
//   · `detectConflictingOffers` — same-buyer/same-listing conflict scan.
//     SURVIVOR: app/actions/buyer-offer/handle-multi-offer.ts:checkDuplicateOffer,
//     which asks the same question with a session + tenant gate and a destructured
//     read error. Its two unique capabilities (`excludeOfferId`, and returning the
//     FULL conflicting set rather than the first hit) were MERGED onto the survivor
//     before this was removed; its three defects (no brokerage filter, swallowed
//     read error, PENDING-only instead of non-terminal) were NOT ported.
//   · `OfferLifecycleEvent` / `OfferEventMetadata` — types over the dead vocabulary.
//     `OfferEventMetadata` was an index-signature bag whose `offer_id` field WAS the
//     abandoned `metadata->>offer_id` key. No importer anywhere (verified across
//     app/ lib/ components/ hooks/ services/ scripts/). SURVIVOR for the event union:
//     ./offer-lifecycle:OfferEvent.
//
// Full accounting: docs/wave7-slice-derivations.md
export {
  OFFER_EVENT,
  EVENT_TO_STATE,
  EVENT_TO_STATUS,
  TERMINAL_OFFER_STATES,
  OFFER_LIFECYCLE_EVENT_TYPES,
  isTerminalOfferState,
  deriveOfferStateFromActivities,
} from './offer-lifecycle'
export type {
  OfferState,
  OfferEvent,
  OfferHistoryEntry,
  DerivedOfferState,
} from './offer-lifecycle'

// NOTE: ./expire-offers is deliberately NOT re-exported here. Its callers
// (app/actions/buyer-offer/track-offer-lifecycle.ts and the offer-expiry cron
// route) import it by path so the session-free module is never pulled in as a
// side effect of reaching for something else in this barrel.

// ─── STATUS SYNC ──────────────────────────────────────────────────────────────
export {
  syncOfferStatus,
  getCurrentOfferStatus,
} from './status-sync'
