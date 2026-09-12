"use server"

import { generateTextRouted } from "@/lib/ai/models"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint, so the AI cost ledger's tenant can only come from the SESSION
// (CLAUDE.md §4) — never from an id the caller supplied.
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function askRelationshipAI(params: {
  question: string
  contactName: string
  contactPersona?: string | null
  systemPrompt?: string
}): Promise<{ success: boolean; answer?: string; error?: string }> {
  const { question, contactName, contactPersona, systemPrompt } = params

  // Tenant for the AI cost ledger — SESSION (§4). Every argument here is
  // caller-supplied copy; none of it can name a payer.
  const spendActor = await getAgentContext()

  if (!question?.trim()) {
    return { success: false, error: "Question is required" }
  }

  const resolvedSystemPrompt = systemPrompt ??
    `You are a real estate relationship advisor. The agent is asking about their client named ${contactName}${contactPersona ? ` (persona: ${contactPersona})` : ""}. Give concise, actionable advice in 2-3 sentences. Be specific and practical.`

  // Single egress through generateTextRouted: gateway + AI_TASK_ROUTING + automatic fallback
  // model + fair-use accounting + cost log. Previously this file had a direct-OpenAI fallback
  // that bypassed the gateway entirely (defeating cost metering, rate-limit pooling, healer).
  // The routed wrapper IS the correct fallback layer: if the primary model fails, it falls back
  // to the routing table's secondary model — all under the same single egress.
  if (!process.env.AI_GATEWAY_API_KEY) {
    return { success: false, error: "AI provider not configured. Please add AI_GATEWAY_API_KEY to environment variables." }
  }

  try {
    const { text } = await generateTextRouted({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      feature:     "ai_isa_response",
      system:      resolvedSystemPrompt,
      prompt:      question.trim(),
      maxTokens:   600,
    })

    return { success: true, answer: text.trim() }
  } catch (err: any) {
    console.error("[v0] Relationship AI error:", err)
    return { success: false, error: "Failed to generate advice. Please try again." }
  }
}
