"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { TransactionOrchestrator } from "@/lib/transactions/transaction-orchestrator"
import { TransactionStage, TRANSACTION_STAGES } from "@/lib/transactions/transaction-stages"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"
import { closeNegotiationStrategyForOffer } from "@/lib/strategy-learning/close-strategy-loop"
import { requireOverrideActor, PortalAuthError } from "@/lib/kernel/portal-auth"
import { revalidatePath } from "next/cache"

// Helper: resolve session user + caller brokerage; verifies the
// caller-supplied brokerageId matches the session brokerage. The
// orchestrator uses brokerageId to find/update the transaction, so
// without this check a caller could advance/lose/inspect any
// brokerage's transactions by passing its id.
async function requireCallerForBrokerage(
  claimedBrokerageId: string,
): Promise<
  | { ok: true; userId: string; brokerageId: string; userRole: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: profile } = await supabase
    .from("users").select("brokerage_id, user_type, role").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "Not authenticated" }
  if (profile.brokerage_id !== claimedBrokerageId) {
    return { ok: false, error: "Cannot act on transactions outside your brokerage" }
  }
  return {
    ok: true,
    userId: user.id,
    brokerageId: profile.brokerage_id,
    userRole: profile.role ?? profile.user_type ?? "agent",
  }
}

// ─── THIN WRAPPERS AROUND TransactionOrchestrator ─────────────────────────────

/**
 * Check if the current user can advance a transaction to the target stage.
 * Returns validation result with any blockers.
 */
export async function checkStageAdvancement(params: {
  transactionId: string
  brokerageId: string
  targetStage: TransactionStage
}): Promise<{ allowed: boolean; blockers: string[] }> {
  const auth = await requireCallerForBrokerage(params.brokerageId)
  if (!auth.ok) return { allowed: false, blockers: [auth.error] }

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   auth.brokerageId,
    userId:        auth.userId,
    userRole:      auth.userRole,
  })

  return orchestrator.checkAdvancement(params.targetStage)
}

/**
 * Advance a transaction to the target stage.
 * Validates permissions and blockers before advancing.
 *
 * If `overrideReason` is provided, the action bypasses blocker checks but
 * requires a broker / admin / superadmin / compliance role and writes a
 * full audit trail (lifecycle_events row with override metadata). Use only
 * when the agent is unblocked by external context the system can't verify
 * (e.g. lender confirmed CTC by phone before uploading the doc).
 */
export async function advanceTransactionStage(params: {
  transactionId: string
  brokerageId: string
  targetStage: TransactionStage
  reason?: string
  /** Manual override — requires elevated role + min 10-char reason */
  overrideReason?: string
}): Promise<{ success: boolean; newStage?: TransactionStage; blockers?: string[]; error?: string }> {
  // ── Override path ──────────────────────────────────────────────────────────
  // Authorize the override, then force the transition + audit. We skip
  // canAdvanceStage entirely; the override is the explicit human decision.
  if (params.overrideReason) {
    let overrideCtx
    try {
      overrideCtx = await requireOverrideActor(params.overrideReason)
    } catch (err) {
      if (err instanceof PortalAuthError) return { success: false, error: err.message }
      throw err
    }
    if (overrideCtx.brokerageId !== params.brokerageId) {
      return { success: false, error: "Cannot override transaction outside your brokerage" }
    }

    const svc = createServiceClient()

    // Get current stage for audit metadata
    const { data: current } = await svc
      .from("transactions")
      .select("stage")
      .eq("id", params.transactionId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    if (!current) return { success: false, error: "Transaction not found in your brokerage" }

    // Force the transition
    const { error: updateErr } = await svc
      .from("transactions")
      .update({
        stage: params.targetStage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.transactionId)
      .eq("brokerage_id", params.brokerageId)
    if (updateErr) return { success: false, error: updateErr.message }

    // Audit trail — explicit override event with reason + actor role in metadata
    await svc.from("lifecycle_events").insert({
      brokerage_id:  params.brokerageId,
      entity_type:   "transaction",
      entity_id:     params.transactionId,
      event_type:    "transaction.stage_overridden",
      actor_user_id: overrideCtx.userId,
      metadata: {
        from_stage:           current.stage,
        to_stage:             params.targetStage,
        override_reason:      overrideCtx.reason,
        override_actor:       overrideCtx.userId,
        override_user_type:   overrideCtx.userType,
        original_reason:      params.reason ?? null,
      },
      created_at: new Date().toISOString(),
    })

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    revalidatePath(`/dashboard/coordinator`)
    revalidatePath(`/dashboard/transactions`)

    calculateDealHealth({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
    }).catch((error) => {
      console.error("[transaction-stage-machine] calculateDealHealth failed:", error)
    })

    return { success: true, newStage: params.targetStage }
  }

  // ── Standard path ──────────────────────────────────────────────────────────
  // Verify the caller actually belongs to params.brokerageId — without
  // this the orchestrator would happily look up + advance a transaction
  // in another tenant.
  const auth = await requireCallerForBrokerage(params.brokerageId)
  if (!auth.ok) return { success: false, error: auth.error }

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   auth.brokerageId,
    userId:        auth.userId,
    userRole:      auth.userRole,
  })

  const result = await orchestrator.advanceToStage(params.targetStage, params.reason)

  if (result.success) {
    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    revalidatePath(`/dashboard/coordinator`)
    revalidatePath(`/dashboard/transactions`)

    calculateDealHealth({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
    }).catch((error) => {
      console.error("[transaction-stage-machine] calculateDealHealth failed:", error)
    })

    // SPHERE MANAGER referral closing loop — when the deal CLOSES, close any matching
    // open referral, credit the partner, and propose a partner thank-you into the gate.
    // Best-effort: never fails the stage transition.
    if (params.targetStage === TRANSACTION_STAGES.CLOSED) {
      const svcClient = createServiceClient()
      try {
        const { closeReferralOnDealClose } = await import("@/lib/agents/referral-closer")
        await closeReferralOnDealClose(svcClient, {
          transactionId: params.transactionId, brokerageId: auth.brokerageId,
        })
      } catch (err) {
        console.error("[transaction-stage-machine] referral close failed:", err)
      }
      // MANAGERS TALKING — Deal Coordinator tells the Sphere Manager the deal closed:
      // the client crosses the boundary into LIFETIME territory (sphere = closed/past
      // clients). The Sphere consumes by proposing the lifetime welcome into the gate.
      try {
        const { data: txn } = await svcClient.from("transactions")
          .select("contact_id, buyer_contact_id, seller_contact_id, deal_name, property_address, listing_id")
          .eq("id", params.transactionId).maybeSingle()
        const contactId = (txn as any)?.contact_id ?? (txn as any)?.buyer_contact_id ?? (txn as any)?.seller_contact_id ?? null
        const closedListingId = (txn as any)?.listing_id ?? null
        if (contactId) {
          const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
          await publishManagerSignal({
            brokerageId: auth.brokerageId,
            fromManager: "deal_coordinator",
            toManager: "sphere_of_influence",
            signalType: "deal_closed",
            message: `${(txn as any)?.property_address ?? "A deal"} just closed — this client is now lifetime territory. Over to you for the welcome.`,
            entityType: "transaction",
            entityId: params.transactionId,
            contactId,
          }, svcClient)

          // CONSENSUS MEMORY — a closed deal is the outcome that PROVES the strategic plays right
          // (offer strategy, a price drop that moved buyers, relist recovery, etc.). Resolve any open
          // second-opinion huddles for this client AND the closed listing so the consulted managers'
          // track records build from real wins, not just the failures.
          try {
            const { resolveConsultOutcomes } = await import("@/lib/kernel/consult-outcome-resolver")
            await resolveConsultOutcomes({
              brokerageId: auth.brokerageId, contactId, entityId: closedListingId, success: true,
            }, svcClient)
          } catch (err) {
            console.error("[transaction-stage-machine] consult outcome resolve failed:", err)
          }
        }
      } catch (err) {
        console.error("[transaction-stage-machine] deal_closed signal failed:", err)
      }
      // MANAGERS TALKING — if a RECRUITED agent just closed their FIRST deal, the Deal
      // Coordinator tells the Recruiting Manager: ROI gets its first real production
      // datapoint + the broker gets the celebration moment.
      try {
        const { data: t2 } = await svcClient.from("transactions")
          .select("agent_id, commission_amount").eq("id", params.transactionId).maybeSingle()
        const closeAgentId = (t2 as any)?.agent_id ?? null
        if (closeAgentId) {
          const { data: agentRow } = await svcClient.from("agents").select("user_id").eq("id", closeAgentId).maybeSingle()
          const agentUid = (agentRow as any)?.user_id ?? null
          const { data: recruitRow } = agentUid
            ? await svcClient.from("recruits").select("id").eq("provisioned_user_id", agentUid).eq("provisioned", true).limit(1).maybeSingle()
            : { data: null }
          if (recruitRow) {
            const { count: closedCount } = await svcClient.from("transactions")
              .select("id", { count: "exact", head: true })
              .eq("brokerage_id", auth.brokerageId).eq("agent_id", closeAgentId).eq("status", "closed")
            if ((closedCount ?? 0) === 1) {
              const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
              await publishManagerSignal({
                brokerageId: auth.brokerageId,
                fromManager: "deal_coordinator",
                toManager: "recruiting_manager",
                signalType: "agent_first_close",
                message: "A recruited agent just closed their FIRST deal — recruiting ROI has its first production datapoint.",
                entityType: "recruit",
                entityId: (recruitRow as any).id,
                payload: { agent_id: closeAgentId, commission_amount: (t2 as any)?.commission_amount ?? 0 },
              }, svcClient)
            }
          }
        }
      } catch (err) {
        console.error("[transaction-stage-machine] agent_first_close signal failed:", err)
      }
    }
  }

  return result
}

/**
 * Mark a transaction as LOST with reason tracking.
 */
export async function markTransactionLost(params: {
  transactionId: string
  brokerageId: string
  lostReason: string
  category: string
  earnestMoneyOutcome: "returned" | "forfeited"
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCallerForBrokerage(params.brokerageId)
  if (!auth.ok) return { success: false, error: auth.error }

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   auth.brokerageId,
    userId:        auth.userId,
    userRole:      auth.userRole,
  })

  // First advance to LOST stage
  const result = await orchestrator.advanceToStage(TRANSACTION_STAGES.LOST, params.lostReason)

  if (!result.success) {
    return { success: false, error: result.error }
  }

  // Record the lost reason details — scoped by brokerage
  const svc = createServiceClient()
  const { error: updateError } = await svc
    .from("transactions")
    .update({
      lost_reason:           params.lostReason,
      lost_category:         params.category,
      earnest_money_outcome: params.earnestMoneyOutcome,
      lost_at:               new Date().toISOString(),
    })
    .eq("id", params.transactionId)
    .eq("brokerage_id", auth.brokerageId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  // OUTCOME-CLOSING LOOP (post-acceptance failure) — a deal that died after the
  // offer won is a DIFFERENT failure mode than a rejected offer, so we don't
  // overwrite the strategy_outcomes 'accepted' row. Instead close any still-open
  // negotiation strategy for the transaction's offer as 'lost', so the negotiation
  // model learns this deal fell apart. Best-effort.
  try {
    const { data: txn } = await svc
      .from("transactions").select("offer_id").eq("id", params.transactionId).maybeSingle()
    if (txn?.offer_id) {
      await closeNegotiationStrategyForOffer(svc, {
        offerId: txn.offer_id, brokerageId: auth.brokerageId, outcome: "lost",
      })
    }
  } catch (err) {
    console.error("[markTransactionLost] negotiation loop close failed:", err)
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  revalidatePath(`/dashboard/coordinator`)
  revalidatePath(`/dashboard/transactions`)

  return { success: true }
}

/**
 * Get the current stage and allowed next stages for a transaction.
 */
export async function getTransactionStageInfo(params: {
  transactionId: string
  brokerageId: string
}): Promise<{
  currentStage: TransactionStage | null
  allowedNextStages: TransactionStage[]
  status: string | null
} | null> {
  const auth = await requireCallerForBrokerage(params.brokerageId)
  if (!auth.ok) return null

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   auth.brokerageId,
    userId:        auth.userId,
    userRole:      auth.userRole,
  })

  const current = await orchestrator.getCurrentStage()
  if (!current) return null

  // Import allowed transitions
  const { STAGE_TRANSITIONS } = await import("@/lib/transactions/transaction-stages")
  const allowedNextStages = STAGE_TRANSITIONS[current.stage] || []

  return {
    currentStage:      current.stage,
    allowedNextStages: allowedNextStages as TransactionStage[],
    status:            current.status,
  }
}
