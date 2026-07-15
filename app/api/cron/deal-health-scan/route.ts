import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"
import { KernelEvent } from "@/lib/kernel/events"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Deal Health Scan Cron
 * 
 * GET: Scheduled scan of all active transactions (6-hour interval)
 * POST: Single transaction rescan (triggered from UI)
 * 
 * Emits kernel events:
 *   - DEAL_HEALTH_SCORE_UPDATED for every scored transaction
 *   - DEAL_AT_RISK_DETECTED for critical/at_risk transactions
 * 
 * Creates proactive_interventions for at-risk deals if no open intervention exists.
 */

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "deal-health-scan",
    cron_path: "/app/api/cron/deal-health-scan/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[DealHealthScan] Failed to record cron start:", startRecordResult.error)
  }

  const supabase = createServiceClient()
  const results: { transactionId: string; score: number; riskLevel: string; error?: string }[] = []

  try {
    // Get all non-terminal transactions. NB: `stage` holds the UPPERCASE state-machine values
    // (transactions_stage_check) — CLOSED / LOST are the two terminal stages. The previous filter used
    // lowercase 'closed,cancelled,on_hold' (none of which the column can ever hold), so it excluded
    // nothing and re-scanned finished deals every 6h, producing false at-risk alerts on closed deals.
    const { data: transactions, error: fetchError } = await supabase
      .from("transactions")
      .select("id, brokerage_id")
      .not("stage", "in", "(CLOSED,LOST)")

    if (fetchError) {
      throw new Error(`Failed to fetch transactions: ${fetchError.message}`)
    }

    if (!transactions || transactions.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { message: "No active transactions" } })
      return NextResponse.json({ message: "No active transactions to scan", results: [] })
    }

    // Process each transaction
    for (const tx of transactions) {
      try {
        const result = await calculateDealHealth({ transactionId: tx.id, brokerageId: tx.brokerage_id })

        // Log DEAL_HEALTH_SCORE_UPDATED event
        await supabase.from("lifecycle_events").insert({
          event_type: KernelEvent.DEAL_HEALTH_SCORE_UPDATED,
          entity_type: "transaction",
          entity_id: tx.id,
          brokerage_id: tx.brokerage_id,
          metadata: {
            overall_score: result.overallScore,
            risk_level: result.riskLevel,
            score_delta: result.scoreDelta,
            flags: result.components.flatMap((c) => c.issues),
          },
        })

        // Check for at-risk or critical status
        if (result.riskLevel === "critical" || result.riskLevel === "at_risk") {
          // Log DEAL_AT_RISK_DETECTED event
          await supabase.from("lifecycle_events").insert({
            event_type: KernelEvent.DEAL_AT_RISK_DETECTED,
            entity_type: "transaction",
            entity_id: tx.id,
            brokerage_id: tx.brokerage_id,
            metadata: {
              overall_score: result.overallScore,
              risk_level: result.riskLevel,
              flags: result.components.flatMap((c) => c.issues),
            },
          })

          // Check if there's already an open intervention for this transaction
          const { data: existingIntervention } = await supabase
            .from("proactive_interventions")
            .select("id")
            .eq("transaction_id", tx.id)
            .eq("resolved", false)
            .maybeSingle()

          // Only create intervention if none exists
          if (!existingIntervention) {
            const issueDetected = result.components
              .flatMap((c) => c.issues)
              .slice(0, 3)
              .join(", ") || "Deal health score below threshold"

            await supabase.from("proactive_interventions").insert({
              transaction_id: tx.id,
              brokerage_id: tx.brokerage_id,
              issue_detected: issueDetected,
              severity: result.riskLevel === "critical" ? "critical" : "high",
              ai_recommendation: result.aiNarrative || null,
              client_impacted: true,
              resolved: false,
            })
          }
        }

        results.push({
          transactionId: tx.id,
          score: result.overallScore,
          riskLevel: result.riskLevel,
        })
      } catch (err) {
        results.push({
          transactionId: tx.id,
          score: 0,
          riskLevel: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        })
      }
    }

    const atRiskCount = results.filter((r) => r.riskLevel === "at_risk" || r.riskLevel === "critical").length

    // OS SELF-AUDIT — the live-data integrity sweep nothing else reads:
    // decision-latency breaches (client said yes 48h+ ago, nothing moved) +
    // vendor bookings stuck in pre-accept limbo. Dedupe-tagged, best-effort.
    let selfAudit: Record<string, number> | null = null
    try {
      const { runOsSelfAudit } = await import("@/lib/kernel/os-self-audit")
      selfAudit = await runOsSelfAudit(supabase) as any
    } catch (e) { console.error("[deal-health-scan] self-audit failed (non-blocking)", e) }

    // FLOW INTEGRITY — assert the OS's own surface-to-surface contracts (a
    // signed envelope whose packet-completion silently didn't fire). Best-effort.
    let flowBreaks = 0, flowHealed = 0
    try {
      const { runFlowIntegrityAll } = await import("@/lib/kernel/flow-integrity")
      const fi = await runFlowIntegrityAll(supabase)
      flowBreaks = fi.breaks; flowHealed = fi.healed
    } catch (e) { console.error("[deal-health-scan] flow-integrity failed (non-blocking)", e) }

    // INGRESS RECONCILIATION — replay webhook dead letters whose artifact of
    // record has since appeared (data stuck between a webhook and where it
    // belongs finally flows); abandon + escalate what never matches. Best-effort.
    let ingressReplayed = 0, ingressAbandoned = 0
    try {
      const { runIngressReconciliation } = await import("@/lib/kernel/ingress-continuity")
      const ir = await runIngressReconciliation(supabase)
      ingressReplayed = ir.replayed; ingressAbandoned = ir.abandoned
    } catch (e) { console.error("[deal-health-scan] ingress reconciliation failed (non-blocking)", e) }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: transactions.length,
      output_count: atRiskCount,
      metadata: { total: transactions.length, atRiskCount, selfAudit, flowBreaks, flowHealed, ingressReplayed, ingressAbandoned },
    })

    return NextResponse.json({
      message: `Scanned ${transactions.length} transactions`,
      results,
      atRiskCount,
    })
  } catch (error) {
    console.error("[deal-health-scan] Error:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error", context_id: contextId },
      { status: 500 }
    )
  }
}

/**
 * POST: Single transaction rescan (triggered from health page UI)
 */
export async function POST(request: NextRequest) {
  try {
    const { transaction_id } = await request.json()

    if (!transaction_id) {
      return NextResponse.json({ error: "transaction_id required" }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Get transaction details
    const { data: tx, error: txError } = await supabase
      .from("transactions")
      .select("id, brokerage_id")
      .eq("id", transaction_id)
      .single()

    if (txError || !tx) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
    }

    // Calculate health score
    const result = await calculateDealHealth({ transactionId: tx.id, brokerageId: tx.brokerage_id })

    // Log DEAL_HEALTH_SCORE_UPDATED event
    await supabase.from("lifecycle_events").insert({
      event_type: KernelEvent.DEAL_HEALTH_SCORE_UPDATED,
      entity_type: "transaction",
      entity_id: tx.id,
      brokerage_id: tx.brokerage_id,
      metadata: {
        overall_score: result.overallScore,
        risk_level: result.riskLevel,
        score_delta: result.scoreDelta,
        flags: result.components.flatMap((c) => c.issues),
        manual_rescan: true,
      },
    })

    // Check for at-risk status
    if (result.riskLevel === "critical" || result.riskLevel === "at_risk") {
      await supabase.from("lifecycle_events").insert({
        event_type: KernelEvent.DEAL_AT_RISK_DETECTED,
        entity_type: "transaction",
        entity_id: tx.id,
        brokerage_id: tx.brokerage_id,
        metadata: {
          overall_score: result.overallScore,
          risk_level: result.riskLevel,
          flags: result.components.flatMap((c) => c.issues),
        },
      })

      // Check if intervention exists
      const { data: existingIntervention } = await supabase
        .from("proactive_interventions")
        .select("id")
        .eq("transaction_id", tx.id)
        .eq("resolved", false)
        .maybeSingle()

      if (!existingIntervention) {
        const issueDetected = result.components
          .flatMap((c) => c.issues)
          .slice(0, 3)
          .join(", ") || "Deal health score below threshold"

        await supabase.from("proactive_interventions").insert({
          transaction_id: tx.id,
          brokerage_id: tx.brokerage_id,
          issue_detected: issueDetected,
          severity: result.riskLevel === "critical" ? "critical" : "high",
          ai_recommendation: result.aiNarrative || null,
          client_impacted: true,
          resolved: false,
        })
      }
    }

    return NextResponse.json({
      success: true,
      transactionId: tx.id,
      score: result.overallScore,
      riskLevel: result.riskLevel,
      scoreDelta: result.scoreDelta,
    })
  } catch (error) {
    console.error("[deal-health-scan] POST Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
