"use server"

import { generateTextRouted as generateText } from "@/lib/ai/models"

/**
 * Generic AI insight generator for page-level context.
 * Uses AI SDK directly — no contactId required.
 * Called from client components via server action.
 */
export async function generatePageInsight({
  context,
  question,
}: {
  context: string
  question: string
}): Promise<{ success: boolean; insight?: string; error?: string }> {
  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      system:
        "You are a concise real estate business coach. Respond in 2-3 sentences maximum. Be specific and actionable. No bullet points.",
      messages: [
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion: ${question}`,
        },
      ],
    })
    return { success: true, insight: text.trim() }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Failed to generate insight" }
  }
}
