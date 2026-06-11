// lib/kernel/client-pulse.ts
//
// THE CLIENT PULSE — the weekly "here's what your team did for you," for the CLIENT.
// Everything the OS built so far serves the agent; this serves the people paying them.
// The #1 client complaint in real estate is silence between milestones: "my agent went
// dark — I don't know what's being done for me." The Pulse answers it every week, in
// plain language, from real tables only:
//
//   · SELLERS (Listing Concierge writes it): showings held this week (+ a feedback
//     line when one exists), social posts that went out for their home, the promo
//     reel's real status, paid campaigns live in their city — and what's next.
//   · BUYERS (Shopping Agent writes it): homes saved this week, tours on the books,
//     where their deal stands (stage + the next deadline, with the honest coverage
//     state — "appraisal is ordered" vs "we're on it this week").
//
// RULES THAT KEEP IT TRUSTWORTHY:
//   · an empty week sends NOTHING — silence beats fabricated activity
//   · every Pulse goes through the gate (proposed → human approves → portal card),
//     and Manager Dissent peer-reviews it like any other proposal
//   · one Pulse per client per week; withdrawn relationships are never touched
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface SellerPulseFacts {
  address: string | null
  showings: number
  feedbackSnippet: string | null
  socialPosts: number
  reelStatus: "ready" | "rendering" | null
  adsLiveInCity: number
  nextDeadline: { kind: string; date: string; covered: boolean } | null
}

export interface BuyerPulseFacts {
  savedThisWeek: number
  latestSave: string | null
  toursOnBooks: number
  dealName: string | null
  stage: string | null
  nextDeadline: { kind: string; date: string; covered: boolean } | null
}

/** Pure: the seller's week — earned lines only; null when there is nothing to say. */
export function composeSellerPulse(firstName: string | null, f: SellerPulseFacts): { subject: string; body: string } | null {
  const lines: string[] = []
  if (f.showings > 0) lines.push(`${f.showings} buyer showing${f.showings === 1 ? "" : "s"} came through${f.feedbackSnippet ? ` — one visitor said: "${f.feedbackSnippet}"` : ""}.`)
  if (f.socialPosts > 0) lines.push(`${f.socialPosts} social post${f.socialPosts === 1 ? "" : "s"} about your home went out this week.`)
  if (f.reelStatus === "ready") lines.push(`Your home's video reel is rendered and being shared.`)
  else if (f.reelStatus === "rendering") lines.push(`A new video reel for your home is rendering now.`)
  if (f.adsLiveInCity > 0) lines.push(`${f.adsLiveInCity} paid campaign${f.adsLiveInCity === 1 ? " is" : "s are"} live putting your area in front of buyers.`)
  if (f.nextDeadline) lines.push(f.nextDeadline.covered
    ? `Next up: the ${f.nextDeadline.kind} deadline on ${f.nextDeadline.date} — already covered.`
    : `Next up: the ${f.nextDeadline.kind} deadline on ${f.nextDeadline.date} — your team is on it this week.`)
  if (lines.length === 0) return null // an empty week sends NOTHING
  return {
    subject: `Your week at ${f.address ?? "your home"} — what your team did`,
    body: `Hi${firstName ? ` ${firstName}` : ""} — your weekly update, so you always know what's being done for you. ${lines.join(" ")} Questions? Just reply here.`,
  }
}

/** Pure: the buyer's week — earned lines only; null when there is nothing to say. */
export function composeBuyerPulse(firstName: string | null, f: BuyerPulseFacts): { subject: string; body: string } | null {
  const lines: string[] = []
  if (f.savedThisWeek > 0) lines.push(`You saved ${f.savedThisWeek} home${f.savedThisWeek === 1 ? "" : "s"} this week${f.latestSave ? `, most recently ${f.latestSave}` : ""} — we're watching all of them for changes.`)
  if (f.toursOnBooks > 0) lines.push(`${f.toursOnBooks} tour${f.toursOnBooks === 1 ? " is" : "s are"} on the books.`)
  if (f.dealName && f.stage) lines.push(`${f.dealName} is ${f.stage.toLowerCase().replace(/_/g, " ")}.`)
  if (f.nextDeadline) lines.push(f.nextDeadline.covered
    ? `The ${f.nextDeadline.kind} deadline on ${f.nextDeadline.date} is already covered.`
    : `The ${f.nextDeadline.kind} deadline is ${f.nextDeadline.date} — your team is working it this week.`)
  if (lines.length === 0) return null
  return {
    subject: `Your home search this week — what your team did`,
    body: `Hi${firstName ? ` ${firstName}` : ""} — your weekly update, so you always know where things stand. ${lines.join(" ")} Questions? Just reply here.`,
  }
}

export interface ClientPulseResult { sellerPulses: number; buyerPulses: number; quietWeeks: number }

/** Next uncovered-or-covered deadline from a transaction row (honest coverage state). */
function nextDeadlineOf(t: any, lender: any): { kind: string; date: string; covered: boolean } | null {
  const opts: Array<{ kind: string; date: string | null; covered: boolean }> = [
    { kind: "inspection", date: t.inspection_deadline, covered: !!t.inspection_contingency_removed_at },
    { kind: "appraisal", date: t.appraisal_deadline, covered: !!t.appraisal_contingency_removed_at || !!(lender?.appraisal_ordered_date) || !!t.appraisal_value },
    { kind: "financing", date: t.financing_deadline, covered: !!t.financing_contingency_removed_at || !!(lender?.clear_to_close_date) },
  ]
  const future = opts.filter((o): o is { kind: string; date: string; covered: boolean } => !!o.date)
    .sort((a, b) => a.date.localeCompare(b.date))
  return future[0] ?? null
}

/**
 * One weekly pass: every active seller and buyer gets their Pulse PROPOSED into the
 * gate (portal channel). Idempotent per contact per 7 days; empty weeks stay silent.
 */
export async function runClientPulse(
  brokerageId: string,
  opts: { now?: Date } = {},
  client?: Svc,
): Promise<ClientPulseResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const weekAgoDate = weekAgo.slice(0, 10)
  let sellerPulses = 0, buyerPulses = 0, quietWeeks = 0

  const alreadyPulsed = async (contactId: string): Promise<boolean> => {
    const { data } = await supabase.from("agent_client_messages").select("id")
      .eq("recipient_contact_id", contactId).ilike("rationale", "CLIENT PULSE%")
      .gte("proposed_at", weekAgo).limit(1).maybeSingle()
    return !!data
  }
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

  // ── SELLERS: active/pending listings with a seller contact. ──
  // CONSOLIDATION: the weekly seller-update D-ID VIDEO (seller-update-reel-producer,
  // Mondays) is the seller's PRIMARY weekly update — richer (avatar, showings,
  // interest, DOM, price position) and already gated. The text Pulse DEFERS to it:
  // any seller the Listing Concierge already touched this week is skipped, so the
  // Pulse only fills the weeks the video system produced nothing. ONE weekly seller
  // touch, never two.
  const sellerTouchedThisWeek = async (contactId: string): Promise<boolean> => {
    const { data } = await supabase.from("agent_client_messages").select("id")
      .eq("recipient_contact_id", contactId).eq("agent_kind", "listing_concierge")
      .gte("proposed_at", weekAgo).limit(1).maybeSingle()
    return !!data
  }
  const { data: sellerListings } = await supabase.from("listings")
    .select("id, address, city, seller_contact_id").eq("brokerage_id", brokerageId)
    .in("status", ["active", "pending", "coming_soon"]).not("seller_contact_id", "is", null).limit(100)
  for (const l of (sellerListings ?? []) as any[]) {
    const { data: c } = await supabase.from("contacts").select("first_name, nurture_status").eq("id", l.seller_contact_id).maybeSingle()
    if (!c || (c as any).nurture_status === "withdrawn") continue
    if (await sellerTouchedThisWeek(l.seller_contact_id)) continue

    const [{ data: shows }, { count: socialCount }, { data: reel }, txnRow] = await Promise.all([
      supabase.from("showings").select("feedback").eq("listing_id", l.id).gte("scheduled_date", weekAgoDate).limit(50),
      supabase.from("social_posts").select("id", { count: "exact", head: true })
        .eq("listing_id", l.id).eq("status", "published").gte("published_at", weekAgo),
      supabase.from("listing_promo_videos").select("status").eq("listing_id", l.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("transactions")
        .select("inspection_deadline, appraisal_deadline, financing_deadline, inspection_contingency_removed_at, appraisal_contingency_removed_at, financing_contingency_removed_at, appraisal_value, id")
        .eq("listing_id", l.id).in("status", ["under_contract", "closing"]).is("deleted_at", null).limit(1).maybeSingle(),
    ])
    let adsLive = 0
    if (l.city) {
      const { data: ads } = await supabase.from("ad_campaigns").select("targeting_config")
        .eq("brokerage_id", brokerageId).in("status", ["live", "launching"]).limit(100)
      adsLive = ((ads ?? []) as any[]).filter((a) =>
        Array.isArray(a.targeting_config?.locations) &&
        a.targeting_config.locations.some((loc: unknown) => String(loc).toLowerCase().includes(String(l.city).toLowerCase()))).length
    }
    let lender: any = null
    if (txnRow.data) {
      const { data: ld } = await supabase.from("transaction_lenders")
        .select("clear_to_close_date, appraisal_ordered_date").eq("transaction_id", (txnRow.data as any).id).limit(1).maybeSingle()
      lender = ld
    }
    const showRows = (shows ?? []) as Array<{ feedback: string | null }>
    const reelStatus = (reel as any)?.status === "social_drafted" ? "ready"
      : ["queued", "remotion_pending", "rendering"].includes((reel as any)?.status ?? "") ? "rendering" : null
    const pulse = composeSellerPulse((c as any).first_name ?? null, {
      address: l.address, showings: showRows.length,
      feedbackSnippet: showRows.find((s) => s.feedback)?.feedback?.slice(0, 120) ?? null,
      socialPosts: socialCount ?? 0, reelStatus, adsLiveInCity: adsLive,
      nextDeadline: txnRow.data ? nextDeadlineOf(txnRow.data, lender) : null,
    })
    if (!pulse) { quietWeeks += 1; continue }
    const res = await proposeClientMessage({
      brokerageId, agentKind: "listing_concierge", entityType: "listing",
      entityId: l.id, recipientContactId: l.seller_contact_id, audience: "seller",
      subject: pulse.subject, body: pulse.body,
      rationale: `CLIENT PULSE — the seller's weekly "what your team did" (showings, social, reel, ads, next deadline) so the client never wonders if work is happening.`,
      channel: "portal",
    }, supabase)
    if (res.ok) sellerPulses += 1
  }

  // ── BUYERS: live deals + this week's saves. ──
  const { data: buyerTxns } = await supabase.from("transactions")
    .select("id, deal_name, stage, buyer_contact_id, inspection_deadline, appraisal_deadline, financing_deadline, inspection_contingency_removed_at, appraisal_contingency_removed_at, financing_contingency_removed_at, appraisal_value")
    .eq("brokerage_id", brokerageId).in("status", ["active", "under_contract", "closing"])
    .not("buyer_contact_id", "is", null).is("deleted_at", null).limit(100)
  for (const t of (buyerTxns ?? []) as any[]) {
    const { data: c } = await supabase.from("contacts").select("first_name, nurture_status").eq("id", t.buyer_contact_id).maybeSingle()
    if (!c || (c as any).nurture_status === "withdrawn") continue
    if (await alreadyPulsed(t.buyer_contact_id)) continue

    const [{ data: saves }, { count: tourCount }, { data: lender }] = await Promise.all([
      supabase.from("saved_properties").select("property_address").eq("contact_id", t.buyer_contact_id)
        .eq("dismissed", false).gte("saved_at", weekAgo).order("saved_at", { ascending: false }).limit(10),
      supabase.from("tours").select("id", { count: "exact", head: true })
        .eq("contact_id", t.buyer_contact_id).in("status", ["scheduled", "confirmed", "pending"]),
      supabase.from("transaction_lenders").select("clear_to_close_date, appraisal_ordered_date")
        .eq("transaction_id", t.id).limit(1).maybeSingle(),
    ])
    const saveRows = (saves ?? []) as Array<{ property_address: string | null }>
    const pulse = composeBuyerPulse((c as any).first_name ?? null, {
      savedThisWeek: saveRows.length, latestSave: saveRows[0]?.property_address ?? null,
      toursOnBooks: tourCount ?? 0, dealName: t.deal_name, stage: t.stage,
      nextDeadline: nextDeadlineOf(t, lender),
    })
    if (!pulse) { quietWeeks += 1; continue }
    const res = await proposeClientMessage({
      brokerageId, agentKind: "shopping_agent", entityType: "transaction",
      entityId: t.id, recipientContactId: t.buyer_contact_id, audience: "buyer",
      subject: pulse.subject, body: pulse.body,
      rationale: `CLIENT PULSE — the buyer's weekly "what your team did" (saves, tours, deal stage, next deadline with honest coverage) so the client never wonders.`,
      channel: "portal",
    }, supabase)
    if (res.ok) buyerPulses += 1
  }

  return { sellerPulses, buyerPulses, quietWeeks }
}
