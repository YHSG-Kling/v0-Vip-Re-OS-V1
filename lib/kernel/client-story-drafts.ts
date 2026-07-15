// lib/kernel/client-story-drafts.ts
//
// THE THREE JOBS-COMPLETION DRAFTS (owner: "all users benefit from AI helping
// them complete their jobs… and customers are well informed") — the recurring
// client communications every seat still assembled by hand:
//
//   1. WEEKLY SELLER UPDATE — per active listing: showings, feedback themes,
//      what we're doing next week. The #1 recurring job on the listing side;
//      sellers fire agents when this goes quiet.
//   2. TOUR-EVENING RECAP — the same-evening note after a buyer tour: what we
//      saw, the standout, and the offer-readiness nudge when a favorite exists.
//   3. WEEKLY DEAL NOTE — the transaction-coordinator's all-parties status:
//      loan progress in client language, the next dates, what we're waiting on.
//
// DISCIPLINE (agentic-os): all three are PURE deterministic composers over
// facts the OS already holds — no LLM in the cron path, nothing invented, a
// quiet week is said plainly ("a quieter week" + the plan), zero data = NO
// draft (never a hollow note). Every draft lands as a GATED proposal on the
// agent_client_messages rail (the agent approves and sends — nothing
// auto-sends), deduped by rationale tag per listing/tour/deal per period.
// CONSOLIDATION: the on-demand LLM seller draft (app/actions/seller-updates)
// stays as the interactive button; this is the PROACTIVE weekly rail beside
// it — same gate, same audience, different trigger.

import type { SupabaseClient } from "@supabase/supabase-js"
import { isoWeekOf } from "@/lib/kernel/week-in-review"

type Svc = SupabaseClient<any, any, any>

const first = (name: string | null | undefined): string => (name ?? "").trim().split(/\s+/)[0] || "there"

// ── 1. Weekly seller update ─────────────────────────────────────────────────

export interface SellerWeekFacts {
  sellerFirstName: string | null
  address: string
  showingCount: number
  /** honest feedback themes (impressions/concerns), already filtered to this listing */
  feedbackNotes: string[]
  daysOnMarket: number | null
  /** optional market line (momentum) — "" when the data can't support one */
  marketLine?: string
}

/** PURE: the seller's weekly story — warm, specific, honest about a quiet week. */
export function composeWeeklySellerUpdate(f: SellerWeekFacts): { subject: string; body: string } {
  const hello = `Hi ${first(f.sellerFirstName)} —`
  const lines: string[] = [hello]
  if (f.showingCount > 0) {
    lines.push(`${f.showingCount} showing${f.showingCount === 1 ? "" : "s"} came through ${f.address} this week.`)
    if (f.feedbackNotes.length > 0) {
      lines.push(`What we heard: ${f.feedbackNotes.slice(0, 3).join("; ")}.`)
    } else {
      lines.push(`I'm following up with each agent for their buyers' reactions and will share what comes back.`)
    }
  } else {
    lines.push(`It was a quieter week at ${f.address} — no showings came through, and I'd rather tell you that straight than dress it up.`)
    lines.push(`Here's what I'm doing about it: refreshing where the listing appears, re-touching the agents who showed earlier interest, and watching the weekend traffic closely.`)
  }
  if (f.marketLine) lines.push(f.marketLine)
  if (f.daysOnMarket != null && f.daysOnMarket > 0) {
    lines.push(`We're ${f.daysOnMarket} day${f.daysOnMarket === 1 ? "" : "s"} in, and I'm watching how we compare to what's moving around us.`)
  }
  lines.push(`Next week: I'll keep the pressure on and you'll have this same update from me — and if anything meaningful happens sooner, you'll hear from me the same day.`)
  return { subject: `Your weekly update on ${f.address}`, body: lines.join(" ") }
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

/** PURE: the same-evening recap. Returns null when NO stop carries feedback or
 *  a rating — we never recap a tour the OS knows nothing about. */
export function composeTourRecap(f: TourRecapFacts): { subject: string; body: string } | null {
  const known = f.stops.filter((s) => s.rating != null || (s.feedback ?? "").trim())
  if (known.length === 0) return null
  const lines: string[] = [`Hi ${first(f.buyerFirstName)} —`]
  lines.push(`Great getting out there today. We saw ${f.stops.length} home${f.stops.length === 1 ? "" : "s"}; here's how the day settled for me.`)
  for (const s of known.slice(0, 5)) {
    const bits: string[] = [s.address]
    if (s.rating != null) bits.push(`you rated it ${s.rating}/5`)
    if ((s.feedback ?? "").trim()) bits.push(`your note: "${(s.feedback ?? "").trim().slice(0, 120)}"`)
    lines.push(`• ${bits.join(" — ")}.`)
  }
  const standout = pickStandout(f.stops)
  if (standout) {
    lines.push(`${standout.address} felt like the standout. If it's still on your mind tonight, let's talk numbers before the weekend crowd sees it — good homes are moving quickly and I'd rather we set the pace than react to it.`)
  } else {
    lines.push(`Nothing jumped out as THE one today — that's useful information, not a setback. I'll line up the next round based on what today taught us about your list.`)
  }
  return { subject: "Today's tour — how it settled", body: lines.join(" ") }
}

/** PURE: once-per-tour dedupe tag. */
export function tourRecapTag(tourId: string): string {
  return `[TOUR_RECAP] [${tourId}]`
}

// ── 3. Weekly deal note (the TC's all-parties status) ───────────────────────

const LOAN_CLIENT_LANGUAGE: Record<string, string> = {
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
  /** next milestones by date, already limited */
  upcoming: Array<{ name: string; date: string | null }>
  openTaskCount: number
}

/** PURE: where the deal stands, in the client's language. Returns null when
 *  the OS holds NOTHING to report (no loan state, no dates) — never a hollow note. */
export function composeDealNote(f: DealNoteFacts): { subject: string; body: string } | null {
  const hasLoan = !!(f.loanStatus && LOAN_CLIENT_LANGUAGE[f.loanStatus])
  if (!hasLoan && f.upcoming.length === 0) return null
  const where = f.address ? ` on ${f.address}` : ""
  const lines: string[] = [`Hi ${first(f.clientFirstName)} —`, `Here's where everything stands${where} this week.`]
  if (hasLoan) {
    lines.push(`Financing: ${LOAN_CLIENT_LANGUAGE[f.loanStatus!]}${f.loanStatus === "clear_to_close" && f.clearToCloseDate ? ` (as of ${f.clearToCloseDate})` : ""}.`)
  }
  if (f.upcoming.length > 0) {
    const dates = f.upcoming.slice(0, 3).map((m) => `${m.name.replace(/_/g, " ")}${m.date ? ` — ${m.date}` : ""}`)
    lines.push(`Coming up: ${dates.join("; ")}.`)
  }
  lines.push(f.openTaskCount > 0
    ? `Our team is working ${f.openTaskCount} open item${f.openTaskCount === 1 ? "" : "s"} behind the scenes — nothing is waiting on you right now, and if that changes you'll hear from me first.`
    : `Nothing is waiting on you right now — we're on track, and if that changes you'll hear from me first.`)
  return { subject: `Your deal this week${where}`, body: lines.join(" ") }
}

/** PURE: per-deal-per-week dedupe tag. */
export function dealWeeklyTag(transactionId: string, isoWeek: string): string {
  return `[TC_WEEKLY] [${transactionId}] [${isoWeek}]`
}

// ── Runners (ride the deal-health-scan cron; tag-deduped, gated, best-effort) ──

async function alreadyProposed(svc: Svc, brokerageId: string, tag: string): Promise<boolean> {
  const { data } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", brokerageId).ilike("rationale", `%${tag}%`).limit(1).maybeSingle()
  return !!data
}

export interface StoryDraftResult { scanned: number; proposed: number }

export async function runWeeklySellerUpdates(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<StoryDraftResult> {
  const out: StoryDraftResult = { scanned: 0, proposed: 0 }
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
    const feedbackNotes = showingRows.map((s) => (s.feedback ?? "").trim()).filter(Boolean).slice(0, 3)
    const dom = l.created_at ? Math.max(0, Math.floor((now.getTime() - new Date(l.created_at).getTime()) / 86_400_000)) : null

    const draft = composeWeeklySellerUpdate({
      sellerFirstName: (seller as any)?.first_name ?? null,
      address: l.address ?? "your home",
      showingCount: showingRows.length,
      feedbackNotes,
      daysOnMarket: dom,
    })
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
      rationale: `weekly seller update — the recurring story every seller deserves, drafted from this week's real activity. ${tag}`,
      channel: "portal",
      outreachReason: "relationship_maintenance",
    }, svc as any)
    if (r.ok) out.proposed++
  }
  return out
}

export async function runTourRecaps(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<StoryDraftResult> {
  const out: StoryDraftResult = { scanned: 0, proposed: 0 }
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
    const draft = composeTourRecap({
      buyerFirstName: (buyer as any)?.first_name ?? null,
      stops: ((stops ?? []) as any[]).map((s) => ({ address: s.property_address ?? "one of the homes", rating: s.rating ?? null, feedback: s.feedback ?? null })),
    })
    if (!draft) continue // no ratings/feedback recorded — never recap what we don't know
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
  const out: StoryDraftResult = { scanned: 0, proposed: 0 }
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
    const draft = composeDealNote({
      clientFirstName: (client as any)?.first_name ?? null,
      address: tx.property_address ?? null,
      loanStatus: (lender as any)?.underwriting_status ?? null,
      clearToCloseDate: (lender as any)?.clear_to_close_date ?? null,
      upcoming: ((milestones ?? []) as any[]).map((m) => ({ name: m.milestone_name ?? "next step", date: m.target_date ?? null })),
      openTaskCount: openTasks ?? 0,
    })
    if (!draft) continue // the OS holds nothing to report — never a hollow note
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

/** Autonomous: all three story rails for every brokerage (rides deal-health-scan). */
export async function runClientStoryDraftsAll(svc: Svc): Promise<{ brokerages: number; proposed: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(1000)
  let proposed = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const [a, t, d] = await Promise.all([
      runWeeklySellerUpdates(svc, b.id).catch(() => ({ scanned: 0, proposed: 0 })),
      runTourRecaps(svc, b.id).catch(() => ({ scanned: 0, proposed: 0 })),
      runWeeklyDealNotes(svc, b.id).catch(() => ({ scanned: 0, proposed: 0 })),
    ])
    proposed += a.proposed + t.proposed + d.proposed
  }
  return { brokerages: (brokerages ?? []).length, proposed }
}
