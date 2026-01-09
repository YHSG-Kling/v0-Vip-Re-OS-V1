import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get("agent_id") || undefined

    console.log("[v0] API /api/contacts/list called with agentId:", agentId)

    const contacts = await supabaseService.getContacts(agentId)

    console.log("[v0] API fetched contacts:", contacts?.length || 0)

    return NextResponse.json({
      success: true,
      contacts: contacts || [],
      total: contacts?.length || 0,
    })
  } catch (error: any) {
    console.error("[Contact List API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
