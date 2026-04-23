import { type NextRequest, NextResponse } from "next/server"
import { generateAIResponse } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { analyzeContentQuality } from "@/lib/quality-checker"
import { getAgentContext } from "@/lib/identity/get-agent-context"

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

    // Get actor context for governance
    const agentCtx = await getAgentContext()
    const actorContext = agentCtx
      ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
      : undefined

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: actorContext?.userId ?? "",
        brokerageId: actorContext?.brokerageId ?? "",
        feature: "newsletter_generation",
      },
    })
    const text = response.text

    // Analyze quality
    const quality = analyzeContentQuality(text)

    // Save generated content — only columns that exist in the schema
    const supabase = await createClient()
    const { data: savedContent, error: saveError } = await supabase
      .from("generated_content")
      .insert({
        content_type: "newsletter",
        content: text,
        agent_id: agentCtx?.userId ?? null,
        title: `Newsletter — ${topic || audienceType || 'General'}`,
      })
      .select("id")
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
