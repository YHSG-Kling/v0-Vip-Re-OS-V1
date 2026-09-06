import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * GET /api/dashboard/badge-counts
 *
 * Returns real counts for every badgeKey used in navigation-config.ts.
 * Called once per session from AppShell and refreshed on navigation.
 * All queries are scoped to the authenticated user's brokerage.
 *
 * ─── TOMBSTONE ───────────────────────────────────────────────────────────────
 *
 * `app/api/notifications/unread-count/route.ts` was DELETED into this route. It
 * was a GET returning `{ unread }` and nothing else — a third door onto the one
 * number `unread_notifications` below already serves, and nothing in the tree
 * addressed it (no fetch, no SWR key, no config entry, no cron, and no database
 * caller — checked live on `hrvaqgvukzxfskkcrwbt`: zero edge functions, zero
 * pg_proc bodies naming an `/api/` path). Deleting it removed the whole
 * `app/api/notifications/` directory.
 *
 * Nothing needed merging: it was a two-line wrapper over
 * `countUnreadNotifications`, strictly less than either survivor.
 *
 * WHERE THE CAPABILITY LIVES:
 *   · the HTTP surface, i.e. the unread badge → this route, read by
 *     app/components/layout/app-shell.tsx:62 through SWR.
 *   · the in-process count → lib/kernel/notification-center.ts:60
 *     `countUnreadNotifications`, read by app/notifications/page.tsx:34.
 *
 * ONE HONEST DIVERGENCE, LEFT STANDING AND WRITTEN DOWN RATHER THAN GUESSED AT
 * (§6): the two survivors spell "unread" differently. This route filters
 * `brokerage_id` AND `user_id`; `countUnreadNotifications` filters `user_id`
 * only. For a single-brokerage user they agree; for anyone whose notifications
 * span tenants the bell and the /notifications page would show different
 * numbers. It is NOT collapsed here because `public.notifications` currently
 * holds 0 rows (live count, 2026-08-26), so there is no evidence which way the
 * live data would break, and tightening the page's count on a guess could take
 * a working list to zero. Whoever gets rows into that table owns the merge.
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

    // Resolve brokerage + role from users row (source of truth per spec).
    //
    // `error` is destructured: supabase-js RESOLVES a refused read, so without it
    // a refusal arrives as `data: null`, `brokerageId` falls to null, and EVERY
    // badge on the page silently reports zero — indistinguishable from a quiet
    // day. This one value is also the tenant every notification writer must stamp
    // (see lib/notifications/recipient-tenant.ts): `.eq("brokerage_id", …)` below
    // compares against exactly this, and `NULL = <uuid>` is NULL, never true.
    const { data: userData, error: userLookupError } = await supabase
      .from("users")
      .select("id, brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle()
    if (userLookupError) {
      console.error("[badge-counts] users lookup refused:", userLookupError.message)
    }

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
        // compliance_flags.status is flagged|reviewed|resolved|overridden — neither
        // "open" nor "pending" exists, so this badge count was always 0.
        .in("status", ["flagged"]),

      // Active deals (transactions coordinator — TC/broker/admin only)
      ["tc", "broker", "admin", "team_lead"].includes(userType)
        ? supabase
            .from("transactions")
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId)
            .in("status", ["active", "under_contract"])
        : Promise.resolve({ count: 0 }),

      // Vendor pending jobs (vendor role only)
      userType === "vendor"
        ? supabase
            .from("vendor_jobs")
            .select("id", { count: "exact", head: true })
            .eq("status", "pending")
        : Promise.resolve({ count: 0 }),

      // Lenders are vendors — a lender's pipeline counts under the vendor branch.
      Promise.resolve({ count: 0 }),

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

    // A COUNT query carries its refusal in `error` too, and `count` comes back
    // null — which `?? 0` then renders as "no unread notifications". The response
    // contract is deliberately unchanged (this route never fails navigation), but
    // the refusal is no longer silent.
    if ((notificationsResult as { error?: { message: string } | null }).error) {
      console.error(
        "[badge-counts] unread notifications count refused:",
        (notificationsResult as { error: { message: string } }).error.message,
      )
    }

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
