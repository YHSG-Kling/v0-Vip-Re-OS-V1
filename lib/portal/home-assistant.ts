// ─── ASK YOUR HOME ANYTHING (lifetime portal AI) ─────────────────────────────
// Pure, import-free helpers behind the lifetime portal's home assistant: input
// validation, the compliance-railed system prompt, the facts block, and a
// DETERMINISTIC fallback answer (the floor — used verbatim when the AI gateway
// is unavailable, so the client always gets a sane, on-brand reply).
//
// No imports → trivially unit-testable (scripts/home-assistant-simulator.ts).

export interface HomeFacts {
  firstName?: string | null
  agentName?: string | null
  propertyAddress?: string | null
  purchasePrice?: number | null
  closeDate?: string | null
  currentValue?: number | null
  estimatedEquity?: number | null
  gainPercent?: number | null
  marketTrend?: string | null
  neighborhoodActivityCount?: number | null
  vendorCategories?: string[] | null
}

export interface QuestionValidation {
  ok: boolean
  reason?: string
  clean?: string
}

export function validateHomeQuestion(raw: string | null | undefined): QuestionValidation {
  const q = (raw ?? "").toString().trim()
  if (q.length < 3) return { ok: false, reason: "Please type a question." }
  if (q.length > 500) return { ok: true, clean: q.slice(0, 500) }
  return { ok: true, clean: q }
}

const usd = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
    : null

/** A compact, model-readable block of the ONLY facts the assistant may rely on. */
export function buildHomeFactsBlock(facts: HomeFacts): string {
  const lines: string[] = []
  if (facts.firstName) lines.push(`Homeowner first name: ${facts.firstName}`)
  if (facts.agentName) lines.push(`Their real estate agent: ${facts.agentName}`)
  if (facts.propertyAddress) lines.push(`Home address: ${facts.propertyAddress}`)
  if (usd(facts.purchasePrice)) lines.push(`Purchase price: ${usd(facts.purchasePrice)}`)
  if (facts.closeDate) lines.push(`Purchased / closed on: ${facts.closeDate}`)
  if (usd(facts.currentValue)) lines.push(`Current estimated value (AVM estimate, not an appraisal): ${usd(facts.currentValue)}`)
  if (usd(facts.estimatedEquity)) lines.push(`Estimated gain in value since purchase: ${usd(facts.estimatedEquity)}`)
  if (typeof facts.gainPercent === "number") lines.push(`Estimated gain percent since purchase: ${facts.gainPercent.toFixed(1)}%`)
  if (facts.marketTrend) lines.push(`Local market trend: ${facts.marketTrend}`)
  if (typeof facts.neighborhoodActivityCount === "number")
    lines.push(`Recent nearby listings on file: ${facts.neighborhoodActivityCount}`)
  if (facts.vendorCategories && facts.vendorCategories.length > 0)
    lines.push(`Trusted vendor categories available through their agent: ${facts.vendorCategories.join(", ")}`)
  return lines.length > 0 ? lines.join("\n") : "No specific home facts are on file yet."
}

/**
 * The system prompt. Hard rails: stay scoped to THIS home, never give legal /
 * tax / lending / appraisal advice (defer to a licensed pro or the agent), never
 * guarantee or forecast future value, never discuss protected classes or steer
 * (fair housing), and redirect cleanly when out of scope.
 */
export function buildHomeAssistantSystemPrompt(facts: HomeFacts): string {
  const agent = facts.agentName || "their agent"
  return [
    `You are a warm, concise home assistant inside a homeowner's private real-estate portal.`,
    `You help ${facts.firstName || "the homeowner"} understand THEIR home and what's in this portal.`,
    ``,
    `RULES (follow strictly):`,
    `- Use ONLY the facts provided below. If a fact isn't given, say you don't have it and suggest they ask ${agent}.`,
    `- You are NOT a lawyer, lender, tax advisor, or licensed appraiser. For legal, tax, mortgage, or formal valuation questions, recommend they speak with ${agent} or the appropriate licensed professional. Do not give that advice yourself.`,
    `- NEVER guarantee or predict future home value, prices, or rates. Value figures are estimates, not appraisals or promises.`,
    `- NEVER discuss or imply anything about race, religion, national origin, family status, disability, age, or any protected class, and never steer toward or away from any area or group (fair housing).`,
    `- If the question is not about this home, this portal, or general homeownership, gently redirect them to ${agent}.`,
    `- Keep answers short (2–4 sentences), friendly, and specific to their home. End by pointing them to ${agent} when a human is the right next step.`,
    ``,
    `THE HOMEOWNER'S FACTS:`,
    buildHomeFactsBlock(facts),
  ].join("\n")
}

/**
 * Deterministic floor answer — returned verbatim when the AI gateway is
 * unavailable, so the client never sees an error. Summarizes known facts and
 * routes to the agent. Contains no forecast/guarantee.
 */
export function fallbackHomeAnswer(facts: HomeFacts): string {
  const agent = facts.agentName || "your agent"
  const bits: string[] = []
  if (facts.propertyAddress) bits.push(`your home at ${facts.propertyAddress}`)
  const val = usd(facts.currentValue)
  if (val) bits.push(`its current estimated value is about ${val} (an estimate, not an appraisal)`)
  const gain = usd(facts.estimatedEquity)
  if (gain && (facts.estimatedEquity ?? 0) > 0) bits.push(`you've gained roughly ${gain} in value since you bought`)
  const summary = bits.length > 0 ? `Here's what I have on file: ${bits.join(", ")}.` : `I don't have those details on file yet.`
  return `${summary} For anything more specific, ${agent} is the best person to ask — I'll let them know you're curious.`
}
