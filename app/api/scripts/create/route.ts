import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { supabaseService } from "@/services/supabaseService"

export async function POST(request: NextRequest) {
  // Auth — was previously open to the world. createScript() uses the admin
  // client (RLS bypass), so unauth callers could insert arbitrary script
  // rows attributed to any agent / brokerage they specified.
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const scriptData = await request.json()

    // Stamp caller identity onto the row so the body can't claim a different
    // agent/brokerage. This wins over whatever the request body sends.
    const safeScriptData = {
      ...scriptData,
      agent_id:     auth.agentId,
      brokerage_id: auth.brokerageId,
      created_by:   auth.userId,
    }
    const script = await supabaseService.createScript(safeScriptData)

    if (!script) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to create script",
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      script,
    })
  } catch (error: any) {
    console.error("[Script Create API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
