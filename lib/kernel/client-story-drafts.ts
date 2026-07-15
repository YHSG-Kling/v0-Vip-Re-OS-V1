// lib/kernel/client-story-drafts.ts
//
// THE THREE JOBS-COMPLETION DRAFTS (owner: "all users benefit from AI helping
// them complete their jobs… and customers are well informed" + "all content/
// messages should not be hardcoded") — the recurring client communications
// every seat still assembled by hand:
//
//   1. WEEKLY SELLER UPDATE — per active listing: showings, feedback themes,
//      what we're doing next week.
//   2. TOUR-EVENING RECAP — the same-evening note after a buyer tour: what we
//      saw, the standout, the offer-readiness read.
//   3. WEEKLY DEAL NOTE — the transaction-coordinator's all-parties status in
//      client language.
//
// DISCIPLINE (agentic-os + owner's no-hardcode rule): the PURE layer builds a
// BRIEF — the grounded facts plus the honesty instructions the writer must
// follow ("ZERO showings: say it plainly, give the plan, never dress it up").
// The BODY is AUTHORED by the model through the ONE copy path the OS already
// trusts (realCopyGenerator: gateway-routed, charter-governed, facts-only,
// Fair-Housing-ruled) — never a canned template. If the model can't produce
// copy, the draft is SKIPPED — an honest absence, never hardcoded fallback
// prose. Every draft lands as a GATED proposal on agent_client_messages (the
// agent approves and sends — nothing auto-sends), deduped by rationale tag
// per listing/tour/deal per period.
// CONSOLIDATION: the on-demand seller draft button (app/actions/seller-updates)
// stays as the interactive path; feedback CHASE already exists
// (lib/kernel/showing-lifecycle — tokenized ask + reminders); this module is
// the PROACTIVE story rail beside them.

import type { SupabaseClient } from "@supabase/supabase-js"
import { isoWeekOf } from "@/lib/kernel/week-in-review"

type Svc = SupabaseClient<any, any, any>

export interface StoryBrief {
  goal: string
  audience: "seller" | "buyer"
  /** persona situation line for the writer */
  situation: string
  /** grounded facts + honesty instructions — the writer may use NOTHING else */
  facts: string[]
  recipientFirstName: string | null
}

// ── 1. Weekly seller update ─────────────────────────────────────────────────

export interface SellerWeekFacts {
  sellerFirstName: string | null
  address: string
  showingCount: number
  feedbackNotes: string[]
  daysOnMarket: number | null
}

/** PURE: the seller-update brief — facts + the honesty rules the writer must follow. */
export function sellerUpdateBrief(f: SellerWeekFacts): StoryBrief {
  const facts: string[] = [`Listing: ${f.address}.`]
  if (f.showingCount > 0) {
    facts.push(`Showings this week: ${f.showingCount}.`)
    facts.push(f.feedbackNotes.length > 0
      ? `Feedback from showing agents (quote themes, stay constructive): ${f.feedbackNotes.slice(0, 3).join("; ")}.`
      : `No feedback collected yet — say the agent is following up with each showing agent and will share what comes back.`)
  } else {
    facts.push(`ZERO showings this week. HONESTY RULE: say this plainly (e.g. "a quieter week") — never dress it up — and give the concrete plan: refreshing listing exposure, re-touching previously interested agents, watching weekend traffic.`)
  }
  if (f.daysOnMarket != null && f.daysOnMarket > 0) facts.push(`Days on market so far: ${f.daysOnMarket}.`)
  facts.push(`Close with what happens next week and that anything meaningful is shared same-day.`)
  return {
    goal: "the seller's weekly update on their listing — the recurring story that keeps them confident",
    audience: "seller",
    situation: `Home seller with an active listing at ${f.address}; expects a truthful weekly account of activity and the plan.`,
    facts,
    recipientFirstName: f.sellerFirstName,
  }
}

/** PURE: the per-listing-per-week dedupe tag. */
export function sellerWeeklyTag(listingId: string, isoWeek: string): string {
  return `[SELLER_WEEKLY] [${listingId}] [${isoWeek}]`
}

// ── 2. Tour-evening recap ───────────────────────────────────────────────────

export interface TourStopFact { address: string; rating: number | null; feedback: string | null }

export interface TourRecapFacts {
  buyerFirstName: string | null
  stops: TourStopFact[]
}

/** PURE: the standout stop — highest rating ≥ 4, ties broken by having feedback. */
export function pickStandout(stops: TourStopFact[]): TourStopFact | null {
  const rated = stops.filter((s) => (s.rating ?? 0) >= 4)
  if (rated.length === 0) return null
  return [...rated].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.feedback ? 1 : 0) - (a.feedback ? 1 : 0))[0]
}

/** PURE: the recap brief. Returns null when NO stop carries a reaction —
 *  the OS never narrates a day it didn't see. */
export function tourRecapBrief(f: TourRecapFacts): StoryBrief | null {
  const known = f.stops.filter((s) => s.rating != null || (s.feedback ?? "").trim())
  if (known.length === 0) return null
  const facts: string[] = [`Homes toured today: ${f.stops.length}.`]
  for (const s of known.slice(0, 5)) {
    const bits: string[] = [s.address]
    if (s.rating != null) bits.push(`buyer's rating ${s.rating}/5`)
    if ((s.feedback ?? "").trim()) bits.push(`buyer's own note: "${(s.feedback ?? "").trim().slice(0, 120)}"`)
    facts.push(`Stop: ${bits.join(" — ")}.`)
  }
  const standout = pickStandout(f.stops)
  facts.push(standout
    ? `STANDOUT: ${standout.address} (the buyer's top reaction). Include a warm, no-pressure offer-readiness suggestion — if it's still on their mind tonight, talking numbers early beats reacting to the weekend crowd.`
    : `No home stood out today. HONESTY RULE: frame that as useful information, not a setback — today sharpened the list for the next round.`)
  return {
    goal: "the buyer's same-evening tour recap — how the day settled, in their own reactions",
    audience: "buyer",
    situation: "Home buyer who toured today; expects the recap while it's fresh and a clear read on next steps.",
    facts,
    recipientFirstName: f.buyerFirstName,
  }
}

/** PURE: once-per-tour dedupe tag. */
export function tourRecapTag(tourId: string): string {
  return `[TOUR_RECAP] [${tourId}]`
}

// ── 3. Weekly deal note (the TC's all-parties status) ───────────────────────

export const LOAN_CLIENT_LANGUAGE: Record<string, string> = {
  submitted: "your loan file is in with the lender",
  in_review: "the lender is reviewing your file",
  in_underwriting: "your loan is in underwriting — normal at this stage",
  pending_conditions: "the lender has a short list of items they still need",
  approved: "your loan is approved",
  clear_to_close: "you are CLEAR TO CLOSE — the finish line is set",
  funded: "your loan has funded",
}

export interface DealNoteFacts {
  clientFirstName: string | null
  address: string | null
  loanStatus: string | null
  clearToCloseDate: string | null
  upcoming: Array<{ name: string; date: string | null }>
  openTaskCount: number
}

/** PURE: the deal-note brief. Returns null when the OS holds NOTHING to
 *  report (no loan state, no dates) — never a hollow note. */
export function dealNoteBrief(f: DealNoteFacts): StoryBrief | null {
  const hasLoan = !!(f.loanStatus && LOAN_CLIENT_LANGUAGE[f.loanStatus])
  if (!hasLoan && f.upcoming.length === 0) return null
  const facts: string[] = []
  if (f.address) facts.push(`Property: ${f.address}.`)
  if (hasLoan) {
    facts.push(`Loan status (use this exact client-language framing): "${LOAN_CLIENT_LANGUAGE[f.loanStatus!]}"${f.loanStatus === "clear_to_close" && f.clearToCloseDate ? ` (recorded ${f.clearToCloseDate})` : ""}.`)
  }
  if (f.upcoming.length > 0) {
    facts.push(`Upcoming dates: ${f.upcoming.slice(0, 3).map((m) => `${m.name.replace(/_/g, " ")}${m.date ? ` on ${m.date}` : ""}`).join("; ")}.`)
  }
  facts.push(f.openTaskCount > 0
    ? `The team is working ${f.openTaskCount} open item(s) behind the scenes; nothing is currently waiting on the client — say that calmly and that they'll hear first if it changes.`
    : `Nothing is waiting on the client right now — close on that reassurance.`)
  return {
    goal: "the weekly all-parties status note on an active deal — where everything stands, in the client's language",
    audience: "buyer",
    situation: `Client under contract${f.address ? ` on ${f.address}` : ""}; the most nervous stretch of the deal — calm, specific, zero jargon.`,
    facts,
    recipientFirstName: f.clientFirstName,
  }
}

/** PURE: per-deal-per-week dedupe tag. */
export function dealWeeklyTag(transactionId: string, isoWeek: string): string {
  return `[TC_WEEKLY] [${transactionId}] [${isoWeek}]`
}

// ── 4. Buyer weekly search story (the RealScout counter — authored, not a blast) ──

export interface BuyerWeekFacts {
  buyerFirstName: string | null
  /** portal activity events in the window (views, searches, decisions) */
  portalActivityCount: number
  /** listings matched to this buyer's search this week */
  matches: Array<{ address: string | null; confidence: string | null }>
  /** matched homes that have since gone pending/sold — real market-pace facts */
  movedListings: Array<{ address: string | null; status: string }>
}

/** PURE: the buyer-story brief. Returns null when the week held NO activity
 *  and NO matches — a buyer with nothing happening gets silence, not filler. */
export function buyerStoryBrief(f: BuyerWeekFacts): StoryBrief | null {
  if (f.portalActivityCount === 0 && f.matches.length === 0) return null
  const facts: string[] = []
  if (f.portalActivityCount > 0) facts.push(`The buyer was active on their portal ${f.portalActivityCount} time(s) this week — acknowledge their engagement naturally, never surveil-y.`)
  if (f.matches.length > 0) {
    facts.push(`New matches to their search this week: ${f.matches.slice(0, 4).map((m) => `${m.address ?? "a new listing"}${m.confidence === "high" ? " (strong match)" : ""}`).join("; ")}.`)
  } else {
    facts.push(`No new matches hit their criteria this week. HONESTY RULE: say that plainly and what it means (inventory at their criteria is tight) — never pad with near-misses.`)
  }
  if (f.movedListings.length > 0) {
    facts.push(`Market pace on homes from their search: ${f.movedListings.slice(0, 3).map((m) => `${m.address ?? "one match"} went ${m.status}`).join("; ")}. Present as useful pace information, no pressure.`)
  }
  facts.push(`Close with what the agent is doing next in the search and an easy invitation to adjust criteria or see something in person.`)
  return {
    goal: "the buyer's weekly search story — what happened in their home search this week, in their own activity",
    audience: "buyer",
    situation: "Active home buyer with a running search; expects a truthful weekly read on matches, market pace, and next steps — not a listing blast.",
    facts,
    recipientFirstName: f.buyerFirstName,
  }
}

/** PURE: per-buyer-per-week dedupe tag. */
export function buyerWeeklyTag(contactId: string, isoWeek: string): string {
  return `[BUYER_WEEKLY] [${contactId}] [${isoWeek}]`
}

// ── The one authoring path (no hardcoded copy, no canned fallback) ──────────

/** Author a brief through the OS's ONE charter-governed copy path. Null = skip
 *  the draft entirely — an honest absence, never template prose. */
async function authorStory(brief: StoryBrief): Promise<{ subject: string; body: string } | null> {
  try {
    const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")
    const draft = await realCopyGenerator({
      goal: brief.goal,
      channel: "portal",
      persona: {
        name: brief.recipientFirstName ?? undefined,
        audience: brief.audience,
        situation: brief.situation,
      },
      facts: brief.facts,
      words: 140,
    })
    if (!draft?.body?.trim()) return null
    return { subject: draft.subject?.trim() || brief.goal, body: draft.body.trim() }
  } catch {
    return null
  }
}

// ── Runners (ride the deal-health-scan cron; tag-deduped, gated, best-effort) ──

async function alreadyProposed(svc: Svc, brokerageId: string, tag: string): Promise<boolean> {
  const { data } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", brokerageId).ilike("rationale", `%${tag}%`).limit(1).maybeSingle()
  return !!data
}

export interface StoryDraftResult { scanned: number; proposed: number; skippedNoCopy: number }

export async function runWeeklySellerUpdates(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<StoryDraftResult> {
  const out: StoryDraftResult = { scanned: 0, proposed: 0, skippedNoCopy: 0 }
  const isoWeek = isoWeekOf(now)
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()

  const { data: listings } = await svc.from("listings")
    .select("id, address, contact_id, seller_contact_id, agent_id, status, created_at")
    .eq("brokerage_id", brokerageId).in("status", ["active", "coming_soon"])
    .not("agent_id", "is", null).limit(200)
  for (const l of ((listings ?? []) as any[])) {
    const sellerId = l.seller_contact_id ?? l.contact_id
    if (!sellerId) continue
    out.scanned++
    const tag = sellerWeeklyTag(l.id, isoWeek)
    if (await alreadyProposed(svc, brokerageId, tag)) continue

    const [{ data: seller }, { data: showings }] = await Promise.all([
      svc.from("contacts").select("first_name").eq("id", sellerId).maybeSingle(),
      svc.from("showings").select("id, feedback").eq("listing_id", l.id).gte("scheduled_at", since).limit(50),
    ])
    const showingRows = ((showings ?? []) as any[])
    const draft = await authorStory(sellerUpdateBrief({
      sellerFirstName: (seller as any)?.first_name ?? null,
      address: l.address ?? "your home",
      showingCount: showingRows.length,
      feedbackNotes: showingRows.map((s) => (s.feedback ?? "").trim()).filter(Boolean).slice(0, 3),
      daysOnMarket: l.created_at ? Math.max(0, Math.floor((now.getTime() - new Date(l.created_at).getTime()) / 86_400_000)) : null,
    }))
    if (!draft) { out.skippedNoCopy++; continue }
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const r = await proposeClientMessage({
      brokerageId,
      agentKind: "deal_coordinator",
      entityType: "listing",
      entityId: l.id,
      recipientContactId: sellerId,
      audience: "seller",
      subject: draft.subject,
      body: draft.body,
      rationale: `weekly seller update — the recurring story every seller deserves, authored from this week's real activity. ${tag}`,
      channel: "portal",
      outreachReason: "relationship_maintenance",
    }, svc as any)
    if (r.ok) out.proposed++
  }
  return out
}

export async function runTourRecaps(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<StoryDraftResult> {
  const out: StoryDraftResult = { scanned: 0, proposed: 0, skippedNoCopy: 0 }
  const since = new Date(now.getTime() - 36 * 3_600_000).toISOString().slice(0, 10) // today or yesterday

  const { data: tours } = await svc.from("tours")
    .select("id, contact_id, tour_date")
    .eq("brokerage_id", brokerageId).gte("tour_date", since).lte("tour_date", now.toISOString().slice(0, 10))
    .not("contact_id", "is", null).limit(50)
  for (const t of ((tours ?? []) as any[])) {
    out.scanned++
    const tag = tourRecapTag(t.id)
    if (await alreadyProposed(svc, brokerageId, tag)) continue
    const [{ data: buyer }, { data: stops }] = await Promise.all([
      svc.from("contacts").select("first_name").eq("id", t.contact_id).maybeSingle(),
      svc.from("tour_stops").select("property_address, rating, feedback").eq("tour_id", t.id).limit(12),
    ])
    const brief = tourRecapBrief({
      buyerFirstName: (buyer as any)?.first_name ?? null,
      stops: ((stops ?? []) as any[]).map((s) => ({ address: s.property_address ?? "one of the homes", rating: s.rating ?? null, feedback: s.feedback ?? null })),
    })
    if (!brief) continue // no reactions recorded — never narrate a day the OS didn't see
    const draft = await authorStory(brief)
    if (!draft) { out.skippedNoCopy++; continue }
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const r = await proposeClientMessage({
      brokerageId,
      agentKind: "deal_coordinator",
      entityType: "tour",
      entityId: t.id,
      recipientContactId: t.contact_id,
      audience: "buyer",
      subject: draft.subject,
      body: draft.body,
      rationale: `same-evening tour recap — what we saw, the standout, and the offer-readiness read. ${tag}`,
      channel: "portal",
      outreachReason: "decision_required",
    }, svc as any)
    if (r.ok) out.proposed++
  }
  return out
}

export async function runWeeklyDealNotes(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<StoryDraftResult> {
  const out: StoryDraftResult = { scanned: 0, proposed: 0, skippedNoCopy: 0 }
  const isoWeek = isoWeekOf(now)

  const { data: txs } = await svc.from("transactions")
    .select("id, property_address, buyer_contact_id, contact_id, status")
    .eq("brokerage_id", brokerageId).in("status", ["under_contract", "closing"]).limit(200)
  for (const tx of ((txs ?? []) as any[])) {
    const clientId = tx.buyer_contact_id ?? tx.contact_id
    if (!clientId) continue
    out.scanned++
    const tag = dealWeeklyTag(tx.id, isoWeek)
    if (await alreadyProposed(svc, brokerageId, tag)) continue

    const [{ data: client }, { data: lender }, { data: milestones }, { count: openTasks }] = await Promise.all([
      svc.from("contacts").select("first_name").eq("id", clientId).maybeSingle(),
      svc.from("transaction_lenders").select("underwriting_status, clear_to_close_date").eq("transaction_id", tx.id).limit(1).maybeSingle(),
      svc.from("transaction_milestones").select("milestone_name, target_date").eq("transaction_id", tx.id).eq("status", "pending").order("target_date", { ascending: true }).limit(3),
      svc.from("tasks").select("id", { count: "exact", head: true }).eq("transaction_id", tx.id).eq("status", "pending"),
    ])
    const brief = dealNoteBrief({
      clientFirstName: (client as any)?.first_name ?? null,
      address: tx.property_address ?? null,
      loanStatus: (lender as any)?.underwriting_status ?? null,
      clearToCloseDate: (lender as any)?.clear_to_close_date ?? null,
      upcoming: ((milestones ?? []) as any[]).map((m) => ({ name: m.milestone_name ?? "next step", date: m.target_date ?? null })),
      openTaskCount: openTasks ?? 0,
    })
    if (!brief) continue // the OS holds nothing to report — never a hollow note
    const draft = await authorStory(brief)
    if (!draft) { out.skippedNoCopy++; continue }
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const r = await proposeClientMessage({
      brokerageId,
      agentKind: "deal_coordinator",
      entityType: "transaction",
      entityId: tx.id,
      recipientContactId: clientId,
      audience: tx.buyer_contact_id ? "buyer" : "seller",
      subject: draft.subject,
      body: draft.body,
      rationale: `weekly deal note — the all-parties status in the client's language. ${tag}`,
      channel: "portal",
      outreachReason: "relationship_maintenance",
    }, svc as any)
    if (r.ok) out.proposed++
  }
  return out
}

export async function runBuyerSearchStories(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<StoryDraftResult> {
  const out: StoryDraftResult = { scanned: 0, proposed: 0, skippedNoCopy: 0 }
  const isoWeek = isoWeekOf(now)
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()

  // Buyers with a live search this week: buyer_search_match activity rows.
  const { data: matchRows } = await svc.from("activities")
    .select("contact_id, metadata, created_at")
    .eq("brokerage_id", brokerageId).eq("activity_type", "buyer_search_match")
    .gte("created_at", since).limit(500)
  const byBuyer = new Map<string, Array<Record<string, any>>>()
  for (const r of ((matchRows ?? []) as any[])) {
    if (!r.contact_id) continue
    byBuyer.set(r.contact_id, [...(byBuyer.get(r.contact_id) ?? []), (r.metadata as any) ?? {}])
  }

  for (const [contactId, metas] of [...byBuyer.entries()].slice(0, 100)) {
    out.scanned++
    const tag = buyerWeeklyTag(contactId, isoWeek)
    if (await alreadyProposed(svc, brokerageId, tag)) continue

    const listingIds = [...new Set(metas.map((m) => m.listing_id).filter(Boolean))] as string[]
    const [{ data: buyer }, { count: portalCount }, { data: listingRows }] = await Promise.all([
      svc.from("contacts").select("first_name").eq("id", contactId).maybeSingle(),
      svc.from("client_portal_activity").select("id", { count: "exact", head: true }).eq("contact_id", contactId).gte("created_at", since),
      listingIds.length
        ? svc.from("listings").select("id, address, status").in("id", listingIds.slice(0, 20))
        : Promise.resolve({ data: [] } as any),
    ])
    const listings = ((listingRows ?? []) as any[])
    const brief = buyerStoryBrief({
      buyerFirstName: (buyer as any)?.first_name ?? null,
      portalActivityCount: portalCount ?? 0,
      matches: metas.slice(0, 4).map((m) => ({
        address: listings.find((l) => l.id === m.listing_id)?.address ?? null,
        confidence: (m.confidence_level as string) ?? null,
      })),
      movedListings: listings.filter((l) => ["pending", "sold", "under_contract"].includes(String(l.status ?? ""))).map((l) => ({ address: l.address ?? null, status: String(l.status) })),
    })
    if (!brief) continue
    const draft = await authorStory(brief)
    if (!draft) { out.skippedNoCopy++; continue }
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const r = await proposeClientMessage({
      brokerageId,
      agentKind: "deal_coordinator",
      entityType: "contact",
      entityId: contactId,
      recipientContactId: contactId,
      audience: "buyer",
      subject: draft.subject,
      body: draft.body,
      rationale: `buyer weekly search story — matches, market pace, and next steps from their real activity. ${tag}`,
      channel: "portal",
      outreachReason: "relationship_maintenance",
    }, svc as any)
    if (r.ok) out.proposed++
  }
  return out
}

/** Autonomous: all four story rails for every brokerage (rides deal-health-scan). */
export async function runClientStoryDraftsAll(svc: Svc): Promise<{ brokerages: number; proposed: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(1000)
  let proposed = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const [a, t, d, bs] = await Promise.all([
      runWeeklySellerUpdates(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
      runTourRecaps(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
      runWeeklyDealNotes(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
      runBuyerSearchStories(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
    ])
    proposed += a.proposed + t.proposed + d.proposed + bs.proposed
  }
  return { brokerages: (brokerages ?? []).length, proposed }
}
