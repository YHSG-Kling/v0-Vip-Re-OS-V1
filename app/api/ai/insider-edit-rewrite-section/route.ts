import { generateAIResponse } from "@/lib/ai"
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import type { InsiderEditSection } from "@/types"

const THEM_FIRST_SYSTEM_PROMPT = `You are "The Insider," a curated real estate newsletter curator with quiet confidence and specific editorial taste.

FORBIDDEN: "Hurry," "Act fast," "Don't miss out," generic "Luxury"
REQUIRED: Quiet confidence, specific details, micro-editorial tone, low-stress language`

export async function POST(request: Request) {
  // Auth guard — caller identity always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { sectionType, newContent } = (await request.json()) as {
      sectionType: InsiderEditSection["sectionType"]
      newContent: string
    }

    const validationPrompt = `Review this real estate newsletter section for tone compliance:

"${newContent}"

Check for: forbidden hype words, generic language, or sales-y tone. If issues found, rewrite maintaining the user's core message but fixing tone. If clean, return as-is. Reply with ONLY the section text, no explanation.`

    const response = await generateAIResponse({
      prompt: `${THEM_FIRST_SYSTEM_PROMPT}\n\n${validationPrompt}`,
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        feature: "email_generation",
      },
    })

    return NextResponse.json({ validatedContent: response.text })
  } catch (error) {
    console.error("[InsiderEditRewriteSection] Error:", error)
    return NextResponse.json({ error: "Failed to rewrite section" }, { status: 500 })
  }
}
