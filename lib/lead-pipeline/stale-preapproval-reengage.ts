// lib/lead-pipeline/stale-preapproval-reengage.ts
//
// STALE PRE-APPROVAL RE-ENGAGE — the pure engine (the pre-contract financing mirror of the
// recovery suite).
//
// THE GAP (verified PARTIAL → genuine white space): financing-pit-stop watches
// buyer_financial_profiles.pre_approval_expires_at, but ONLY for buyers in an ACTIVE deal
// (status active/under_contract/closing), where it races a rate refresh. A buyer who got
// pre-approved, browsed, and then went QUIET — with their pre-approval now expired and NO
// active deal — falls through every net: financing-pit-stop ignores them (no deal), the
// stale-contact monitor would only reach them generically at 14 days with no financing
// context. A buyer whose pre-approval lapsed literally CAN'T make a competitive offer; this
// is the moment to refresh their financing and get them back in the hunt before they drift to
// another agent.
//
// PURE (no I/O): given the pre-approval expiry, when the buyer was last touched, and whether
// they're a cash buyer / in an active deal, decide whether (and how urgently) to re-engage.
// HONEST: a CASH buyer has no pre-approval to go stale; an in-deal buyer is financing-pit-
// stop's job; a recently-touched buyer is being worked (don't over-touch); no expiry on file
// → nothing to act on. None of those fabricate a re-engagement.

export type PreApprovalUrgency = "expired" | "expiring" | "not_eligible"

export interface PreApprovalReengageInput {
  /** ISO date the pre-approval expires (buyer_financial_profiles.pre_approval_expires_at) */
  preApprovalExpiresAt: string | null
  /** ISO "now" — injectable for deterministic tests */
  now: string
  /** ISO timestamp the buyer was last contacted (contacts.last_contacted_at) */
  lastContactedAt?: string | null
  isCashBuyer?: boolean
  /** true when the buyer is already in an active transaction (financing-pit-stop owns those) */
  inActiveDeal?: boolean
  buyerName?: string | null
}

export interface PreApprovalReengagePlan {
  eligible: boolean
  urgency: PreApprovalUrgency
  daysToExpiry: number | null
  /** the buyer has gone quiet (worth re-engaging vs being actively worked) */
  quiet: boolean
  /** route to the AI ISA for a re-qualification call (expired only) */
  recommendCall: boolean
  agentBrief: string
  /** the gated buyer-facing re-engagement message (deterministic fallback) */
  buyerOutreach: string
  reason: string
}

// Re-engage when the pre-approval is expired or within this window; only buyers quiet for
// at least QUIET_DAYS (otherwise their agent is actively working them).
export const EXPIRING_WINDOW_DAYS = 14
export const QUIET_DAYS = 14

function buyerLabel(p: PreApprovalReengageInput): string {
  return p.buyerName ?? "your buyer"
}

/** Decide the stale-pre-approval re-engagement play for one buyer. Pure. */
export function planPreApprovalReengage(input: PreApprovalReengageInput): PreApprovalReengagePlan {
  const base = { daysToExpiry: null as number | null, quiet: false, recommendCall: false }
  const no = (reason: string): PreApprovalReengagePlan => ({ ...base, eligible: false, urgency: "not_eligible", agentBrief: "", buyerOutreach: "", reason })

  if (input.isCashBuyer) return no("Cash buyer — no pre-approval to go stale.")
  if (input.inActiveDeal) return no("Buyer is in an active deal — financing-pit-stop owns the financing window.")
  if (!input.preApprovalExpiresAt) return no("No pre-approval expiration on file.")

  const daysToExpiry = Math.floor((new Date(input.preApprovalExpiresAt).getTime() - new Date(input.now).getTime()) / 86_400_000)

  // Quiet gate: a recently-touched buyer is being worked — don't pile on.
  const quiet = !input.lastContactedAt ||
    (new Date(input.now).getTime() - new Date(input.lastContactedAt).getTime()) / 86_400_000 >= QUIET_DAYS
  if (!quiet) return { ...base, eligible: false, urgency: daysToExpiry < 0 ? "expired" : "expiring", daysToExpiry, reason: "Buyer was recently contacted — their agent is already on it.", agentBrief: "", buyerOutreach: "" }

  if (daysToExpiry > EXPIRING_WINDOW_DAYS) return no("Pre-approval still has a healthy runway.")

  const expired = daysToExpiry < 0
  const urgency: PreApprovalUrgency = expired ? "expired" : "expiring"

  const agentBrief = expired
    ? `${buyerLabel(input)}'s mortgage pre-approval EXPIRED ${Math.abs(daysToExpiry)} day(s) ago and they've gone quiet. Right now they can't make a competitive offer. Re-engage to refresh their financing and re-qualify — recommend a quick call so they're offer-ready again before they drift to another agent.`
    : `${buyerLabel(input)}'s pre-approval expires in ${daysToExpiry} day(s) and they've gone quiet. A gentle "let's keep you offer-ready" nudge refreshes their financing before it lapses.`

  const buyerOutreach = expired
    ? `Quick heads-up — your mortgage pre-approval has expired, which means we'd want to refresh it before making any offers (sellers look for a current pre-approval). The good news: it's usually a fast update with your lender. Want me to connect you so you're ready to move the moment the right home shows up?`
    : `Just keeping you offer-ready — your mortgage pre-approval is about to expire. A quick refresh with your lender keeps you in a strong position when the right home comes along. Want me to help line that up?`

  return { eligible: true, urgency, daysToExpiry, quiet, recommendCall: expired, agentBrief, buyerOutreach, reason: expired ? "Pre-approval expired + buyer quiet — re-qualify now." : "Pre-approval expiring soon + buyer quiet — refresh." }
}
