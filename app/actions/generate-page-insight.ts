"use server"

import { generateTextRouted as generateText } from "@/lib/ai/models"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint, so the AI cost ledger's tenant can only come from the SESSION
// (CLAUDE.md §4) — never from an id the caller supplied.
import { getAgentContext } from "@/lib/identity/get-agent-context"

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
    // Tenant for the AI cost ledger — SESSION (§4). This action takes no id at
    // all, so the session is the only honest payer.
    const spendActor = await getAgentContext()
    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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
