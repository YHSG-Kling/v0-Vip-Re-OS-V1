import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import { checkVendorBudget, getBrokerageBudgetWarningEnabled } from "@/lib/vendor-governance/budget-gate"
import { redactBudgetForActor } from "@/lib/vendor-governance/budget-visibility"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  // PRIVACY: brokerage/subscriber users NEVER see vendor names or dollar amounts.
  // They get only a coarse status level + a (superadmin-toggled) "approaching limit"
  // warning. Full vendor-spend detail is platform-staff only — the owner's four
  // roles, resolved from users.platform_role.
  //
  // This gate previously read `isPlatformStaff(auth.userType)`: a roster of
  // platform_role values matched against user_type. It leaked in one direction and
  // locked out in the other — any TENANT user whose user_type is 'support' (a legal
  // tenant role) got the full vendor-name breakdown, while the platform's actual
  // superadmin (user_type='admin', platform_role='superadmin') did not.
  if (!isPlatformStaffIdentity(auth.userType, auth.platformRole)) {
    const [budget, warningEnabled] = await Promise.all([
      checkVendorBudget({ brokerageId: auth.brokerageId }),
      getBrokerageBudgetWarningEnabled(),
    ])
    return NextResponse.json(
      redactBudgetForActor(budget, { isPlatformStaff: false, showBrokerageWarning: warningEnabled }),
    )
  }

  try {
    const searchParams = request.nextUrl.searchParams
    const vendor_name = searchParams.get("vendor_name")
    const start_date = searchParams.get("start_date")
    const end_date = searchParams.get("end_date")
    // Platform staff may inspect any brokerage; default to their own.
    const targetBrokerageId = searchParams.get("brokerage_id") ?? auth.brokerageId

    const svc = createServiceClient()

    let query = svc
      .from("vendor_usage_tracking")
      .select("*")
      .eq("brokerage_id", targetBrokerageId)

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
