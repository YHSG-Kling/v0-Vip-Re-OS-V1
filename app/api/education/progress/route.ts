import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import {
  assignResource,
  recordCompletion,
  getProgressDashboard,
} from "@/lib/kernel/education"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const contactId = request.nextUrl.searchParams.get("contactId")

  try {
    if (contactId) {
      const { data: progress } = await supabase
        .from("learning_assignments")
        .select("id, module_id, signal_source, status, viewed_at, completed_at, created_at")
        .eq("contact_id", contactId)
        .eq("brokerage_id", auth.brokerageId)  // always scope to caller's brokerage

      return NextResponse.json({ progress })
    }

    const dashboard = await getProgressDashboard(supabase, { brokerageId: auth.brokerageId })
    return NextResponse.json(dashboard)
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch progress" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { action, ...input } = body

    if (action === "assign") {
      const result = await assignResource(supabase, { ...input, brokerageId: auth.brokerageId })
      return NextResponse.json(result, { status: 201 })
    } else if (action === "complete") {
      const result = await recordCompletion(supabase, {
        ...input,
        brokerageId: auth.brokerageId,
        completedAt: new Date().toISOString(),
      })
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: "Failed to update progress" }, { status: 500 })
  }
}
