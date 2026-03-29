import { generateText } from "ai"
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

export async function validateThemFirstContent(
  content: string,
  contentType: ContentType,
  personaId?: string,
): Promise<ValidationResult> {
  // 1. Analyze structure with AI
  const structure = await analyzeContentStructure(content)

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
  const suggestions = generateSuggestions(structure, sentiment, passed)

  return {
    passed,
    overall_score: overallScore,
    breakdown: structure,
    sentiment_score: sentimentScore,
    suggestions,
    prohibited_violations: prohibited.violations,
  }
}

async function analyzeContentStructure(content: string) {
  try {
    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Analyze this content and categorize each sentence into one of four categories:

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
    const { text } = await generateText({
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

function generateSuggestions(structure: any, sentiment: any, passed: boolean): string[] {
  const suggestions: string[] = []

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
    suggestions.push("✅ Great job! This follows the 'Them First' approach perfectly.")
  }

  return suggestions
}
