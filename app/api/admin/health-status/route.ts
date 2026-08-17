import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function GET() {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // TRUE ADMIN GATE (operational: health status) — repointed to the ONE tenant
    // roster. 'superadmin' was dead: 0 live rows store that users.user_type.
    if (!isAdminOrBroker({ user_type: ctx.role })) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Fetch service statuses
    const { data: services, error } = await supabase
      .from("service_status")
      .select("*")
      .eq("brokerage_id", ctx.brokerageId)
      .order("is_critical", { ascending: false })
      .order("service_category")
      .order("service_name")

    if (error) {
      console.error("Error fetching service statuses:", error)
      return NextResponse.json({ error: "Failed to fetch services" }, { status: 500 })
    }

    const typedServices = services || []

    // Determine overall status
    const criticalDown = typedServices.filter(
      (s: { is_critical: boolean; current_status: string }) =>
        s.is_critical && s.current_status === "down"
    )
    const anyDegraded = typedServices.some(
      (s: { current_status: string }) =>
        s.current_status === "degraded" || s.current_status === "down"
    )

    let overallStatus: "operational" | "critical" | "degraded" = "operational"
    if (criticalDown.length > 0) {
      overallStatus = "critical"
    } else if (anyDegraded) {
      overallStatus = "degraded"
    }

    // Get last checked timestamp
    const lastCheckedAt = typedServices.reduce(
      (latest: string | null, s: { last_checked_at: string | null }) => {
        if (!s.last_checked_at) return latest
        if (!latest) return s.last_checked_at
        return new Date(s.last_checked_at) > new Date(latest)
          ? s.last_checked_at
          : latest
      },
      null as string | null
    )

    return NextResponse.json({
      services: typedServices,
      overallStatus,
      criticalIssues: criticalDown,
      lastCheckedAt,
    })
  } catch (error) {
    console.error("Health status API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
