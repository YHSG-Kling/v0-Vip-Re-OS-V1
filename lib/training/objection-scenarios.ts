/**
 * Objection-training scenario library — defined in code so adding new
 * scenarios is just a code change. Each scenario carries the prospect's
 * opening line and the system prompt that shapes the AI's behavior as
 * the prospect throughout the conversation.
 */

export type Difficulty = "easy" | "medium" | "hard"

export interface ObjectionScenario {
  key: string
  label: string
  category: "listing" | "buyer" | "fsbo" | "investor" | "negotiation"
  persona: string
  difficulty: Difficulty
  openingLine: string
  systemPrompt: string
  /** What the agent should ideally accomplish — used by the scorer */
  successCriteria: string[]
  /** "library" = static catalog below; "call" = AI-generated from a real call. */
  source?: "library" | "call"
  /** For call-sourced scenarios: the objections the AI heard on the real call. */
  sourceObjections?: string[]
}

export const OBJECTION_SCENARIOS: ObjectionScenario[] = [
  {
    key: "commission_pushback",
    label: "Seller pushes back on commission",
    category: "listing",
    persona: "Skeptical seller, has interviewed 2 other agents who quoted lower",
    difficulty: "medium",
    openingLine: "Honestly, your commission is too high. The other agent I talked to said they'd do it for 4% total. Why should I pay you 6%?",
    systemPrompt:
      "You are role-playing as a seller objecting to commission. Stay firm but not unreasonable. Push back on generic answers; reward agents who lead with value (marketing, exposure, days on market reduction). If the agent gives a strong, specific answer, soften your stance gradually. If they give a weak/scripted answer, dig in harder. Keep responses to 2-3 sentences. Stay in character — never break role.",
    successCriteria: [
      "Leads with value, not price defense",
      "Cites specific marketing or service differentiators",
      "Asks a clarifying question about the seller's priorities",
      "Closes by reframing commission as an investment in net proceeds",
    ],
  },
  {
    key: "rate_shopping_buyer",
    label: "Rate-shopping buyer",
    category: "buyer",
    persona: "First-time buyer, comparing lender quotes, anxious about rates",
    difficulty: "easy",
    openingLine: "I just got pre-qualified through Rocket at 6.2%. Your lender quoted me 6.4%. Why shouldn't I just go with Rocket?",
    systemPrompt:
      "You are role-playing as a first-time buyer focused on lender rate. You're anxious and have done a little online research. Push back on generic 'they'll work harder for you' answers. Reward agents who explain rate vs cost-of-loan, lender responsiveness during contract, or how their lender handles low-appraisal scenarios. Keep responses 2-3 sentences. Stay in character.",
    successCriteria: [
      "Differentiates rate from total cost / closing costs",
      "Asks about the buyer's timeline and specific concerns",
      "Offers a lender comparison framework rather than dismissing the question",
      "Builds trust through education, not deflection",
    ],
  },
  {
    key: "fsbo_cold_call",
    label: "Cold-calling a FSBO",
    category: "fsbo",
    persona: "Frustrated FSBO seller, 30 days on market, no offers yet",
    difficulty: "hard",
    openingLine: "I'm not interested in working with a realtor. You guys all say the same thing. Don't waste my time.",
    systemPrompt:
      "You are role-playing as a FSBO seller. You're skeptical and tired of agent calls. Hang up (end the call) if the agent leads with a generic pitch. Soften only if they (a) acknowledge your situation, (b) ask permission to share something specific, (c) provide value before asking for anything. Keep responses brief and curt. If they break through your wall, you can engage but stay guarded.",
    successCriteria: [
      "Acknowledges the seller's frustration before pitching",
      "Asks for permission to share value",
      "Provides specific local market data or insight",
      "Avoids closing for a meeting in the first 30 seconds",
    ],
  },
  {
    key: "low_offer_seller",
    label: "Seller wants to reject a low offer",
    category: "negotiation",
    persona: "Emotional seller, anchored on Zillow Zestimate, 45 days on market",
    difficulty: "medium",
    openingLine: "$50k below my asking is insulting. Tell them no, and don't bother responding to anything below my list price.",
    systemPrompt:
      "You are role-playing as an emotional seller who got an offer well below asking. You're anchored on the Zestimate. Push back on the agent's attempt to negotiate. Reward agents who reframe offers as conversations, who use comparable solds, who acknowledge your emotion before pivoting to data. Keep responses 2-3 sentences.",
    successCriteria: [
      "Acknowledges the emotion before introducing logic",
      "Reframes 'low offer' as 'opening conversation'",
      "Uses recent comparable solds to anchor a counter discussion",
      "Frames the cost of NOT responding (DOM, future buyer perception)",
    ],
  },
  {
    key: "investor_objections",
    label: "Investor pushing on cap rate",
    category: "investor",
    persona: "Experienced investor, owns 8 properties, knows the numbers",
    difficulty: "hard",
    openingLine: "The cap rate at this price doesn't work. I'd need it $80k lower to hit my target return. What's your move?",
    systemPrompt:
      "You are role-playing as a sophisticated investor who knows real estate math. Push the agent on assumptions in their analysis. Reward agents who can talk concretely about NOI, vacancy assumptions, value-add opportunities, ARV potential, or financing structure. Punish vague or emotional answers. Keep responses 2-3 sentences. You'll walk away if the agent doesn't bring real numbers.",
    successCriteria: [
      "Engages on the actual math (cap rate, NOI, expense ratio)",
      "Identifies a value-add opportunity OR a financing angle",
      "Offers a specific counter-position with numerical backing",
      "Acknowledges the investor's expertise without sycophancy",
    ],
  },
  {
    key: "expired_listing",
    label: "Calling an expired listing",
    category: "listing",
    persona: "Frustrated previous seller, listing expired without selling",
    difficulty: "hard",
    openingLine: "My last agent promised the moon and we got nothing. Why should I trust you any more than them?",
    systemPrompt:
      "You are role-playing as a previous seller whose listing expired. You're disappointed and skeptical. Reward agents who diagnose what went wrong (price, marketing, days on market) before pitching themselves. Stay guarded if they jump to their own credentials. Keep responses 2-3 sentences.",
    successCriteria: [
      "Diagnoses what went wrong with the previous listing",
      "Asks specific questions about the expired listing's history",
      "Avoids bashing the previous agent",
      "Proposes a different specific approach (not 'I'll work harder')",
    ],
  },
]

export function getScenarioByKey(key: string): ObjectionScenario | undefined {
  return OBJECTION_SCENARIOS.find((s) => s.key === key)
}

// ── THE ASSESSMENT SESSION (wave 106, lane 106D) ─────────────────────────────────────────────
// The owner's "AI coaching / simulation → assessment" step is THIS library + the practice session
// (app/actions/objection-training.ts): scenario prompt + rubric (successCriteria), scored per turn,
// result stored on objection_training_sessions (total_score, completed_at). What was missing:
// (1) which COMPETENCY a scenario assesses — the category → competency map below, on the ONE
// vocabulary (lib/education/skill-freshness.ts COMPETENCY_SKILLS); (2) compliance FIRST — fair
// housing lives in the WRITING prompt (CLAUDE.md §5), not only in a post-hoc scan.

import type { CompetencySkill } from "@/lib/education/skill-freshness"

/** Which competency each scenario CATEGORY assesses (one vocabulary; the proof asserts every value is a COMPETENCY_SKILLS key). */
export const SCENARIO_CATEGORY_COMPETENCY: Record<ObjectionScenario["category"], CompetencySkill> = {
  listing:     "listing_presentation",
  buyer:       "buyer_consultation",
  fsbo:        "lead_conversion",
  investor:    "pricing",
  negotiation: "negotiation",
}

/** The competency a scenario assesses. */
export function scenarioCompetency(s: Pick<ObjectionScenario, "category">): CompetencySkill {
  return SCENARIO_CATEGORY_COMPETENCY[s.category]
}

/**
 * COMPLIANCE-FIRST: prepended to every role-play / scoring prompt the simulation sends, so the
 * prospect never baits the agent into a fair-housing violation and the rubric SCORES one as a
 * failure. Written into the prompt, not only scanned afterwards (CLAUDE.md §5 — the video-script
 * ruling applied to coaching).
 */
export const COMPLIANCE_FIRST_PREAMBLE =
  "COMPLIANCE FIRST (Fair Housing Act, state law, REALTOR Code of Ethics): never reference or invite " +
  "discussion of race, color, religion, national origin, sex, familial status, disability or any other " +
  "protected class; never characterize a neighborhood by who lives there, school 'quality' or 'safety' " +
  "as a proxy for demographics; never suggest steering, blockbusting or discriminatory lending. If the " +
  "agent's response does any of these, score that turn 0 and name the violation in the feedback. Keep " +
  "the role-play realistic without ever modeling a violation yourself.\n\n"

/**
 * PURE — the assessment session for a competency: the library scenario (hardest first, so an
 * assessment is a test, not a warm-up) with the compliance-first prompt composed in and the rubric
 * the scorer applies. Null when the library has no scenario for that competency (honest: the loop
 * then recommends education without a simulation, and says so).
 * @proofSeam scripts/adaptive-development-guard.ts asserts the compliance-first prompt and the null case.
 */
export function composeAssessment(competency: CompetencySkill, library: readonly ObjectionScenario[] = OBJECTION_SCENARIOS): { competency: CompetencySkill; scenarioKey: string; label: string; systemPrompt: string; rubric: string[] } | null {
  const rank: Record<Difficulty, number> = { hard: 0, medium: 1, easy: 2 }
  const match = library.filter((s) => scenarioCompetency(s) === competency).sort((a, b) => rank[a.difficulty] - rank[b.difficulty] || a.key.localeCompare(b.key))[0]
  if (!match) return null
  return { competency, scenarioKey: match.key, label: match.label, systemPrompt: COMPLIANCE_FIRST_PREAMBLE + match.systemPrompt, rubric: [...match.successCriteria] }
}
