import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { trackCertificationExpiration, monitorTRIDCompliance } from "@/app/actions/compliance-monitoring"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Run daily to check compliance
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = await createClient()
    const results = {
      certifications_checked: 0,
      expiring_certs: 0,
      expired_certs: 0,
      trid_violations: 0,
      expired_content_deactivated: 0,
      cold_lead_violations_detected: 0,
    }

    // Check all agent certifications
    const { data: agents } = await supabase.from("profiles").select("id").eq("role", "agent")

    for (const agent of agents || []) {
      const status = await trackCertificationExpiration(agent.id)
      results.certifications_checked++
      results.expiring_certs += status.expiring
      results.expired_certs += status.expired
    }

    // Check TRID compliance for active transactions
    const { data: transactions } = await supabase
      .from("transactions")
      .select("id")
      .in("status", ["under_contract", "pending"])

    for (const txn of transactions || []) {
      const compliance = await monitorTRIDCompliance(txn.id)
      if (!compliance.compliant) {
        results.trid_violations += compliance.violations.length
      }
    }

    // === CONTENT APPROVAL AUDIT ===

    // Find and deactivate expired approved content
    const { data: expiredContent } = await supabase
      .from("approved_content_library")
      .select("id")
      .eq("is_active", true)
      .lt("expires_at", new Date().toISOString())

    if (expiredContent && expiredContent.length > 0) {
      const expiredIds = expiredContent.map((c) => c.id)
      await supabase.from("approved_content_library").update({ is_active: false }).in("id", expiredIds)
      results.expired_content_deactivated = expiredContent.length
    }

    // Check for cold lead channel violations in the last 24 hours
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    const { data: coldLeadViolations } = await supabase
      .from("communication_audit_log")
      .select("*")
      .gte("sent_at", yesterday.toISOString())
      .eq("lead_temperature", "cold")
      .not("communication_type", "in", "(email,print)")

    // Log violations
    if (coldLeadViolations && coldLeadViolations.length > 0) {
      const violations = coldLeadViolations.map((comm) => ({
        user_id: comm.user_id,
        agent_id: comm.agent_id,
        violation_type: "cold_lead_channel_violation",
        violation_details: {
          communication_log_id: comm.id,
          lead_id: comm.lead_id,
          contact_id: comm.contact_id,
          attempted_channel: comm.communication_type,
          message: `Cold lead contacted via ${comm.communication_type} instead of email or print mail`,
        },
        communication_log_id: comm.id,
        severity: "critical",
        detected_by: "automated_audit",
      }))

      await supabase.from("compliance_flags").insert(violations)
      results.cold_lead_violations_detected = coldLeadViolations.length
    }

    // Check for content used without approval
    const { data: unapprovedContent } = await supabase
      .from("communication_audit_log")
      .select("*")
      .gte("sent_at", yesterday.toISOString())
      .eq("was_approved_content", false)
      .eq("compliance_check_passed", false)

    if (unapprovedContent && unapprovedContent.length > 0) {
      const violations = unapprovedContent.map((comm) => ({
        user_id: comm.user_id,
        agent_id: comm.agent_id,
        violation_type: "unapproved_content_violation",
        violation_details: {
          communication_log_id: comm.id,
          contact_id: comm.contact_id,
          channel: comm.communication_type,
          message: "Content sent without compliance approval",
        },
        communication_log_id: comm.id,
        severity: "high",
        detected_by: "automated_audit",
      }))

      await supabase.from("compliance_flags").insert(violations)
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      results,
    })
  } catch (error: any) {
    console.error("[v0] Compliance monitoring cron error:", error)
    return NextResponse.json({ error: "Compliance monitoring failed", details: error.message }, { status: 500 })
  }
}
