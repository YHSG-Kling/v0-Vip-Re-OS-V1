"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { TRANSACTION_STATUSES_IN_ESCROW } from "@/lib/transactions/transaction-status"

// ============================================
// HELPERS
// ============================================

// ============================================
// AI TRANSACTION COORDINATOR
// Smart transaction management with AI insights
// ============================================

/**
 * AI-powered transaction health analysis
 * Analyzes all aspects of a transaction and provides recommendations
 */
export async function analyzeTransactionHealth(params: {
  transactionId: string
  agentId: string
}) {
  try {
    if (!isValidUUID(params.transactionId)) {
      return { success: false, error: "Invalid transaction ID" }
    }

    const supabase = await createClient()

    // Get comprehensive transaction data
    const { data: transaction, error } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        transaction_participants(*),
        transaction_deadlines(*),
        transaction_documents(*),
        listings(*),
        contacts(*)
      `)
      .eq("id", params.transactionId)
      .single()

    if (error || !transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { object: analysis } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        healthScore: z.number().min(0).max(100),
        riskLevel: z.enum(["low", "medium", "high", "critical"]),
        winProbability: z.number().min(0).max(100),
        daysToClose: z.number(),
        criticalIssues: z.array(z.object({
          issue: z.string(),
          severity: z.enum(["low", "medium", "high", "critical"]),
          recommendation: z.string(),
          deadline: z.string().optional(),
        })),
        missingDocuments: z.array(z.string()),
        upcomingDeadlines: z.array(z.object({
          task: z.string(),
          dueDate: z.string(),
          daysRemaining: z.number(),
          priority: z.enum(["low", "medium", "high", "urgent"]),
        })),
        nextBestActions: z.array(z.object({
          action: z.string(),
          reason: z.string(),
          priority: z.number(),
        })),
        communicationSuggestions: z.array(z.object({
          recipient: z.string(),
          message: z.string(),
          timing: z.string(),
        })),
        potentialDelays: z.array(z.object({
          cause: z.string(),
          likelihood: z.number(),
          mitigation: z.string(),
        })),
      }),
      prompt: `Analyze this real estate transaction and provide a comprehensive health assessment:

Transaction Details:
- Property: ${transaction.property_address}
- Sale Price: $${transaction.purchase_price?.toLocaleString()}
- Status: ${transaction.status}
- Type: ${transaction.deal_type}
- Contract Date: ${transaction.contract_date}
- Target Close: ${transaction.estimated_close_date}
- Days on Market: ${transaction.days_on_market || 'N/A'}

Milestones:
${JSON.stringify(transaction.transaction_milestones, null, 2)}

Participants:
${JSON.stringify(transaction.transaction_participants, null, 2)}

Deadlines:
${JSON.stringify(transaction.transaction_deadlines, null, 2)}

Documents:
${JSON.stringify(transaction.transaction_documents, null, 2)}

Analyze for:
1. Overall health score (0-100)
2. Risk assessment
3. Win probability
4. Missing documents for ${(transaction.property_state || 'FL').toUpperCase()} compliance
5. Critical deadlines approaching
6. Communication needs
7. Potential delays and mitigations
8. Next best actions for the agent`,
    })

    // Update transaction with AI insights
    await supabase
      .from("transactions")
      .update({
        health_score: analysis.healthScore,
        win_probability: analysis.winProbability,
        ai_risk_level: analysis.riskLevel,
        ai_analysis: analysis,
        last_ai_analysis: new Date().toISOString(),
      })
      .eq("id", params.transactionId)

    // ── WIN-PROBABILITY FREEZER (owner round 36) ────────────────────────────
    // transactions.win_probability is mutable and converges toward the outcome,
    // so the accuracy flywheel refused to grade it. Freeze THIS claim as an
    // immutable ai_predictions snapshot at the moment it's made — the close-time
    // grader stamps the real outcome later and the deal_outcome rail grades the
    // FIRST pre-outcome claim per deal. Best-effort; never blocks the analysis.
    try {
      const { captureWinProbabilitySnapshot } = await import("@/lib/analytics/ai-prediction-outcomes")
      if (transaction.brokerage_id) {
        await captureWinProbabilitySnapshot(supabase as any, {
          transactionId: params.transactionId,
          brokerageId: transaction.brokerage_id,
          winProbability: analysis.winProbability,
          moment: "ai_health_analysis",
        })
      }
    } catch (e) {
      console.error("[AI Transaction Coordinator] win-probability snapshot failed:", e)
    }

    revalidatePath(`/transactions/${params.transactionId}`)
    return { success: true, analysis }
  } catch (error) {
    console.error("[AI Transaction Coordinator] Error:", error)
    return handleError(error, "analyzeTransactionHealth")
  }
}

/**
 * AI-powered portfolio risk monitoring across one agent's in-escrow deals.
 * Complements the deterministic deal-health scorer: that one scores components,
 * this one reads the whole book at once and names the week's focus.
 */
export async function monitorTransactionRisks(agentId: string) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Get all active transactions
    const { data: transactions, error: txnError } = await supabase
      .from("transactions")
      .select(`
        *,
        transaction_milestones(*),
        transaction_deadlines(*)
      `)
      .eq("agent_id", agentId)
      .in("status", [...TRANSACTION_STATUSES_IN_ESCROW])

    // supabase-js RESOLVES a failed query — a dropped error here reported
    // "no active transactions" (a clean, reassuring zero) for a read that failed.
    if (txnError) {
      return { success: false, error: txnError.message }
    }

    if (!transactions || transactions.length === 0) {
      return { success: true, risks: [], summary: "No active transactions" }
    }

    const { object: riskAnalysis } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        overallRiskLevel: z.enum(["low", "medium", "high", "critical"]),
        transactionRisks: z.array(z.object({
          transactionId: z.string(),
          propertyAddress: z.string(),
          riskLevel: z.enum(["low", "medium", "high", "critical"]),
          primaryRisk: z.string(),
          daysToDeadline: z.number(),
          recommendedAction: z.string(),
          urgency: z.enum(["routine", "attention_needed", "urgent", "critical"]),
        })),
        immediateActions: z.array(z.object({
          transactionId: z.string(),
          action: z.string(),
          deadline: z.string(),
        })),
        weeklyFocus: z.array(z.string()),
      }),
      prompt: `Analyze risks across all active transactions.
Use the exact transactionId given for each deal — never invent one.

${transactions.map((t: any) => `
transactionId: ${t.id}
Transaction: ${t.property_address}
Status: ${t.status}
Target Close: ${t.estimated_close_date}
Health Score: ${t.health_score || 'Unknown'}
Milestones: ${t.transaction_milestones?.length || 0} total, ${t.transaction_milestones?.filter((m: any) => m.status === 'completed').length || 0} completed
Upcoming Deadlines: ${t.transaction_deadlines?.filter((d: any) => new Date(d.due_date) > new Date()).length || 0}
`).join('\n---\n')}

Identify:
1. Overall portfolio risk level
2. Specific risks per transaction
3. Immediate actions needed
4. Weekly focus priorities`,
    })

    // Write the risk level back — ONLY onto deals that were actually in the
    // scan set. The id on each risk row comes back from the model, so writing it
    // unfiltered let a hallucinated (or another tenant's) id take an AI risk
    // label. The fetched set is the authority; anything else is dropped.
    const scanned = new Set(transactions.map((t: { id: string }) => t.id))
    const applied: string[] = []
    for (const risk of riskAnalysis.transactionRisks) {
      if (!scanned.has(risk.transactionId)) continue
      const { error } = await supabase
        .from("transactions")
        .update({
          ai_risk_level: risk.riskLevel,
          ai_primary_risk: risk.primaryRisk,
        })
        .eq("id", risk.transactionId)
        .eq("agent_id", agentId)
      if (!error) applied.push(risk.transactionId)
    }

    return {
      success: true,
      riskAnalysis: {
        ...riskAnalysis,
        // Only report on deals we could match back to the scan set.
        transactionRisks: riskAnalysis.transactionRisks.filter((r) => scanned.has(r.transactionId)),
        immediateActions: riskAnalysis.immediateActions.filter((a) => scanned.has(a.transactionId)),
      },
      scannedCount: transactions.length,
      appliedCount: applied.length,
    }
  } catch (error) {
    return handleError(error, "monitorTransactionRisks")
  }
}

