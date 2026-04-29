import { type NextRequest, NextResponse } from "next/server"
import { generateContent } from "@/lib/services"
import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    // agentId is intentionally NOT read from body — derived from session below.
    const { prospectId, emailType } = body

    if (!prospectId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // Resolve actor identity from session — never trust client-supplied agentId.
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // generateContent service expects the agent's users.id (session-derived)
    const agentId = user.id

    // Fetch prospect context
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
      id: result.content?.id,
    })
  } catch (error) {
    console.error("[v0] Error generating email:", error)
    const errorResponse = handleError(error, "generateEmail")
    return NextResponse.json(errorResponse, { status: 500 })
  }
}
