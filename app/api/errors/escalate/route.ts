import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * POST /api/errors/escalate
 * Escalate one or more errors with optional severity upgrade
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check user role
    const { data: userData } = await supabase
      .from("users")
      .select("user_type, platform_role, brokerage_id, first_name, last_name")
      .eq("id", user.id)
      .single()

    // TRUE ADMIN GATE (operational: error ops) — repointed to the ONE tenant
    // roster; the separate platform_role clause is kept as the platform lane.
    // 'superadmin' was dead in the array: 0 live rows store that users.user_type.
    if (!userData || (!isAdminOrBroker({ user_type: userData.user_type }) && userData.platform_role !== "superadmin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body = await request.json()
    const { 
      errorId, 
      errorIds, 
      escalatedSeverity, 
      notes,
      notifyUserId 
    } = body

    const idsToEscalate = errorIds || (errorId ? [errorId] : [])

    if (idsToEscalate.length === 0) {
      return NextResponse.json(
        { error: "No error IDs provided" },
        { status: 400 }
      )
    }

    const results: { errorId: string; success: boolean; error?: string }[] = []

    for (const id of idsToEscalate) {
      try {
        // Update severity if provided
        if (escalatedSeverity) {
          await supabase
            .from("automation_errors")
            .update({ severity: escalatedSeverity })
            .eq("id", id)
        }

        // Get error details for notification
        const { data: errorRecord } = await supabase
          .from("automation_errors")
          .select("*")
          .eq("id", id)
          .single()

        // Insert escalation log
        await supabase
          .from("error_resolution_log")
          .insert({
            error_id: id,
            brokerage_id: errorRecord?.brokerage_id || null,
            action_type: "escalated",
            action_by_user_id: user.id,
            action_by: `${userData.first_name || ""} ${userData.last_name || ""}`.trim() || user.email,
            notes: notes || "Manually escalated",
            resolution_metadata: {
              escalated_severity: escalatedSeverity,
              notify_user_id: notifyUserId,
            },
          })

        // Emit kernel event for critical escalations
        if (escalatedSeverity === "critical" && errorRecord) {
          await supabase
            .from("lifecycle_events")
            .insert({
              brokerage_id: errorRecord.brokerage_id,
              entity_type: "automation_error",
              entity_id: id,
              event_type: "SYSTEM_HEALTH_ALERT",
              actor_user_id: user.id,
              metadata: {
                workflow_name: errorRecord.workflow_name,
                severity: "critical",
                escalated_by: user.id,
                notes,
              },
            })
        }

        // Send notification if user specified
        if (notifyUserId && errorRecord) {
          await supabase
            .from("notifications")
            .insert({
              user_id: notifyUserId,
              brokerage_id: errorRecord.brokerage_id,
              type: "system_alert",
              title: `Error Escalation: ${errorRecord.workflow_name}`,
              body: `An automation error has been escalated to ${escalatedSeverity || errorRecord.severity}. ${notes || ""}`,
              priority: escalatedSeverity === "critical" ? "high" : "medium",
              entity_type: "automation_error",
              entity_id: id,
            })
        }

        results.push({ errorId: id, success: true })
      } catch (err) {
        results.push({
          errorId: id,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        })
      }
    }

    const successCount = results.filter(r => r.success).length
    const failCount = results.filter(r => !r.success).length

    return NextResponse.json({
      results,
      summary: {
        total: results.length,
        success: successCount,
        failed: failCount,
      },
    })
  } catch (err) {
    console.error("[API /errors/escalate] Error:", err)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
