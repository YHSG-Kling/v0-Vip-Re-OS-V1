import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"
import { KernelEvent } from "@/lib/kernel/events"

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
  // Verify CRON_SECRET
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const results: { transactionId: string; score: number; riskLevel: string; error?: string }[] = []

  try {
    // Get all active transactions (not closed, cancelled, or on_hold)
    const { data: transactions, error: fetchError } = await supabase
      .from("transactions")
      .select("id, brokerage_id")
      .not("stage", "in", "(closed,cancelled,on_hold)")

    if (fetchError) {
      throw new Error(`Failed to fetch transactions: ${fetchError.message}`)
    }

    if (!transactions || transactions.length === 0) {
      return NextResponse.json({ message: "No active transactions to scan", results: [] })
    }

    // Process each transaction
    for (const tx of transactions) {
      try {
        const result = await calculateDealHealth(tx.id, tx.brokerage_id)

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

    return NextResponse.json({
      message: `Scanned ${transactions.length} transactions`,
      results,
      atRiskCount: results.filter((r) => r.riskLevel === "at_risk" || r.riskLevel === "critical").length,
    })
  } catch (error) {
    console.error("[deal-health-scan] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
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
    const result = await calculateDealHealth(tx.id, tx.brokerage_id)

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
