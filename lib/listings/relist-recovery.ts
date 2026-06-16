// lib/listings/relist-recovery.ts
//
// EXPIRED/WITHDRAWN LISTING RE-LIST RECOVERY — the pure engine (the seller-side mirror of
// offer-rejection recovery).
//
// THE GAP (verified white space, from the follow-up audit): when a listing EXPIRES or is
// WITHDRAWN, LISTING_EXPIRED / LISTING_CANCELLED fires and a portal card is written — but
// NOTHING re-engages the seller. No "let's reposition and re-list" conversation, no AI-ISA
// call, no agent nudge. An expired/withdrawn listing is a CRITICAL retention moment: the
// seller still wants to sell, the relationship is intact for now, and competitors pounce fast
// ("I know a buyer", "let me re-list at a sharper price"). Missing this window quietly loses
// the listing to another brokerage.
//
// PURE (no I/O): given the status + when it transitioned, decide whether (and how urgently)
// to re-engage, and compose the deterministic fallback copy. HONEST: only true terminal
// no-sale statuses (expired/withdrawn/cancelled) qualify — a SOLD/closed listing is a win,
// never a "re-list" target; and past the window the play expires rather than nagging.

export type RelistUrgency = "acute" | "followup" | "expired" | "not_eligible"

export interface RelistRecoveryInput {
  /** the listing's current status */
  status: string | null
  /** ISO timestamp it went expired/withdrawn (stage_updated_at ?? updated_at) */
  transitionAt: string | null
  /** ISO "now" — injectable for deterministic tests */
  now: string
  address?: string | null
}

export interface RelistPlan {
  eligible: boolean
  urgency: RelistUrgency
  daysSince: number | null
  /** route to the AI ISA for a re-list call (acute window only) */
  recommendCall: boolean
  agentBrief: string
  /** the gated seller-facing re-list message (deterministic fallback) */
  sellerOutreach: string
  reason: string
}

// Sellers mull longer than buyers; the acute window is days, the soft tail weeks.
export const ACUTE_WINDOW_DAYS = 7
export const FOLLOWUP_WINDOW_DAYS = 45

// True terminal no-sale statuses worth a re-list conversation.
const RELIST_STATUSES = ["expired", "withdrawn", "cancelled", "canceled"]

export function isRelistStatus(status: string | null): boolean {
  return status != null && RELIST_STATUSES.includes(status.toLowerCase())
}

function homeLabel(p: RelistRecoveryInput): string {
  return p.address ? `your home at ${p.address}` : "your home"
}

/** Decide the re-list recovery play for one expired/withdrawn listing. Pure. */
export function planRelistRecovery(input: RelistRecoveryInput): RelistPlan {
  const base = { daysSince: null as number | null, recommendCall: false }

  if (!isRelistStatus(input.status)) {
    return { ...base, eligible: false, urgency: "not_eligible", agentBrief: "", sellerOutreach: "", reason: "Listing is not in an expired/withdrawn/cancelled state — nothing to re-list." }
  }
  if (!input.transitionAt) {
    return { ...base, eligible: false, urgency: "not_eligible", agentBrief: "", sellerOutreach: "", reason: "No transition timestamp on file." }
  }

  const daysSince = (new Date(input.now).getTime() - new Date(input.transitionAt).getTime()) / 86_400_000
  if (daysSince < 0) {
    return { ...base, daysSince, eligible: false, urgency: "not_eligible", agentBrief: "", sellerOutreach: "", reason: "Transition timestamp is in the future." }
  }
  if (daysSince > FOLLOWUP_WINDOW_DAYS) {
    return { ...base, daysSince, eligible: false, urgency: "expired", agentBrief: "", sellerOutreach: "", reason: "Past the recovery window — a re-list nudge now would feel out of the blue." }
  }

  const acute = daysSince <= ACUTE_WINDOW_DAYS
  const urgency: RelistUrgency = acute ? "acute" : "followup"

  const agentBrief = acute
    ? `${homeLabel(input)} just came off the market without selling — the highest-leverage moment to retain this seller. Reach out now with a reposition plan (pricing vs comps, photos/staging, exposure) before a competitor calls with "I have a buyer." Recommend a quick call.`
    : `${homeLabel(input)} came off the market recently without selling. Re-engage with a fresh reposition angle before the seller drifts to another brokerage.`

  const sellerOutreach = acute
    ? `I saw ${homeLabel(input)} came off the market — I know that's frustrating when you're ready to move. The good news: most homes that don't sell the first time just need a sharper strategy, not a worse market. I've pulled a fresh read on pricing, exposure, and presentation. Can we grab 15 minutes to map out a re-launch that gets it sold?`
    : `Following up on ${homeLabel(input)} — when you're ready to give it another run, I've got a refreshed plan on pricing and marketing that I think will make the difference. No pressure at all; I'm here whenever the timing's right.`

  return { eligible: true, urgency, daysSince, recommendCall: acute, agentBrief, sellerOutreach, reason: acute ? "Acute re-list window (≤7d) — reach out now." : "Follow-up window — warm re-list re-engagement." }
}
