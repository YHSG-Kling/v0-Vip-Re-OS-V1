import { createClient } from "@/lib/supabase/server"
import {
  assignResource,
  recordCompletion,
  getProgressDashboard,
} from "@/lib/kernel/education"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const brokerageId = request.nextUrl.searchParams.get("brokerageId")
  const contactId = request.nextUrl.searchParams.get("contactId")

  if (!brokerageId) {
    return NextResponse.json({ error: "Missing brokerageId" }, { status: 400 })
  }

  try {
    if (contactId) {
      const { data: progress } = await supabase
        .from("contact_education_progress")
        .select("*")
        .eq("contact_id", contactId)
        .eq("brokerage_id", brokerageId)

      return NextResponse.json({ progress })
    }

    const dashboard = await getProgressDashboard(supabase, { brokerageId })
    return NextResponse.json(dashboard)
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch progress" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  try {
    const body = await request.json()
    const { action, ...input } = body

    if (action === "assign") {
      const result = await assignResource(supabase, input)
      return NextResponse.json(result, { status: 201 })
    } else if (action === "complete") {
      const result = await recordCompletion(supabase, {
        ...input,
        completedAt: new Date().toISOString(),
      })
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: "Failed to update progress" }, { status: 500 })
  }
}
