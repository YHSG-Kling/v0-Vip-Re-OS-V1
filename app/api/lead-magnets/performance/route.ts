import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getMagnetPerformance } from "@/lib/kernel/lead-magnets"

// GET /api/lead-magnets/performance?magnetId=&brokerageId=&dateFrom=&dateTo=
// Input contract: query params
// Output contract: GetMagnetPerformanceOutput
// Auth: required
export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const magnetId   = searchParams.get("magnetId")   ?? ""
    const brokerageId = searchParams.get("brokerageId") ?? ""
    const dateFrom   = searchParams.get("dateFrom")   ?? undefined
    const dateTo     = searchParams.get("dateTo")     ?? undefined

    if (!magnetId)    return NextResponse.json({ success: false, error: "magnetId required" }, { status: 400 })
    if (!brokerageId) return NextResponse.json({ success: false, error: "brokerageId required" }, { status: 400 })

    const result = await getMagnetPerformance({ magnetId, brokerageId, dateFrom, dateTo })

    if (!result.success) {
      return NextResponse.json(result, { status: 422 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("[API] /api/lead-magnets/performance:", err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}
