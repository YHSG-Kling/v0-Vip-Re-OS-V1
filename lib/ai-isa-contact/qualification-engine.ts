/**
 * AI ISA CONTACT - QUALIFICATION ENGINE
 * System 3.2 Component
 *
 * Extracts qualification signals from contact conversations using Claude.
 * Persists structured data to activities table.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateAIJSON } from "@/lib/ai/generate"

export interface QualificationSignals {
  buyerSeller: "buyer" | "seller" | "both" | "unknown"
  urgency: "immediate" | "within_month" | "within_quarter" | "exploring" | "unknown"
  financingStatus: "preapproved" | "needs_preapproval" | "cash" | "unknown"
  priceRange?: { min?: number; max?: number }
  locations?: string[]
  motivations?: string[]
  readinessScore: number  // 0-100
  confidence: number      // 0-1
  escalationNeeded: boolean
  escalationReason?: string
}

export interface ExtractSignalsParams {
  contactId: string
  messageContent: string
  conversationHistory: string[]
}

const FALLBACK_SIGNALS: QualificationSignals = {
  buyerSeller: "unknown",
  urgency: "unknown",
  financingStatus: "unknown",
  readinessScore: 0,
  confidence: 0,
  escalationNeeded: false,
}

/**
 * Extract qualification signals from conversation using Claude (claude-haiku-4-5 for low latency).
 * Falls back to keyword heuristics if AI call fails.
 */
export async function extractQualificationSignals(
  params: ExtractSignalsParams
): Promise<QualificationSignals> {
  const conversationText = [params.messageContent, ...params.conversationHistory]
    .join("\n---\n")
    .slice(0, 4000)

  const prompt = `You are a real estate ISA qualification analyst. Extract structured signals from the following conversation.

CONVERSATION:
${conversationText}

Return a JSON object with EXACTLY these fields:
{
  "buyerSeller": "buyer" | "seller" | "both" | "unknown",
  "urgency": "immediate" | "within_month" | "within_quarter" | "exploring" | "unknown",
  "financingStatus": "preapproved" | "needs_preapproval" | "cash" | "unknown",
  "priceRange": { "min": number | null, "max": number | null } | null,
  "locations": string[],
  "motivations": string[],
  "readinessScore": number (0-100, based on intent clarity + urgency + financing status),
  "confidence": number (0-1, how confident you are in these signals),
  "escalationNeeded": boolean (true if: asking for human agent, frustrated, ready to make offer, or urgent buying/selling decision),
  "escalationReason": string | null
}

Only output the JSON object, no explanation.`

  const { data, error } = await generateAIJSON<QualificationSignals>(prompt, {
    maxTokens: 500,
    temperature: 0.1,
    feature: "isa_qualification",
  })

  if (error || !data) {
    console.warn("[ISA Qualification] AI extraction failed, using heuristics:", error)
    return heuristicFallback(params)
  }

  return {
    buyerSeller: data.buyerSeller ?? "unknown",
    urgency: data.urgency ?? "unknown",
    financingStatus: data.financingStatus ?? "unknown",
    priceRange: data.priceRange ?? undefined,
    locations: Array.isArray(data.locations) ? data.locations : [],
    motivations: Array.isArray(data.motivations) ? data.motivations : [],
    readinessScore: typeof data.readinessScore === "number" ? Math.min(100, Math.max(0, data.readinessScore)) : 0,
    confidence: typeof data.confidence === "number" ? Math.min(1, Math.max(0, data.confidence)) : 0.5,
    escalationNeeded: data.escalationNeeded ?? false,
    escalationReason: data.escalationReason ?? undefined,
  }
}

function heuristicFallback(params: ExtractSignalsParams): QualificationSignals {
  const allText = [params.messageContent, ...params.conversationHistory].join(" ").toLowerCase()

  const isBuyer = ["buy", "looking for", "searching for", "house hunt"].some(kw => allText.includes(kw))
  const isSeller = ["sell", "list", "selling my", "market my home"].some(kw => allText.includes(kw))

  let buyerSeller: QualificationSignals["buyerSeller"] = "unknown"
  if (isBuyer && isSeller) buyerSeller = "both"
  else if (isBuyer) buyerSeller = "buyer"
  else if (isSeller) buyerSeller = "seller"

  const urgencyMap: Array<[QualificationSignals["urgency"], string[]]> = [
    ["immediate", ["asap", "urgent", "right away", "immediately", "this week"]],
    ["within_month", ["within month", "next month", "soon", "30 days"]],
    ["within_quarter", ["few months", "this year", "by summer", "by fall"]],
    ["exploring", ["just looking", "exploring", "researching", "thinking about"]],
  ]

  let urgency: QualificationSignals["urgency"] = "unknown"
  for (const [level, keywords] of urgencyMap) {
    if (keywords.some(kw => allText.includes(kw))) { urgency = level; break }
  }

  let readinessScore = 0
  if (buyerSeller !== "unknown") readinessScore += 25
  if (urgency === "immediate") readinessScore += 40
  else if (urgency === "within_month") readinessScore += 30
  else if (urgency === "within_quarter") readinessScore += 20

  return {
    buyerSeller,
    urgency,
    financingStatus: "unknown",
    readinessScore,
    confidence: 0.4,
    escalationNeeded: readinessScore >= 65,
  }
}

/**
 * Persist qualification signals to activities table.
 */
export async function persistQualificationSignals(
  contactId: string,
  signals: QualificationSignals
): Promise<boolean> {
  const supabase = createServiceClient()

  const { error } = await supabase.from("activities").insert({
    activity_type: "ai_qualification_update",
    title: "AI ISA Qualification Update",
    description: `Qualification: ${signals.buyerSeller} | ${signals.urgency} | Readiness: ${signals.readinessScore}% | Confidence: ${Math.round(signals.confidence * 100)}%`,
    status: "completed",
    priority: signals.escalationNeeded ? "high" : "normal",
    contact_id: contactId,
    notes: JSON.stringify(signals),
    created_at: new Date().toISOString(),
  })

  if (error) {
    console.error("[AI ISA] Failed to persist qualification signals:", error)
    return false
  }

  return true
}
