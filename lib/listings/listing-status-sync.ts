// lib/listings/listing-status-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE canonical map: listings.lifecycle_stage (the 34-state stage machine) → listings.status (the
// coarse market state buyer search / public pages / dashboards read). The two columns drifted: the
// stage machine advanced lifecycle_stage while `status` was only written ad-hoc by webhooks, so a
// just-MLS-active listing could still read status='coming_soon' and never surface in buyer search.
// transitionLifecycle now calls statusForStage() on every listing_stage_machine transition and writes
// the synced status in the SAME atomic update — no extra round-trip, no separate code path.
//
// ── "ACTIVE" NAMES TWO DIFFERENT THINGS AND THIS FILE MUST NOT CONFLATE THEM ──
//
// Owner's ruling, verbatim (2026-09-05):
//
//   "after the compliance gate for a signed executed listing agreement is passed, the listing is
//    active in the system but the listing status is coming soon."
//
// So there are two senses of "active" and they are NOT the same event:
//
//   · ACTIVE IN THE SYSTEM — the OS starts running the listing: the file is live, automation
//     enrols, the concierge works it. This happens the moment the listing-agreement compliance
//     gate passes. Its MARKET-FACING listings.status at that moment is `coming_soon`.
//   · ACTIVE ON THE MARKET — listings.status = 'active'. That is MLS-live, and ONLY MLS-live.
//     It is reached at lifecycle_stage MLS_ACTIVE, behind lib/listings/listing-activation-gate.ts
//     (the owner's 2026-09-04 ruling: the same compliance gate an offer passes to become a
//     transaction).
//
// The invariant this file exists to hold: EXACTLY ONE stage may yield `active`, and it is the
// MLS-live one. If a second stage ever yields `active`, the two senses have re-merged and a
// listing goes publicly live on the strength of a signed agreement alone. scripts/listing-status-
// two-senses-guard.ts asserts that as a derived property over the whole live stage vocabulary.
//
// DESIGN: only the MEANINGFUL market-state boundaries are mapped. Intermediate stages return
// undefined so they NEVER clobber status — coming_soon holds through OPEN_HOUSE_MARKETING; active
// holds through OFFERS_RECEIVED/NEGOTIATION; pending holds through INSPECTION/APPRAISAL/FINANCING/
// CLOSING_PREP. The coarse status only moves when the listing actually crosses a public
// market-state line. No I/O — unit-testable.

import { LISTING_STATUSES, type ListingStatus } from "@/lib/constants"
import type { ComingSoonWindow } from "./compute-dom"

// TOMBSTONE (2026-09-05). The hand-typed vocabulary that used to live here —
//   `type ListingStatus = "draft" | "coming_soon" | "active" | "pending" | "sold" | "expired" | "withdrawn"`
//   `const LISTING_STATUS_VALUES = [...the same 7...]`
// each carrying the comment "The 7 allowed listings.status values (live CHECK constraint)" — is
// DELETED. That comment was FALSE: the live CHECK admits TEN, and the three it omitted
// (`listing_signed`, `cancelled`, `off_market`) are exactly the ones a status decision here would
// need. It was a claim about the database made by a file that had never read it (CLAUDE.md §3).
//
// THE SURVIVOR is lib/constants/index.ts::LISTING_STATUSES — the full admitted set, already matched
// to the CHECK, already the list the status picker renders from and updateListingStatus validates
// against, and already held against the generated cache by scripts/sequence-step-palette-guard.ts.
// Nothing was missing from the survivor, so there was nothing to merge onto it first (§1.1).
//
// `LISTING_STATUS_VALUES` survives ONLY as a re-export of that one definition, because
// scripts/listing-status-sync-simulator.ts (another lane's file) imports it by that name. There is
// now ONE definition and two names; the second name should be inlined to `LISTING_STATUSES` by
// whoever owns that simulator. scripts/listing-status-two-senses-guard.ts asserts the alias is
// value-identical to the survivor so the two names cannot drift back into two vocabularies (§6).
export type { ListingStatus }
export { LISTING_STATUSES as LISTING_STATUS_VALUES }

/**
 * THE RULING'S STATUS. What listings.status becomes once the listing-agreement compliance gate has
 * passed: `coming_soon`, never `active`.
 *
 * ONE WRITER, AND IT IS THE GATED MAP. For one wave this constant was ALSO imported by the three
 * signature-time writers (the two e-sign webhooks and the compliance auto-create chain), which
 * stamped `coming_soon` the moment the agreement was executed — BEFORE the gate had run, and on
 * the webhook paths OVERWRITING the `listing_signed` the kernel transition had just stamped. That
 * contradicted the owner's sequence (listing_signed → coming_soon → active). Those writers now
 * stamp nothing (the kernel path does it) or STATUS_AT_LISTING_AGREEMENT_SIGNED (the insert), and
 * `coming_soon` is reached ONLY through the gated COMING_SOON_PREP entry below — which is what
 * "after the gate" means.
 */
export const STATUS_AFTER_LISTING_AGREEMENT_GATE: ListingStatus = "coming_soon"

/**
 * THE STATUS AT WHICH COMPLIANCE STARTS. Owner: "the listing signed is part of the gate to start
 * compliance." Stamped UNGATED on LISTING_AGREEMENT_SIGNED by the map below and by the one
 * producer that INSERTS a listing already at that stage
 * (lib/workflow-orchestrator/chains/compliance-listing-auto-create.ts). It is NOT the status
 * after the gate passes — that is STATUS_AFTER_LISTING_AGREEMENT_GATE, reached only through the
 * gated COMING_SOON_PREP entry. The two names exist so the two moments cannot be spelled as one:
 * for one wave the signature-time writers stamped `coming_soon`, which overwrote the kernel's
 * fresh `listing_signed` and declared compliance passed before it had run.
 */
export const STATUS_AT_LISTING_AGREEMENT_SIGNED: ListingStatus = "listing_signed"

/**
 * Evidence that a GATE has passed, supplied by the caller that ran it. This file is pure and does
 * no I/O, so it cannot check a gate itself — it takes the gate's VERDICT rather than re-deriving
 * it, so there is no second spelling of "did compliance pass" anywhere (§6). The one authority on
 * that question is lib/listings/listing-activation-gate.ts.
 */
export interface ListingStatusGate {
  /**
   * TRUE only when the listing-agreement compliance gate has PASSED for this listing — i.e. a
   * `listing_agreements` row exists carrying compliance_passed=true AND an esign_status at or past
   * all-signed on the ladder (wave 143, lane 143A: `fully_executed_at` is the stamp of the ladder's
   * `fully_executed` hop that lands after compliance approval, not an input to it), which is
   * obligation 1 of lib/listings/listing-activation-gate.ts::assertListingActivationAllowed.
   *
   * Absent or false means NOT PROVEN, and not-proven refuses (CLAUDE.md §4): the gated stage
   * yields undefined and status is left untouched. "Nobody checked" must never render as
   * "checked and fine".
   */
  listingAgreementCompliancePassed?: boolean
}

// ── UNGATED: the stage alone implies the market state ────────────────────────
// lifecycle_stage → coarse status, at market-state boundaries only. Unlisted stages → undefined
// (status untouched). Keys must be valid lifecycle_stage values (live CHECK).
const STATUS_FOR_STAGE: Record<string, ListingStatus> = {
  // ── OWNER RULING 2026-09-05: "the listing signed is part of the gate to start compliance." ──
  // The signed agreement is the moment compliance BEGINS, not the moment it passes — so this
  // stage is UNGATED and yields `listing_signed`, the live CHECK value that until now nothing
  // automated ever wrote (recorded as an OWNER QUESTION in test:listing-status-two-senses; this
  // is the answer). The pass is a different stage: COMING_SOON_PREP, gated below, yields
  // `coming_soon`. The status sequence therefore reads in the owner's words —
  //   listing_signed (compliance started) → coming_soon (compliance passed) → active (MLS-live) —
  // and no two of those are the same fact. markAgreementSigned reaches this through
  // transitionLifecycle, so the stamp is autonomous: no surface has to remember to set it.
  LISTING_AGREEMENT_SIGNED: STATUS_AT_LISTING_AGREEMENT_SIGNED,
  COMING_SOON_ACTIVE: "coming_soon", // publicly teased, pre-MLS
  MLS_ACTIVE:         "active",      // live on MLS — must surface in buyer search. THE ONLY 'active'.
  UNDER_CONTRACT:     "pending",     // accepted offer, off the active market
  CLOSED:             "sold",
  LIFETIME_CUSTOMER:  "sold",        // post-close; idempotent (already sold from CLOSED)
  LISTING_EXPIRED:    "expired",
  // ── ADJUDICATED 2026-09-05, DELIBERATELY LEFT AS `withdrawn`. UNRESOLVED, NOT SETTLED. ──
  // The live CHECK admits BOTH `withdrawn` and `cancelled`, and on the stage's own words
  // ("Active listing cancelled by agent, seller, or admin" — lib/listing-lifecycle/
  // lifecycle-definitions.ts) `cancelled` is the better reading: a cancellation terminates the
  // executed listing agreement, a withdrawal only pulls the property off the market.
  //
  // It is NOT changed here, because this is HALF of a pair and the other half is not this lane's
  // to edit. app/actions/listings-kernel.ts:1067 carries the REVERSE map and spells the same
  // terminal `withdrawn`:  `status === "withdrawn" ? "LISTING_CANCELLED" : undefined`.
  // Flipping only this half would produce withdrawn → LISTING_CANCELLED → cancelled: a value that
  // silently rewrites itself, i.e. exactly the two-spellings defect §6 forbids, created by the fix.
  // §1.1 requires merging onto the survivor FIRST; the "first" half is out of reach here, so the
  // one-sided edit is refused and the pair is left CONSISTENT and recorded instead.
  // The rule — not the value — is enforced: scripts/listing-status-two-senses-guard.ts asserts the
  // forward map and that reverse map name the SAME terminal, and holds whichever value the pair
  // settles on, so this cannot be quietly split later.
  LISTING_CANCELLED:  "withdrawn",
  // The seller chose not to list — terminal, and NO listing agreement was ever executed, so there
  // is nothing to have `cancelled`. `withdrawn` (off the market without a cancelled agreement) is
  // the honest reading of the pair above.
  SELLER_DECLINED:    "withdrawn",
}

// ── GATED: the stage implies the market state ONLY once a named gate has passed ──
// The owner's ruling lives here rather than in the map above, because the ruling is conditional
// ("AFTER the compliance gate ... is passed") and the map above is not. A listing that reaches a
// gated stage by some path that never ran the gate must NOT pick up `coming_soon` by accident.
//
// ── WHICH STAGE THE GATE HANGS OFF — THE OWNER REFINED THIS ON 2026-09-05 ────
// First statement: "after the compliance gate for a signed executed listing agreement is passed,
// the listing is active in the system but the listing status is coming soon."
// Refinement, asked and answered the same day, verbatim: "listing agreement signed /mls start date
// starts the compliance gate to be sure all listing documents are signed, intitialed and all docs
// present. if passed then the status is coming soon prep".
//
// So the agreement being signed — and the MLS start date being set — are what START the gate; they
// are not themselves the pass. The stage that means THE GATE PASSED is COMING_SOON_PREP, and that
// is where the status change belongs. Hanging it on LISTING_AGREEMENT_SIGNED (the first reading)
// would have moved the market state at the moment the gate BEGINS, which is the one moment the
// owner's sentence excludes.
//
// "coming soon prep" NAMES A LIFECYCLE STAGE, NOT A STATUS. `coming_soon_prep` is not a member of
// listings_status_check (verified live: draft, listing_signed, coming_soon, active, pending,
// withdrawn, cancelled, off_market, expired, sold), while COMING_SOON_PREP IS a member of
// listings_lifecycle_stage_check. The two columns answer different questions and this is exactly
// the two-senses-of-active problem this module exists to hold apart: the STAGE is COMING_SOON_PREP
// (where the OS is working the listing — "active in the system") and the market-facing STATUS is
// `coming_soon`, the only coming-soon value the database admits.
//
// COMING_SOON_ACTIVE keeps its UNGATED mapping to the same status above. That is not a duplicate:
// prep is "the gate passed, we are preparing", active is "publicly teased". They are consecutive
// stages that share one coarse market state, which is precisely what a coarse status is for.
const STATUS_FOR_GATED_STAGE: Record<string, { status: ListingStatus; gate: keyof ListingStatusGate }> = {
  COMING_SOON_PREP: {
    status: STATUS_AFTER_LISTING_AGREEMENT_GATE,
    gate:   "listingAgreementCompliancePassed",
  },
}

/** PURE. The coarse listings.status a given lifecycle_stage implies, or undefined when the stage
 *  does not change the public market state (leave status as-is).
 *
 *  `gate` carries the verdicts of gates the CALLER ran. A gated stage yields its status only when
 *  the named verdict is exactly `true`; omitted, false or unknown all mean NOT PROVEN and yield
 *  undefined, which leaves status untouched (fail closed — CLAUDE.md §4).
 *
 *  ── BLAST RADIUS: THREE WRITERS CALL THIS, AND ALL THREE ARE UNCHANGED ──────
 *    · lib/kernel/lifecycle.ts:204                — transitionLifecycle, every listing_stage_machine
 *                                                   transition, same atomic update
 *    · lib/application/listing-lifecycle.ts:392   — the stage-advance service
 *    · lib/application/listing-lifecycle.ts:475   — the stage-override/transition service
 *  All three call `statusForStage(toState)` with NO gate argument, so every one of them behaves
 *  EXACTLY as before this change: the eight ungated boundaries map as they always did, and the one
 *  gated stage returns undefined and leaves status untouched. Nothing they write moves.
 *
 *  ── WIRED 2026-09-05. THE RULING IS NOW IN FORCE ────────────────────────────
 *  All three callers now resolve the verdict and pass it. Each does so LAZILY — `isGatedStage()`
 *  below is asked first, and only a gated target stage pays for the read, so the overwhelming
 *  majority of transitions (every ungated boundary, every intermediate stage) do exactly what they
 *  did before with no extra round trip. The verdict comes from
 *  lib/listings/listing-activation-gate.ts::listingAgreementComplianceState, which delegates to the
 *  same readListingCompliance the full gate uses, so there is ONE implementation of the question.
 *  A `"unknown"` state (the read was REFUSED — supabase-js resolves refusals, §3) is passed through
 *  as NOT proven and logged as unknown, never as a clean negative.
 *
 *  ── THE ALTERNATIVE THAT WAS REJECTED ───────────────────────────────────────
 *  The tempting shortcut was to map LISTING_AGREEMENT_SIGNED unconditionally, which would hand `coming_soon`
 *  to any transition into that stage — including one that never touched compliance — and the
 *  ruling says AFTER THE GATE PASSES.
 *
 *  to any transition into that stage — including one that never touched compliance — and the ruling
 *  says AFTER THE GATE PASSES.
 *
 *  The three ad-hoc writers named on STATUS_AFTER_LISTING_AGREEMENT_GATE (the two e-sign webhooks
 *  and the compliance auto-create chain) are NOT replaced by this and are not duplicates of it:
 *  they write at the moment their own provider confirms execution, on a listing that may have no
 *  stage transition at all. They and this map now spell the value one way (§6); which of them fires
 *  first for a given listing is a race that resolves to the same status either way.
 */
export function statusForStage(stage: string, gate?: ListingStatusGate): ListingStatus | undefined {
  const ungated = STATUS_FOR_STAGE[stage]
  if (ungated) return ungated

  const gated = STATUS_FOR_GATED_STAGE[stage]
  if (!gated) return undefined
  return gate?.[gated.gate] === true ? gated.status : undefined
}

/** PURE. Is this stage's status conditional on a gate verdict? DERIVED from the gated map, never a
 *  typed list — a caller that hardcoded "COMING_SOON_PREP" would be pinning a WAYPOINT (§2) and
 *  would silently stop paying for the verdict the day a second gated stage is added.
 *
 *  Callers ask this BEFORE doing any I/O: only a gated target stage needs a database read, so an
 *  ungated transition costs exactly what it always did. */
export function isGatedStage(stage: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATUS_FOR_GATED_STAGE, stage)
}

// ══ C12 — THE LISTING LIFECYCLE (wave 147, lane 147F; owner rulings 8 + 10, 2026-10-31) ═════════════════════════════
//
//   agreement_executed(at) → coming_soon(start = executed_at, planned_mls_live_at) → active(on the MLS-live EVENT, never
//   on a date) → pending / sold / withdrawn / expired → archived (internal only).
//
// Owner, verbatim: "coming soon start date is the day the listing agreement was executed and once the listing is live on
// mls, the listing becomes active not coming soon"; "no archived listing should still be seen publicly" AND "archived
// listings should still show" — internal history yes, public surfaces no.
//
// ONE VOCABULARY: every value below is a member of the live listings_status_check (scripts/check-vocabularies.ts), and
// ARCHIVED IS NOT A STATUS — it is `listings.deleted_at` (lib/kernel/listing-archive.ts explains why, with the live probe:
// status='archived' is refused 23514 and would erase the record's own outcome). So "publicly visible" is TWO facts, always
// asked together: a public status AND not archived.

/**
 * THE STATUSES ONLY A GATED DOOR MAY WRITE — never a picker, never a date. Derived from the map above, not typed:
 *   · STATUS_AT_LISTING_AGREEMENT_SIGNED  — the agreement was executed (the kernel's LISTING_AGREEMENT_SIGNED hop);
 *   · STATUS_AFTER_LISTING_AGREEMENT_GATE — the listing-agreement compliance gate passed (the gated COMING_SOON_PREP hop);
 *   · the MLS_ACTIVE status (`active`)     — live on the MLS: the activation gate behind the launch / activateMLS doors, or
 *                                           the feed-verified event (lib/listings/mls-live-verification.ts).
 * app/actions/listings-kernel.ts updateListingStatus refuses these (the board's status picker could set `active` with
 * nothing checked — the two senses of "active" re-merged through a dropdown).
 */
export const GATED_LISTING_STATUSES: readonly ListingStatus[] = [
  STATUS_AT_LISTING_AGREEMENT_SIGNED,
  STATUS_AFTER_LISTING_AGREEMENT_GATE,
  STATUS_FOR_STAGE.MLS_ACTIVE,
]

/** PURE. May a person set this status by hand (a picker), or does only a gated door reach it? */
export function isManuallySettableListingStatus(status: string | null | undefined): boolean {
  return (LISTING_STATUSES as readonly string[]).includes(String(status)) && !(GATED_LISTING_STATUSES as readonly string[]).includes(String(status))
}

/**
 * C12 `publiclyVisibleListingStatuses` — the ONE public sense of listings.status: the statuses an ANONYMOUS visitor may
 * see on any public surface (the listing page, the agent profile, the tenant site, the team page, the sitemap, llms.txt,
 * the QR landing, the video landing, the IDX property page). A surface may NARROW it (the storefront shows `active`
 * only); none may widen it. Every public read ALSO filters `deleted_at IS NULL` — an archived listing is never public.
 *
 * MERGED (§6): two spellings existed and disagreed on `sold` — app/listings/[listingId]/page.tsx PUBLIC_LISTING_STATUSES
 * (with `sold`) and app/actions/idx-search.ts PUBLICLY_MARKETED_STATUSES (without). The survivor keeps `sold`: a sold
 * listing is history the listing brokerage may show ("sold" is the record's own outcome, not an archive), and the QR on a
 * yard sign must not 404 the day the house sells. Both now read this list.
 * `coming_soon` is in it; WHETHER this MLS permits public Coming Soon marketing, and whether the street may print, are
 * decided where they always were (lib/compliance/coming-soon-policy.ts, lib/marketing/listing-public-address.ts).
 */
export const PUBLICLY_VISIBLE_LISTING_STATUSES = ["coming_soon", "active", "pending", "sold"] as const satisfies readonly ListingStatus[]
/** @proofSeam the named complement of PUBLICLY_VISIBLE_LISTING_STATUSES — scripts/listing-lifecycle-guard.ts asserts the two partition the live listings_status_check EXACTLY (a status added to the CHECK cannot land in neither bucket and read as handled). */
export const NOT_PUBLICLY_VISIBLE_LISTING_STATUSES = ["draft", "listing_signed", "withdrawn", "cancelled", "off_market", "expired"] as const satisfies readonly ListingStatus[]

/** PURE. A fresh array for a `.in("status", …)` filter (the readonly constant is never handed to a mutable API). */
export function publiclyVisibleListingStatuses(): ListingStatus[] {
  return [...PUBLICLY_VISIBLE_LISTING_STATUSES]
}

/**
 * C12 DISCREPANCIES — what the responsible manager (listing_concierge) is told, each with the evidence behind it. PURE; the
 * publisher is lib/listings/mls-live-verification.ts reconcileListingLifecycle. An ARCHIVED listing raises nothing (it is
 * a record, not a working listing), and an UNKNOWN agreement read accuses nothing ("unknown is not failure", CLAUDE.md §4).
 *   coming_soon_without_executed_agreement — Coming Soon with no execution date to start from (the ruling's anchor is gone);
 *   live_on_mls_not_active                 — the feed VERIFIED the listing live, the OS still says pre-active (ruling 10:
 *                                            "once the listing is live on mls, the listing becomes active not coming soon");
 *   planned_live_date_passed_unverified    — the seller-agreed / planned day has passed and no feed shows it live (the plan
 *                                            is PRESERVED — the date never flips the status; a person must look);
 *   verified_live_differs_from_agreed_date — the verified live day is not the day the executed agreement states;
 *   coming_soon_beyond_mls_limit           — counted from the EXECUTION day, the window passed the MLS's attested limit.
 */
export type ListingLifecycleFindingCode =
  | "coming_soon_without_executed_agreement"
  | "live_on_mls_not_active"
  | "planned_live_date_passed_unverified"
  | "verified_live_differs_from_agreed_date"
  | "coming_soon_beyond_mls_limit"
export interface ListingLifecycleFinding { code: ListingLifecycleFindingCode; message: string; evidence: Record<string, unknown> }

export function listingLifecycleFindings(f: {
  status: string | null
  deletedAt?: string | null
  window: ComingSoonWindow
  /** false when the agreement read was REFUSED — nothing about the agreement is asserted then. */
  agreementKnown: boolean
  /** The seller-agreed MLS live day the executed agreement (or an amendment) states, yyyy-mm-dd. */
  agreedMlsLiveDate: string | null
  /** The MLS's attested Coming Soon limit in days (lib/compliance/coming-soon-policy.ts), null when none is attested. */
  mlsMaxComingSoonDays?: number | null
  /** Today in the listing's market zone, yyyy-mm-dd. */
  today: string
}): ListingLifecycleFinding[] {
  if (f.deletedAt) return []
  const out: ListingLifecycleFinding[] = []
  const w = f.window
  const preActive = f.status === STATUS_AT_LISTING_AGREEMENT_SIGNED || f.status === STATUS_AFTER_LISTING_AGREEMENT_GATE
  if (f.status === STATUS_AFTER_LISTING_AGREEMENT_GATE && f.agreementKnown && w.startBasis === "unknown") {
    out.push({ code: "coming_soon_without_executed_agreement", message: "This listing reads Coming Soon, but no executed listing agreement dates it — Coming Soon starts on the day the agreement was executed, so that agreement must be on file.", evidence: { status: f.status } })
  }
  if (w.verifiedLive && preActive) {
    out.push({ code: "live_on_mls_not_active", message: `The MLS feed verified this listing live on ${w.verifiedLive}, but it still reads ${f.status} — once it is live on the MLS it is Active, not Coming Soon.`, evidence: { status: f.status, verified_live: w.verifiedLive } })
  }
  if (f.status === STATUS_AFTER_LISTING_AGREEMENT_GATE && w.plannedLive && !w.verifiedLive && w.plannedLive < f.today) {
    out.push({ code: "planned_live_date_passed_unverified", message: `The planned MLS live date (${w.plannedLive}) has passed and no MLS feed shows the listing live — check the MLS entry; the listing stays Coming Soon until the feed verifies it.`, evidence: { planned_live: w.plannedLive, today: f.today } })
  }
  if (w.verifiedLive && f.agreedMlsLiveDate && w.verifiedLive !== f.agreedMlsLiveDate) {
    out.push({ code: "verified_live_differs_from_agreed_date", message: `The listing went live on the MLS on ${w.verifiedLive}; the executed agreement states ${f.agreedMlsLiveDate}.`, evidence: { verified_live: w.verifiedLive, agreed: f.agreedMlsLiveDate } })
  }
  if (f.status === STATUS_AFTER_LISTING_AGREEMENT_GATE && w.open && w.days !== null && typeof f.mlsMaxComingSoonDays === "number" && w.days > f.mlsMaxComingSoonDays) {
    out.push({ code: "coming_soon_beyond_mls_limit", message: `Coming Soon since ${w.start} (the execution day) is ${w.days} days — past this MLS's attested ${f.mlsMaxComingSoonDays}-day limit.`, evidence: { start: w.start, days: w.days, limit: f.mlsMaxComingSoonDays } })
  }
  return out
}

/** PURE. May an anonymous visitor see this listing row? A public status AND not archived — both, always. The row form of
 *  the predicate (the authorized lifecycle page tells the agent "Public pages: shown / hidden"); SQL readers spell the same
 *  rule as `.in("status", publiclyVisibleListingStatuses()).is("deleted_at", null)`. */
export function isListingPubliclyVisible(row: { status?: string | null; deleted_at?: string | null } | null | undefined): boolean {
  if (!row) return false
  return !row.deleted_at && (PUBLICLY_VISIBLE_LISTING_STATUSES as readonly string[]).includes(String(row.status))
}

/** PURE. Every lifecycle_stage this module maps at all, gated or not — so a guard can enumerate the
 *  map without reaching into module internals or re-typing it (a re-typed list is a second
 *  vocabulary, §6). */
/** @proofSeam guard-consumed by design (see doc above) — scripts/listing-status-sync-simulator.ts and scripts/listing-status-two-senses-guard.ts (guard chain) */
export function mappedStages(): { stage: string; status: ListingStatus; gate: keyof ListingStatusGate | null }[] {
  return [
    ...Object.entries(STATUS_FOR_STAGE).map(([stage, status]) => ({ stage, status, gate: null })),
    ...Object.entries(STATUS_FOR_GATED_STAGE).map(([stage, g]) => ({ stage, status: g.status, gate: g.gate })),
  ]
}
