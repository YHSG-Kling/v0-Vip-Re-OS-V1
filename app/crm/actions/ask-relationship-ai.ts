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

  // Try Vercel AI Gateway first; fall back to direct OpenAI if gateway key missing
  const hasGateway = !!process.env.AI_GATEWAY_API_KEY
  const hasOpenAI  = !!process.env.OPENAI_API_KEY

  if (!hasGateway && !hasOpenAI) {
    return { success: false, error: "AI provider not configured. Please add AI_GATEWAY_API_KEY or OPENAI_API_KEY to environment variables." }
  }

  try {
    let model: any

    if (hasGateway) {
      model = resolveModel("openai/gpt-4o-mini")
    } else {
      // Direct OpenAI fallback
      const { createOpenAI } = await import("@ai-sdk/openai")
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
      model = openai("gpt-4o-mini")
    }

    const { text } = await generateText({
      model,
      system: resolvedSystemPrompt,
      prompt: question.trim(),
      maxOutputTokens: 600,
    })

    return { success: true, answer: text.trim() }
  } catch (err: any) {
    console.error("[v0] Relationship AI error:", err)
    // If gateway failed but we have OpenAI, retry directly
    if (hasGateway && hasOpenAI) {
      try {
        const { createOpenAI } = await import("@ai-sdk/openai")
        const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const { text } = await generateText({
          model: openai("gpt-4o-mini"),
          system: resolvedSystemPrompt,
          prompt: question.trim(),
          maxOutputTokens: 600,
        })
        return { success: true, answer: text.trim() }
      } catch (fallbackErr: any) {
        console.error("[v0] Relationship AI fallback error:", fallbackErr)
      }
    }
    return { success: false, error: "Failed to generate advice. Please try again." }
  }
}
