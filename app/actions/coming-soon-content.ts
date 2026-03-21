"use server"

import { generateText } from "ai"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"

export async function generateComingSoonContent(params: {
  agentId: string
  listingAddress: string
  daysUntilLaunch: number
  launchDateStr: string
}): Promise<{ success: boolean; socialPost?: string; emailBody?: string; error?: string }> {
  const { agentId, listingAddress, daysUntilLaunch, launchDateStr } = params

  const brandVoice = await getBrandVoiceProfile(agentId).catch(() => null)
  const tone = (brandVoice as any)?.tone ?? "exciting and professional"

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Write a coming soon real estate listing announcement.
Property: ${listingAddress}.
Going live in ${daysUntilLaunch} days (${launchDateStr}).
Tone: ${tone}.
Generate two versions separated by "---EMAIL---":
1. Social post (2-3 sentences, engaging, includes CTA to request a showing)
2. Email teaser (4-5 sentences, builds anticipation, includes showing request CTA)
Format: social content first, then ---EMAIL--- then email content.`,
    })

    const parts = text.split("---EMAIL---")
    return {
      success: true,
      socialPost: (parts[0] ?? "").trim(),
      emailBody: (parts[1] ?? "").trim(),
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "AI generation failed",
    }
  }
}
