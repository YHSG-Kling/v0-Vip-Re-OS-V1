/**
 * Approval Queue Aggregator — single source for the agent's daily review queue.
 *
 * Three approval data sources existed in parallel before this:
 *   1. approval_items table (empty — nothing inserts into it)
 *   2. activities with activity_type='content.approval' (compliance dashboard)
 *   3. per-content tables (newsletter_campaigns.approval_status, etc.)
 *
 * This module unifies #1 + #3 (the #2 path stays on the compliance dashboard
 * for compliance-officer-specific workflows). The agent's /approvals page
 * sees one feed across newsletters, emails, ad creatives, video snippets,
 * and blog drafts.
 *
 * Each row carries a PREFIXED id encoding the source table so the approve/
 * reject endpoints can route the action back to the right column without
 * a schema migration.
 *
 * Prefix legend:
 *   nl:   newsletter_campaigns (approval_status pending / pending_review)
 *   em:   email_campaigns      (approval_status pending)
 *   acv:  ad_creative_variations (approval_status draft — pre-launch review)
 *   vsn:  video_snippets       (approval_status pending)
 *   bp:   blog_posts           (publish_status draft)
 *   pc:   podcast_episodes     (approval_status pending_review — generated
 *         episodes awaiting release before the distributor ships them)
 *   vp:   ai_video_projects    (approval_status pending_review — commissioned
 *         video renders awaiting release before publish/distribution)
 *   of:   offers               (DEAL DECISIONS — NOT marketing content. Only
 *         INBOUND offers received on OUR seller listings (listing_id set,
 *         status pending/submitted, not a counter row) enter the queue; the
 *         full response set is accept / reject / COUNTER. Approve REUSES the
 *         canonical acceptOffer kernel command from /offers, reject reuses
 *         rejectOffer (optional reason), counter reuses issueCounterOffer via
 *         cascadeCounterOffer. Outbound offers — our buyer offering on an
 *         OUTSIDE property (listing_id NULL, property_address set) or our own
 *         counters awaiting the buyer — are the OTHER side's decision and are
 *         never approvable here.)
 *   pa:   property_alerts      (SPOKEN/WRITTEN CRITERIA proposals —
 *         is_active=false, source 'voice_conversation' (calls) or
 *         'text_conversation' (inbound email/SMS), paused_reason
 *         '[VOICE_PROPOSAL]…' / '[TEXT_PROPOSAL]…' carrying the buyer's
 *         literal quotes; approve activates + runs the first search, reject
 *         deletes the proposal. Pinned to is_active=false + these two
 *         sources ONLY — never a live or agent-created alert.)
 *   ai:   approval_items       (legacy table; no prefix when present)
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  BLOG_PENDING_PUBLISH_STATUS,
  NEWSLETTER_PENDING_APPROVAL_STATUSES,
  AD_CREATIVE_PENDING_APPROVAL_STATUSES,
  PODCAST_PENDING_STATUS,
  PODCAST_PENDING_APPROVAL_STATUS,
} from "./approval-pending"

export type ApprovalSource = "newsletter" | "email" | "ad_creative" | "video_snippet" | "blog" | "podcast" | "video" | "offer" | "property_alert" | "legacy"

// ─── Canonical marketing-asset transitions (ONE implementation) ──────────────
// The dedicated /dashboard/admin/marketing-approvals surface and this unified
// queue's cascade both call these — the approve/reject state machine for
// newsletter / blog / podcast / direct-mail / video assets lives HERE, so the
// two surfaces can never drift ("approve" always leaves the asset PUBLISHABLE,
// per the 2026-07 loop audit).

export type MarketingAssetKind = "newsletter" | "blog" | "podcast" | "direct_mail" | "video" | "video_script"

export const MARKETING_TABLE_BY_KIND: Record<MarketingAssetKind, string> = {
  newsletter:   "newsletter_campaigns",
  blog:         "blog_posts",
  podcast:      "podcast_episodes",
  direct_mail:  "direct_mail_campaigns",
  video:        "ai_video_projects",
  video_script: "video_scripts_library",
}

/**
 * Approve (RELEASE) a marketing asset — sets approval_status='approved' and
 * runs the kind-specific cascade so the asset leaves human review PUBLISHABLE:
 *   newsletter — the publish cron only sends status='scheduled' with a
 *     send_date; the stager writes draft/pending with none, so approve-only
 *     stranded every AI newsletter forever.
 *   blog — publishBlogPost keys on publish_status (a separate ladder from
 *     approval_status); approval advances it so the cadence cron can ship.
 *   podcast — the distributor ships approved episodes to publish_channels ∩
 *     enabled channels; the auto-producer stages with NO channels, so default
 *     them to everything the brokerage has enabled.
 * Caller is responsible for auth + tenant/agent scoping.
 */
export async function applyMarketingAssetApproval(
  kind: MarketingAssetKind, id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const table = MARKETING_TABLE_BY_KIND[kind]

  // Some marketing tables (newsletter_campaigns) don't carry updated_at;
  // keep the update minimal to the column we know exists everywhere.
  const { error } = await svc.from(table)
    .update({ approval_status: "approved" })
    .eq("id", id)
  if (error) return { ok: false, error: error.message }

  if (kind === "newsletter") {
    const { data: nl } = await svc.from("newsletter_campaigns")
      .select("status, send_date").eq("id", id).maybeSingle()
    if (nl && (nl.status === "draft" || nl.status === "pending_review")) {
      await svc.from("newsletter_campaigns").update({
        status: "scheduled",
        send_date: nl.send_date ?? new Date().toISOString(),
      }).eq("id", id)
    }
  }
  if (kind === "blog") {
    const { data: bp } = await svc.from("blog_posts")
      .select("publish_status").eq("id", id).maybeSingle()
    if (bp && bp.publish_status === "draft") {
      await svc.from("blog_posts").update({ publish_status: "approved" }).eq("id", id)
    }
  }
  if (kind === "podcast") {
    const { data: ep } = await svc.from("podcast_episodes")
      .select("publish_channels, brokerage_id").eq("id", id).maybeSingle()
    if (ep && (!Array.isArray(ep.publish_channels) || ep.publish_channels.length === 0)) {
      const { data: channels } = await svc.from("podcast_distribution_channels")
        .select("channel_name").eq("brokerage_id", ep.brokerage_id).eq("is_enabled", true)
      const names = ((channels ?? []) as Array<{ channel_name: string }>).map((c) => c.channel_name)
      if (names.length > 0) {
        await svc.from("podcast_episodes").update({ publish_channels: names }).eq("id", id)
      }
    }
  }
  if (kind === "direct_mail") {
    // Direct-mail has TWO terminals, and they key on DIFFERENT status values —
    // so approval must branch on whether the piece has a 1:1 recipient:
    //
    //   • 1:1 RECIPIENT pieces (contact_id or lead_id set — welcome kits,
    //     AI-ISA lead-intro / nurture postcards, listing-appt-prep) are MAILED
    //     by runDirectMailCampaignDrain, whose query REQUIRES status STILL
    //     'planning' (+ approval_status 'approved'). Flipping status to
    //     'approved' here would drop them out of the drain and they'd NEVER
    //     mail. Leave status at 'planning' — the base approval_status='approved'
    //     is exactly what the drain waits for.
    //   • AUDIENCE / BATCH pieces (no recipient link — farm / motivated-seller
    //     print runs) key print-eligibility on the STATUS lifecycle
    //     (planning→approved→printed→mailed), so those must advance to
    //     status='approved' or the campaign never prints.
    const { data: dm } = await svc.from("direct_mail_campaigns")
      .select("contact_id, lead_id").eq("id", id).maybeSingle()
    const isOneToOne = !!(dm && ((dm as { contact_id?: string | null }).contact_id
      || (dm as { lead_id?: string | null }).lead_id))
    if (!isOneToOne) {
      await svc.from("direct_mail_campaigns")
        .update({ status: "approved" })
        .eq("id", id)
        .eq("status", "planning")
    }
  }

  return { ok: true }
}

/**
 * Reject a marketing asset — approval_status='rejected' (+ rejected_reason on
 * tables that have it, with a defensive retry for those that don't). Blog also
 * drops publish_status to 'rejected' so the post leaves BOTH review queues and
 * the publish cron can never ship it.
 */
export async function applyMarketingAssetRejection(
  kind: MarketingAssetKind, id: string, reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const table = MARKETING_TABLE_BY_KIND[kind]

  // rejected_reason exists on direct_mail_campaigns; some tables only have
  // approval_status. Set both defensively — retry without for the rest.
  const { error } = await svc.from(table)
    .update({ approval_status: "rejected", rejected_reason: reason })
    .eq("id", id)
  if (error) {
    const { error: retryErr } = await svc.from(table)
      .update({ approval_status: "rejected" })
      .eq("id", id)
    if (retryErr) return { ok: false, error: retryErr.message }
  }

  if (kind === "blog") {
    await svc.from("blog_posts").update({ publish_status: "rejected" }).eq("id", id)
  }

  return { ok: true }
}

export interface UnifiedApprovalItem {
  /** Prefixed id — nl:<uuid> / em:<uuid> / acv:<uuid> / vsn:<uuid> / bp:<uuid>
   *  or bare uuid for legacy approval_items. */
  id: string
  type: ApprovalSource
  agent_id: string | null
  status: string
  priority: "high" | "medium" | "standard"
  content: string
  created_at: string
  updated_at: string
  /** UI grouping. "deals" = offer responses — DEAL DECISIONS the /approvals
   *  page renders in their own section, never among marketing content.
   *  Unset = the default content/workflow feed. */
  section?: "deals"
  /** Action lanes this item supports. Unset = approve/reject (the default
   *  pair every source has). Offers carry the full negotiation response set:
   *  approve (= accept), reject, counter. */
  actions?: Array<"approve" | "reject" | "counter">
  /** Offer-decision metadata (section='deals' only) — powers the /approvals
   *  counter dialog prefill. */
  deal?: {
    offer_id: string
    offer_price: number | null
    listing_address: string | null
    buyer_name: string | null
    round: number
    response_deadline: string | null
  }
}

const PER_TABLE_LIMIT = 50

export async function aggregatePendingApprovals(
  brokerageId: string,
  agentScopeId: string | null,
): Promise<UnifiedApprovalItem[]> {
  const svc = createServiceClient()

  // newsletter_campaigns.agent_id is agents.id (FK); blog_posts uses
  // agent_user_id (users.id). Filter applied conditionally — when the caller
  // is a broker/admin agentScopeId is null so they see brokerage-wide.
  const [newsletters, emails, adCreatives, videoSnippets, blogs, podcasts, videoProjects, pendingOffers, voiceAlerts, legacy] =
    await Promise.all([
      svc
        .from("newsletter_campaigns")
        .select("id, agent_id, campaign_name, subject_line, status, approval_status, created_at")
        .eq("brokerage_id", brokerageId)
        // 'pending' is the legacy manual value; the AI stager (lib/kernel/
        // marketing.ts) writes 'pending_review' — both are awaiting a human.
        // Shared with the Command Center via approval-pending (no drift).
        .in("approval_status", [...NEWSLETTER_PENDING_APPROVAL_STATUSES])
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("email_campaigns")
        .select("id, agent_id, campaign_name, subject_line, status, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .eq("approval_status", "pending")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("ad_creative_variations")
        .select("id, ad_campaign_id, variation_name, headline, primary_text, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        // Both pre-spend review states — shared with the Command Center (no drift).
        .in("approval_status", [...AD_CREATIVE_PENDING_APPROVAL_STATUSES])
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("video_snippets")
        .select("id, created_by, snippet_title, caption_text, approval_status, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("approval_status", "pending")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("blog_posts")
        .select("id, agent_user_id, title, excerpt, publish_status, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        // Shared with the Command Center via approval-pending (no drift).
        .eq("publish_status", BLOG_PENDING_PUBLISH_STATUS)
        // A dedicated-surface reject only flips approval_status — keep those
        // out so a rejected draft can't linger in this queue. (NULL-safe: a
        // plain NOT IN would also drop manual drafts with no approval_status.)
        .or("approval_status.is.null,approval_status.neq.rejected")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        // Podcast episodes staged for review (lib/kernel/marketing.ts writes
        // approval_status='pending_review'); the distribute-podcast-episodes
        // cron only ships 'approved', so a pending episode cannot reach a feed.
        .from("podcast_episodes")
        .select("id, agent_id, title, description, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        // status=completed (generation done) + approval_status=pending_review
        // (awaiting release) — the same two-column predicate the Command Center
        // and the distributor use (approval-pending, no drift).
        .eq("status", PODCAST_PENDING_STATUS)
        .eq("approval_status", PODCAST_PENDING_APPROVAL_STATUS)
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        // Commissioned VIDEO RENDERS (ai_video_projects) awaiting release —
        // migration 1051 gates AI videos on approval_status='pending_review';
        // publishVideo (lib/kernel/marketing.ts) refuses anything not approved.
        .from("ai_video_projects")
        .select("id, agent_id, title, video_type, audience_type, video_provider, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .eq("approval_status", "pending_review")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        // INBOUND OFFERS awaiting OUR side's decision (accept / reject /
        // counter) — DEAL DECISIONS, kept apart from the marketing feed.
        // Direction key (round-34 study of the offer rails):
        //   INSIDE  = offer received ON OUR SELLER LISTING → listing_id IS
        //             SET. The intake rails (app/api/offers/upload + lib/
        //             inbound-mail/offer-intake.ts) insert these with
        //             status='submitted' (also the column default); 'pending'
        //             is the legacy/manual value. Our seller side responds —
        //             these are the queue's approvables.
        //   OUTSIDE = our buyer's offer on an EXTERNAL property → listing_id
        //             NULL, property identified by property_address
        //             (app/actions/buyer-offers.ts never fabricates a listing
        //             for an external target). The OTHER side responds — we
        //             WAIT (recordSellerResponse records their answer), so
        //             outside rows must never appear approvable.
        // Exclusions (either would be a dishonest approvable):
        //   - offer_type='counter': every counter row is issued by OUR side
        //     (kernel issueCounterOffer / seller sendCounterOffer) and awaits
        //     the BUYER's response. Null-safe or-filter (offer_type nullable).
        //   - esign_status='sent': an in-house buyer offer on our own listing
        //     mid-signature — status-sync maps buyer.offer.signature.requested
        //     → status='submitted', but it awaits the buyer's SIGNATURE, not
        //     a seller decision.
        .from("offers")
        .select("id, agent_id, contact_id, listing_id, offer_price, status, offer_type, current_round, response_deadline, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .in("status", ["pending", "submitted"])
        .not("listing_id", "is", null)
        .or("offer_type.is.null,offer_type.neq.counter")
        .or("esign_status.is.null,esign_status.neq.sent")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        // SPOKEN + WRITTEN CRITERIA proposals — inactive conversation-sourced
        // alerts ('voice_conversation' from the call sweep, 'text_conversation'
        // from inbound email/SMS) still carrying their proposal marker
        // (approval clears it, so an approved-then-paused alert can never
        // re-enter the queue).
        .from("property_alerts")
        .select("id, contact_id, agent_user_id, alert_name, paused_reason, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .eq("is_active", false)
        .in("source", ["voice_conversation", "text_conversation"])
        .or("paused_reason.ilike.[VOICE_PROPOSAL]%,paused_reason.ilike.[TEXT_PROPOSAL]%")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("approval_items")
        .select("id, agent_id, item_type, item_id, status, submitted_at, reviewed_at")
        .eq("brokerage_id", brokerageId)
        .eq("status", "pending")
        .order("submitted_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
    ])

  const items: UnifiedApprovalItem[] = []

  for (const row of (newsletters.data ?? []) as Array<Record<string, unknown>>) {
    if (agentScopeId && row.agent_id && row.agent_id !== agentScopeId) continue
    items.push({
      id: `nl:${String(row.id)}`,
      type: "newsletter",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.approval_status ?? "pending"),
      priority: "standard",
      content: `${String(row.campaign_name ?? "(untitled)")} — ${String(row.subject_line ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (emails.data ?? []) as Array<Record<string, unknown>>) {
    if (agentScopeId && row.agent_id && row.agent_id !== agentScopeId) continue
    items.push({
      id: `em:${String(row.id)}`,
      type: "email",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.approval_status ?? "pending"),
      priority: "standard",
      content: `${String(row.campaign_name ?? "(untitled)")} — ${String(row.subject_line ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (adCreatives.data ?? []) as Array<Record<string, unknown>>) {
    items.push({
      id: `acv:${String(row.id)}`,
      type: "ad_creative",
      agent_id: null, // ad creatives are scoped via ad_campaigns; future: join + check
      status: String(row.approval_status ?? "draft"),
      priority: "medium",
      content: `${String(row.variation_name ?? "(unnamed)")} — ${String(row.headline ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (videoSnippets.data ?? []) as Array<Record<string, unknown>>) {
    // video_snippets uses created_by (users.id) — separate scope key.
    // No agent_id, snippet_title (not title), caption_text (not caption),
    // no updated_at column.
    if (agentScopeId && row.created_by && row.created_by !== agentScopeId) continue
    items.push({
      id: `vsn:${String(row.id)}`,
      type: "video_snippet",
      agent_id: (row.created_by as string | null) ?? null,
      status: String(row.approval_status ?? "pending"),
      priority: "standard",
      content: `${String(row.snippet_title ?? "(snippet)")} — ${String(row.caption_text ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (blogs.data ?? []) as Array<Record<string, unknown>>) {
    // blog uses agent_user_id (users.id) — separate scope key
    items.push({
      id: `bp:${String(row.id)}`,
      type: "blog",
      agent_id: (row.agent_user_id as string | null) ?? null,
      status: String(row.publish_status ?? "draft"),
      priority: "standard",
      content: `${String(row.title ?? "(untitled)")} — ${String(row.excerpt ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (podcasts.data ?? []) as Array<Record<string, unknown>>) {
    // podcast_episodes.agent_id FKs users.id while the agent scope key is
    // agents.id — same id-class mismatch as blog_posts, so these list
    // brokerage-wide (like blogs).
    items.push({
      id: `pc:${String(row.id)}`,
      type: "podcast",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.approval_status ?? "pending_review"),
      priority: "standard",
      content: `${String(row.title ?? "(untitled episode)")} — ${String(row.description ?? "")}`.trim().replace(/—\s*$/, "").trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (videoProjects.data ?? []) as Array<Record<string, unknown>>) {
    // ai_video_projects.agent_id IS agents.id (kernel commissionVideo writes
    // ctx.agentId) — the newsletter scope key applies.
    if (agentScopeId && row.agent_id && row.agent_id !== agentScopeId) continue
    const facets = [row.video_type, row.audience_type === "customer_facing" ? "customer-facing" : row.audience_type, row.video_provider]
      .filter(Boolean).join(" · ")
    items.push({
      id: `vp:${String(row.id)}`,
      type: "video",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.approval_status ?? "pending_review"),
      priority: "medium",
      content: `${String(row.title ?? "(untitled video)")}${facets ? ` — ${facets}` : ""}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  // Received offers — enrich with buyer name + listing address (same light
  // lookup idiom the alert proposals below use).
  const offerRows = ((pendingOffers.data ?? []) as Array<Record<string, unknown>>)
    // offers.agent_id is agents.id — same scope key as newsletters.
    .filter((row) => !(agentScopeId && row.agent_id && row.agent_id !== agentScopeId))
  const offerContactNames = new Map<string, string>()
  const offerListingAddresses = new Map<string, string>()
  if (offerRows.length > 0) {
    const contactIds = [...new Set(offerRows.map((r) => r.contact_id).filter(Boolean))] as string[]
    const listingIds = [...new Set(offerRows.map((r) => r.listing_id).filter(Boolean))] as string[]
    const [{ data: offerContacts }, { data: offerListings }] = await Promise.all([
      contactIds.length > 0
        ? svc.from("contacts").select("id, first_name, last_name").in("id", contactIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      listingIds.length > 0
        ? svc.from("listings").select("id, address, city").in("id", listingIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ])
    for (const c of (offerContacts ?? []) as Array<Record<string, unknown>>) {
      const name = `${String(c.first_name ?? "").trim()} ${String(c.last_name ?? "").trim()}`.trim()
      if (name) offerContactNames.set(String(c.id), name)
    }
    for (const l of (offerListings ?? []) as Array<Record<string, unknown>>) {
      const addr = [l.address, l.city].filter(Boolean).join(", ")
      if (addr) offerListingAddresses.set(String(l.id), addr)
    }
  }
  for (const row of offerRows) {
    const buyerName = offerContactNames.get(String(row.contact_id)) ?? null
    const who = buyerName ?? "a buyer"
    const addr = offerListingAddresses.get(String(row.listing_id)) ?? null
    const price = typeof row.offer_price === "number" && row.offer_price > 0
      ? `$${Number(row.offer_price).toLocaleString()}`
      : null
    const round = typeof row.current_round === "number" && row.current_round > 0
      ? row.current_round
      : 1
    items.push({
      id: `of:${String(row.id)}`,
      type: "offer",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.status ?? "submitted"),
      priority: "high", // a live offer is deal-critical — jumps the queue
      section: "deals", // deal decision — the UI renders these apart from marketing
      actions: ["approve", "reject", "counter"],
      deal: {
        offer_id: String(row.id),
        offer_price: typeof row.offer_price === "number" && row.offer_price > 0 ? Number(row.offer_price) : null,
        listing_address: addr,
        buyer_name: buyerName,
        round,
        response_deadline: (row.response_deadline as string | null) ?? null,
      },
      content: `Offer from ${who}${addr ? ` on ${addr}` : ""}${price ? ` — ${price}` : ""}${round > 1 ? ` (round ${round})` : ""}. Accept = under contract (competing open offers on the listing are declined); counter = send new terms; reject = decline with optional reason.`,
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  // SPOKEN/WRITTEN CRITERIA → LIVING ALERT proposals. The card leads with
  // the buyer's literal quotes ("They said: …" / "They wrote: …") so the
  // agent approves what was actually SAID — the fair-housing no-steering
  // line: only buyer-stated criteria, evidenced by their own words, ever
  // reach this queue. property_alerts.agent_user_id is users.id while the
  // agent scope key is agents.id — same id-class mismatch as blog_posts, so
  // these list brokerage-wide (like blogs).
  const alertRows = (voiceAlerts.data ?? []) as Array<Record<string, unknown>>
  const alertContactNames = new Map<string, string>()
  if (alertRows.length > 0) {
    const contactIds = [...new Set(alertRows.map((r) => r.contact_id).filter(Boolean))] as string[]
    const { data: contacts } = await svc
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds)
    for (const c of (contacts ?? []) as Array<Record<string, unknown>>) {
      const name = `${String(c.first_name ?? "").trim()} ${String(c.last_name ?? "").trim()}`.trim()
      if (name) alertContactNames.set(String(c.id), name)
    }
  }
  for (const row of alertRows) {
    const who = alertContactNames.get(String(row.contact_id)) ?? "a buyer"
    const label = String(row.alert_name ?? "Property alert").replace(/\s*\[(?:call|msg):[^\]]*\]\s*/g, " ").trim()
    const heard = String(row.paused_reason ?? "").replace(/^\[(?:VOICE|TEXT)_PROPOSAL\]\s*/, "")
    items.push({
      id: `pa:${String(row.id)}`,
      type: "property_alert",
      agent_id: (row.agent_user_id as string | null) ?? null,
      status: "proposed",
      priority: "medium",
      content: `Proposed alert for ${who}: ${label}. ${heard}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (legacy.data ?? []) as Array<Record<string, unknown>>) {
    if (agentScopeId && row.agent_id && row.agent_id !== agentScopeId) continue
    items.push({
      id: String(row.id), // bare uuid — no prefix
      type: "legacy",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.status ?? "pending"),
      priority: "standard",
      content: `${String(row.item_type ?? "approval")} — ${String(row.item_id ?? "")}`.trim(),
      created_at: String(row.submitted_at ?? new Date().toISOString()),
      updated_at: String(row.reviewed_at ?? row.submitted_at ?? new Date().toISOString()),
    })
  }

  // Sort newest first across all sources
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
}

// ─── Dispatch approve / reject by prefix ─────────────────────────────────────

export type CascadeOutcome =
  | { success: true; type: ApprovalSource; targetId: string }
  | { success: false; error: string }

interface CascadeContext {
  brokerageId: string
  agentScopeId: string | null
  reviewerUserId: string
  notes?: string
}

/** Route an approve action to the right source table based on the prefixed id. */
export async function cascadeApprove(
  prefixedId: string,
  ctx: CascadeContext,
): Promise<CascadeOutcome> {
  return cascade(prefixedId, "approved", ctx)
}

/** Route a reject action to the right source table based on the prefixed id. */
export async function cascadeReject(
  prefixedId: string,
  ctx: CascadeContext,
): Promise<CascadeOutcome> {
  return cascade(prefixedId, "rejected", ctx)
}

async function cascade(
  prefixedId: string,
  outcome: "approved" | "rejected",
  ctx: CascadeContext,
): Promise<CascadeOutcome> {
  const svc = createServiceClient()
  const colonIdx = prefixedId.indexOf(":")
  const prefix = colonIdx > 0 ? prefixedId.slice(0, colonIdx) : ""
  const targetId = colonIdx > 0 ? prefixedId.slice(colonIdx + 1) : prefixedId

  if (!targetId) return { success: false, error: "Invalid id" }

  // Helper for per-content-table updates with brokerage scoping
  async function updateApprovalStatus(table: string, type: ApprovalSource, hasUpdatedAt = true) {
    let query = svc
      .from(table)
      .update({
        approval_status: outcome,
        // newsletter_campaigns has no updated_at column
        ...(hasUpdatedAt ? { updated_at: new Date().toISOString() } : {}),
      })
      .eq("id", targetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (ctx.agentScopeId) query = query.eq("agent_id", ctx.agentScopeId)
    const { error } = await query
    if (error) return { success: false as const, error: error.message }
    return { success: true as const, type, targetId }
  }

  // Scope pre-check for the sources whose approve/reject rides the shared
  // canonical marketing transition (helpers scope by id only — tenancy is
  // enforced HERE, before the write).
  async function checkMarketingScope(
    kind: MarketingAssetKind,
    scopeKey: "agent_id" | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const table = MARKETING_TABLE_BY_KIND[kind]
    const { data: row } = await svc
      .from(table)
      .select(scopeKey ? `id, brokerage_id, ${scopeKey}` : "id, brokerage_id")
      .eq("id", targetId)
      .maybeSingle()
    if (!row) return { ok: false, error: "Not found" }
    const r = row as unknown as Record<string, unknown>
    if (r.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }
    if (scopeKey && ctx.agentScopeId && r[scopeKey] && r[scopeKey] !== ctx.agentScopeId) {
      return { ok: false, error: "Forbidden" }
    }
    return { ok: true }
  }

  async function marketingCascade(
    kind: MarketingAssetKind,
    type: ApprovalSource,
    scopeKey: "agent_id" | null,
  ): Promise<CascadeOutcome> {
    const scope = await checkMarketingScope(kind, scopeKey)
    if (!scope.ok) return { success: false, error: scope.error }
    const res = outcome === "approved"
      ? await applyMarketingAssetApproval(kind, targetId)
      : await applyMarketingAssetRejection(kind, targetId, ctx.notes?.trim() || "Rejected in approvals queue")
    if (!res.ok) return { success: false, error: res.error }
    return { success: true, type, targetId }
  }

  switch (prefix) {
    case "nl":
      // Canonical newsletter transition — approve also schedules the send
      // (the publish cron only ships status='scheduled' with a send_date).
      // newsletter_campaigns.agent_id is agents.id — scope applies.
      return marketingCascade("newsletter", "newsletter", "agent_id")
    case "em":
      return updateApprovalStatus("email_campaigns", "email")
    case "acv": {
      // ad_creative_variations doesn't have agent_id; brokerage scope only
      const { error } = await svc
        .from("ad_creative_variations")
        .update({
          approval_status: outcome,
          updated_at: new Date().toISOString(),
        })
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
      if (error) return { success: false, error: error.message }
      return { success: true, type: "ad_creative", targetId }
    }
    case "vsn": {
      // video_snippets uses created_by for scope (no agent_id), no updated_at.
      let q = svc
        .from("video_snippets")
        .update({ approval_status: outcome })
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
      if (ctx.agentScopeId) q = q.eq("created_by", ctx.agentScopeId)
      const { error } = await q
      if (error) return { success: false, error: error.message }
      return { success: true, type: "video_snippet", targetId }
    }
    case "bp":
      // Canonical blog transition — approve advances BOTH ladders
      // (approval_status + publish_status) so neither review queue re-shows
      // it and the cadence cron can publish; reject drops both to rejected.
      // blog_posts.agent_user_id is users.id while the agent scope key is
      // agents.id (id-class mismatch) — blogs list + action brokerage-wide,
      // matching the aggregate view above.
      return marketingCascade("blog", "blog", null)
    case "pc":
      // Podcast episode release — canonical transition (approve also defaults
      // publish_channels to everything the brokerage has enabled, else the
      // distributor would have nothing to ship to). podcast_episodes.agent_id
      // is users.id — brokerage-wide, like blogs.
      return marketingCascade("podcast", "podcast", null)
    case "vp":
      // Commissioned video render release — canonical transition; the publish
      // rail (publishVideo) refuses anything not 'approved'.
      // ai_video_projects.agent_id is agents.id — scope applies.
      return marketingCascade("video", "video", "agent_id")
    case "of": {
      // Inbound offer DEAL DECISION — REUSE the canonical /offers kernel
      // commands: approve = acceptOffer (declines competing open offers,
      // advances a linked transaction to under_contract, emits
      // OFFER_OS_ACCEPTED); reject = rejectOffer (notes carry the reason,
      // emits OFFER_OS_REJECTED). The counter lane lives in
      // cascadeCounterOffer (same guard, kernel issueCounterOffer).
      const guard = await loadInboundOfferForDecision(svc, targetId, ctx)
      if (!guard.ok) return { success: false, error: guard.error }
      const { acceptOffer, rejectOffer } = await import("@/lib/kernel/offers")
      const res = outcome === "approved"
        ? await acceptOffer({ offerId: targetId, agentId: ctx.reviewerUserId, brokerageId: ctx.brokerageId })
        : await rejectOffer({ offerId: targetId, agentId: ctx.reviewerUserId, brokerageId: ctx.brokerageId, reason: ctx.notes })
      if (!res.success) return { success: false, error: res.error ?? "Offer action failed" }
      return { success: true, type: "offer", targetId }
    }
    case "pa": {
      // SPOKEN/WRITTEN CRITERIA alert proposal. Approve = activate (resume
      // semantics: is_active true, paused_* cleared — which removes the
      // [VOICE_PROPOSAL]/[TEXT_PROPOSAL] marker so the row can never re-enter
      // the queue) + run the first search, exactly like resumePropertyAlert.
      // Reject = DELETE the proposal — it never ran, there is nothing to
      // keep. Both are pinned to the two conversation sources
      // ('voice_conversation' from calls, 'text_conversation' from inbound
      // email/SMS) + is_active=false so this route can never touch a live or
      // agent-created alert.
      if (outcome === "approved") {
        const { data, error } = await svc
          .from("property_alerts")
          .update({ is_active: true, paused_by: null, paused_reason: null, updated_at: new Date().toISOString() })
          .eq("id", targetId)
          .eq("brokerage_id", ctx.brokerageId)
          .in("source", ["voice_conversation", "text_conversation"])
          .eq("is_active", false)
          .select("id")
          .maybeSingle()
        if (error) return { success: false, error: error.message }
        if (!data) return { success: false, error: "Not a pending alert proposal" }
        try {
          const { runAlert } = await import("@/lib/property-alerts/alert-engine")
          await runAlert(targetId) // first search fires on approval; failure doesn't undo it
        } catch { /* alert is active; the alert cron picks it up */ }
        return { success: true, type: "property_alert", targetId }
      }
      const { error } = await svc
        .from("property_alerts")
        .delete()
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
        .in("source", ["voice_conversation", "text_conversation"])
        .eq("is_active", false)
      if (error) return { success: false, error: error.message }
      return { success: true, type: "property_alert", targetId }
    }
    case "": {
      // Bare uuid — legacy approval_items row
      let q = svc
        .from("approval_items")
        .update({
          status: outcome,
          reviewed_by: ctx.reviewerUserId,
          reviewed_at: new Date().toISOString(),
          review_notes: ctx.notes ?? null,
        })
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
      if (ctx.agentScopeId) q = q.eq("agent_id", ctx.agentScopeId)
      const { error } = await q
      if (error) return { success: false, error: error.message }
      return { success: true, type: "legacy", targetId }
    }
    default:
      return { success: false, error: `Unknown approval id prefix: ${prefix}` }
  }
}

// ─── Offer decision guard + COUNTER lane ─────────────────────────────────────

/**
 * Load + guard an offer for a queue decision. Enforces, in order:
 *   - tenant + agent scope (offers.agent_id is agents.id — the newsletter
 *     scope key class)
 *   - INBOUND only: listing_id set (the offer is ON our seller listing —
 *     outside/buyer-side offers with property_address await the OTHER side)
 *     and not a counter row (every counter is OUR side's and awaits the buyer)
 *   - still awaiting a decision (status pending/submitted) — idempotence, so
 *     a double-click or a raced /offers action can't re-run a transition.
 */
async function loadInboundOfferForDecision(
  svc: ReturnType<typeof createServiceClient>,
  targetId: string,
  ctx: CascadeContext,
): Promise<
  | { ok: true; offer: { id: string; agent_id: string | null } }
  | { ok: false; error: string }
> {
  const { data: offer } = await svc
    .from("offers")
    .select("id, brokerage_id, agent_id, status, listing_id, offer_type")
    .eq("id", targetId)
    .maybeSingle()
  if (!offer) return { ok: false, error: "Not found" }
  if (offer.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Forbidden" }
  if (ctx.agentScopeId && offer.agent_id && offer.agent_id !== ctx.agentScopeId) {
    return { ok: false, error: "Forbidden" }
  }
  if (!offer.listing_id) {
    return { ok: false, error: "This is our buyer's offer on an outside property — the other side responds; nothing to decide here" }
  }
  if (offer.offer_type === "counter") {
    return { ok: false, error: "This is our counter — it awaits the buyer's response" }
  }
  if (offer.status !== "pending" && offer.status !== "submitted") {
    return { ok: false, error: "Offer is no longer awaiting a decision" }
  }
  return { ok: true, offer: { id: offer.id as string, agent_id: (offer.agent_id as string | null) ?? null } }
}

/**
 * COUNTER lane — routes a queue counter action to the REAL kernel command,
 * issueCounterOffer (the same canonical creator the /offers surfaces delegate
 * to — see app/actions/buyer-offer/record-seller-signed-counter.ts; the
 * seller counter slide-over idiom supplies price + optional notes/terms).
 * Never forks the transition: the kernel command creates the counter row
 * (offer_type='counter', parent_offer_id, round+1), marks the parent
 * status='countered' + has_counter=true, and emits OFFER_OS_COUNTERED.
 * Valid ONLY for of:-prefixed queue ids — marketing content has no counter
 * semantics.
 */
export async function cascadeCounterOffer(
  prefixedId: string,
  ctx: CascadeContext,
  terms: { counterPrice: number; closingDate?: string; notes?: string },
): Promise<CascadeOutcome> {
  const svc = createServiceClient()
  const colonIdx = prefixedId.indexOf(":")
  const prefix = colonIdx > 0 ? prefixedId.slice(0, colonIdx) : ""
  const targetId = colonIdx > 0 ? prefixedId.slice(colonIdx + 1) : ""

  if (prefix !== "of" || !targetId) {
    return { success: false, error: "Counter is only available for offer items" }
  }
  if (!Number.isFinite(terms.counterPrice) || terms.counterPrice <= 0) {
    return { success: false, error: "Counter price must be a positive number" }
  }

  const guard = await loadInboundOfferForDecision(svc, targetId, ctx)
  if (!guard.ok) return { success: false, error: guard.error }

  const { issueCounterOffer } = await import("@/lib/kernel/offers")
  const res = await issueCounterOffer({
    offerId: targetId,
    // agents.id for the counter row — the offer's own agent when set, else
    // the reviewer (same fallback idiom as record-seller-signed-counter).
    agentId: guard.offer.agent_id ?? ctx.reviewerUserId,
    brokerageId: ctx.brokerageId,
    counterPrice: terms.counterPrice,
    closingDate: terms.closingDate,
    notes: terms.notes ?? ctx.notes,
  })
  if (!res.success || !res.data) {
    return { success: false, error: res.error ?? "Counter failed" }
  }
  return { success: true, type: "offer", targetId }
}
