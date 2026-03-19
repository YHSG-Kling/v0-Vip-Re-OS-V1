import { generateAIResponse } from "@/lib/ai"
import { NextResponse } from "next/server"
import type { InsiderEditSection } from "@/types"
import { getAgentContext } from "@/lib/identity/get-agent-context"

const THEM_FIRST_SYSTEM_PROMPT = `You are "The Insider," a curated real estate newsletter curator with quiet confidence and specific editorial taste.

FORBIDDEN: "Hurry," "Act fast," "Don't miss out," generic "Luxury"
REQUIRED: Quiet confidence, specific details, micro-editorial tone, low-stress language`

export async function POST(request: Request) {
  try {
    const { sectionType, newContent } = (await request.json()) as {
      sectionType: InsiderEditSection["sectionType"]
      newContent: string
    }

    // Validate the rewritten content against THEM-FIRST standards
    const validationPrompt = `Review this real estate newsletter section for tone compliance:

"${newContent}"

Check for: forbidden hype words, generic language, or sales-y tone. If issues found, rewrite maintaining the user's core message but fixing tone. If clean, return as-is. Reply with ONLY the section text, no explanation.`

    // Get actor context for governance
    const agentCtx = await getAgentContext()
    const actorContext = agentCtx
      ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
      : undefined

    const response = await generateAIResponse({
      prompt: `${THEM_FIRST_SYSTEM_PROMPT}\n\n${validationPrompt}`,
      metadata: {
        userId: actorContext?.userId,
        brokerageId: actorContext?.brokerageId,
        feature: "email_generation",
      },
    })
    const validatedContent = response.text

    return NextResponse.json({ validatedContent })
  } catch (error) {
    console.error("[InsiderEditRewriteSection] Error:", error)
    return NextResponse.json({ error: "Failed to rewrite section" }, { status: 500 })
  }
}
