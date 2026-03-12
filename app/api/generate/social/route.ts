import { type NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { analyzeContentQuality } from "@/lib/quality-checker"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const agentId = await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return NextResponse.json({ error: "Agent profile not found" }, { status: 403 })
    }

    const body = await request.json()
    const { audienceSegment, platform } = body

    // Generate them-first social post
    const prompt = `Generate a THEM-FIRST social media post for real estate.

CRITICAL RULES:
- 90% about your AUDIENCE, 10% about you
- Address THEIR pain points and emotions
- Be helpful and valuable, not salesy
- Use engaging format for ${platform || "general social media"}
- Include a soft call-to-action focused on THEIR benefit

Audience Segment: ${audienceSegment}

Generate a post that resonates with their situation and needs.`

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
        content_type: "social",
        content: text,
        quality_score: quality.score / 100,
        them_percentage: quality.themPercentage,
        agent_percentage: quality.agentPercentage,
        warnings: quality.warnings,
        metadata: { audienceSegment, platform },
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
    console.error("[v0] Error generating social post:", error)
    return NextResponse.json({ error: "Failed to generate social post" }, { status: 500 })
  }
}
