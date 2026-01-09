import { type NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { supabase } from "@/services/supabase"
import { analyzeContentQuality } from "@/lib/quality-checker"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { audienceType, painPoint, topic } = body

    // Generate them-first newsletter
    const prompt = `Generate a THEM-FIRST newsletter for real estate prospects.

CRITICAL RULES:
- 85% about THEIR needs, concerns, and situations
- 15% about your expertise (positioned as how it helps THEM)
- Include sections that answer THEIR questions
- Be genuinely helpful, not promotional
- Use engaging subject line focused on THEIR benefit

Audience Type: ${audienceType}
Pain Point: ${painPoint}
Topic: ${topic || "General real estate insights"}

Generate a full newsletter with:
1. Subject line (them-focused)
2. Opening (addresses their emotion/situation)
3. Main content (valuable information for them)
4. Local Event they may be interested in.
5. Closing (soft CTA focused on their benefit)
`

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
        content_type: "newsletter",
        content: text,
        quality_score: quality.score / 100,
        them_percentage: quality.themPercentage,
        agent_percentage: quality.agentPercentage,
        warnings: quality.warnings,
        metadata: { audienceType, painPoint, topic },
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
    console.error("[v0] Error generating newsletter:", error)
    return NextResponse.json({ error: "Failed to generate newsletter" }, { status: 500 })
  }
}
