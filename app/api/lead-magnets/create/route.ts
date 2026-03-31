import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createLeadMagnet, type CreateLeadMagnetInput } from "@/lib/kernel/lead-magnets"

// POST /api/lead-magnets/create
// Input contract: CreateLeadMagnetInput
// Output contract: CreateLeadMagnetOutput
// Auth: required — broker admin or agent
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const body: CreateLeadMagnetInput = await req.json()

    if (!body.title?.trim()) {
      return NextResponse.json({ success: false, error: "title is required" }, { status: 400 })
    }
    if (!body.brokerageId) {
      return NextResponse.json({ success: false, error: "brokerageId is required" }, { status: 400 })
    }
    if (!body.agentId) {
      return NextResponse.json({ success: false, error: "agentId is required" }, { status: 400 })
    }
    if (!body.magnetType) {
      return NextResponse.json({ success: false, error: "magnetType is required" }, { status: 400 })
    }

    const result = await createLeadMagnet({ ...body, createdBy: user.id })

    if (!result.success) {
      return NextResponse.json(result, { status: 422 })
    }

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    console.error("[API] /api/lead-magnets/create:", err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}
