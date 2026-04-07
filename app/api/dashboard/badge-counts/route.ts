import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * GET /api/dashboard/badge-counts
 *
 * Returns real counts for every badgeKey used in navigation-config.ts.
 * Called once per session from AppShell and refreshed on navigation.
 * All queries are scoped to the authenticated user's brokerage.
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Resolve brokerage + role from users row (source of truth per spec)
    const { data: userData } = await supabase
      .from("users")
      .select("id, brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle()

    const brokerageId = userData?.brokerage_id ?? null
    const userType: string = userData?.user_type ?? "agent"

    if (!brokerageId) {
      // New user with no brokerage — all counts are zero
      return NextResponse.json({
        unread_notifications: 0,
        pending_approvals: 0,
        isa_queue_count: 0,
        compliance_violations: 0,
        active_deals: 0,
        vendor_pending_jobs: 0,
        lender_pipeline_count: 0,
        title_open_orders: 0,
      })
    }

    // Run all count queries in parallel
    const [
      notificationsResult,
      approvalsResult,
      violationsResult,
      dealsResult,
      vendorJobsResult,
      lenderPipelineResult,
      titleOrdersResult,
      isaQueueResult,
    ] = await Promise.all([
      // Unread notifications for this user
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("user_id", user.id)
        .eq("is_read", false),

      // Pending approvals for this brokerage
      supabase
        .from("approval_items")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "pending"),

      // Open compliance flags (unresolved) for this brokerage
      supabase
        .from("compliance_flags")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .in("status", ["open", "pending"]),

      // Active deals (transactions coordinator — TC/broker/admin only)
      ["tc", "broker", "admin", "team_lead"].includes(userType)
        ? supabase
            .from("transactions")
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId)
            .in("status", ["active", "pending", "under_contract"])
        : Promise.resolve({ count: 0 }),

      // Vendor pending jobs (vendor role only)
      userType === "vendor"
        ? supabase
            .from("vendor_jobs")
            .select("id", { count: "exact", head: true })
            .eq("status", "pending")
        : Promise.resolve({ count: 0 }),

      // Lender pipeline (lender role only)
      userType === "lender"
        ? supabase
            .from("lender_portal_users")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("brokerage_id", brokerageId)
        : Promise.resolve({ count: 0 }),

      // Title open orders (title_agent role only)
      userType === "title_agent"
        ? supabase
            .from("title_company_users")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("brokerage_id", brokerageId)
        : Promise.resolve({ count: 0 }),

      // ISA calling queue — ai_isa_qualifications awaiting outreach
      userType === "isa"
        ? supabase
            .from("ai_isa_qualifications")
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId)
            .is("assigned_to_agent_id", null)
            .is("assigned_at", null)
        : Promise.resolve({ count: 0 }),
    ])

    return NextResponse.json({
      unread_notifications: notificationsResult.count ?? 0,
      pending_approvals: approvalsResult.count ?? 0,
      compliance_violations: violationsResult.count ?? 0,
      active_deals: dealsResult.count ?? 0,
      vendor_pending_jobs: vendorJobsResult.count ?? 0,
      lender_pipeline_count: lenderPipelineResult.count ?? 0,
      title_open_orders: titleOrdersResult.count ?? 0,
      isa_queue_count: isaQueueResult.count ?? 0,
    })
  } catch (error) {
    console.error("[badge-counts] Error:", error)
    return NextResponse.json(
      {
        unread_notifications: 0,
        pending_approvals: 0,
        isa_queue_count: 0,
        compliance_violations: 0,
        active_deals: 0,
        vendor_pending_jobs: 0,
        lender_pipeline_count: 0,
        title_open_orders: 0,
      },
      { status: 200 } // Return zeros on error — never fail navigation
    )
  }
}
