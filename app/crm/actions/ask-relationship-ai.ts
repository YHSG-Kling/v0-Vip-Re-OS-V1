"use server"

import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"

export async function askRelationshipAI(params: {
  question: string
  contactName: string
  contactPersona?: string | null
  systemPrompt?: string
}): Promise<{ success: boolean; answer?: string; error?: string }> {
  const { question, contactName, contactPersona, systemPrompt } = params

  if (!question?.trim()) {
    return { success: false, error: "Question is required" }
  }

  const resolvedSystemPrompt = systemPrompt ??
    `You are a real estate relationship advisor. The agent is asking about their client named ${contactName}${contactPersona ? ` (persona: ${contactPersona})` : ""}. Give concise, actionable advice in 2-3 sentences. Be specific and practical.`

  // Single egress through Vercel AI Gateway. Previously this had a direct-OpenAI fallback
  // (`createOpenAI({apiKey: OPENAI_API_KEY})`) that bypassed the gateway entirely — that defeats
  // cost metering, rate-limit pooling, and the connector healer. If the gateway path fails, the
  // model-routing layer's fallback (in generateTextRouted) is the correct recovery path; we don't
  // want a second egress route from this caller.
  if (!process.env.AI_GATEWAY_API_KEY) {
    return { success: false, error: "AI provider not configured. Please add AI_GATEWAY_API_KEY to environment variables." }
  }

  try {
    const { text } = await generateText({
      model:           resolveModel("openai/gpt-4o-mini"),
      system:          resolvedSystemPrompt,
      prompt:          question.trim(),
      maxOutputTokens: 600,
    })

    return { success: true, answer: text.trim() }
  } catch (err: any) {
    console.error("[v0] Relationship AI error:", err)
    return { success: false, error: "Failed to generate advice. Please try again." }
  }
}
