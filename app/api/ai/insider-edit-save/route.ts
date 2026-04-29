import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: Request) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const newsletter = await request.json()

    // Upsert to newsletter_campaigns — real persistence (not a mock return).
    // The live schema uses newsletter_campaigns, not newsletters.
    const { data: saved, error } = await supabase
      .from("newsletter_campaigns")
      .upsert({
        ...(newsletter.id ? { id: newsletter.id } : {}),
        agent_id:     auth.agentId,
        brokerage_id: auth.brokerageId,
        created_by:   auth.userId,
        campaign_name: newsletter.title ?? "Untitled",
        subject_line:  newsletter.subjectLine ?? newsletter.subject_line ?? "",
        content:       newsletter.content ?? "",
        status:        "draft",
      })
      .select()
      .single()

    if (error) {
      console.error("[InsiderEditSave] DB error:", error)
      return NextResponse.json({ error: "Failed to save newsletter" }, { status: 500 })
    }

    return NextResponse.json({
      ...saved,
      updatedAt: saved.created_at,
    })
  } catch (error: any) {
    console.error("[InsiderEditSave] Error:", error)
    return NextResponse.json({ error: "Failed to save newsletter" }, { status: 500 })
  }
}
