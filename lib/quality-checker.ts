export interface QualityScore {
  score: number
  themPercentage: number
  agentPercentage: number
  warnings: string[]
  suggestions: string[]
}

export function analyzeContentQuality(content: string): QualityScore {
  // Words that indicate "them-first" focus
  const themWords = [
    "you",
    "your",
    "yours",
    "yourself",
    "family",
    "home",
    "dream",
    "future",
    "needs",
    "important",
    "feel",
    "deserve",
    "peace",
    "comfort",
    "children",
    "kids",
    "lifestyle",
    "neighborhood",
  ]

  // Words that indicate agent-focused content
  const agentWords = [
    "i",
    "me",
    "my",
    "mine",
    "myself",
    "our",
    "we",
    "us",
    "award",
    "certified",
    "experience",
    "years",
    "sold",
    "listing",
    "expert",
    "professional",
    "service",
  ]

  const words = content.toLowerCase().split(/\s+/)
  const totalWords = words.length

  let themCount = 0
  let agentCount = 0

  words.forEach((word) => {
    const cleanWord = word.replace(/[^\w]/g, "")
    if (themWords.includes(cleanWord)) themCount++
    if (agentWords.includes(cleanWord)) agentCount++
  })

  const themPercentage = (themCount / totalWords) * 100
  const agentPercentage = (agentCount / totalWords) * 100

  const warnings: string[] = []
  const suggestions: string[] = []

  // Scoring logic
  if (agentPercentage > 20) {
    warnings.push("Too much agent-focused content (over 20%)")
    suggestions.push("Rewrite to focus more on the prospect's needs and situation")
  }

  if (themPercentage < 10) {
    warnings.push("Not enough prospect-focused content (under 10%)")
    suggestions.push('Add more "you" language and focus on their emotions/situation')
  }

  // Check for common agent-first mistakes
  if (content.toLowerCase().includes("i have") || content.toLowerCase().includes("i am")) {
    warnings.push('Using "I have" or "I am" statements')
    suggestions.push("Rephrase to focus on what they get or how they benefit")
  }

  if (content.toLowerCase().match(/\b(award|certified|years of experience)\b/)) {
    warnings.push("Leading with credentials instead of their needs")
    suggestions.push("Start with their pain point or emotion, credentials come later")
  }

  // Calculate overall score (0-100)
  let score = 100
  score -= agentPercentage > 20 ? 30 : 0
  score -= themPercentage < 10 ? 30 : 0
  score -= warnings.length * 10
  score = Math.max(0, Math.min(100, score))

  return {
    score,
    themPercentage,
    agentPercentage,
    warnings,
    suggestions,
  }
}
