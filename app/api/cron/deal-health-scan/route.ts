import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth, requireCronOrSessionCaller } from "@/lib/cron-auth"
import { loadDealWorkAccess } from "@/lib/auth/deal-work-ownership"
import { isValidUUID } from "@/lib/validations"
import { tenantScope, platformScope } from "@/lib/kernel/tenant-scope"

export const dynamic = "force-dynamic"

/**
 * Deal Health Scan Cron
 * 
 * GET: Scheduled scan of all active transactions (6-hour interval)
 * POST: Single transaction rescan (triggered from UI) — GATED (wave 155): the scheduler's credential, or a signed-in
 *       person who may work THAT deal (lib/auth/deal-work-ownership.ts). It had no gate at all before.
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
  if (contextResult.data?.held) return NextResponse.json({ success: true, held: true, decision: contextResult.data.decision }) // cron decision door (155R1): held before any domain write
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
    // MERGED FROM THE RETIRED DUPLICATE (wave 155; /api/deal-health/cron ran the same scorer once a day): a soft-deleted
    // deal is not scanned. This sweep had no such filter, so a deleted deal could still raise an at-risk alert.
    const { data: transactions, error: fetchError } = await supabase
      .from("transactions")
      .select("id, brokerage_id")
      .not("stage", "in", "(CLOSED,LOST)")
      .is("deleted_at", null)

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

        // DEAL_HEALTH_SCORE_UPDATED — audit row + reactor (the bare insert reached nothing).
        await emitKernelEvent({
          event: KernelEvent.DEAL_HEALTH_SCORE_UPDATED,
          entityType: "transaction",
          entityId: tx.id,
          brokerageId: tx.brokerage_id,
          transactionId: tx.id,
          source: "cron",
          metadata: {
            overall_score: result.overallScore,
            risk_level: result.riskLevel,
            score_delta: result.scoreDelta,
            flags: result.components.flatMap((c) => c.issues),
          },
        })

        // Check for at-risk or critical status
        if (result.riskLevel === "critical" || result.riskLevel === "at_risk") {
          // DEAL_AT_RISK_DETECTED — audit row + reactor.
          await emitKernelEvent({
            event: KernelEvent.DEAL_AT_RISK_DETECTED,
            entityType: "transaction",
            entityId: tx.id,
            brokerageId: tx.brokerage_id,
            transactionId: tx.id,
            source: "cron",
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

            await sentinelWrite(supabase, supabase.from("proactive_interventions").insert({
              transaction_id: tx.id,
              brokerage_id: tx.brokerage_id,
              issue_detected: issueDetected,
              severity: result.riskLevel === "critical" ? "critical" : "high",
              ai_recommendation: result.aiNarrative || null,
              client_impacted: true,
              resolved: false,
            }), { table: "proactive_interventions", flow: "proactive_interventions_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
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
      const { runIngressReconciliation } = await import("@/lib/kernel/ingress-reconciliation")
      const ir = await runIngressReconciliation(supabase)
      ingressReplayed = ir.replayed; ingressAbandoned = ir.abandoned
    } catch (e) { console.error("[deal-health-scan] ingress reconciliation failed (non-blocking)", e) }

    // REPAIR-PATTERN DIGEST — weekly ledger read for platform staff (the
    // first tick of each ISO week sends it; deduped inside). Best-effort.
    try {
      const { runRepairPatternDigest } = await import("@/lib/kernel/repair-digest")
      await runRepairPatternDigest(supabase)
    } catch (e) { console.error("[deal-health-scan] repair digest failed (non-blocking)", e) }

    // CLIENT STORY DRAFTS — the three recurring client communications every
    // seat assembled by hand (weekly seller update / tour-evening recap /
    // weekly deal note), proposed onto the gated rail, tag-deduped. Best-effort.
    let storyProposed = 0
    try {
      const { runClientStoryDraftsAll } = await import("@/lib/kernel/client-story-drafts")
      const s = await runClientStoryDraftsAll(supabase)
      storyProposed = s.proposed
    } catch (e) { console.error("[deal-health-scan] client story drafts failed (non-blocking)", e) }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: transactions.length,
      output_count: atRiskCount,
      metadata: { total: transactions.length, atRiskCount, selfAudit, flowBreaks, flowHealed, ingressReplayed, ingressAbandoned, storyProposed },
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
 * POST: Single transaction rescan (triggered from health page UI — app/dashboard/transactions/[id]/health/page.tsx).
 *
 * GATE FIRST, THEN THE SERVICE CLIENT (CLAUDE.md §4). Until wave 155 this handler had no gate: anyone could POST any
 * tenant's transaction id, have it re-scored, read the score back, and raise DEAL_AT_RISK_DETECTED plus an intervention row
 * for that tenant. Now:
 *   · the scheduler's credential, or a signed-in person (requireCronOrSessionCaller);
 *   · a signed-in person must be able to WORK this deal — the owning agent, the assigned coordinator, the team lead of the
 *     deal's agent, a tenant admin or the compliance reviewer (loadDealWorkAccess, the one deal-work rule). A lender, title
 *     company, vendor or Contact on the deal is NOT a worker of it: the live row policy lets a vendor party READ the
 *     transaction row, so a row-security read alone would have admitted them;
 *   · the transaction is read pinned to the SESSION's tenant. Another tenant's deal, an unknown id and a deal the caller may
 *     not work all answer the same 404;
 *   · a gate that cannot run refuses (503), never passes.
 */
export async function POST(request: NextRequest) {
  const gate = await requireCronOrSessionCaller(request)
  if (!gate.ok) return gate.response
  const caller = gate.caller

  try {
    let body: { transaction_id?: unknown } | null = null
    try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }) }
    const transaction_id = body?.transaction_id

    if (!transaction_id) {
      return NextResponse.json({ error: "transaction_id required" }, { status: 400 })
    }
    if (typeof transaction_id !== "string" || !isValidUUID(transaction_id)) {
      return NextResponse.json({ error: "transaction_id must be a valid id" }, { status: 400 })
    }

    const supabase = createServiceClient()

    if (caller.kind === "session") {
      const work = await loadDealWorkAccess(supabase, { userId: caller.userId, brokerageId: caller.brokerageId, userType: caller.userType, transactionId: transaction_id })
      if (!work.ok) {
        console.error("[deal-health-scan] POST gate could not run:", work.error)
        return NextResponse.json({ error: "Your access to this deal could not be confirmed. Try again in a moment." }, { status: 503 })
      }
      if (!work.access.capabilities.read) {
        return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
      }
    }

    // Get transaction details. The scope is WRITTEN DOWN, never inferred from a missing id (lib/kernel/tenant-scope.ts): a
    // person reads inside the session's tenant (tenantScope refuses a blank id); the scheduler, having proven the cron
    // credential, names its own rows. Two explicit reads — the typed query builder is too deep for applyTenantScope's generic.
    const scope = caller.kind === "session"
      ? tenantScope(caller.brokerageId, "deal-health-scan manual rescan")
      : platformScope("manual rescan by the scheduler — the cron credential was verified")
    const { data: tx, error: txError } = scope.kind === "tenant"
      ? await supabase.from("transactions").select("id, brokerage_id").eq("id", transaction_id).eq("brokerage_id", scope.brokerageId).maybeSingle()
      : await supabase.from("transactions").select("id, brokerage_id").eq("id", transaction_id).maybeSingle()

    if (txError) {
      console.error("[deal-health-scan] POST transaction read refused:", txError.message)
      return NextResponse.json({ error: "The transaction could not be read. Try again in a moment." }, { status: 503 })
    }
    if (!tx) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
    }
    const actorUserId = caller.kind === "session" ? caller.userId : null

    // Calculate health score
    const result = await calculateDealHealth({ transactionId: tx.id, brokerageId: tx.brokerage_id })

    // DEAL_HEALTH_SCORE_UPDATED — audit row + reactor.
    await emitKernelEvent({
      event: KernelEvent.DEAL_HEALTH_SCORE_UPDATED,
      entityType: "transaction",
      entityId: tx.id,
      brokerageId: tx.brokerage_id,
      transactionId: tx.id,
      actorUserId,
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
      await emitKernelEvent({
        event: KernelEvent.DEAL_AT_RISK_DETECTED,
        entityType: "transaction",
        entityId: tx.id,
        brokerageId: tx.brokerage_id,
        transactionId: tx.id,
        actorUserId,
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

        await sentinelWrite(supabase, supabase.from("proactive_interventions").insert({
          transaction_id: tx.id,
          brokerage_id: tx.brokerage_id,
          issue_detected: issueDetected,
          severity: result.riskLevel === "critical" ? "critical" : "high",
          ai_recommendation: result.aiNarrative || null,
          client_impacted: true,
          resolved: false,
        }), { table: "proactive_interventions", flow: "proactive_interventions_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
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
