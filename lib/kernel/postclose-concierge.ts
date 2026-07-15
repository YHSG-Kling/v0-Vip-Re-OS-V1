// lib/kernel/postclose-concierge.ts
//
// POST-CLOSE MOVE-IN CONCIERGE (Journey #6's opening frontiers, per the
// owner's journey/frontier spec) — the lifetime-customer on-ramp nothing
// owned: the stretch AFTER the closing gift where loyalty is actually won.
// Three frontiers, each keyed to the deal's close_date:
//
//   • MOVE-IN GUIDE (days 1–14) — the practical first-week help: utilities,
//     address changes, locks, the boring-but-vital list nobody remembers.
//   • SETTLE-IN CHECK (days 7–21) — "how's the house treating you", small
//     issues surfaced early while the agent can still be the hero.
//   • 30-DAY CARE CHECK (days 30–60) — the relationship turn: anything the
//     home needs, the agent's trusted-vendor bench, staying the client's
//     real-estate person for life.
//
// FRONTIER CONTRACT (spec): trigger = closed transaction entering each day
// window · context = deal + buyer facts · decisioning = pure window/eligibility
// gates · drafting = brief → the ONE charter-governed authoring path (no
// hardcoded copy; model failure = honest skip) · approval = GATED proposal
// (agent approves, nothing auto-sends) · memory write-back = rationale tag,
// once per transaction per frontier · error policy = best-effort per row,
// never blocks the cron. BUYER-SIDE ONLY by design: the seller's post-sale
// care is owned by the gift/anniversary rails (consolidation — no overlap).

import type { SupabaseClient } from "@supabase/supabase-js"
import type { StoryBrief } from "@/lib/kernel/client-story-drafts"

type Svc = SupabaseClient<any, any, any>

export type PostCloseFrontier = "move_in_guide" | "settle_in_check" | "care_30d"

export interface FrontierWindow { frontier: PostCloseFrontier; fromDay: number; toDay: number }

/** The journey's frontier windows, in days since close (inclusive). */
export const POSTCLOSE_WINDOWS: FrontierWindow[] = [
  { frontier: "move_in_guide", fromDay: 1, toDay: 14 },
  { frontier: "settle_in_check", fromDay: 7, toDay: 21 },
  { frontier: "care_30d", fromDay: 30, toDay: 60 },
]

/** PURE: which frontiers are due for a deal closed N days ago. */
export function dueFrontiers(daysSinceClose: number): PostCloseFrontier[] {
  return POSTCLOSE_WINDOWS.filter((w) => daysSinceClose >= w.fromDay && daysSinceClose <= w.toDay).map((w) => w.frontier)
}

/** PURE: once-per-transaction-per-frontier dedupe tag. */
export function postCloseTag(transactionId: string, frontier: PostCloseFrontier): string {
  return `[POSTCLOSE] [${transactionId}] [${frontier}]`
}

export interface PostCloseFacts {
  buyerFirstName: string | null
  address: string | null
  daysSinceClose: number
  /** the tenant has a vendor bench the agent can draw on (marketplace fact) */
  hasVendorBench: boolean
}

/** PURE: the frontier's brief — grounded facts + the instructions the writer
 *  must follow. Content is AUTHORED, never templated. */
export function postCloseBrief(frontier: PostCloseFrontier, f: PostCloseFacts): StoryBrief {
  const home = f.address ?? "the new home"
  if (frontier === "move_in_guide") {
    return {
      goal: "the new homeowner's first-week move-in guide — practical, warm, zero sales content",
      audience: "buyer",
      situation: `Just closed on ${home} ${f.daysSinceClose} day(s) ago; buried in boxes and logistics.`,
      facts: [
        `They closed ${f.daysSinceClose} day(s) ago on ${home}.`,
        `Cover the practical first-week items as helpful reminders (not a lecture): utilities into their name, USPS address change, driver's license/insurance updates, re-keying or smart-lock reset, locating the water shutoff and breaker panel.`,
        `Offer the agent's help arranging any of it. HONESTY RULE: no upsell, no market talk — this note exists purely to be useful.`,
      ],
      recipientFirstName: f.buyerFirstName,
    }
  }
  if (frontier === "settle_in_check") {
    return {
      goal: "the one-week settle-in check — how's the house treating you, small issues surfaced early",
      audience: "buyer",
      situation: `About a week into ${home}; small surprises (a tricky garage door, a mystery switch) surface now.`,
      facts: [
        `They've been in ${home} roughly ${f.daysSinceClose} days.`,
        `Ask genuinely how the house is treating them and invite the small stuff — anything the inspection didn't catch, anything that needs a pro.`,
        f.hasVendorBench
          ? `The agent keeps a bench of trusted local pros (handyman, locksmith, HVAC) and can connect them same-day — offer it naturally.`
          : `Offer the agent's help finding the right local pro for anything that comes up.`,
        `HONESTY RULE: no market content, no referral ask — this is care, not marketing.`,
      ],
      recipientFirstName: f.buyerFirstName,
    }
  }
  return {
    goal: "the 30-day care check — the relationship turn from 'my agent' to 'my real-estate person for life'",
    audience: "buyer",
    situation: `A month into ${home}; the dust has settled and real homeownership questions start.`,
    facts: [
      `They closed on ${home} about ${f.daysSinceClose} days ago.`,
      `Check in on the first month; mention the agent stays their resource — seasonal maintenance questions, a contractor they can trust, what a renovation might do for value someday.`,
      f.hasVendorBench ? `The trusted-vendor bench remains one text away.` : ``,
      `HONESTY RULE: warm and unhurried; NO referral ask and NO listing pitch — the relationship IS the point.`,
    ].filter(Boolean),
    recipientFirstName: f.buyerFirstName,
  }
}

export interface ConciergeResult { scanned: number; proposed: number; skippedNoCopy: number }

/** Runner: closed deals inside the 60-day journey window; each due frontier
 *  proposes ONCE per transaction (tag write-back = the journey memory). */
export async function runPostCloseConcierge(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<ConciergeResult> {
  const out: ConciergeResult = { scanned: 0, proposed: 0, skippedNoCopy: 0 }
  const oldest = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10)

  const { data: txs } = await svc.from("transactions")
    .select("id, property_address, buyer_contact_id, close_date")
    .eq("brokerage_id", brokerageId).eq("status", "closed")
    .not("buyer_contact_id", "is", null).not("close_date", "is", null)
    .gte("close_date", oldest).limit(200)

  // One marketplace probe per brokerage (the vendor-bench fact).
  const { count: vendorCount } = await svc.from("vendors")
    .select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
  const hasVendorBench = (vendorCount ?? 0) > 0

  for (const tx of ((txs ?? []) as any[])) {
    out.scanned++
    const daysSinceClose = Math.floor((now.getTime() - new Date(tx.close_date).getTime()) / 86_400_000)
    const due = dueFrontiers(daysSinceClose)
    if (due.length === 0) continue

    const { data: buyer } = await svc.from("contacts").select("first_name").eq("id", tx.buyer_contact_id).maybeSingle()
    for (const frontier of due) {
      const tag = postCloseTag(tx.id, frontier)
      const { data: prior } = await svc.from("agent_client_messages").select("id")
        .eq("brokerage_id", brokerageId).ilike("rationale", `%${tag}%`).limit(1).maybeSingle()
      if (prior) continue

      const { authorStory } = await import("@/lib/kernel/client-story-drafts")
      const draft = await authorStory(postCloseBrief(frontier, {
        buyerFirstName: (buyer as any)?.first_name ?? null,
        address: tx.property_address ?? null,
        daysSinceClose,
        hasVendorBench,
      }))
      if (!draft) { out.skippedNoCopy++; continue }

      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const r = await proposeClientMessage({
        brokerageId,
        agentKind: "deal_coordinator",
        entityType: "transaction",
        entityId: tx.id,
        recipientContactId: tx.buyer_contact_id,
        audience: "buyer",
        subject: draft.subject,
        body: draft.body,
        rationale: `post-close concierge (${frontier.replace(/_/g, " ")}) — the lifetime-customer on-ramp; pure care, no marketing. ${tag}`,
        channel: "portal",
        outreachReason: "relationship_maintenance",
      }, svc as any)
      if (r.ok) out.proposed++
    }
  }
  return out
}
