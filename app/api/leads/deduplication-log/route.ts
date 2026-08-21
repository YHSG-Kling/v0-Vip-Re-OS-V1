import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { resolveLeadVisibility, resolveScopedLeadIds } from "@/lib/auth/lead-visibility"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  // TOMBSTONE (lead-visibility consolidation): the inline `leadVisibleRoles`
  // array is DELETED. The survivor is
  // lib/auth/lead-visibility.ts:resolveLeadVisibility.
  //
  //   · team_lead ADMITTED, per the owner's ruling, and TEAM-SCOPED — the dedup
  //     log carries `lead_id` but no `agent_id`, so the scope cannot be written
  //     as a column filter here. resolveScopedLeadIds resolves the in-scope lead
  //     ids first and the log read keys off those. A team lead therefore sees
  //     dedup metadata for their own team's leads only.
  //   · 'support' REMOVED as a user_type comparison. The old note called it "a
  //     storable platform-staff user_type" — it is a storable TENANT user_type,
  //     unconnected to platform employment, so the entry admitted tenant users
  //     named 'support' and still missed real platform support (whose answer is
  //     in platform_role). The survivor reads platform_role.
  //   · 'broker_admin' REMOVED — not a storable user_type; the comparison
  //     matched nothing.
  const vis = await resolveLeadVisibility(supabase, {
    userId: auth.userId,
    userType: auth.userType,
    platformRole: auth.platformRole,
    brokerageId: auth.brokerageId,
  })
  if (!vis.allowed) {
    return NextResponse.json(
      { error: vis.status === "forbidden" ? "Forbidden" : vis.reason },
      { status: vis.status === "forbidden" ? 403 : 500 },
    )
  }

  try {
    const searchParams = request.nextUrl.searchParams
    const lead_id = searchParams.get("lead_id")
    const raw_record_id = searchParams.get("raw_record_id")
    const stage = searchParams.get("stage")
    const action_taken = searchParams.get("action_taken")
    const limit = parseInt(searchParams.get("limit") || "100")

    const svc = createServiceClient()

    // TEAM ROW SCOPE, resolved through the leads table because this one has no
    // agent column. `null` = no restriction needed (brokerage / platform scope);
    // an ARRAY = the team's leads; a refusal fails CLOSED rather than degrading
    // to an unrestricted read.
    const scopedIds = await resolveScopedLeadIds(supabase, vis.scope)
    if (!scopedIds.ok) {
      return NextResponse.json({ error: "Could not resolve your lead scope" }, { status: 500 })
    }

    let query = svc
      .from("lead_deduplication_log")
      .select("*")
      .eq("brokerage_id", auth.brokerageId)  // always scope to caller's brokerage
      .order("created_at", { ascending: false })
      .limit(limit)

    if (scopedIds.leadIds !== null) {
      query = scopedIds.leadIds.length > 0
        ? query.in("lead_id", scopedIds.leadIds)
        // A team with no in-scope leads gets NO rows, not every row.
        : query.eq("lead_id", "00000000-0000-0000-0000-000000000000")
    }

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
