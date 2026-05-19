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
    const vendor_name = searchParams.get("vendor_name")
    const start_date = searchParams.get("start_date")
    const end_date = searchParams.get("end_date")

    const svc = createServiceClient()

    let query = svc
      .from("vendor_usage_tracking")
      .select("*")
      .eq("brokerage_id", auth.brokerageId)  // always scope to caller's brokerage

    if (vendor_name) {
      query = query.eq("vendor_name", vendor_name)
    }
    if (start_date) {
      query = query.gte("created_at", start_date)
    }
    if (end_date) {
      query = query.lte("created_at", end_date)
    }

    const { data, error } = await query.order("created_at", { ascending: false })

    if (error) {
      console.error("[vendor-costs] Error fetching vendor costs:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const totals = data.reduce(
      (acc, record) => {
        const vendor = record.vendor_name
        if (!acc.byVendor[vendor]) {
          acc.byVendor[vendor] = { total_cost: 0, total_units: 0, count: 0 }
        }
        acc.byVendor[vendor].total_cost += parseFloat(record.total_cost)
        acc.byVendor[vendor].total_units += record.units_used
        acc.byVendor[vendor].count += 1
        acc.grand_total += parseFloat(record.total_cost)
        return acc
      },
      { byVendor: {} as Record<string, any>, grand_total: 0 }
    )

    return NextResponse.json({ data, summary: totals, count: data.length })
  } catch (error) {
    console.error("[vendor-costs] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
