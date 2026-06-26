// lib/kernel/client-framing.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT-FRAMING DOCTRINE — owner's sales rule, made reusable across every manager.
//
//   • What the AI shows a HUMAN CLIENT (buyer/seller) is WARM, confidence-building, and
//     conversation-STARTING — it always routes them to THEIR AGENT, never a stark verdict that
//     scares them off or ends the relationship.
//   • The precise / black-and-white analysis (exact gaps, "overpriced", "underwater", a thin-CMA
//     number) stays with the AGENT (in_house), who has the conversation.
//
// PURE, no I/O. Buyer affordability has its own tuned instance (clientAffordabilityFraming);
// this is the shared core the seller-side value surfaces (equity, net sheet, CMA) route through.

/** How the underlying number FEELS to the client — drives tone, never the exact figure shown. */
export type NewsTone = "good" | "sensitive" | "neutral"

/**
 * valueNewsTone — PURE. Classify a client-facing money metric into a tone WITHOUT leaking the
 * stark number. "sensitive" = anything that could worry them (low/negative equity, a shortfall,
 * below a promised figure); "good" = clearly positive; "neutral" = no strong signal / unknown.
 */
export function valueNewsTone(input: {
  /** The headline value (equity, net proceeds, delta vs a promise). null = unknown → neutral. */
  value: number | null | undefined
  /** Optional reference the value is measured against (a prior promise, the purchase price). */
  reference?: number | null
  /** When true, a value AT/ABOVE reference is good and BELOW is sensitive (e.g. net vs promise). */
  higherIsBetter?: boolean
}): NewsTone {
  if (typeof input.value !== "number") return "neutral"
  if (typeof input.reference === "number" && input.reference !== 0) {
    const delta = input.value - input.reference
    // Within ~2% of the reference reads neutral; meaningfully below = sensitive.
    if (Math.abs(delta) <= Math.abs(input.reference) * 0.02) return "neutral"
    return delta >= 0 ? "good" : "sensitive"
  }
  if (input.value < 0) return "sensitive" // underwater / negative
  if (input.value === 0) return "neutral"
  return "good"
}

/**
 * clientSafeCtaLine — PURE. A warm, conversation-STARTING line that always routes to the agent.
 * Sensitive news is reframed as an opportunity to talk, never an alarm; good news invites the
 * agent to help capitalize; neutral nudges a conversation for the real picture. `topic` softly
 * names the subject ("your equity", "your numbers") without quoting a figure.
 */
export function clientSafeCtaLine(tone: NewsTone, topic = "this"): string {
  switch (tone) {
    case "good":
      return `Great position on ${topic} — your agent can help you make the most of it. Want to talk it through?`
    case "sensitive":
      return `There's nuance to ${topic} worth a real conversation — your agent can walk you through what it means and the smart next move. Let's connect.`
    case "neutral":
    default:
      return `Your agent can give you the full picture on ${topic} — reach out whenever you'd like to talk.`
  }
}
