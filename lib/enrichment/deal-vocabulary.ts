// lib/enrichment/deal-vocabulary.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE. The definition of "this contact is in a live deal", with no I/O and no
// `server-only` — so scripts/enrichment-suppression-simulator.ts can import it
// and assert the partition directly. lib/enrichment/deal-suppression.ts is the
// I/O half and re-exports everything here, so callers have one import site.
//
// Split for the same reason lib/transactions/closing-overdue-policy.ts is split
// from its reaper: the policy is the part worth unit-testing, and a module that
// imports "server-only" cannot be loaded by a tsx guard.
//
// "…BUT NOT IF THEY HAVE AN ACTIVE LISTING OR AN ACTIVE TRANSACTION; JUST BEFORE
//  OR AFTER."  (owner's ruling on contact enrichment)
//
// THE ONE PREDICATE. Every enrichment entry point in the system asks this file
// the same question — `isContactInLiveDeal` — so the definition of "active"
// cannot drift between the create-time lane, the queue drain, the nightly net
// and the server actions. Before this existed the suppression did not exist AT
// ALL: nothing anywhere in the enrichment path looked at listings or
// transactions.
//
// ── WHY THE ACTIVE SET IS DECLARED POSITIVELY ────────────────────────────────
// The obvious implementation is "not terminal". It is also the wrong one, and
// this repo already contains the proof: lib/transactions/closing-overdue-policy.ts
// exports TERMINAL_TXN_STATUSES = {closed, lost, cancelled, terminated,
// withdrawn, dead}. Four of those six are values the live
// transactions_status_check CANNOT HOLD, and the two it can hold are not the
// whole terminal set — 'funded' and 'archived' are both missing. Suppressing on
// `!TERMINAL_TXN_STATUSES.has(status)` would therefore mark every funded and
// every archived deal as still live, and those contacts would never be enriched
// again. That is the "too broad → enrichment never runs" failure, shipped by
// re-use.
//
// So both vocabularies are partitioned EXHAUSTIVELY here — BEFORE / ACTIVE /
// AFTER — over the live CHECK constraint, and the partition is asserted to cover
// the constraint by scripts/enrichment-suppression-simulator.ts. A value added
// to the database by a future migration fails that guard instead of silently
// landing in whichever bucket the negation happened to put it.
//
// ── VERIFIED AGAINST THE LIVE DATABASE (project hrvaqgvukzxfskkcrwbt) ─────────
//   listings_status_check          10 values
//   listings_lifecycle_stage_check 34 values, column is NOT NULL
//   transactions_status_check      10 values
//   transactions_stage_check       7 values, NULL admitted
// and against scripts/check-vocabularies.ts (listings @854, transactions @1481),
// which is the settled snapshot the check-vocabulary guard enforces. The two
// agree exactly.
//
// Contact linkage is by live FOREIGN KEY, not by convention — five columns
// reference contacts(id):
//   listings.contact_id, listings.seller_contact_id
//   transactions.contact_id, transactions.buyer_contact_id, transactions.seller_contact_id
// Missing any of them would mean a buyer under contract still gets enriched
// mid-deal, so all five are queried.
//
// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
// supabase-js RESOLVES a refused query — `const { data }` reads "RLS said no" as
// "no rows", i.e. as "this contact is not in a deal". For a suppression check
// that inversion is the whole defect: an unreadable table would turn the gate
// off rather than on. Every read here destructures `error`, and ANY error
// returns `inLiveDeal: true`. If we cannot tell whether the contact is in a live
// deal, we do not enrich.

// ─── LISTINGS ────────────────────────────────────────────────────────────────

/**
 * listings.lifecycle_stage — the 34-state machine, NOT NULL, advanced by
 * transitionLifecycle. This is the AUTHORITATIVE column for "is the seller a
 * live client", because `status` is the coarse 7-value market state that
 * lib/listings/listing-status-sync.ts only writes at market-state BOUNDARIES:
 * a listing sitting at LISTING_AGREEMENT_SIGNED still carries whatever status
 * it was created with (often 'draft'). Keying suppression off `status` alone
 * would enrich a seller the day after they signed.
 */

/** Pre-deal: the listing agreement is not signed. The owner's "just before". */
export const LISTING_STAGES_BEFORE = [
  "LEAD",
  "LEAD_ASSIGNED",
  "AGENT_CONSULTATION",
  "APPOINTMENT_SET",
  "CMA_GENERATION",
  "LISTING_PRESENTATION_CREATED",
  "PRESENTATION_VIDEO_GENERATED",
  "PRESENTATION_DRIP_PREP",
  "SELLER_DECISION",
  "LISTING_AGREEMENT_INITIATED",
] as const

/**
 * The deal is LIVE. Starts the moment the listing agreement is SIGNED — that is
 * when the seller stops being a prospect and becomes a client with an engagement
 * running — and holds through closing prep.
 */
export const LISTING_STAGES_ACTIVE = [
  "LISTING_AGREEMENT_SIGNED",
  "MLS_DATE_CONFIRMED",
  "COMING_SOON_PREP",
  "REPAIRS_IN_PROGRESS",
  "COMING_SOON_ACTIVE",
  "MEDIA_CAPTURE",
  "MEDIA_APPROVED",
  "MLS_READY",
  "OPEN_HOUSE_MARKETING",
  "MLS_ACTIVE",
  "OPEN_HOUSE_EVENT",
  "SHOWINGS_ACTIVE",
  "OFFERS_RECEIVED",
  "NEGOTIATION",
  "UNDER_CONTRACT",
  "INSPECTION",
  "APPRAISAL",
  "FINANCING",
  "CLOSING_PREP",
] as const

/** The deal is over — closed, cancelled, expired, or never started. "Just after". */
export const LISTING_STAGES_AFTER = [
  "CLOSED",
  "LIFETIME_CUSTOMER",
  "LISTING_CANCELLED",
  "LISTING_EXPIRED",
  "SELLER_DECLINED",
] as const

/** listings.status — coarse market state. Corroborating signal only (see below). */
export const LISTING_STATUSES_ACTIVE = ["listing_signed", "coming_soon", "active", "pending"] as const
/** 'draft' is pre-deal; the rest are terminal. */
export const LISTING_STATUSES_INACTIVE = [
  "draft",
  "withdrawn",
  "cancelled",
  "off_market",
  "expired",
  "sold",
] as const

// ─── TRANSACTIONS ────────────────────────────────────────────────────────────

/**
 * transactions.status is the authoritative column here (the inverse of listings:
 * `stage` is nullable and only covers the under-contract half of the funnel,
 * while `status` spans lead → funded).
 */
export const TXN_STATUSES_BEFORE = ["lead", "qualifying"] as const
export const TXN_STATUSES_ACTIVE = ["active", "under_contract", "pending", "clear_to_close"] as const
/** 'funded' and 'archived' belong HERE — the omission that makes the existing
 *  TERMINAL_TXN_STATUSES set unusable for this predicate. */
export const TXN_STATUSES_AFTER = ["closed", "funded", "lost", "archived"] as const

export const TXN_STAGES_ACTIVE = [
  "UNDER_CONTRACT",
  "INSPECTION",
  "APPRAISAL",
  "FINANCING_PENDING",
  "CLOSING_PREP",
] as const
export const TXN_STAGES_AFTER = ["CLOSED", "LOST"] as const

const listingStagesActive = new Set<string>(LISTING_STAGES_ACTIVE)
const listingStagesAfter = new Set<string>(LISTING_STAGES_AFTER)
const listingStatusesActive = new Set<string>(LISTING_STATUSES_ACTIVE)
const txnStatusesActive = new Set<string>(TXN_STATUSES_ACTIVE)
const txnStatusesAfter = new Set<string>(TXN_STATUSES_AFTER)
const txnStagesActive = new Set<string>(TXN_STAGES_ACTIVE)

// ─── PURE CLASSIFIERS ────────────────────────────────────────────────────────

/**
 * PURE. Is this listing row a live seller engagement?
 *
 * A TERMINAL STAGE IS DECISIVE. `status` is only allowed to *add* suppression,
 * never to keep it switched on after the stage machine says the listing is done
 * — otherwise a stale ad-hoc webhook write of status='active' on a CLOSED
 * listing would suppress that past client's enrichment forever, which is exactly
 * the moment the owner wants enrichment to resume ("or after").
 *
 * Below that, EITHER signal saying "live" is enough. They are written by
 * different code paths (the stage machine vs. ad-hoc webhook status writes), so
 * requiring both to agree would mean a real live listing whose status never got
 * synced goes un-suppressed.
 */
export function isListingLive(row: { lifecycle_stage?: string | null; status?: string | null }): boolean {
  const stage = (row.lifecycle_stage ?? "").trim()
  const status = (row.status ?? "").trim()
  if (listingStagesAfter.has(stage)) return false
  return listingStagesActive.has(stage) || listingStatusesActive.has(status)
}

/**
 * PURE. Is this transaction row a live deal?
 *
 * A TERMINAL STATUS IS DECISIVE, for the mirror-image reason: transactions.stage
 * is nullable and is not cleared on close, so a funded deal can still read
 * stage='CLOSING_PREP'. Without this the contact would never be enrichable again
 * after their first closing.
 */
export function isTransactionLive(row: { status?: string | null; stage?: string | null }): boolean {
  const status = (row.status ?? "").trim()
  const stage = (row.stage ?? "").trim()
  if (txnStatusesAfter.has(status)) return false
  return txnStatusesActive.has(status) || txnStagesActive.has(stage)
}

// ─── THE LEAD SIDE (wave 5) ──────────────────────────────────────────────────
//
// "enrichment also needs to still happen with raw leads" (owner). Track A rides
// the same queue and the same drain as Track B, so it needs the same suppression
// rule — but the rule cannot be re-keyed onto a lead id, and this is why.
//
// VERIFIED AGAINST THE LIVE SCHEMA (project hrvaqgvukzxfskkcrwbt): thirty-seven
// tables carry a foreign key to `leads`. `listings` is NOT one of them and
// `transactions` is NOT one of them. A column scan agrees — listings has only
// `contact_id` / `seller_contact_id`, transactions has only `contact_id` /
// `buyer_contact_id` / `seller_contact_id`. There is no `listings.lead_id` and no
// `transactions.lead_id` anywhere in the schema.
//
// So "is THIS LEAD in a live deal" is UNANSWERABLE in the lead's own id space.
// Answering it "no" would be a guess dressed as a fact. The only bridge is
// `leads.contact_id` (FK → contacts), and it is exactly the case that matters:
// lib/kernel/lead-acquisition-handlers.ts:413 stamps `leads.contact_id` when a
// lead converts, so a converted lead whose contact then signs a listing must be
// suppressed or the lead lane pays to enrich a client mid-deal — precisely what
// the ruling forbids.
//
// leads.id and contacts.id are DISJOINT id spaces. This function exists so that
// the resolution is a named, testable step rather than a `leadId ?? contactId`
// somewhere in an I/O function — the substitution that raises 22P02 at best and
// answers a question about the wrong row at worst.

/**
 * What the deal tables can be asked about a lead.
 *  · `unlinked` — the lead has no contact. NOTHING in `listings` or
 *    `transactions` can reference it, so it cannot be in a live deal. This is a
 *    schema fact, not an assumption, and it is the ordinary case for a raw lead.
 *  · `resolve`  — the lead converted; ask the CONTACT-keyed predicate about
 *    `contactId`, which is a contacts.id and never the lead's own id.
 */
export type LeadDealLinkage =
  | { kind: "unlinked" }
  | { kind: "resolve"; contactId: string }

/**
 * PURE. Resolve a lead row to the id the deal tables can actually be queried by.
 *
 * Whitespace-only and empty-string `contact_id` are treated as UNLINKED rather
 * than passed through: `.eq("id", "")` on a uuid column raises 22P02 (invalid
 * input syntax), which supabase-js surfaces as an error — and an error in a
 * fail-closed predicate suppresses the lead forever.
 */
export function leadDealLinkage(row: { contact_id?: string | null }): LeadDealLinkage {
  const contactId = (row.contact_id ?? "").trim()
  if (!contactId) return { kind: "unlinked" }
  return { kind: "resolve", contactId }
}

