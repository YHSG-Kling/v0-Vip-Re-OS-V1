import { type NextRequest, NextResponse } from "next/server"
import { generateContent } from "@/lib/services/content-generation.service"
import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"
import { generateText } from "@/lib/services/text-generation.service"
import { analyzeContentQuality } from "@/lib/services/content-quality.service"

const supabase = createClient()

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { prospectId, emailType, agentId } = body

    if (!prospectId || !agentId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // Fetch prospect context
    const supabase = await createClient()
    const { data: context, error: contextError } = await supabase
      .from("prospect_context")
      .select("*, prospects(*)")
      .eq("prospect_id", prospectId)
      .single()

    if (contextError) throw contextError

    // Use consolidated content generation service
    const result = await generateContent({
      agentId,
      contentType: "email",
      targetAudience: context.contact_persona || "general",
      context: {
        emotion: context.emotion,
        situation: context.situation,
        painPoint: context.pain_point,
        timeline: context.timeline,
        lifeContext: context.life_context,
        whatHelps: context.what_helps,
        emailType,
      },
      platform: "email",
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Failed to generate email" }, { status: 500 })
    }

    return NextResponse.json({
      content: result.content,
      quality: result.qualityScore,
      id: result.contentId,
    })
  } catch (error) {
    console.error("[v0] Error generating email:", error)
    return handleError(error, "generateEmail")
  }
}
