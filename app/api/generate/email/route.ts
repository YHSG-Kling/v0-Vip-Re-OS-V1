import { type NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { supabase } from "@/services/supabase"
import { analyzeContentQuality } from "@/lib/quality-checker"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { prospectId, emailType } = body

    // Fetch prospect context
    const { data: context, error: contextError } = await supabase
      .from("prospect_context")
      .select("*, prospects(*)")
      .eq("prospect_id", prospectId)
      .single()

    if (contextError) throw contextError

    // Generate them-first email using AI
    const prompt = `You are a real estate content expert. Generate a THEM-FIRST email for a prospect.

CRITICAL RULES:
- 80-90% about the PROSPECT, 10-20% about the agent
- Start with THEIR emotion or situation, NOT your credentials
- Focus on THEIR pain point and what helps them
- Use "you" and "your" frequently
- Minimize "I", "me", "my"

Prospect Context:
- Emotion: ${context.emotion || "Not specified"}
- Situation: ${context.situation || "Not specified"}
- Pain Point: ${context.pain_point || "Not specified"}
- Timeline: ${context.timeline || "Not specified"}
- Life Context: ${context.life_context || "Not specified"}
- What Helps: ${context.what_helps || "Not specified"}

Email Type: ${emailType}

Generate an email that's warm, empathetic, and focused on THEM, not you.`

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
        content_type: "email",
        content: text,
        quality_score: quality.score / 100,
        them_percentage: quality.themPercentage,
        agent_percentage: quality.agentPercentage,
        warnings: quality.warnings,
        metadata: { emailType },
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
    console.error("[v0] Error generating email:", error)
    return NextResponse.json({ error: "Failed to generate email" }, { status: 500 })
  }
}
