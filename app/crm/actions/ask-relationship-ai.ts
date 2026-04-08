"use server"

import { generateText } from "ai"
import { anthropic } from "@ai-sdk/anthropic"

export async function askRelationshipAI(params: {
  question: string
  contactName: string
  contactPersona?: string | null
}): Promise<{ success: boolean; answer?: string; error?: string }> {
  try {
    const { question, contactName, contactPersona } = params

    if (!question?.trim()) {
      return { success: false, error: "Question is required" }
    }

    const { text } = await generateText({
      model: anthropic("claude-sonnet-4-20250514"),
      system: `You are a real estate relationship advisor. The agent is asking about their client named ${contactName}${contactPersona ? ` (persona: ${contactPersona})` : ""}. Give concise, actionable advice in 2-3 sentences. Be specific and practical.`,
      prompt: question.trim(),
      maxOutputTokens: 400,
    })

    return { success: true, answer: text.trim() }
  } catch {
    return { success: false, error: "Failed to generate advice" }
  }
}
