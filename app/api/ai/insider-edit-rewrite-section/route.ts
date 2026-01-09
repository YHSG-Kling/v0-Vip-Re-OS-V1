import { generateText } from "ai"
import { NextResponse } from "next/server"
import type { InsiderEditSection } from "@/types"

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

    const { text: validatedContent } = await generateText({
      model: "openai/gpt-4-turbo",
      system: THEM_FIRST_SYSTEM_PROMPT,
      prompt: validationPrompt,
    })

    return NextResponse.json({ validatedContent })
  } catch (error) {
    console.error("[InsiderEditRewriteSection] Error:", error)
    return NextResponse.json({ error: "Failed to rewrite section" }, { status: 500 })
  }
}
