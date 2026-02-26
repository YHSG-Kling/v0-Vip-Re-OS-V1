import { type NextRequest, NextResponse } from "next/server"
import { supabase } from "@/services/supabase"
import { getAgentContext } from "@/lib/identity"

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { agentId, brokerageId } = await getAgentContext()

    const { data: contact, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.id)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .single()

    if (error) {
      console.error("[Contact Get] Supabase error:", error)
      return NextResponse.json({ success: false, error: "Contact not found" }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      contact,
    })
  } catch (error: any) {
    console.error("[Contact Get] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { agentId, brokerageId } = await getAgentContext()

    // Soft delete
    const { error } = await supabase
      .from("contacts")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)

    if (error) {
      console.error("[Contact Delete] Supabase error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: "Contact deleted successfully",
    })
  } catch (error: any) {
    console.error("[Contact Delete] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
