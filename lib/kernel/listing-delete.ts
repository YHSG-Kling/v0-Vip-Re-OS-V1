// lib/kernel/listing-delete.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHAT DELETING A LISTING IS ALLOWED TO DESTROY.
//
// `app/actions/listings.ts` `deleteListing` was, until this file existed, one
// statement:
//
//     await supabase.from("listings").delete().eq("id", listingId)
//                                             .eq("brokerage_id", auth.brokerageId)
//
// It is a `"use server"` export and therefore a public HTTP endpoint (CLAUDE.md
// §4), reachable whether or not any component calls it — and no component does.
// It was gated correctly and it read its own error. What it could not see was
// the 63 foreign keys pointing at `listings`.
//
// ── MEASURED LIVE on hrvaqgvukzxfskkcrwbt, 2026-08-23 ───────────────────────
//
//   pg_constraint, contype='f', confrelid = public.listings   →  63 keys
//
//     NO ACTION (a)   31    the delete is REFUSED while a child exists
//     CASCADE   (c)   16    the child dies with the listing
//     SET NULL  (n)   16    the child SURVIVES with its listing pointer nulled
//
// So the old statement had two distinct failure modes and told the caller about
// neither in terms it could act on:
//
//   * With any of the 31, PostgreSQL refused with a raw 23503 naming a
//     constraint. `handleError` surfaced that as a foreign-key message. A broker
//     deleting a listing that had merely CHANGED STAGE ONCE — every listing has
//     a `listing_stage_history` row — got an unexplainable failure.
//   * With none of the 31 but some of the 16 SET NULL, the delete SUCCEEDED and
//     16 tables' pointers were silently cleared.
//
// ── THE 16 SET NULL KEYS ARE NOT AN ORPHAN BUG, AND THAT IS A MEASUREMENT ───
//
// The wave that found this defect expected these 16 to become ON DELETE RESTRICT
// alongside the 68 `brokerage_id` keys of m533, on the reasoning that SET NULL
// "erases the child's parentage, leaving a live row that tenant-scoped reads can
// no longer see". That reasoning is exactly right for `brokerage_id`: the tenant
// column IS the reachability, so nulling it strands the row.
//
// It does not transfer to `listing_id`, and the live database says so. Every one
// of the 16 child tables carries `brokerage_id` of its own, and every one is
// read in this codebase by an anchor that is not the listing:
//
//   agent_assistant_sessions  agent_id (5 read sites), conversation_id
//   ai_assistant_notes        brokerage_id (3), created_by (3)
//   appointments              agent_id / contact_id / brokerage_id columns
//   documents                 brokerage_id (37), id (34), contact_id (12),
//                             transaction_id (4) vs listing_id (4)
//   generated_documents       brokerage_id (4), transaction_id (1)
//   income_gap_…_actions      gap_analysis_id (4) — never read by listing
//   listing_landing_pages     slug (2) — see below
//   open_houses               brokerage_id, agent_id
//   portal_event_stream       brokerage_id (4), contact_id (2)
//   property_feedback         contact_id, brokerage_id
//   transactions              id (196), brokerage_id (176), agent_id (62)
//                             vs listing_id (15)
//   transparency_updates      contact_id (7), transaction_id (3)
//   vendor_bookings           brokerage_id (24), vendor_id (17)
//   vendor_invoices           brokerage_id (12), vendor_id (7)
//   workflow_runs             id (16), chain_key (3), brokerage_id (3)
//
// `listing_landing_pages` is the sharpest case, because the product does not
// merely tolerate a null listing_id — it RENDERS it. `app/listing/[slug]/page.tsx`
// branches on `landingPage?.listing_id ? … : …` and its else-branch is commented
// "Standalone generated landing page (no live listing behind it)". Converting
// that key to RESTRICT would forbid a state the page is written to display.
//
// A transaction whose listing was deleted is a deal that still has money in it,
// still belongs to a brokerage and an agent, and is still read 196 times by id.
// Nulling its listing pointer loses a link. RESTRICT would instead refuse — and
// this file's `block` set already refuses, in code, with a sentence a human can
// act on. So the DB-level rule is not the thing standing between a listing and
// its children; the manifest below is. All 16 stay SET NULL, and each is
// declared `detach` here so that "the database handles it" is a stated position
// with a row count attached rather than a blind spot.
//
// ── WHY `block` AND NOT "delete everything" ─────────────────────────────────
//
// The rule applied to the 31 NO ACTION keys is mechanical, not a taste call:
// a child is `remove` only when it has NO foreign key to any table other than
// `listings` / `brokerages` / `users` / `agents` — i.e. nothing but the listing
// owns it. Measured live from pg_constraint; the 11 that pass are derived
// artefacts of the listing itself (its metrics, its stage history, its price
// history, its media). The other 20 all point at a `contacts`, `transactions`,
// `offers`, `cma_reports`, `tours` or `marketing_campaigns` row — they are
// somebody else's record that merely mentions the listing, and a listing delete
// has no business destroying them. Those refuse the delete and say which table.
//
// The practical effect is that a listing with any real history cannot be hard
// deleted, which is what a foreign key spelled NO ACTION has been saying all
// along. What changes is that the refusal now names the table and the count
// instead of quoting a constraint name.
//
// ── KNOWN, STATED BLIND SPOT ────────────────────────────────────────────────
//
// `listing_media` rows are removed; the storage objects they point at are not.
// Blob cleanup is `deleteListingMedia`'s lane (app/actions/listing-media.ts) and
// is not wired here. A deleted draft listing can therefore leave storage bytes.
// That is a smaller and more recoverable failure than the row-level orphaning
// this file exists to close, and it is written down rather than left to be
// rediscovered.

import type { ChildRule, ParentDeletePlan, ParentDeleteOutcome } from "./child-safe-delete"
import { deleteParentWithChildren, describeDeleteFailure } from "./child-safe-delete"
import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/**
 * EVERY foreign key that points at `listings`, with a disposition for each.
 *
 * Completeness is the defence, not a nicety: "child-blind" is exactly the state
 * of having no answer for a child table, and a manifest with a hole reads like a
 * manifest with none. `scripts/listing-delete-simulator.ts` checks this list
 * against `SCHEMA_FK_MAP` (generated from the live database) in BOTH directions,
 * so a child table added later fails the check rather than quietly reopening the
 * hole, and a table removed from the schema cannot linger here as a phantom.
 *
 * The `remove` entries are applied IN THIS ORDER. None of the 11 references any
 * other (verified live), so the order is stable rather than load-bearing —
 * derived analytics first, the listing's own media last.
 */
export const LISTING_CHILD_RULES: readonly ChildRule[] = [
  // ── remove: nothing but the listing owns these (11) ──────────────────────
  { table: "listing_page_analytics", column: "listing_id", disposition: "remove", why: "page-view rows for this listing only" },
  { table: "showing_analytics", column: "listing_id", disposition: "remove", why: "derived showing counters, no other parent" },
  { table: "listing_metrics", column: "listing_id", disposition: "remove", why: "computed metrics for this listing only" },
  { table: "listing_stage_history", column: "listing_id", disposition: "remove", why: "the listing's own stage trail" },
  { table: "pricing_history", column: "listing_id", disposition: "remove", why: "the listing's own price trail" },
  { table: "price_predictions", column: "listing_id", disposition: "remove", why: "model output about this listing" },
  { table: "price_trend_alerts", column: "listing_id", disposition: "remove", why: "alerts derived from this listing's price" },
  { table: "neighborhood_reports", column: "listing_id", disposition: "remove", why: "report generated for this listing" },
  { table: "property_upgrades", column: "listing_id", disposition: "remove", why: "upgrade list attached to this listing" },
  { table: "listing_packet_jobs", column: "listing_id", disposition: "remove", why: "packet render jobs for this listing" },
  { table: "listing_media", column: "listing_id", disposition: "remove", why: "the listing's own media rows (storage blobs NOT cleaned — see header)" },

  // ── block: somebody else's record that mentions the listing (20) ─────────
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

  // ── detach: DB nulls the pointer, the row survives under its own owner (16)
  { table: "transactions", column: "listing_id", disposition: "detach", why: "a deal outlives the listing; read by id/brokerage/agent" },
  { table: "documents", column: "listing_id", disposition: "detach", why: "owned by brokerage / contact / transaction" },
  { table: "generated_documents", column: "listing_id", disposition: "detach", why: "owned by brokerage / transaction" },
  { table: "vendor_invoices", column: "listing_id", disposition: "detach", why: "owned by a vendor; a bill outlives the listing" },
  { table: "vendor_bookings", column: "listing_id", disposition: "detach", why: "owned by a vendor" },
  { table: "appointments", column: "listing_id", disposition: "detach", why: "owned by agent / contact" },
  { table: "open_houses", column: "listing_id", disposition: "detach", why: "owned by agent / brokerage" },
  { table: "open_houses", column: "property_id", disposition: "detach", why: "second listings pointer on the same table" },
  { table: "portal_event_stream", column: "listing_id", disposition: "detach", why: "a contact's portal event trail" },
  { table: "property_feedback", column: "listing_id", disposition: "detach", why: "owned by the contact who gave it" },
  { table: "transparency_updates", column: "listing_id", disposition: "detach", why: "owned by contact / transaction" },
  { table: "workflow_runs", column: "listing_id", disposition: "detach", why: "owned by its workflow chain" },
  { table: "ai_assistant_notes", column: "listing_id", disposition: "detach", why: "owned by brokerage / author" },
  { table: "agent_assistant_sessions", column: "context_listing_id", disposition: "detach", why: "an optional CONTEXT pointer, named as one" },
  { table: "income_gap_recommended_actions", column: "listing_id", disposition: "detach", why: "owned by a gap analysis" },
  { table: "listing_landing_pages", column: "listing_id", disposition: "detach", why: "app/listing/[slug]/page.tsx RENDERS the null case" },

  // ── cascade: the database removes these with the listing (16) ────────────
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

export const LISTING_DELETE_PLAN: ParentDeletePlan = {
  parentTable: "listings",
  parentIdColumn: "id",
  // The parent delete carries the session's `brokerage_id` too, so a delete that
  // matched nothing means the id was not this tenant's. That must not report
  // success after the child rows have already been removed.
  requireParentRowRemoved: true,
  children: LISTING_CHILD_RULES,
}

export interface ListingDeleteResult {
  ok: boolean
  /** Caller-safe sentence when `ok` is false. Null on success. */
  error: string | null
  outcome: ParentDeleteOutcome
}

/**
 * Delete a listing together with the rows that exist only because of it, and
 * refuse when a row belonging to somebody else is attached.
 *
 * TENANCY: `brokerageId` is the SESSION's tenant (CLAUDE.md §4), and the caller
 * must already have confirmed the listing belongs to it. It is applied AGAIN as
 * a predicate on the parent delete, so even a mistaken id cannot cross tenants.
 * The child steps key on `listingId`, which by then is a tenant-verified anchor.
 *
 * Never throws: the outcome is in the result.
 */
export async function deleteListingWithChildren(
  service: Svc,
  listingId: string,
  brokerageId: string,
): Promise<ListingDeleteResult> {
  // Fail closed (§4): without a session tenant there is no scope to delete
  // inside, and an unscoped listing delete is the IDOR shape this repo has
  // already paid for. Refuse rather than widen.
  if (!brokerageId) {
    return {
      ok: false,
      error: "This listing could not be removed: no workspace was resolved for the request.",
      outcome: {
        ok: false, blocked: {}, childrenRemoved: {}, childRefusals: [],
        detached: {}, censusFailures: [], parentError: null, reason: "no-parent-id",
      },
    }
  }

  const outcome = await deleteParentWithChildren(service, LISTING_DELETE_PLAN, listingId, {
    brokerage_id: brokerageId,
  })

  return { ok: outcome.ok, error: describeDeleteFailure(outcome, "listing"), outcome }
}
