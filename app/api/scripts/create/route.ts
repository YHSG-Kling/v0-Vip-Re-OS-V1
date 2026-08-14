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
    //
    // `agent_id` was in this list and is NOT a column on `scripts` — the columns
    // are id, title, category, content, status, created_by, brokerage_id (m429),
    // visibility (m429), created_at, updated_at. PostgREST refuses an insert
    // naming a column it cannot find, and createScript() below swallows that
    // into `null`, so this route has been answering 500 "Failed to create
    // script" for every call it has ever received. Removed rather than added to
    // the table: authorship on `scripts` is `created_by`, a users id, which is
    // what the m429 INSERT policy pins to auth.uid().
    //
    // `visibility` is stamped, not defaulted, and the body cannot override it: a
    // script authored here starts as its author's own work. The only thing that
    // promotes one to 'brokerage' is lib/video/viral-script-share.ts, on the
    // owner's viral rule. Letting a request body post `visibility: "brokerage"`
    // would be a self-service share that skips the rule entirely.
    const safeScriptData = {
      ...scriptData,
      brokerage_id: auth.brokerageId,
      created_by:   auth.userId,
      visibility:   "private",
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
