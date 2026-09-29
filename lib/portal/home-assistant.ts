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

// NOT merged into lib/format/money.ts's `usdOrNull` (§1/§6, 2026-09-08) despite
// being its byte-equivalent source — this file's header contract is "Pure,
// import-free helpers" so scripts/home-assistant-simulator.ts can exercise it
// with zero module resolution. `usdOrNull` there is documented as this
// function's canonical text; keep the two in sync by hand if either changes.
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

// ─── THE FOLLOW-UP THE QUESTION DESERVES (lane 90C) ─────────────────────────
// The assistant answered a past client's home-value / refinance / vendor
// question and then NOTHING happened ("no persistence, self-serve, no noise"):
// the one moment a lifetime customer raises their hand ended the loop. The
// sphere persona of the ISA playbook (lib/ai-isa/qualification-playbook.ts
// PERSONA_QUESTION_GUIDE.sphere) already names the three offers — an equity
// check-in the AGENT brings the number to, a trusted-vendor intro from the
// brokerage's own bench, and a refinance review with the finance desk. This pure
// classifier decides WHICH of the portal's EXISTING asks the question is
// (app/actions/portal-lifetime.ts: requestValueUpdate / submitNextMoveIntent
// 'refinance' / requestVendorIntro); the action files it once and says so.
// Deliberately conservative: a question that names none of the three yields
// null — the agent redirect in the answer is the floor, never a phantom task.

export type HomeFollowUpKind = "home_value" | "refinance" | "vendor"

const HOME_VALUE_RE = /\b(worth|home value|house value|property value|valuation|appraisal|equity|what (could|would|can) (it|my (home|house)) sell for|sell (it|my (home|house)) for|market value|cma|comps?)\b/i
const REFINANCE_RE = /\b(refi|refinanc\w*|heloc|home equity (loan|line)|cash[- ]out|lower (my|the|our) (rate|payment|mortgage)|interest rate|mortgage rate|rate drop|second mortgage)\b/i
const VENDOR_RE = /\b(plumber|plumbing|electrician|electrical|roofer|roofing|hvac|furnace|a\/?c|air condition\w*|contractor|handyman|landscap\w*|painter|painting|mover|moving company|cleaner|cleaning|pest|inspector|gutter\w*|window\w*|flooring|remodel\w*|renovat\w*|repair\w*|fix (my|the|our)|recommend(ation)? (for )?a|know (a|any|someone)|who (do|would) you (use|recommend)|referral for a|good (\w+ )?(guy|company|service|pro|vendor)|lender|mortgage broker)\b/i

/** PURE: which follow-up the question earns; null when none of the three. Vendor
 *  wins over refinance only when a trade is named ("a lender for a refi" is a
 *  refinance review, "know a good plumber" is a vendor intro). */
export function classifyHomeFollowUp(question: string | null | undefined): HomeFollowUpKind | null {
  const q = (question ?? "").toString().trim()
  if (!q) return null
  if (REFINANCE_RE.test(q)) return "refinance"
  if (VENDOR_RE.test(q)) return "vendor"
  if (HOME_VALUE_RE.test(q)) return "home_value"
  return null
}

const VENDOR_CATEGORY_WORDS: Array<[RegExp, string]> = [
  [/plumb/i, "plumbing"], [/electric/i, "electrical"], [/roof/i, "roofing"], [/hvac|furnace|a\/?c\b|air condition/i, "hvac"],
  [/landscap|lawn|yard/i, "landscaping"], [/paint/i, "painting"], [/mover|moving/i, "moving"], [/clean/i, "cleaning"],
  [/pest/i, "pest_control"], [/inspect/i, "inspection"], [/gutter/i, "gutters"], [/window/i, "windows"], [/floor/i, "flooring"],
  [/remodel|renovat|contractor/i, "general_contractor"], [/handyman|repair|fix/i, "handyman"], [/lender|mortgage/i, "lender"],
]

/** PURE: the vendor category a question names, matched against the brokerage's
 *  own categories first (so the intro can land on a real bench row), then the
 *  generic word list; "home_services" when only a vague ask ("know anyone?"). */
export function vendorCategoryFor(question: string, knownCategories: string[] | null | undefined): string {
  const q = question.toLowerCase()
  for (const cat of knownCategories ?? []) {
    const stem = cat.toLowerCase().replace(/_/g, " ").split(" ")[0]
    if (stem && stem.length >= 4 && q.includes(stem.slice(0, 5))) return cat
  }
  for (const [re, cat] of VENDOR_CATEGORY_WORDS) if (re.test(q)) return cat
  return "home_services"
}

/** PURE: the one sentence appended to the answer ONLY when the follow-up was
 *  actually filed — never a promise the row does not back. */
export function followUpAcknowledgement(kind: HomeFollowUpKind, agentName: string | null | undefined): string {
  const agent = agentName || "your agent"
  switch (kind) {
    case "home_value": return `I've let ${agent} know you're curious about your home's value — they'll prepare an updated look and reach out to walk through it with you.`
    case "refinance": return `I've flagged this for ${agent} so they can set up a refinance review with the finance desk — no obligation, just the numbers.`
    case "vendor": return `I've asked ${agent} to connect you with a trusted pro from their own bench — they'll follow up with an intro.`
  }
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
