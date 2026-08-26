import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { validateThemFirstContent } from "@/lib/them-first"

/**
 * POST /api/validate-them-first
 *
 * AUTH ADDED: this route was open to the internet and
 * lib/them-first/validator.ts:86 puts the caller's text straight into a live
 * model call (resolveModel("openai/gpt-4o-mini")) on the platform's own AI
 * credentials. Unauthenticated it was a free, unmetered proxy onto the AI
 * gateway that any stranger could bill to this platform, with no tenant to
 * charge the spend to. Nothing in the tree addresses this route, so the gate
 * cannot break a caller; an in-app caller already has a session.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { content, contentType, personaId } = await req.json()

    if (!content || content.length < 10) {
      return NextResponse.json({ error: "Content too short to validate (minimum 10 characters)" }, { status: 400 })
    }

    // THE TENANT COMES FROM THE SESSION (§4). requireAuth resolved brokerageId
    // off the users row, never off this request body — which matters twice here:
    // it is what stops the route being an unmetered proxy onto the platform's AI
    // credentials, and it is what makes the two model calls inside the validator
    // land on ai_tool_usage under the tenant that actually spent them (§5).
    const validation = await validateThemFirstContent(content, contentType, personaId, {
      brokerageId: auth.brokerageId,
      userId:      auth.userId,
      agentId:     auth.agentId,
    })

    return NextResponse.json(validation)
  } catch (error: any) {
    console.error("[v0] Them First validation error:", error)
    return NextResponse.json({ error: error.message || "Validation failed" }, { status: 500 })
  }
}
