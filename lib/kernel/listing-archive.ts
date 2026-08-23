// lib/kernel/listing-archive.ts
// ─────────────────────────────────────────────────────────────────────────────
// A LISTING IS RETAINED, NEVER DESTROYED.
//
// ── THE RULING THAT REVERSED THE PREVIOUS WAVE ──────────────────────────────
//
//     "listing shouldn't be deleted because of rules of needing to keep real
//      estate records."
//
// The previous wave built a child-safe HARD DELETE for listings and proved it
// worked. It worked, and it was the wrong thing: a listing is a real-estate
// record with a statutory retention window, and destroying the row is not a
// remedy for "the broker wants it off their board". This file is that wave's
// knowledge, kept, with the destruction taken out.
//
// TOMBSTONE — `deleteListingWithChildren` (was lib/kernel/listing-delete.ts) is
// GONE. Its survivor is `archiveListing`, below. Its 63-key manifest is NOT gone:
// it survives as `LISTING_CHILD_RULES` in this file, repurposed from a
// destruction plan into a RETENTION LEDGER — see the next section, which is the
// whole reason the manifest was worth keeping.
//
// TOMBSTONE — the ENGINE `lib/kernel/child-safe-delete.ts` is NOT retired and is
// NOT changed. It still serves `lib/kernel/tenant-creation-rollback.ts`, which is
// a genuine hard delete (a half-built tenant created seconds ago, with no
// records to retain) and is untouched by this ruling. It simply no longer has a
// second caller. `scripts/listing-archive-simulator.ts` section 4 keeps proving
// the rollback works, because an engine whose only proof lived in the caller
// that just walked away is an engine nobody is watching.
//
// ══ WHY THE 63-KEY MANIFEST SURVIVED THE REVERSAL ═══════════════════════════
//
// The manifest was built by measuring, live, what every one of the 63 foreign
// keys onto `listings` would do if the row were deleted. Read backwards it says
// something an archive needs to be able to say out loud:
//
//   disposition   what a HARD DELETE did          what ARCHIVE does
//   ───────────   ──────────────────────────────  ────────────────────────────
//   remove (11)   DESTROYED the row               retains it, untouched
//   cascade (16)  DESTROYED it via ON DELETE      retains it — CASCADE never fires
//   detach (15)   kept the row, NULLED its        retains it AND its listing_id;
//                 listing pointer                 SET NULL never fires
//   block  (20)   REFUSED the whole operation     nothing to refuse — see below
//
// So the ledger is the measurement behind the sentence "archive destroys
// nothing": 42 of the 62 keys name rows a delete would have destroyed or
// unlinked, and an archive touches none of them. `archiveListing` COUNTS them
// and reports the total, because "nothing was destroyed" asserted without a
// number is the same shape as "the database will handle it".
//
// ── THE `block` SET IS NOT THE ARCHIVE'S BLOCKER SET ────────────────────────
//
// This is the part that would be easy to get wrong by carrying the old rule
// forward unexamined. The 20 `block` tables refused a DELETE because the delete
// would have destroyed somebody else's record — a seller's signed listing
// agreement, a contact's saved-properties row, a CMA report already delivered.
// An ARCHIVE destroys none of those and does not even unlink them: they keep
// pointing at a listing row that is still there and still readable by id. There
// is nothing left to refuse. Carrying the 20 across would produce an archive
// that refuses almost every real listing (every listing with a task, or a
// saved-properties row, or one CMA) while offering no alternative at all —
// strictly worse than the delete it replaced.
//
// What an archive CAN break is a WORKFLOW, not a record. Taking a listing off
// the working surface while a deal is in flight strands the deal desk. That, and
// only that, is `LISTING_ARCHIVE_BLOCKERS`.
//
// ── WHY `deleted_at` AND NOT `status` ───────────────────────────────────────
//
// Both columns exist live on `public.listings` (verified on hrvaqgvukzxfskkcrwbt,
// 2026-08-23: `deleted_at timestamp without time zone NULL`, no default, 0 of 3
// rows populated; `status text NULL`). `deleted_at` carries the archive. `status`
// is not touched. Three measured reasons, in order of how badly `status` fails:
//
//  1. THE LIVE CHECK REFUSES IT. `listings_status_check` admits exactly ten
//     values — draft, listing_signed, coming_soon, active, pending, withdrawn,
//     cancelled, off_market, expired, sold. `archived` is not among them.
//
//     NOT REASONED — PROBED, against hrvaqgvukzxfskkcrwbt on 2026-08-23, inside
//     an exception block that put every value straight back:
//
//       status='archived'  → REFUSED 23514 "new row for relation \"listings\"
//                            violates check constraint \"listings_status_check\""
//       CONTROL, the same UPDATE with a value the CHECK admits
//                          → ACCEPTED — so the probe CAN write this column and
//                            the refusal is the constraint, not a broken probe
//       deleted_at=now()   → ACCEPTED, then restored to NULL
//       final status       → unchanged
//
//     An archive whose write the database rejects is not an archive.
//
//  2. IT WOULD DESTROY THE FACT RETENTION EXISTS TO KEEP. `status` IS the
//     real-estate record's own field — whether the property SOLD, was WITHDRAWN,
//     EXPIRED. Overwriting it to say "archived" erases the outcome of the
//     transaction while claiming to preserve the record. The ruling asks for the
//     record to survive; `status` is a large part of what "the record" means.
//     After an archive a sold listing still reads `sold`, and commission,
//     transaction-history and compliance readers still see what they saw.
//
//  3. IT WOULD SILENTLY REDEFINE EVERY EXISTING READER. `status` is filtered by
//     more than a hundred call sites as a MARKET state (`.eq("status","active")`,
//     `.in("status",["active","coming_soon","pending"])`). An eleventh value
//     meaning "not a market state at all" changes what every one of those
//     queries means without editing any of them — CLAUDE.md §6's defect exactly.
//
// `deleted_at` is also already this repository's ONE spelling of soft-delete
// (§6). The survivor pattern is `archiveContactRecord` at lib/kernel/crm.ts:936:
// `.update({ deleted_at: now, updated_at: now })`, guarded `.is("deleted_at",
// null)` so a second archive is a no-op rather than a lie, and `.select()`ed so
// a zero-row update cannot report success. Three further writers spell it the
// same way — lib/services/transaction-management.service.ts:229,
// lib/services/contact-management.service.ts:269, app/actions/data-health.ts:405.
// This file follows that pattern rather than inventing a fourth.
//
// ── THE READER EVIDENCE, WHICH IS WHAT MAKES IT NOT A NO-OP ─────────────────
//
// Measured over lib/ + app/ + scripts/ on 2026-08-23: 511 `.from("listings")`
// call sites, of which 23 name `deleted_at` in their query chain. The shape of
// those 23 is the finding, not the count:
//
//   EVERY ONE is a working-surface reader — search (idx-alert-search,
//   idx-search, buyer-offers address lookup, showing-request), inventory
//   (reception-inventory, twilio-voice), lists and counts (board-packet,
//   reverse-prospecting, deliberation, critical-setup, video-plays,
//   social-carousel, listing-brochure, jobs page, agent-assistant tool-call),
//   and the PUBLIC surfaces (llms.txt, sitemap, /site/[slug], /team/[slug]).
//
//   NOT ONE is a by-id record lookup. Every `.eq("id", listingId).maybeSingle()`
//   that resolves a listing for a transaction, an offer, a commission, a
//   document or a compliance read is in the other 488 and stays there.
//
// So `deleted_at` already means, in this tree, exactly "hide from the working
// surface, keep for the record". The archive extends that meaning; it does not
// introduce it. Two canonical surfaces were MISSING the filter and would have
// made this archive a no-op — both are fixed in this wave and are pinned by the
// simulator, because a filter that can be deleted without any test going red is
// the half of a soft-delete that rots:
//
//   lib/application/listings.ts        getListingsService — the /listings list
//   app/dashboard/listings/page.tsx    the agent's listings board
//
// DELIBERATELY NOT FILTERED, and this is a ruling not an omission:
// `app/listings/[listingId]/page.tsx` and every by-id resolver. An archived
// listing must still open by id — that is the retention surface, the audit
// surface, and the only way back through `unarchiveListing`. A soft-delete that
// makes the record unreachable has destroyed it in every sense that matters.
//
// ── KNOWN, STATED BLIND SPOTS ───────────────────────────────────────────────
//
// · The 488 unfiltered call sites are NOT all correct-by-construction. They were
//   classified by inspection of the 23 that filter, not by auditing all 511. A
//   list-shaped reader among the 488 will keep showing archived listings until
//   somebody adds the filter. What is proved here is that the two canonical
//   surfaces filter and that the record surfaces do not; the long tail is
//   unresolved and is written down rather than counted as clean.
// · RLS is not involved. `deleted_at` is a column, not a policy, so a direct
//   PostgREST caller with a valid session still sees archived rows. That is the
//   same posture every other soft-delete in this tree has.
// · The retention census is a row COUNT per child table. It proves the rows are
//   still there; it does not diff their contents.

import type { ChildRule } from "./child-safe-delete"
import { isTransactionLive } from "../enrichment/deal-vocabulary"
import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/**
 * THE RETENTION LEDGER — every foreign key that points at `listings`, with the
 * disposition a HARD DELETE would have applied to it.
 *
 * It is no longer executed. Nothing in this file deletes, nulls or cascades
 * anything. The ledger is kept for three jobs a soft-delete still needs done:
 *
 *   1. It is the denominator for the retention claim. `archiveListing` counts
 *      the `remove` + `cascade` + `detach` tables and reports how many rows
 *      survived that a delete would have destroyed or unlinked.
 *   2. It is the drift alarm. `scripts/listing-archive-simulator.ts` checks it
 *      against `SCHEMA_FK_MAP` (generated from the live database) in BOTH
 *      directions, so a child table added later fails the check rather than
 *      quietly falling outside the ledger, and a table removed from the schema
 *      cannot linger here as a phantom.
 *   3. It records, dated and per key, what the live ON DELETE rules actually are
 *      — knowledge that took a live pg_constraint sweep to obtain and that the
 *      next person to touch listing deletion would otherwise have to re-derive.
 *
 * MEASURED LIVE on hrvaqgvukzxfskkcrwbt, 2026-08-23, AFTER m542:
 *
 *   pg_constraint, contype='f', confrelid = public.listings   →  62 keys
 *     NO ACTION (a)   31        CASCADE (c)   16        SET NULL (n)   15
 *
 * It read 63 / 31 / 16 / 16 before m542 dropped `open_houses.property_id`.
 */
export const LISTING_CHILD_RULES: readonly ChildRule[] = [
  // ── remove (11): a hard delete DESTROYED these. Archive retains them. ─────
  // Nothing but the listing owns them, which is exactly why they are the
  // listing's own record: its price trail, its stage trail, its media.
  { table: "listing_page_analytics", column: "listing_id", disposition: "remove", why: "page-view rows for this listing only" },
  { table: "showing_analytics", column: "listing_id", disposition: "remove", why: "derived showing counters, no other parent" },
  { table: "listing_metrics", column: "listing_id", disposition: "remove", why: "computed metrics for this listing only" },
  { table: "listing_stage_history", column: "listing_id", disposition: "remove", why: "the listing's own stage trail — a retention record in its own right" },
  { table: "pricing_history", column: "listing_id", disposition: "remove", why: "the listing's own price trail — a retention record in its own right" },
  { table: "price_predictions", column: "listing_id", disposition: "remove", why: "model output about this listing" },
  { table: "price_trend_alerts", column: "listing_id", disposition: "remove", why: "alerts derived from this listing's price" },
  { table: "neighborhood_reports", column: "listing_id", disposition: "remove", why: "report generated for this listing" },
  { table: "property_upgrades", column: "listing_id", disposition: "remove", why: "upgrade list attached to this listing" },
  { table: "listing_packet_jobs", column: "listing_id", disposition: "remove", why: "packet render jobs for this listing" },
  { table: "listing_media", column: "listing_id", disposition: "remove", why: "the listing's own media rows — and their storage blobs, which a delete never cleaned" },

  // ── block (20): a hard delete was REFUSED by these. Archive is not. ───────
  // These are somebody else's record MENTIONING the listing. A delete had to
  // refuse because it would have destroyed them; an archive leaves every one of
  // them intact and still pointing at a live row, so there is nothing to refuse.
  // See LISTING_ARCHIVE_BLOCKERS for what an archive genuinely must refuse.
  { table: "listing_agreements", column: "listing_id", disposition: "block", why: "signed agreement with a seller contact" },
  { table: "tasks", column: "listing_id", disposition: "block", why: "also hangs off contacts / transactions" },
  { table: "saved_properties", column: "listing_id", disposition: "block", why: "a contact's saved list" },
  { table: "showing_requests", column: "listing_id", disposition: "block", why: "contacts, showings, tours" },
  { table: "tour_stops", column: "listing_id", disposition: "block", why: "belongs to a tour" },
  { table: "journey_states", column: "listing_id", disposition: "block", why: "a contact's journey, also keyed to transactions" },
  { table: "buyer_behavior_log", column: "listing_id", disposition: "block", why: "a contact's behaviour trail" },
  { table: "listing_engagement", column: "listing_id", disposition: "block", why: "per-contact engagement" },
  { table: "smart_landing_sessions", column: "listing_id", disposition: "block", why: "a contact's session" },
  { table: "property_alert_results", column: "listing_id", disposition: "block", why: "belongs to a property_alerts row and a contact" },
  { table: "cma_reports", column: "listing_id", disposition: "block", why: "a report delivered to a contact" },
  { table: "ai_comp_scores", column: "listing_id", disposition: "block", why: "belongs to a cma_report / cma_comparable" },
  { table: "comp_risk_flags", column: "listing_id", disposition: "block", why: "belongs to a cma_report" },
  { table: "net_sheet_calculations", column: "listing_id", disposition: "block", why: "seller net sheet held against a contact" },
  { table: "offer_comparison", column: "listing_id", disposition: "block", why: "belongs to offers" },
  { table: "strategy_recommendations", column: "listing_id", disposition: "block", why: "belongs to offers / contacts" },
  { table: "marketing_campaigns", column: "listing_id", disposition: "block", why: "campaign with real spend and its own children" },
  { table: "qr_codes", column: "listing_id", disposition: "block", why: "belongs to a marketing_campaign, printed in the world" },
  { table: "social_posts", column: "listing_id", disposition: "block", why: "published content on a social account" },
  { table: "ai_message_drafts", column: "listing_id", disposition: "block", why: "belongs to a conversation / message thread" },

  // ── detach (15): a hard delete kept the row and NULLED its pointer. ───────
  // Archive keeps the row AND the pointer. This is the sharpest single argument
  // for archive over delete: `transactions.listing_id` is how a closed deal
  // finds the property it closed on, and a delete cleared it.
  { table: "transactions", column: "listing_id", disposition: "detach", why: "a closed deal keeps its listing pointer — commission and transaction history read it" },
  { table: "documents", column: "listing_id", disposition: "detach", why: "owned by brokerage / contact / transaction; disclosures are retention records" },
  { table: "generated_documents", column: "listing_id", disposition: "detach", why: "owned by brokerage / transaction" },
  { table: "vendor_invoices", column: "listing_id", disposition: "detach", why: "owned by a vendor; a bill outlives the listing" },
  { table: "vendor_bookings", column: "listing_id", disposition: "detach", why: "owned by a vendor" },
  { table: "appointments", column: "listing_id", disposition: "detach", why: "owned by agent / contact" },
  // TOMBSTONE — `{ table: "open_houses", column: "listing_id" }` stood here and is
  // GONE, because the TABLE is gone. m543 established `open_house_events` as the
  // survivor on evidence (all 5 satellites FK to it, 61 call sites against 6, 5
  // public/cron routes against 0) and merged 13 columns onto it; m547 then dropped
  // `open_houses` once nothing named it. SURVIVOR: `open_house_events.listing_id`,
  // in the cascade block below — which is the correct disposition for it, not
  // `detach`, because the survivor's FK is ON DELETE CASCADE where the retired
  // table's was SET NULL.
  //
  // ORDERING MATTERED AND IS WHY THIS ENTRY OUTLIVED THE TABLE BY ONE STEP: this
  // manifest checks itself against SCHEMA_FK_MAP, so the entry could only be
  // removed AFTER the drop and the cache regeneration, and the drop could only
  // happen after every reader had moved. Removing it first would have failed the
  // completeness check; dropping first would have made every archive raise
  // "relation does not exist".
  { table: "portal_event_stream", column: "listing_id", disposition: "detach", why: "a contact's portal event trail" },
  { table: "property_feedback", column: "listing_id", disposition: "detach", why: "owned by the contact who gave it" },
  { table: "transparency_updates", column: "listing_id", disposition: "detach", why: "owned by contact / transaction" },
  { table: "workflow_runs", column: "listing_id", disposition: "detach", why: "owned by its workflow chain" },
  { table: "ai_assistant_notes", column: "listing_id", disposition: "detach", why: "owned by brokerage / author" },
  { table: "agent_assistant_sessions", column: "context_listing_id", disposition: "detach", why: "an optional CONTEXT pointer, named as one" },
  { table: "income_gap_recommended_actions", column: "listing_id", disposition: "detach", why: "owned by a gap analysis" },
  { table: "listing_landing_pages", column: "listing_id", disposition: "detach", why: "app/listing/[slug]/page.tsx renders the null case" },
  // TOMBSTONE — `{ table: "open_houses", column: "property_id" }` was the 16th
  // detach entry and is GONE. m542 dropped that column and its foreign key from
  // the live database (APPLIED 2026-08-23 hrvaqgvukzxfskkcrwbt): under the ruling
  // "listings are in house properties and property ids are outside listings", a
  // second FK onto `listings` wearing a property_id's name is the wrong key.
  // SURVIVOR: `open_houses.listing_id`, five entries above — the pointer every
  // reader and writer in the tree already used, and the only one indexed.

  // ── cascade (16): a hard delete DESTROYED these via ON DELETE CASCADE. ────
  // Archive retains them; CASCADE never fires because nothing is deleted.
  { table: "offers", column: "listing_id", disposition: "cascade" },
  { table: "showings", column: "listing_id", disposition: "cascade" },
  { table: "open_house_events", column: "listing_id", disposition: "cascade" },
  { table: "listing_inquiries", column: "listing_id", disposition: "cascade" },
  { table: "listing_health_scores", column: "listing_id", disposition: "cascade" },
  { table: "listing_health_interventions", column: "listing_id", disposition: "cascade" },
  { table: "listing_marketing_content", column: "listing_id", disposition: "cascade" },
  { table: "listing_price_changes", column: "listing_id", disposition: "cascade" },
  { table: "listing_promo_videos", column: "listing_id", disposition: "cascade" },
  { table: "ai_video_projects", column: "listing_id", disposition: "cascade" },
  { table: "closing_gifts", column: "listing_id", disposition: "cascade" },
  { table: "neighbor_notification_campaigns", column: "listing_id", disposition: "cascade" },
  { table: "property_interactions", column: "listing_id", disposition: "cascade" },
  { table: "seller_share_feed", column: "listing_id", disposition: "cascade" },
  { table: "seller_updates", column: "listing_id", disposition: "cascade" },
  { table: "seller_weekly_reports", column: "listing_id", disposition: "cascade" },
]

/**
 * The tables whose rows a HARD DELETE would have destroyed or unlinked, and
 * which an archive keeps intact. This is the retention claim's denominator.
 *
 * `block` is excluded because a delete never got as far as touching those rows —
 * it refused. Counting them here would inflate the retention number with rows
 * that were never at risk.
 */
export const LISTING_RETAINED_TABLES: readonly ChildRule[] = LISTING_CHILD_RULES.filter(
  (r) => r.disposition !== "block",
)

/**
 * WHAT AN ARCHIVE MUST STILL REFUSE.
 *
 * Not "what would be destroyed" — nothing is destroyed. This is "what workflow
 * would be stranded by the listing leaving the working surface".
 *
 * Exactly one entry, and the narrowness is deliberate. A live transaction means
 * a deal is in flight: people are scheduling inspections against this property,
 * the closing coordinator's board reads it, and removing it from the listing
 * surface mid-deal breaks a process rather than protecting a record. Close,
 * cancel or lose the transaction first, and the archive goes through.
 *
 * LIVENESS IS NOT RE-SPELLED HERE. `isTransactionLive` in
 * lib/enrichment/deal-vocabulary.ts is the one authority (CLAUDE.md §6) and its
 * partition is verified against the live `transactions_status_check`, re-verified
 * on 2026-08-23: lead, qualifying, active, under_contract, pending,
 * clear_to_close, closed, funded, lost, archived — exactly the ten values that
 * module partitions into BEFORE / ACTIVE / AFTER. A second definition of "is
 * this deal live" is the defect §6 names, and negating a TERMINAL list is the
 * specific bug that module's header was written about.
 *
 * OFFERS WERE CONSIDERED AND DELIBERATELY EXCLUDED. An open offer is a plausible
 * second blocker, but `public.offers` carries NO status CHECK constraint (live,
 * 2026-08-23 — it has `offers_ai_extraction_status_check` and
 * `offers_esign_status_check`, and nothing on `status`). There is therefore no
 * database-verified vocabulary for "open offer", and writing a literal list here
 * would be inventing a second spelling with nothing holding it to the data —
 * precisely what deal-vocabulary.ts exists to prevent. An offer that matters is
 * an offer being worked, and an offer being worked has a transaction. Written
 * down rather than guessed at.
 */
export interface ArchiveBlocker {
  readonly table: string
  readonly column: string
  /** Columns to read so `isLive` can judge each row. */
  readonly readColumns: string
  /** True when this row would be stranded by the archive. */
  readonly isLive: (row: Record<string, any>) => boolean
  readonly why: string
}

export const LISTING_ARCHIVE_BLOCKERS: readonly ArchiveBlocker[] = [
  {
    table: "transactions",
    column: "listing_id",
    readColumns: "id, status, stage",
    isLive: (r) => isTransactionLive({ status: r.status, stage: r.stage }),
    why: "a deal is in flight on this property; archiving it strands the closing desk",
  },
]

export interface ListingArchiveOutcome {
  /** True only when the listing row is now marked archived. */
  ok: boolean
  /** Machine-readable reason for `ok: false`. Null on success. */
  reason:
    | "no-listing-id"
    | "no-tenant"
    | "blocked"
    | "blocker-census-failed"
    | "not-found-or-already-archived"
    | "update-refused"
    | null
  /** Blocking table → the count of LIVE rows that refused the archive. */
  blocked: Record<string, number>
  /** Blocker censuses that could not RUN. Any entry here is fatal (§4). */
  censusFailures: string[]
  /**
   * Child table → rows RETAINED that a hard delete would have destroyed
   * (`remove`/`cascade`) or unlinked (`detach`). Empty when the census was
   * skipped or could not run; `retainedTotal` says which.
   */
  retained: Record<string, number>
  /** Sum of `retained`. */
  retainedTotal: number
  /**
   * Retention-census reads that failed. NOT fatal, and the asymmetry with
   * `censusFailures` is the point: a blocker census that cannot run must refuse
   * because it gates a change; a retention census that cannot run only means the
   * archive cannot SAY how much it kept, and nothing is at risk either way.
   */
  retentionCensusFailures: string[]
  /** The archived row's own status, read back. Proof the record was not rewritten. */
  statusAfter: string | null
  /** ISO timestamp written to `deleted_at`. Null when nothing was archived. */
  archivedAt: string | null
  /** The update's own error message, verbatim. Null when it succeeded. */
  updateError: string | null
}

function emptyOutcome(): ListingArchiveOutcome {
  return {
    ok: false,
    reason: null,
    blocked: {},
    censusFailures: [],
    retained: {},
    retainedTotal: 0,
    retentionCensusFailures: [],
    statusAfter: null,
    archivedAt: null,
    updateError: null,
  }
}

export interface ListingArchiveResult {
  ok: boolean
  /** Caller-safe sentence when `ok` is false. Null on success. */
  error: string | null
  outcome: ListingArchiveOutcome
}

/**
 * One caller-safe sentence for a failed archive.
 */
export function describeArchiveFailure(out: ListingArchiveOutcome): string | null {
  if (out.ok) return null
  switch (out.reason) {
    case "no-listing-id":
      return "This listing could not be archived: no id was given."
    case "no-tenant":
      return "This listing could not be archived: no workspace was resolved for the request."
    case "blocker-census-failed":
      return (
        `This listing could not be archived because its open deals could not be checked ` +
        `(${out.censusFailures.join("; ")}). Nothing was changed.`
      )
    case "blocked": {
      const parts = Object.entries(out.blocked).map(([t, n]) => `${t} (${n})`)
      return (
        `This listing has a deal still in progress and was not archived: ${parts.join(", ")}. ` +
        `Close, cancel or reassign the deal first. Nothing was deleted — the listing and ` +
        `everything attached to it are unchanged.`
      )
    }
    case "not-found-or-already-archived":
      // Deliberately does not distinguish "does not exist" from "not yours" —
      // that difference is an id-enumeration oracle across tenants. Same reason
      // as lib/kernel/crm.ts:977.
      return "Listing not found, already archived, or not yours to archive."
    case "update-refused":
      return `This listing could not be archived (${out.updateError}).`
    default:
      return "This listing could not be archived."
  }
}

/**
 * Take a listing off the working surface WITHOUT destroying it.
 *
 * TENANCY: `brokerageId` is the SESSION's tenant (CLAUDE.md §4) and is applied as
 * a predicate on the update, so even a mistaken id cannot reach another tenant's
 * listing. The caller should still have tied `listingId` to that tenant first;
 * this function takes no view on how it got the id.
 *
 * Never throws: the outcome is in the result.
 *
 * ORDER: refuse on a live deal → count what is being retained → stamp
 * `deleted_at`. The blocker census runs FIRST so a refused archive costs nothing
 * and, more importantly, so the stamp never lands on a listing that was never
 * going to be archived.
 */
export async function archiveListing(
  service: Svc,
  listingId: string,
  brokerageId: string,
  opts?: {
    /**
     * Count the retained child rows. Default true. Costs one head-count per
     * table in LISTING_RETAINED_TABLES (42 after m542). Skip it only where the
     * retention number is not going to be read.
     */
    census?: boolean
  },
): Promise<ListingArchiveResult> {
  const out = emptyOutcome()

  if (!listingId) {
    out.reason = "no-listing-id"
    return { ok: false, error: describeArchiveFailure(out), outcome: out }
  }
  // Fail closed (§4): without a session tenant there is no scope to archive
  // inside, and an unscoped listing write is the IDOR shape this repo has
  // already paid for. Refuse rather than widen.
  if (!brokerageId) {
    out.reason = "no-tenant"
    return { ok: false, error: describeArchiveFailure(out), outcome: out }
  }

  // ── 1. BLOCKERS — fail CLOSED ────────────────────────────────────────────
  // Not head:true. Liveness is a per-row judgement (`isTransactionLive` reads
  // status AND stage), so the rows have to come back. Bounded to 500: a listing
  // with more than 500 transactions is not a case this needs to page through,
  // and any live one among the first 500 refuses anyway.
  for (const b of LISTING_ARCHIVE_BLOCKERS) {
    const { data, error } = await service
      .from(b.table)
      .select(b.readColumns)
      .eq(b.column, listingId)
      .limit(500)

    // supabase-js RESOLVES refusals (§3). A census that errored has NOT proved
    // the table empty, and "nobody checked" must never render as "checked and
    // fine".
    if (error) {
      out.censusFailures.push(`${b.table} (${error.message})`)
      continue
    }
    const live = (data ?? []).filter((r: any) => b.isLive(r))
    if (live.length > 0) out.blocked[b.table] = live.length
  }

  if (out.censusFailures.length > 0) {
    out.reason = "blocker-census-failed"
    return { ok: false, error: describeArchiveFailure(out), outcome: out }
  }
  if (Object.keys(out.blocked).length > 0) {
    out.reason = "blocked"
    return { ok: false, error: describeArchiveFailure(out), outcome: out }
  }

  // ── 2. RETENTION CENSUS — fail OPEN ──────────────────────────────────────
  // This measures what SURVIVES. A failure here cannot endanger anything, so it
  // is recorded and the archive proceeds. Contrast step 1, which gates.
  if (opts?.census !== false) {
    for (const rule of LISTING_RETAINED_TABLES) {
      const { count, error } = await service
        .from(rule.table)
        .select(rule.column, { count: "exact", head: true })
        .eq(rule.column, listingId)

      if (error) {
        out.retentionCensusFailures.push(`${rule.table} (${error.message})`)
        continue
      }
      if (count && count > 0) {
        out.retained[rule.table] = count
        out.retainedTotal += count
      }
    }
  }

  // ── 3. THE STAMP ─────────────────────────────────────────────────────────
  // `.is("deleted_at", null)` so archiving twice matches zero rows and is
  // reported as such rather than as a fresh archive with a new timestamp.
  // `.select()` because a zero-row UPDATE is NOT an error in PostgREST — it
  // resolves, empty, byte-identical to an update that worked (§3). That is the
  // trap that made archiveContactRecord write an audit trail for an archive that
  // never happened; see lib/kernel/crm.ts:960.
  //
  // `status` and `lifecycle_stage` are READ BACK, not written. The record keeps
  // saying what it really was, and the outcome carries the proof.
  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await service
    .from("listings")
    .update({ deleted_at: now, updated_at: now })
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .select("id, status, lifecycle_stage")

  if (updErr) {
    out.updateError = updErr.message
    out.reason = "update-refused"
    return { ok: false, error: describeArchiveFailure(out), outcome: out }
  }
  if (!Array.isArray(updated) || updated.length === 0) {
    out.reason = "not-found-or-already-archived"
    return { ok: false, error: describeArchiveFailure(out), outcome: out }
  }

  out.ok = true
  out.archivedAt = now
  out.statusAfter = (updated[0] as any)?.status ?? null
  return { ok: true, error: null, outcome: out }
}

/**
 * Put an archived listing back on the working surface.
 *
 * THE WAY BACK IS PART OF THE RULING, not a convenience. A record you cannot
 * un-hide has been destroyed as far as the person looking for it is concerned,
 * and "keep real estate records" is not satisfied by a one-way door. The mirror
 * of the archive: `.not("deleted_at","is",null)` so un-archiving a live listing
 * matches nothing instead of silently reporting success, and `.select()`ed for
 * the same §3 reason.
 */
export async function unarchiveListing(
  service: Svc,
  listingId: string,
  brokerageId: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (!listingId) return { ok: false, error: "This listing could not be restored: no id was given." }
  if (!brokerageId) {
    return { ok: false, error: "This listing could not be restored: no workspace was resolved for the request." }
  }

  const now = new Date().toISOString()
  const { data, error } = await service
    .from("listings")
    .update({ deleted_at: null, updated_at: now })
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .not("deleted_at", "is", null)
    .select("id")

  if (error) return { ok: false, error: `This listing could not be restored (${error.message}).` }
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, error: "Listing not found, not archived, or not yours to restore." }
  }
  return { ok: true, error: null }
}
