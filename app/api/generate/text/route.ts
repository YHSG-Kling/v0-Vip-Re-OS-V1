import { type NextRequest, NextResponse } from "next/server"
import { generateAIResponse } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { analyzeContentQuality } from "@/lib/quality-checker"
import { getAgentContext } from "@/lib/identity/get-agent-context"

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

    // Get actor context for governance
    const agentCtx = await getAgentContext()
    const actorContext = agentCtx
      ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
      : undefined

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: user.id,
        brokerageId: actorContext?.brokerageId,
        feature: "generate_text",
      },
    })
    const text = response.text

    // Analyze quality
    const quality = analyzeContentQuality(text)

    // ai_generated_content is the CANONICAL AI-output ledger (the AI audit +
    // content surfaces read it; plain generated_content was a write-only twin
    // nothing consumed — keep-one repoint, open-loop sweep). prospect_id has
    // no column on the canonical ledger — carried in metadata.
    const { data: savedContent, error: saveError } = await supabase
      .from("ai_generated_content")
      .insert({
        content_type: "text",
        content: text,
        user_id: user.id,                      // users-class
        agent_id: agentId,                     // agents-class (identity census)
        brokerage_id: agentCtx?.brokerageId ?? null,
        title: `Prospect text — ${messageType || "outreach"}`,
        quality_score: quality.score / 100,
        metadata: {
          source: "generate_text_api",
          prospect_id: prospectId,
          messageType,
          them_percentage: quality.themPercentage,
          agent_percentage: quality.agentPercentage,
          warnings: quality.warnings,
        },
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
    console.error("[v0] Error generating text:", error)
    return NextResponse.json({ error: "Failed to generate text message" }, { status: 500 })
  }
}
