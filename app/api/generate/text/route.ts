import { type NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { supabase } from "@/services/supabase"
import { analyzeContentQuality } from "@/lib/quality-checker"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { prospectId, messageType } = body

    // Fetch prospect context
    const { data: context, error: contextError } = await supabase
      .from("prospect_context")
      .select("*, prospects(*)")
      .eq("prospect_id", prospectId)
      .single()

    if (contextError) throw contextError

    // Generate them-first text message
    const prompt = `Generate a THEM-FIRST text message for a real estate prospect.

CRITICAL RULES:
- Keep it SHORT (under 160 characters ideal, max 300)
- 90% about THEM, 10% about you
- Lead with THEIR situation or emotion
- Be conversational and warm
- No credentials or bragging

Prospect Context:
- Emotion: ${context.emotion || "Not specified"}
- Situation: ${context.situation || "Not specified"}
- Pain Point: ${context.pain_point || "Not specified"}
- Timeline: ${context.timeline || "Not specified"}

Message Type: ${messageType}

Generate a brief, them-focused text message.`

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt,
    })

    // Analyze quality
    const quality = analyzeContentQuality(text)

    // Save generated content
    const { data: savedContent, error: saveError } = await supabase
      .from("generated_content")
      .insert({
        prospect_id: prospectId,
        content_type: "text",
        content: text,
        quality_score: quality.score / 100,
        them_percentage: quality.themPercentage,
        agent_percentage: quality.agentPercentage,
        warnings: quality.warnings,
        metadata: { messageType },
      })
      .select()
      .single()

    if (saveError) throw saveError

    return NextResponse.json({
      content: text,
      quality,
      id: savedContent.id,
    })
  } catch (error) {
    console.error("[v0] Error generating text:", error)
    return NextResponse.json({ error: "Failed to generate text message" }, { status: 500 })
  }
}
