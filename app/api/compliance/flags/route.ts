import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    // Scope to brokerage from session — never from query params
    let query = supabase
      .from("compliance_flags")
      .select("*")
      .eq("brokerage_id", auth.brokerageId)
      .order("created_at", { ascending: false })

    // Agents see only their own flags; brokers/admins/compliance see all in brokerage
    if (
      auth.userType === "agent" &&
      auth.agentId
    ) {
      query = query.eq("agent_id", auth.agentId)
    }

    const { data: flags, error } = await query

    if (error) {
      console.error("[Compliance Flags] DB error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      flags: flags ?? [],
      total: flags?.length ?? 0,
    })
  } catch (error: any) {
    console.error("[Compliance Flags] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  // Only brokers/admins/compliance officers can update flags
  // SCOPE LADDER (kept inline — admits compliance_officer): 'superadmin'
  // removed — dead as users.user_type (0 live rows); broker_owner added —
  // storable seat that owns the brokerage.
  if (!["broker", "broker_owner", "admin", "compliance_officer"].includes(auth.userType)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 })
  }

  try {
    const { flagId, status, notes } = await request.json()

    if (!flagId) {
      return NextResponse.json({ success: false, error: "Flag ID required" }, { status: 400 })
    }

    const { data: flag, error } = await supabase
      .from("compliance_flags")
      .update({
        status,
        resolution_notes: notes,
        resolved_at: status === "resolved" ? new Date().toISOString() : null,
      })
      .eq("id", flagId)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle()

    if (error) {
      console.error("[Compliance Flag Update] DB error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    if (!flag) {
      return NextResponse.json(
        { success: false, error: "Flag not found or access denied" },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true, flag })
  } catch (error: any) {
    console.error("[Compliance Flag Update] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
