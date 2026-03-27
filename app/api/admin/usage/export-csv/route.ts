import { createClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  // Verify auth
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Verify role — user_type is the canonical field; role is legacy fallback
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const resolvedType = profile?.user_type ?? profile?.role ?? ""
  if (!profile || !["broker", "admin", "superadmin"].includes(resolvedType)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const month = searchParams.get("month") || new Date().toISOString().slice(0, 7)
  const brokerageId = searchParams.get("brokerageId") || profile.brokerage_id

  // Verify brokerage access
  if (brokerageId !== profile.brokerage_id && resolvedType !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Fetch cost allocation data
  const { data: allocations, error } = await supabase
    .from("cost_allocation")
    .select(`
      *,
      agents:agent_id(id, user_id),
      teams:team_id(id, name)
    `)
    .eq("brokerage_id", brokerageId)
    .eq("period_label", month)
    .order("allocated_cost_cents", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Build CSV
  const headers = ["Agent/Team", "Cost Type", "Allocated Cost ($)", "Period"]
  const rows = (allocations || []).map((a: any) => {
    const name = a.teams?.name || (a.agent_id ? a.agent_id : "Unassigned")
    const costDollars = ((a.allocated_cost_cents || 0) / 100).toFixed(2)
    return [name, a.cost_type || "", costDollars, a.period_label || ""]
  })

  const csv = [
    headers.join(","),
    ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
  ].join("\n")

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="cost-allocation-${month}.csv"`,
    },
  })
}
