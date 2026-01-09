import { type NextRequest, NextResponse } from "next/server"
import { supabase } from "@/services/supabase"

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const { data: contact, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.id)
      .eq("agent_id", user.id)
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
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    // Soft delete
    const { error } = await supabase
      .from("contacts")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .eq("agent_id", user.id)

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
