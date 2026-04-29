import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Auth guard — brokerage scoping always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { id } = await params

    let query = supabase
      .from("contacts")
      .select("*")
      .eq("id", id)
      .eq("brokerage_id", auth.brokerageId)
      .is("deleted_at", null)

    // Agents can only see their own contacts; brokers/admins see all in the brokerage.
    // contacts.agent_id → agents.id (FK corrected in migration 114)
    if (auth.agentId && !["broker", "admin", "superadmin"].includes(auth.userType)) {
      query = query.eq("agent_id", auth.agentId)
    }

    const { data: contact, error } = await query.single()

    if (error) {
      console.error("[Contact GET] Supabase error:", error)
      return NextResponse.json({ success: false, error: "Contact not found" }, { status: 404 })
    }

    return NextResponse.json({ success: true, contact })
  } catch (error: any) {
    console.error("[Contact GET] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Auth guard — brokerage scoping always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { id } = await params

    let query = supabase
      .from("contacts")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("brokerage_id", auth.brokerageId)   // brokerage isolation

    // Agents can only delete their own contacts; brokers/admins can delete any in brokerage.
    // contacts.agent_id → agents.id (FK corrected in migration 114)
    if (auth.agentId && !["broker", "admin", "superadmin"].includes(auth.userType)) {
      query = query.eq("agent_id", auth.agentId)
    }

    const { error } = await query

    if (error) {
      console.error("[Contact DELETE] Supabase error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: "Contact deleted successfully" })
  } catch (error: any) {
    console.error("[Contact DELETE] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
