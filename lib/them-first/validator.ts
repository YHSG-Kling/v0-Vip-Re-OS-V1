import { guardedGenerateText } from "@/lib/data-guard/guarded-generate"
import { resolveModel } from "@/lib/ai/resolve-model"

export type ContentType = "email" | "sms" | "video_script" | "social_post"

export interface ValidationResult {
  passed: boolean
  overall_score: number
  breakdown: {
    feelings_percentage: number
    trust_percentage: number
    value_percentage: number
    solution_percentage: number
  }
  sentiment_score: number
  suggestions: string[]
  prohibited_violations: string[]
}

const PROHIBITED_PHRASES = [
  // Salesy/Pushy
  { phrase: "you'd be crazy not to", category: "pushy", severity: "critical" },
  { phrase: "limited time offer", category: "false_urgency", severity: "error" },
  { phrase: "this won't last long", category: "fear_based", severity: "error" },
  { phrase: "trust me", category: "ironic", severity: "warning" },
  { phrase: "i'm the best agent", category: "ego_driven", severity: "warning" },
  { phrase: "you need to act fast", category: "pushy", severity: "error" },
  { phrase: "don't miss out", category: "fear_based", severity: "error" },

  // Fair Housing Violations
  { phrase: "perfect for families", category: "fair_housing", severity: "critical" },
  { phrase: "great for retirees", category: "fair_housing", severity: "critical" },
  { phrase: "young professional area", category: "fair_housing", severity: "critical" },
  { phrase: "quiet neighborhood", category: "fair_housing", severity: "warning" },
  { phrase: "safe area", category: "fair_housing", severity: "warning" },
  { phrase: "adult community", category: "fair_housing", severity: "critical" },

  // Investment Claims (unless investor persona)
  { phrase: "this is a great investment", category: "investment_advice", severity: "error" },
  { phrase: "guaranteed to appreciate", category: "investment_advice", severity: "critical" },
  { phrase: "you'll make money", category: "investment_advice", severity: "critical" },
]

/**
 * How each content type reads, in the analyzer's own terms. `video_script` is a
 * SPOKEN form and `sms` is one or two lines — categorising either "sentence by
 * sentence" the way an email is read produced percentages that described a shape
 * the format cannot have.
 */
const CONTENT_TYPE_UNIT: Record<ContentType, string> = {
  email:        "an email, read sentence by sentence",
  sms:          "a text message — one or two short lines, not paragraphs",
  video_script: "a spoken video script — categorise each SPOKEN LINE, not each written sentence",
  social_post:  "a social post — short lines and a caption, not prose",
}

/**
 * `contentType` TELLS THE ANALYZER WHAT IT IS READING — it was accepted here and
 * read by NOTHING until 2026-08-24, so a 160-character text message and a
 * thousand-word email were handed to the same "categorize each sentence" prompt
 * and scored against the same four-way structural split.
 *
 * BLIND SPOT, published beside the change (CLAUDE.md §2): the pass THRESHOLDS are
 * deliberately NOT varied by content type. Per-type numbers would be invented, not
 * measured, and this gate already refuses on prohibited phrases regardless of type
 * — which is the fair-housing half (§5) and must not move. What changed is that the
 * analyzer is told the format, and the writer is told which format was judged.
 */
export async function validateThemFirstContent(
  content: string,
  contentType: ContentType,
  personaId?: string,
): Promise<ValidationResult> {
  const readAs = CONTENT_TYPE_UNIT[contentType] ?? CONTENT_TYPE_UNIT.email

  // 1. Analyze structure with AI
  const structure = await analyzeContentStructure(content, readAs)

  // 2. Analyze sentiment
  const sentiment = await analyzeSentiment(content)

  // 3. Check prohibited phrases
  const prohibited = checkProhibitedPhrases(content, personaId)

  // 4. Calculate scores
  const structureScore = calculateStructureScore(structure)
  const sentimentScore = sentiment.empathy_level
  const overallScore = (structureScore + sentimentScore) / 2

  // 5. Determine if passed
  const passed =
    overallScore >= 0.75 &&
    structure.feelings_percentage >= 30 &&
    prohibited.violations.length === 0 &&
    sentimentScore >= 0.7

  // 6. Generate suggestions
  const suggestions = generateSuggestions(structure, sentiment, passed, contentType)

  return {
    passed,
    overall_score: overallScore,
    breakdown: structure,
    sentiment_score: sentimentScore,
    suggestions,
    prohibited_violations: prohibited.violations,
  }
}

async function analyzeContentStructure(content: string, readAs: string) {
  try {
    const { text } = await guardedGenerateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `You are reading ${readAs}.

Analyze this content and categorize each sentence into one of four categories:

FEELINGS: Sentences that acknowledge emotions, pain points, or empathy
TRUST: Sentences that build credibility, share experience, or social proof
VALUE: Sentences that provide actionable help, tips, or resources
SOLUTION: Sentences that mention your services or how you can help

Content: "${content}"

Return ONLY valid JSON with percentage breakdown (must sum to 100):
{
  "feelings_percentage": 40,
  "trust_percentage": 25,
  "value_percentage": 25,
  "solution_percentage": 10
}`,
      temperature: 0.3,
    })

    const data = JSON.parse(text)
    return {
      feelings_percentage: data.feelings_percentage || 0,
      trust_percentage: data.trust_percentage || 0,
      value_percentage: data.value_percentage || 0,
      solution_percentage: data.solution_percentage || 0,
    }
  } catch (error) {
    console.error("Structure analysis error:", error)
    return {
      feelings_percentage: 0,
      trust_percentage: 0,
      value_percentage: 0,
      solution_percentage: 0,
    }
  }
}

async function analyzeSentiment(content: string) {
  try {
    const { text } = await guardedGenerateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Analyze the empathy and sentiment of this content:

Content: "${content}"

Return ONLY valid JSON:
{
  "empathy_level": 0.85,
  "tone": "warm",
  "human_like": true
}

empathy_level should be 0.0 to 1.0
tone should be one of: warm, neutral, transactional, pushy
human_like should be true or false`,
      temperature: 0.3,
    })

    const data = JSON.parse(text)
    return {
      empathy_level: data.empathy_level || 0.5,
      tone: data.tone || "neutral",
      human_like: data.human_like || false,
    }
  } catch (error) {
    console.error("Sentiment analysis error:", error)
    return { empathy_level: 0.5, tone: "neutral", human_like: false }
  }
}

function checkProhibitedPhrases(content: string, personaId?: string) {
  const contentLower = content.toLowerCase()
  const violations: string[] = []

  for (const item of PROHIBITED_PHRASES) {
    // Skip investment-related checks for investor persona
    if (item.category === "investment_advice" && personaId === "investor-buyer") {
      continue
    }

    if (contentLower.includes(item.phrase.toLowerCase())) {
      violations.push(`"${item.phrase}" (${item.category} - ${item.severity})`)
    }
  }

  return { violations }
}

function calculateStructureScore(structure: any): number {
  const targets = { feelings: 40, trust: 25, value: 25, solution: 10 }
  const weights = { feelings: 0.4, trust: 0.25, value: 0.25, solution: 0.1 }

  let score = 0
  score += Math.min(structure.feelings_percentage / targets.feelings, 1) * weights.feelings
  score += Math.min(structure.trust_percentage / targets.trust, 1) * weights.trust
  score += Math.min(structure.value_percentage / targets.value, 1) * weights.value
  score += Math.min(structure.solution_percentage / targets.solution, 1) * weights.solution

  return score
}

function generateSuggestions(
  structure: any,
  sentiment: any,
  passed: boolean,
  contentType: ContentType,
): string[] {
  const suggestions: string[] = []
  const label = contentType.replace(/_/g, " ")

  if (structure.feelings_percentage < 30) {
    suggestions.push("🫂 Add more empathy - acknowledge their feelings and pain points FIRST before anything else")
  }

  if (structure.solution_percentage > 15) {
    suggestions.push("📉 Too solution-heavy - dial back the 'sales' language. They need to feel understood first.")
  }

  if (structure.trust_percentage < 15) {
    suggestions.push("🤝 Add trust-building elements - share relevant experience or a quick story")
  }

  if (structure.value_percentage < 15) {
    suggestions.push("💎 Provide more immediate value - give them something helpful RIGHT NOW")
  }

  if (sentiment.empathy_level < 0.7) {
    suggestions.push("💬 Tone feels transactional - write like you're texting a friend going through this")
  }

  if (sentiment.tone === "pushy") {
    suggestions.push("🛑 Remove pushy language - this should feel like helpful advice, not a sales pitch")
  }

  if (!sentiment.human_like) {
    suggestions.push("🤖 This sounds too robotic - add personal touches and conversational language")
  }

  if (passed) {
    suggestions.push(`✅ Great job! This ${label} follows the 'Them First' approach perfectly.`)
  } else {
    // Name the rubric that judged it. A writer told only "score too low" cannot
    // tell whether the analyzer read their video script as prose.
    suggestions.push(`ℹ️ Scored as a ${label}.`)
  }

  return suggestions
}
