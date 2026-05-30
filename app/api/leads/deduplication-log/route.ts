import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const searchParams = request.nextUrl.searchParams
    const lead_id = searchParams.get("lead_id")
    const raw_record_id = searchParams.get("raw_record_id")
    const stage = searchParams.get("stage")
    const action_taken = searchParams.get("action_taken")
    const limit = parseInt(searchParams.get("limit") || "100")

    const svc = createServiceClient()

    let query = svc
      .from("lead_deduplication_log")
      .select("*")
      .eq("brokerage_id", auth.brokerageId)  // always scope to caller's brokerage
      .order("created_at", { ascending: false })
      .limit(limit)

    if (lead_id) {
      query = query.eq("lead_id", lead_id)
    }
    if (raw_record_id) {
      query = query.eq("raw_record_id", raw_record_id)
    }
    if (stage) {
      query = query.eq("stage", stage)
    }
    if (action_taken) {
      query = query.eq("action_taken", action_taken)
    }

    const { data, error } = await query

    if (error) {
      console.error("[deduplication-log] Error fetching log:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const stats = {
      total: data.length,
      by_action: data.reduce((acc, log) => {
        acc[log.action_taken] = (acc[log.action_taken] || 0) + 1
        return acc
      }, {} as Record<string, number>),
      by_stage: data.reduce((acc, log) => {
        acc[log.stage] = (acc[log.stage] || 0) + 1
        return acc
      }, {} as Record<string, number>),
      avg_match_score: data.length
        ? data.reduce((sum, log) => sum + (log.match_score || 0), 0) / data.length
        : 0,
    }

    return NextResponse.json({ data, stats })
  } catch (error) {
    console.error("[deduplication-log] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
