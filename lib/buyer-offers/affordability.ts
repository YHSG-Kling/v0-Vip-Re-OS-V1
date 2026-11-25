// lib/buyer-offers/affordability.ts
// ─────────────────────────────────────────────────────────────────────────────
// BUYER SELF-SERVE AFFORDABILITY — the honest READS a buyer's numbers get in the portal (pre-approval status, the fit verdict,
// the them-first framing). PURE.
//
// TOMBSTONE (wave 156, lane 156H, round 2) — `AFFORDABILITY_DEFAULTS` (a 6.5% rate, 20% down, 30 years, a 1.1% tax rate, 0.35%
// insurance and 0.5% PMI applied whenever the buyer left a figure blank) and `estimateMonthlyPayment` (the PITI math over those
// defaults) stood here. A default rate shown as the buyer's payment is a figure nobody gave us. SURVIVOR:
// lib/calculators/engine.ts:527 (runCalculator "buyer_payment"), reached through lib/calculators/buyer-payment.ts:28 buyerPaymentFor — every rate, tax and insurance figure
// is the buyer's own (or the property's county bill, labelled as such), a blank one answers "Enter a value", and every result
// carries its assumptions. Callers moved with it: lib/buyer-offers/home-comparison.ts, the portal's BuyerOfferToolsCard and
// AnalyzeAnyHomeCard, app/actions/calculators.ts calculatePropertyPayment (the public listing payment card).

const round2 = (n: number) => Math.round(n * 100) / 100

export type PreApprovalState = "none" | "active" | "expiring" | "expired"

/** Days before expiry within which a pre-approval reads as "expiring soon" (refresh nudge). */
export const PREAPPROVAL_EXPIRING_DAYS = 30

export interface PreApprovalStatus {
  state: PreApprovalState
  amount: number | null
  /** Whole days until expiry (negative = already expired); null when no expiry on file. */
  daysToExpiry: number | null
}

/**
 * preApprovalStatus — PURE. An honest read of the buyer's pre-approval so the affordability tool
 * never treats an EXPIRED approval as a real ceiling. A present amount with no expiry reads as
 * active (we can't claim it's stale without a date); within 30 days reads expiring; past the date
 * reads expired. `now` injectable.
 */
export function preApprovalStatus(
  amount: number | null | undefined,
  expiresAt: string | null | undefined,
  now: Date,
): PreApprovalStatus {
  const amt = typeof amount === "number" && amount > 0 ? amount : null
  if (!amt) return { state: "none", amount: null, daysToExpiry: null }
  if (!expiresAt) return { state: "active", amount: amt, daysToExpiry: null }
  const t = new Date(expiresAt).getTime()
  if (Number.isNaN(t)) return { state: "active", amount: amt, daysToExpiry: null }
  const days = Math.floor((t - now.getTime()) / 86_400_000)
  if (days < 0) return { state: "expired", amount: amt, daysToExpiry: days }
  if (days <= PREAPPROVAL_EXPIRING_DAYS) return { state: "expiring", amount: amt, daysToExpiry: days }
  return { state: "active", amount: amt, daysToExpiry: days }
}

export type AffordabilityVerdict = "within_budget" | "stretch" | "over_budget" | "unknown"

export interface AffordabilityReadInput {
  price: number
  monthlyTotal: number
  /** Lender pre-approval amount on file (the hard ceiling the lender already cleared). */
  preApprovalAmount?: number | null
  /** The buyer's comfortable monthly housing budget, if they enter one. */
  maxMonthlyBudget?: number | null
  /** The most the buyer says they could STRETCH to each month (their own figure). "stretch" is read only against it — the
   *  invented 10% band this used to apply (`maxMonthlyBudget * 1.1`) is gone (wave 156H). */
  stretchMonthlyBudget?: number | null
}

export interface AffordabilityRead {
  /** price ≤ pre-approval (null when no pre-approval on file). */
  withinPreApproval: boolean | null
  /** pre-approval − price (negative = over the lender's ceiling). null when no pre-approval. */
  headroomToPreApproval: number | null
  verdict: AffordabilityVerdict
  reason: string
}

/**
 * affordabilityRead — PURE. Honest read of whether the home fits: against the lender's
 * pre-approval (the real ceiling) and, when the buyer enters one, their comfortable monthly
 * budget. No fabrication — with no pre-approval and no budget, the verdict is "unknown".
 */
export function affordabilityRead(input: AffordabilityReadInput): AffordabilityRead {
  const withinPreApproval =
    typeof input.preApprovalAmount === "number" && input.preApprovalAmount > 0
      ? input.price <= input.preApprovalAmount
      : null
  const headroomToPreApproval =
    typeof input.preApprovalAmount === "number" && input.preApprovalAmount > 0
      ? round2(input.preApprovalAmount - input.price)
      : null

  // Over the lender's ceiling is the strongest signal.
  if (withinPreApproval === false) {
    return { withinPreApproval, headroomToPreApproval, verdict: "over_budget", reason: "above your pre-approval amount" }
  }
  if (typeof input.maxMonthlyBudget === "number" && input.maxMonthlyBudget > 0) {
    if (input.monthlyTotal <= input.maxMonthlyBudget)
      return { withinPreApproval, headroomToPreApproval, verdict: "within_budget", reason: "within your monthly budget" }
    if (typeof input.stretchMonthlyBudget === "number" && input.stretchMonthlyBudget > input.maxMonthlyBudget && input.monthlyTotal <= input.stretchMonthlyBudget)
      return { withinPreApproval, headroomToPreApproval, verdict: "stretch", reason: "above your monthly budget, within the most you said you could stretch to" }
    return { withinPreApproval, headroomToPreApproval, verdict: "over_budget", reason: "above your monthly budget" }
  }
  if (withinPreApproval === true)
    return { withinPreApproval, headroomToPreApproval, verdict: "within_budget", reason: "within your pre-approval" }
  return { withinPreApproval, headroomToPreApproval, verdict: "unknown", reason: "no pre-approval or budget on file yet" }
}

export interface ClientAffordabilityFraming {
  /** Warm, non-alarming chip label the CLIENT sees (never "Over budget"). */
  label: string
  /** UI tone — "good" | "soft" | "neutral". Never an alarm-red for a client. */
  tone: "good" | "soft" | "neutral"
  /** A confidence-building, conversation-STARTING line that routes to the agent. */
  line: string
}

/**
 * clientAffordabilityFraming — PURE. The them-first sales layer: a buyer should never hit a
 * stark "Over budget" wall that scares them off or ends the conversation. Every verdict becomes a
 * warm, confidence-building nudge toward THEIR AGENT (who can find financing, terms, or a better
 * fit). The precise number/verdict stays with the agent; the client gets a reason to reach out.
 */
export function clientAffordabilityFraming(verdict: AffordabilityVerdict): ClientAffordabilityFraming {
  switch (verdict) {
    case "within_budget":
      return { label: "Looks within reach", tone: "good", line: "A strong fit on paper — your agent can help you make it yours." }
    case "stretch":
      return { label: "Worth a conversation", tone: "soft", line: "It's close. Your agent knows ways to make a home like this work — let's talk it through." }
    case "over_budget":
      return { label: "Let's explore your options", tone: "soft", line: "A little above your current numbers — your agent can map the right path: financing, terms, or homes that fit just as well." }
    case "unknown":
    default:
      return { label: "Get your real numbers", tone: "neutral", line: "Get pre-approved and your agent will show you exactly what fits — no guessing." }
  }
}
