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
import { TRANSACTION_STATUSES_IN_ESCROW } from "@/lib/transactions/transaction-status"
// The ONE owner of the buyer-verdict vocabulary (CLAUDE.md §6). Static and pure —
// no I/O, no server-only dependency — so it costs the graph one small module rather
// than a dynamic import re-resolved once per tour inside runTourRecaps' loop.
import { tourInterestToRating } from "@/lib/behavior-learning/signal-mapping"

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

export interface TourStopFact {
  address: string
  rating: number | null
  feedback: string | null
  /** Minutes the buyer actually spent in the house — tour_stops.time_spent_minutes,
   *  DERIVED by the database (m564) from the day-of check-in/check-out stamps that
   *  app/actions/tour-planner.ts::stampTourStopPresence writes. Optional: a stop
   *  nobody checked into carries null, and null must stay SILENT rather than
   *  become "0 minutes". */
  minutesOnSite?: number | null
}

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
    // TIME ON SITE — the day-of check-in/check-out record (m564), added to the
    // brief because how long someone lingered is a real, grounded fact about the
    // day and it is the one the buyer themselves will remember. It ENRICHES a stop
    // that already carries a reaction; it never qualifies a stop on its own — the
    // `known` filter above is untouched, so a tour with stamps and no reactions
    // still yields NO brief. Minutes are only spoken when the OS actually watched
    // the clock: null stays silent rather than rendering as "0 minutes".
    if (s.minutesOnSite != null && s.minutesOnSite > 0) {
      bits.push(`they spent ${s.minutesOnSite} ${s.minutesOnSite === 1 ? "minute" : "minutes"} in the house`)
    }
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
 *  report (no loan state, no dates) — never a hollow note.
 *  ONE composer, two audiences (keep-one, no fork): the default "buyer" note is
 *  second-person on the loan; audience "seller" reframes the SAME facts for the
 *  other side of a dual-represented deal — the buyer's financing progress toward
 *  THEIR sale, never "your loan". */
export function dealNoteBrief(f: DealNoteFacts, audience: "buyer" | "seller" = "buyer"): StoryBrief | null {
  const hasLoan = !!(f.loanStatus && LOAN_CLIENT_LANGUAGE[f.loanStatus])
  if (!hasLoan && f.upcoming.length === 0) return null
  const facts: string[] = []
  if (f.address) facts.push(`Property: ${f.address}.`)
  if (hasLoan) {
    facts.push(audience === "buyer"
      ? `Loan status (use this exact client-language framing): "${LOAN_CLIENT_LANGUAGE[f.loanStatus!]}"${f.loanStatus === "clear_to_close" && f.clearToCloseDate ? ` (recorded ${f.clearToCloseDate})` : ""}.`
      : `The BUYER'S financing status — reframe in third person for the seller (the buyer-language version is "${LOAN_CLIENT_LANGUAGE[f.loanStatus!]}"; the seller hears what the buyer's lender progress means for THEIR sale — e.g. "the buyer's loan is in underwriting, a normal step toward your closing" — never "your loan")${f.loanStatus === "clear_to_close" && f.clearToCloseDate ? ` (recorded ${f.clearToCloseDate})` : ""}.`)
  }
  if (f.upcoming.length > 0) {
    facts.push(`Upcoming dates: ${f.upcoming.slice(0, 3).map((m) => `${m.name.replace(/_/g, " ")}${m.date ? ` on ${m.date}` : ""}`).join("; ")}.`)
  }
  facts.push(f.openTaskCount > 0
    ? `The team is working ${f.openTaskCount} open item(s) behind the scenes; nothing is currently waiting on the client — say that calmly and that they'll hear first if it changes.`
    : `Nothing is waiting on the client right now — close on that reassurance.`)
  return {
    goal: audience === "buyer"
      ? "the weekly all-parties status note on an active deal — where everything stands, in the client's language"
      : "the weekly all-parties status note to the SELLER on their sale — where the buyer's side stands and what it means for their closing, in the seller's language",
    audience,
    situation: audience === "buyer"
      ? `Client under contract${f.address ? ` on ${f.address}` : ""}; the most nervous stretch of the deal — calm, specific, zero jargon.`
      : `Home seller under contract${f.address ? ` on ${f.address}` : ""}; waiting on the buyer's due diligence + financing — calm, specific, zero jargon.`,
    facts,
    recipientFirstName: f.clientFirstName,
  }
}

/** PURE: per-deal-per-week dedupe tag (buyer/primary-client side). */
export function dealWeeklyTag(transactionId: string, isoWeek: string): string {
  return `[TC_WEEKLY] [${transactionId}] [${isoWeek}]`
}

/** PURE: per-deal-per-week dedupe tag for the SELLER side of a dual-represented
 *  deal — separate tag so each side dedupes independently. */
export function dealWeeklySellerTag(transactionId: string, isoWeek: string): string {
  return `[TC_WEEKLY_SELLER] [${transactionId}] [${isoWeek}]`
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
 *  the draft entirely — an honest absence, never template prose. Exported so
 *  every journey frontier (post-close concierge included) authors the SAME way. */
export async function authorStory(brief: StoryBrief): Promise<{ subject: string; body: string } | null> {
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
    .select("id, contact_id, agent_id, tour_date")
    .eq("brokerage_id", brokerageId).gte("tour_date", since).lte("tour_date", now.toISOString().slice(0, 10))
    .not("contact_id", "is", null).limit(50)
  for (const t of ((tours ?? []) as any[])) {
    out.scanned++
    const tag = tourRecapTag(t.id)
    if (await alreadyProposed(svc, brokerageId, tag)) continue
    // TOMBSTONE (orphan doctrine §1.1 — a DUPLICATE existed; merged onto the survivor).
    // This read was `.select("property_address, rating, feedback")`. tour_stops carries
    // TWO spellings of the buyer's verdict and only ONE has writers:
    //   · rating / feedback              — WRITERLESS. No code writes them (the whole
    //     tree's tour_stops call chains were read comment-stripped), and no DB trigger,
    //     routine or column DEFAULT does either — pg_trigger and pg_proc are both empty
    //     for tour_stops on the live project, and both columns default NULL.
    //   · buyer_interest_level / buyer_note — THE SURVIVORS, written by
    //     app/actions/tour-planner.ts:896 (rateTourStop) and :966 (completeTour), and
    //     already read by lib/kernel/tour-optimizer.ts:599.
    // So every stop came back {rating: null, feedback: null}, tourRecapBrief's
    // "never narrate a day the OS didn't see" guard (the `if (!brief) continue` below)
    // returned null for every tour ever planned, and NOT ONE tour recap — nor the
    // offer-readiness bridge task after it — has ever fired.
    // The verdict is translated through the ONE owner of that vocabulary,
    // lib/behavior-learning/signal-mapping.ts::tourInterestToRating, rather than a
    // private map here (CLAUDE.md §6); the pure brief/standout functions keep their
    // 1-5 contract untouched.
    const [{ data: buyer }, { data: stops }] = await Promise.all([
      svc.from("contacts").select("first_name").eq("id", t.contact_id).maybeSingle(),
      // time_spent_minutes joins the read (orphan doctrine §1.2, wave BA): it was
      // WRITERLESS — no code writer, no trigger, no routine, no default, verified
      // live — and its only appearance in the tree was a SELECT list nothing read.
      // The owner ruled showings.completed_at/duration_minutes is NOT its
      // duplicate ("tours and showings are 2 different"), so the missing half was
      // BUILT rather than deleted: app/actions/tour-planner.ts::stampTourStopPresence
      // stamps the day-of arrival/departure and m564 derives this column from them.
      // This read is one of its two real consumers; the other is the CRM day-of tab.
      svc.from("tour_stops").select("property_address, buyer_interest_level, buyer_note, time_spent_minutes").eq("tour_id", t.id).limit(12),
    ])
    const stopFacts = ((stops ?? []) as any[]).map((s) => ({
      address: s.property_address ?? "one of the homes",
      rating: tourInterestToRating(s.buyer_interest_level),
      feedback: s.buyer_note ?? null,
      minutesOnSite: s.time_spent_minutes ?? null,
    }))
    const brief = tourRecapBrief({
      buyerFirstName: (buyer as any)?.first_name ?? null,
      stops: stopFacts,
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

    // RECAP → OFFER BRIDGE: a standout reaction is an offer-readiness SIGNAL —
    // the agent gets the prep task (comps + net sheet) the same evening, once
    // per tour, so the momentum the recap creates lands on someone's list.
    // Same facts the brief was built from — re-deriving them from the raw rows here
    // is how the two halves drifted apart in the first place.
    const standoutStop = pickStandout(stopFacts)
    if (r.ok && standoutStop && t.agent_id) {
      const bridgeTag = `[TOUR_STANDOUT] [${t.id}]`
      const { data: priorTask } = await svc.from("tasks").select("id")
        .eq("brokerage_id", brokerageId).ilike("description", `%${bridgeTag}%`).limit(1).maybeSingle()
      if (!priorTask) {
        // LIVE-FK verified: tours.agent_id → agents(id), which is exactly what
        // tasks.assigned_to_agent_id requires — use it directly.
        await svc.from("tasks").insert({
          brokerage_id: brokerageId,
          contact_id: t.contact_id,
          assigned_to_agent_id: t.agent_id,
          title: `Offer-readiness: today's buyer rated ${standoutStop.address} ${standoutStop.rating}/5`,
          description: `The tour recap flagged ${standoutStop.address} as the standout. Prep the numbers tonight — comps, band, net sheet — so if they say "let's talk," you set the pace instead of reacting to the weekend crowd. ${bridgeTag}`,
          due_date: new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10),
          assignee_type: "agent",
          source: "tour_standout",
          status: "pending",
        }).then(() => {}, () => {})
      }
    }
  }
  return out
}

export async function runWeeklyDealNotes(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<StoryDraftResult> {
  const out: StoryDraftResult = { scanned: 0, proposed: 0, skippedNoCopy: 0 }
  const isoWeek = isoWeekOf(now)

  const { data: txs } = await svc.from("transactions")
    .select("id, property_address, buyer_contact_id, contact_id, seller_contact_id, listing_id, status")
    .eq("brokerage_id", brokerageId).in("status", [...TRANSACTION_STATUSES_IN_ESCROW]).limit(200)
  for (const tx of ((txs ?? []) as any[])) {
    const clientId = tx.buyer_contact_id ?? tx.contact_id
    // Distinct seller contact on a dual-represented deal — the side that used to
    // get NOTHING post-listing from this rail.
    const sellerId: string | null =
      tx.seller_contact_id && tx.seller_contact_id !== clientId ? tx.seller_contact_id : null
    if (!clientId && !sellerId) continue
    out.scanned++
    const tag = dealWeeklyTag(tx.id, isoWeek)
    const sellerTag = dealWeeklySellerTag(tx.id, isoWeek)
    // Each side dedupes on its OWN tag, so a retry after a partial week never
    // skips the side that didn't land.
    const needBuyer = !!clientId && !(await alreadyProposed(svc, brokerageId, tag))
    let needSeller  = !!sellerId && !(await alreadyProposed(svc, brokerageId, sellerTag))

    // DE-CONFLICT with the listing-side weekly seller update: the seller-updates cron
    // (app/api/cron/seller-updates) selects listings with lifecycle_stage IN
    // ('active','under_contract') — when this transaction's listing is in that selection
    // set the seller is already getting the weekly listing-activity update, so we skip
    // rather than double-note. Detection = the cron's own selection predicate (the same
    // lifecycle_stage filter it queries on), not a guess about what it might have sent.
    if (needSeller && tx.listing_id) {
      const { data: lst } = await svc.from("listings").select("lifecycle_stage")
        .eq("id", tx.listing_id).maybeSingle()
      const stage = String((lst as any)?.lifecycle_stage ?? "")
      if (stage === "active" || stage === "under_contract") needSeller = false
    }
    if (!needBuyer && !needSeller) continue

    const [{ data: lender }, { data: milestones }, { count: openTasks }] = await Promise.all([
      svc.from("transaction_lenders").select("underwriting_status, clear_to_close_date").eq("transaction_id", tx.id).limit(1).maybeSingle(),
      svc.from("transaction_milestones").select("milestone_name, target_date").eq("transaction_id", tx.id).eq("status", "pending").order("target_date", { ascending: true }).limit(3),
      svc.from("tasks").select("id", { count: "exact", head: true }).eq("transaction_id", tx.id).eq("status", "pending"),
    ])
    // Same grounded facts for both sides; the composer reframes per audience.
    const sharedFacts = {
      address: tx.property_address ?? null,
      loanStatus: (lender as any)?.underwriting_status ?? null,
      clearToCloseDate: (lender as any)?.clear_to_close_date ?? null,
      upcoming: ((milestones ?? []) as any[]).map((m) => ({ name: m.milestone_name ?? "next step", date: m.target_date ?? null })),
      openTaskCount: openTasks ?? 0,
    }
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

    if (needBuyer) {
      const { data: client } = await svc.from("contacts").select("first_name").eq("id", clientId).maybeSingle()
      const brief = dealNoteBrief({ ...sharedFacts, clientFirstName: (client as any)?.first_name ?? null })
      if (!brief) continue // the OS holds nothing to report — never a hollow note (for either side)
      const draft = await authorStory(brief)
      if (draft) {
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
      } else out.skippedNoCopy++
    }

    if (needSeller && sellerId) {
      const { data: sellerContact } = await svc.from("contacts").select("first_name").eq("id", sellerId).maybeSingle()
      const sellerBrief = dealNoteBrief({ ...sharedFacts, clientFirstName: (sellerContact as any)?.first_name ?? null }, "seller")
      if (!sellerBrief) continue
      const sellerDraft = await authorStory(sellerBrief)
      if (sellerDraft) {
        const r = await proposeClientMessage({
          brokerageId,
          agentKind: "deal_coordinator",
          entityType: "transaction",
          entityId: tx.id,
          recipientContactId: sellerId,
          audience: "seller",
          subject: sellerDraft.subject,
          body: sellerDraft.body,
          rationale: `weekly deal note (seller side) — the same all-parties status, reframed for the seller of a dual-represented deal. ${sellerTag}`,
          channel: "portal",
          outreachReason: "relationship_maintenance",
        }, svc as any)
        if (r.ok) out.proposed++
      } else out.skippedNoCopy++
    }
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
    const [{ data: buyer }, { count: portalCount, error: portalCountError }, { data: listingRows }] = await Promise.all([
      svc.from("contacts").select("first_name").eq("id", contactId).maybeSingle(),
      // Tenant-bounded even though contactId came from a brokerage-scoped scan: this is the
      // SERVICE client, so RLS is not the bound — the filter is. It is writable now only because
      // the portal-activity writers stamp brokerage_id; before that, scoping this read would have
      // returned zero for every buyer. The count feeds "how engaged has this buyer been", so a
      // refused read reporting 0 would author a story saying they were quiet. Destructured below.
      svc.from("client_portal_activity").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("contact_id", contactId).gte("created_at", since),
      listingIds.length
        ? svc.from("listings").select("id, address, status").in("id", listingIds.slice(0, 20))
        : Promise.resolve({ data: [] } as any),
    ])
    if (portalCountError) {
      console.error(`[client-story-drafts] portal-activity count refused for contact ${contactId} — story understates engagement:`, portalCountError.message)
    }
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
    const { runPostCloseConcierge } = await import("@/lib/kernel/postclose-concierge")
    const [a, t, d, bs, pc] = await Promise.all([
      runWeeklySellerUpdates(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
      runTourRecaps(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
      runWeeklyDealNotes(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
      runBuyerSearchStories(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
      runPostCloseConcierge(svc, b.id).catch(() => ({ scanned: 0, proposed: 0, skippedNoCopy: 0 })),
    ])
    proposed += a.proposed + t.proposed + d.proposed + bs.proposed + pc.proposed
  }
  return { brokerages: (brokerages ?? []).length, proposed }
}
