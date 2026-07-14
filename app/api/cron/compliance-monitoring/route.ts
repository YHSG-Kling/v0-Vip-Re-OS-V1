import {
type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { trackCertificationExpirationService, monitorTRIDComplianceService } from "@/lib/application"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Run daily to check compliance
export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "compliance-monitoring",
    cron_path: "/app/api/cron/compliance-monitoring/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[ComplianceMonitoring] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const results = {
      certifications_checked: 0,
      expiring_certs: 0,
      expired_certs: 0,
      trid_violations: 0,
      trid_deadlines_flagged: 0,
      trid_deadlines_escalated: 0,
      expired_content_deactivated: 0,
      cold_lead_violations_detected: 0,
      license_readiness_reminded: 0,
      license_readiness_blocked: 0,
    }

    // AGENT LICENSE / CE / ETHICS READINESS — autonomously warn agents BEFORE a lapse and escalate a
    // hard blocker to the broker (the offer-time gate only catches it mid-transaction). recruiting_manager.
    try {
      const { sweepAllLicenseReadiness } = await import("@/lib/recruiting/license-readiness-sweep")
      const readiness = await sweepAllLicenseReadiness(supabase)
      results.license_readiness_reminded = readiness.reminded
      results.license_readiness_blocked = readiness.blocked
    } catch (e) {
      console.error("[ComplianceMonitoring] license readiness sweep:", e)
    }

    // AGENT RETENTION RADAR — daily flight-risk score per agent; a fresh at-risk breach proposes a gated
    // broker save-play (the defensive mirror of the switch-propensity scout). recruiting_manager.
    try {
      const { runRetentionRadarAll } = await import("@/lib/recruiting/retention-radar")
      const ret = await runRetentionRadarAll(supabase)
      ;(results as any).retention_at_risk = ret.atRisk
      ;(results as any).retention_save_plays = ret.savePlays
    } catch (e) {
      console.error("[ComplianceMonitoring] retention radar:", e)
    }

    // Check all agent certifications
    const { data: agents } = await supabase.from("users").select("id").eq("role", "agent")

    for (const agent of agents || []) {
      const status = await trackCertificationExpirationService(agent.id, supabase)
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
      const compliance = await monitorTRIDComplianceService(txn.id, supabase)
      if (!compliance.compliant) {
        results.trid_violations += compliance.violations.length
      }
    }

    // FORWARD-LOOKING TRID DISCLOSURE CLOCK — per brokerage, warn BEFORE the Closing
    // Disclosure / Loan Estimate deadline (not after, like the post-hoc monitor above).
    const { runTridDisclosureClock } = await import("@/lib/compliance/trid-disclosure-clock-runner")
    const { data: clockBrokerages } = await supabase.from("brokerages").select("id").is("deleted_at", null)
    for (const b of (clockBrokerages ?? []) as Array<{ id: string }>) {
      try {
        const clock = await runTridDisclosureClock({ brokerageId: b.id }, supabase)
        results.trid_deadlines_flagged += clock.flagged
        results.trid_deadlines_escalated += clock.escalated
      } catch (e) {
        console.error(`[ComplianceMonitoring] TRID clock ${b.id}:`, e)
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

    // Log violations.
    // compliance_flags live cols: user_id, agent_id, brokerage_id, contact_id,
    // content_type, flagged_content, violation_type, severity, status,
    // resolution_notes, detected_at. No violation_details/communication_log_id/
    // detected_by fields — fold the context into flagged_content/resolution_notes.
    if (coldLeadViolations && coldLeadViolations.length > 0) {
      const violations = coldLeadViolations.map((comm) => ({
        user_id: comm.user_id,
        agent_id: comm.agent_id,
        brokerage_id: comm.brokerage_id,
        contact_id: comm.contact_id,
        content_type: comm.communication_type,
        violation_type: "cold_lead_channel_violation",
        flagged_content: `Cold lead contacted via ${comm.communication_type} instead of email or print mail (audit_log_id=${comm.id})`,
        severity: "critical",
        status: "flagged",
        detected_at: new Date().toISOString(),
      }))

      await supabase.from("compliance_flags").insert(violations)
      results.cold_lead_violations_detected = coldLeadViolations.length
    }

    // Check for content used without approval.
    // Live column is compliance_passed (not compliance_check_passed).
    const { data: unapprovedContent } = await supabase
      .from("communication_audit_log")
      .select("*")
      .gte("sent_at", yesterday.toISOString())
      .eq("was_approved_content", false)
      .eq("compliance_passed", false)

    if (unapprovedContent && unapprovedContent.length > 0) {
      const violations = unapprovedContent.map((comm) => ({
        user_id: comm.user_id,
        agent_id: comm.agent_id,
        brokerage_id: comm.brokerage_id,
        contact_id: comm.contact_id,
        content_type: comm.communication_type,
        violation_type: "unapproved_content_violation",
        flagged_content: `Content sent without compliance approval (audit_log_id=${comm.id})`,
        severity: "high",
        status: "flagged",
        detected_at: new Date().toISOString(),
      }))

      await supabase.from("compliance_flags").insert(violations)
    }

    // CROSS-CHANNEL CONSISTENCY GUARDIAN — flag any queued client message whose
    // price disagrees with the live listing BEFORE a human releases it.
    let consistencyFlagged = 0
    try {
      const { runConsistencyGuardianAll } = await import("@/lib/kernel/consistency-guardian")
      consistencyFlagged = (await runConsistencyGuardianAll(supabase)).flagged
    } catch (e) { console.error("[ComplianceMonitoring] consistency guardian:", e) }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.certifications_checked,
      metadata: { ...results, consistencyFlagged },
    })

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      results,
    })
  } catch (error: any) {
    console.error("[ComplianceMonitoring] Cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json({ error: "Compliance monitoring failed", details: error.message, context_id: contextId }, { status: 500 })
  }
}
