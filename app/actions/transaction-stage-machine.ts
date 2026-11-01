"use server"

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { decideClaimedTenant } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"
import { TransactionOrchestrator } from "@/lib/transactions/transaction-orchestrator"
import { TransactionStage, TRANSACTION_STAGES, STAGE_TO_STATUS_MAP } from "@/lib/transactions/transaction-stages"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"
import { closeNegotiationStrategyForOffer } from "@/lib/strategy-learning/close-strategy-loop"
import { requireOverrideActor, PortalAuthError } from "@/lib/kernel/portal-auth"
import { revalidatePath } from "next/cache"
import { isTransactionStatus } from "@/lib/transactions/transaction-status"
import { GATED_TRANSACTION_STAGES, overrideStatus, partitionStageBlockers, type StatusEvidence } from "@/lib/kernel/status-override"

// TOMBSTONE (lane 93A, §1/§6): requireCallerForBrokerage — DELETED, MERGED ONTO
// THE SURVIVOR lib/auth/require-caller.ts requireCallerTenant (the body-tenant
// rule, which composes lib/platform/acting-context.ts decideClaimedTenant). It
// was the THIRD file-local copy of the claimed-brokerage ≠ session comparison
// (its twins in transaction-inspections / transaction-hazard-insurance merged in
// lane 92A). What it carried beyond the survivor was its role: `users.role ??
// users.user_type ?? "agent"` — the LEGACY free-form role column read first, and
// a missing seat defaulted to "agent" (fail OPEN, §4). That role fed the
// orchestrator's literal ["admin","broker","tc","agent"] gate, which refused
// team_lead and compliance_officer and admitted any agent to any deal. Both are
// replaced: the role is the session's users.user_type exactly as stored (null
// stays null and is refused), and the gate is lib/transactions/role-guard.ts
// canTransitionStage (tenant-admin roster via isAdminOrBroker; agents and team
// leads on their own / their led team's deals — egress-scope's TEAM tier).

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
  const auth = await requireCallerTenant(params.brokerageId)
  if (!auth.ok) return { allowed: false, blockers: [auth.error] }

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   auth.brokerageId,
    userId:        auth.userId,
    userRole:      auth.userType ?? "",
  })

  return orchestrator.checkAdvancement(params.targetStage)
}

/**
 * Advance a transaction to the target stage.
 * Validates permissions and blockers before advancing.
 *
 * If `overrideReason` is provided, the action passes the gate's SOFT process
 * blockers only (C23 — compliance, signatures, TRID, the CDA and the role gate
 * are never passed) and requires a broker / admin / compliance role, a reason
 * (and proof for CLOSED), and writes a full audit trail (the action ledger row
 * + the lifecycle_events override event). Use only when the agent is unblocked
 * by external context the system can't verify (e.g. lender confirmed CTC by
 * phone before uploading the doc).
 */
export async function advanceTransactionStage(params: {
  transactionId: string
  brokerageId: string
  targetStage: TransactionStage
  reason?: string
  /** Manual override — requires elevated role + min 10-char reason */
  overrideReason?: string
  /** C23 (wave 148, lane 148I) — PROOF where the target demands it (a deal CLOSED by hand: the settlement statement / closing file). */
  overrideEvidence?: StatusEvidence | null
}): Promise<{ success: boolean; newStage?: TransactionStage; blockers?: string[]; error?: string }> {
  // ── Override path ──────────────────────────────────────────────────────────
  // Authorize the override, then force the transition + audit.
  // C23 (wave 148, lane 148I — owner ruling 13: "never bypassing compliance, signatures, tenant authority or transaction
  // gates"). This path used to skip the transaction's gate ENTIRELY — a reason could close a deal over a FAILED closing
  // compliance check, an undelivered TRID Closing Disclosure, a missing CDA or an open deal-breaker flag. It now runs the
  // SAME gate (orchestrator.checkAdvancement → canAdvanceStage, incl. the role gate) and passes only its SOFT process
  // blockers (lib/kernel/status-override.ts classifyTransactionStageBlocker); a HARD blocker refuses, named. The decision is
  // the ONE C23 decision (reason, proof for CLOSED, never a gated value) and the write runs inside the action ledger.
  if (params.overrideReason) {
    let overrideCtx
    try {
      overrideCtx = await requireOverrideActor(params.overrideReason)
    } catch (err) {
      if (err instanceof PortalAuthError) return { success: false, error: err.message }
      throw err
    }
    // The body tenant is checked by the ONE decision table (lane 93A — this was
    // the file's second hand-rolled copy of it); every write below uses the
    // SESSION's brokerage, never the parameter.
    const claim = decideClaimedTenant({ actingBrokerageId: overrideCtx.brokerageId, claimedBrokerageId: params.brokerageId })
    if (!claim.ok) {
      return { success: false, error: "Cannot override transaction outside your brokerage" }
    }
    const brokerageId = claim.brokerageId

    const svc = createServiceClient()

    // Get current stage for audit metadata
    const { data: current, error: currentErr } = await svc
      .from("transactions")
      .select("stage, status, updated_at")
      .eq("id", params.transactionId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (currentErr) return { success: false, error: `Could not read the transaction: ${currentErr.message}` }
    if (!current) return { success: false, error: "Transaction not found in your brokerage" }

    // C23 — a stage with a gated door is never an override target (UNDER_CONTRACT: the transaction creation gate).
    const gatedStage = GATED_TRANSACTION_STAGES[params.targetStage]
    if (gatedStage) return { success: false, error: gatedStage }

    // C23 — the transaction's OWN gate runs; its hard blockers refuse, its soft ones are passed on the record.
    const gateCheck = await new TransactionOrchestrator({
      transactionId: params.transactionId, brokerageId, userId: overrideCtx.userId, userRole: overrideCtx.userType,
    }).checkAdvancement(params.targetStage)
    const { hard, soft } = partitionStageBlockers(gateCheck.blockers ?? [])

    // FAIL CLOSED (§4) — STAGE_TO_STATUS_MAP lives in transaction-stages.ts, a SEPARATE
    // vocabulary file from transaction-status.ts's TRANSACTION_STATUSES (§6: two files
    // naming one column). Nothing previously cross-checked that every mapped value is
    // still a value the CHECK constraint admits; a drift here would have reached the
    // database as an opaque constraint violation instead of a named, actionable refusal.
    const mappedStatus = STAGE_TO_STATUS_MAP[params.targetStage]
    if (!isTransactionStatus(mappedStatus)) {
      return { success: false, error: `Stage "${params.targetStage}" maps to an unrecognized transaction status "${mappedStatus}" — refusing the override rather than writing an invalid status` }
    }

    // Force the transition. Keep status (lowercase coarse state) in lockstep with stage — the
    // override previously wrote only stage, leaving status stale (e.g. stage CLOSING_PREP while
    // status still under_contract), which is what the dashboards + status filters read.
    // C23: the ONE decision (reason; proof for CLOSED; hard blockers refuse) and the write inside the action ledger.
    const overridden = await overrideStatus(
      {
        entity: "transaction", from: (current.status as string | null) ?? null, to: mappedStatus,
        stage: { from: (current.stage as string | null) ?? null, to: params.targetStage },
        reason: overrideCtx.reason, evidence: params.overrideEvidence ?? null,
        actor: { userId: overrideCtx.userId, userType: overrideCtx.userType }, hardBlockers: hard, softBlockers: soft,
      },
      {
        brokerageId, subject: { type: "transaction", id: params.transactionId }, rowVersion: (current.updated_at as string | null) ?? null,
        systemSource: "transaction-stage-machine", action: "transaction.stage.override",
        apply: async () => {
          const { data: moved, error: updateErr } = await svc
            .from("transactions")
            .update({
              stage: params.targetStage,
              status: mappedStatus,
              updated_at: new Date().toISOString(),
            })
            .eq("id", params.transactionId)
            .eq("brokerage_id", brokerageId)
            .select("id")
          if (updateErr) return { ok: false, error: updateErr.message }
          if ((moved?.length ?? 0) !== 1) return { ok: false, error: "the transaction did not move (not found in your brokerage)" }
          return { ok: true }
        },
      },
      { ledger: (await import("@/lib/kernel/action-ledger")).withActionLedger, client: svc },
    )
    if (!overridden.ok) return { success: false, error: overridden.message, ...(hard.length > 0 ? { blockers: hard } : {}) }
    // A deal CLOSED by override records its ACTUAL closing day on the closing-date model (lib/transactions/closing-dates.ts) —
    // a separate, best-effort write so a not-yet-applied column (m927) can never refuse the stage move itself (PGRST204).
    if (params.targetStage === TRANSACTION_STAGES.CLOSED) {
      const { recordActualClosing } = await import("@/lib/transactions/closing-dates")
      const stamped = await recordActualClosing(svc, { brokerageId, transactionId: params.transactionId, closedOn: new Date(), source: "stage_override" })
      if (!stamped.ok) console.warn(`[transaction-stage-machine] actual closing day not stamped: ${stamped.error}`)
    }

    // Audit trail — explicit override event with reason + actor role in metadata
    await sentinelWrite(svc, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
      brokerageId:  brokerageId,
      entityType:   "transaction",
      entityId:     params.transactionId,
      event:    "transaction.stage_overridden",
      actorUserId: overrideCtx.userId,
      metadata: {
        from_stage:           current.stage,
        to_stage:             params.targetStage,
        override_reason:      overrideCtx.reason,
        override_actor:       overrideCtx.userId,
        override_user_type:   overrideCtx.userType,
        original_reason:      params.reason ?? null,
        // C23: what the override consciously passed, and the proof it carried — never hidden.
        soft_blockers_passed: soft,
        evidence:             params.overrideEvidence ?? null,
      },
      createdAt: new Date().toISOString(),
    }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    revalidatePath(`/dashboard/coordinator`)
    revalidatePath(`/dashboard/transactions`)

    calculateDealHealth({
      transactionId: params.transactionId,
      brokerageId:   brokerageId,
    }).catch((error) => {
      console.error("[transaction-stage-machine] calculateDealHealth failed:", error)
    })

    return { success: true, newStage: params.targetStage }
  }

  // ── Standard path ──────────────────────────────────────────────────────────
  // The session's tenant, with a body brokerageId that names another one
  // refused (requireCallerTenant). The orchestrator then asks
  // canTransitionStage whether THIS seat may move THIS deal.
  const auth = await requireCallerTenant(params.brokerageId)
  if (!auth.ok) return { success: false, error: auth.error }

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   auth.brokerageId,
    userId:        auth.userId,
    userRole:      auth.userType ?? "",
  })

  const result = await orchestrator.advanceToStage(params.targetStage, params.reason)

  if (result.success) {
    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    revalidatePath(`/dashboard/coordinator`)
    revalidatePath(`/dashboard/transactions`)

    calculateDealHealth({
      transactionId: params.transactionId,
      brokerageId:   auth.brokerageId,
    }).catch((error) => {
      console.error("[transaction-stage-machine] calculateDealHealth failed:", error)
    })

    // LIFECYCLE RE-SCRAPE SIGNAL — a deal going under contract is one of the
    // named moments contact-signal-rescrape exists for (refresh the property's
    // AVM now that a price is real, instead of waiting for the daily sweep).
    // Best-effort + fire-and-forget: enrichment cost/failure never touches the
    // stage transition. Contact resolved from the transaction row, never params.
    if (params.targetStage === TRANSACTION_STAGES.UNDER_CONTRACT) {
      void (async () => {
        try {
          const svcClient = createServiceClient()
          const { data: txn } = await svcClient.from("transactions")
            .select("contact_id, buyer_contact_id, seller_contact_id")
            .eq("id", params.transactionId).eq("brokerage_id", auth.brokerageId).maybeSingle()
          const contactId = (txn as any)?.seller_contact_id ?? (txn as any)?.contact_id ?? (txn as any)?.buyer_contact_id ?? null
          if (contactId) {
            const { triggerSignalRescrape } = await import("@/lib/lead-pipeline/contact-signal-rescrape")
            await triggerSignalRescrape({ contactId, signal: "deal_under_contract" })
          }
        } catch (err) {
          console.error("[transaction-stage-machine] under-contract rescrape failed (non-fatal):", err)
        }
      })()
    }

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
  const auth = await requireCallerTenant(params.brokerageId)
  if (!auth.ok) return { success: false, error: auth.error }

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   auth.brokerageId,
    userId:        auth.userId,
    userRole:      auth.userType ?? "",
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
// TOMBSTONE (orphan tranche 3): getTransactionStageInfo deleted — a read
// combination no surface called. The live survivor is the transaction detail
// surface itself: app/dashboard/transactions/[id]/transaction-detail-client.tsx
// derives allowedNextStages from lib/transactions/transaction-stages.ts:
// STAGE_TRANSITIONS over the stage it already renders, and asks the server the
// stronger question through checkStageAdvancement above (which validates
// blockers, not just the transition table) before advanceTransactionStage.
