import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"
import { STAGE_TRANSITIONS, CRITICAL_MILESTONES, TransactionStage, STAGE_TO_STATUS_MAP } from "./transaction-stages"
import { getMilestones } from "./milestone-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { seedStageAutoTasks } from "./stage-auto-tasks"
import { seedTransactionComplianceChecks } from "./compliance-checks-seeder"
import { canProceedToClosingPrep } from "@/app/actions/transaction-compliance"

export interface StageProgressionResult {
  success: boolean
  newStage?: TransactionStage
  blockers?: string[]
  error?: string
}

/**
 * Check if transaction can advance to next stage
 * Validates: contract_date set, compliance passed, all critical milestones complete
 */
export async function canAdvanceStage(
  transactionId: string,
  currentStage: TransactionStage,
  targetStage: TransactionStage,
  brokerageId: string
): Promise<{ allowed: boolean; blockers: string[] }> {
  const supabase = createServiceClient()
  const blockers: string[] = []

  // 1. Validate transition is allowed by state machine
  const allowedTargets = STAGE_TRANSITIONS[currentStage]
  if (!allowedTargets.includes(targetStage)) {
    return {
      allowed: false,
      blockers: [`Cannot transition from ${currentStage} to ${targetStage}. Not an allowed transition.`]
    }
  }

  // 2. Get transaction to check contract_date and compliance
  const { data: transaction } = await supabase
    .from("transactions")
    .select("contract_date, compliance_passed_at")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!transaction) {
    return { allowed: false, blockers: ["Transaction not found"] }
  }

  // 3. Require contract_date for any post-contract stage
  if (!transaction.contract_date && targetStage !== "LOST") {
    blockers.push("contract_date must be set before advancing to post-contract stages")
  }

  // 4. Require compliance_passed_at for any post-contract stage
  if (!transaction.compliance_passed_at && targetStage !== "LOST") {
    blockers.push("compliance_passed_at must be set before advancing to post-contract stages")
  }

  // 5. Check critical milestones for current stage
  const criticalForStage = CRITICAL_MILESTONES[currentStage] || []
  if (criticalForStage.length > 0) {
    const milestones = await getMilestones(transactionId, brokerageId)
    
    for (const criticalName of criticalForStage) {
      const milestone = milestones.find(m => m.name === criticalName)
      if (!milestone) {
        blockers.push(`Critical milestone "${criticalName}" not found`)
      } else if (!milestone.completed_at) {
        blockers.push(`Critical milestone "${criticalName}" must be completed`)
      }
    }
  }

  // 6. Get contact_id for compliance_flags lookup (query by contact linkage, not transaction)
  const { data: txn } = await supabase
    .from("transactions")
    .select("contact_id, offer_id")
    .eq("id", transactionId)
    .maybeSingle()

  // 7. Check contingency initialed status from offer/contract intelligence
  if (txn?.offer_id && targetStage !== "LOST") {
    const { data: offer } = await supabase
      .from("offers")
      .select("contingencies, appraisal_contingency_days, financing_contingency_days, inspection_period_days")
      .eq("id", txn.offer_id)
      .maybeSingle()

    if (offer) {
      // Block if any contingency is not initialed (contingencies array contains un-initialed items)
      const contingencies = offer.contingencies ?? []
      const notInitialed = contingencies.filter((c: string) => c && !c.toLowerCase().includes("initialed"))
      if (notInitialed.length > 0) {
        blockers.push(`Contingencies not initialed: ${notInitialed.join(", ")}`)
      }
    }
  }

  // 8. Check compliance_flags for unresolved deal_breaker severity by contact linkage
  if (txn?.contact_id) {
    const { data: dealBreakerFlags } = await supabase
      .from("compliance_flags")
      .select("id, flag_type:violation_type, severity, status")
      .eq("contact_id", txn.contact_id)
      .eq("severity", "deal_breaker")
      .in("status", ["flagged"])

    if (dealBreakerFlags && dealBreakerFlags.length > 0) {
      for (const flag of dealBreakerFlags) {
        blockers.push(`Deal-breaker compliance flag: ${flag.flag_type} (${flag.status})`)
      }
    }
  }

  // 9. Block CLOSING_PREP if any blocking transaction compliance checks have failed
  if (targetStage === "CLOSING_PREP") {
    const complianceResult = await canProceedToClosingPrep(transactionId, brokerageId)
    if (!complianceResult.allowed) {
      blockers.push(...complianceResult.blockers)
    }
  }

  // 10. TRID GATE — a financed deal may not be CONSUMMATED (CLOSED) unless the buyer
  //     RECEIVED the Closing Disclosure at least 3 business days before closing (federal
  //     TILA-RESPA rule, 12 CFR 1026.19(f)). This turns the forward-looking TRID clock
  //     (now federal-holiday-aware) into a HARD GATE instead of a post-hoc alert. Only
  //     applies when a trid_timeline row exists (a financed deal with TRID tracking);
  //     cash deals have no row and are not gated.
  if (targetStage === "CLOSED") {
    const { data: trid } = await supabase
      .from("trid_timeline")
      .select("closing_disclosure_delivered_date")
      .eq("transaction_id", transactionId)
      .maybeSingle()
    if (trid) {
      if (!trid.closing_disclosure_delivered_date) {
        blockers.push("TRID: the Closing Disclosure must be delivered to the buyer at least 3 business days before closing — no delivery date is on file.")
      } else {
        const { computeTridClock } = await import("@/lib/compliance/trid-disclosure-clock")
        const today = new Date().toISOString().slice(0, 10)
        const clock = computeTridClock({
          today,
          closingDisclosureDeliveredDate: trid.closing_disclosure_delivered_date,
          scheduledCloseDate: today, // consummation is happening now
        })
        const cd = clock.deadlines.find((d) => d.kind === "closing_disclosure")
        if (cd && cd.status !== "ok") {
          blockers.push(`TRID: ${cd.message}`)
        }
      }
    }
  }

  return {
    allowed: blockers.length === 0,
    blockers
  }
}

/**
 * Advance transaction to next stage with full validation
 * Emits lifecycle event on success
 */
export async function advanceStage(params: {
  transactionId: string
  targetStage: TransactionStage
  brokerageId: string
  userId: string
  reason?: string
}): Promise<StageProgressionResult> {
  const supabase = createServiceClient()

  // 1. Get current stage
  const { data: transaction } = await supabase
    .from("transactions")
    .select("stage, status")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!transaction) {
    return { success: false, error: "Transaction not found" }
  }

  const currentStage = transaction.stage as TransactionStage

  // 2. Validate transition
  const validation = await canAdvanceStage(
    params.transactionId,
    currentStage,
    params.targetStage,
    params.brokerageId
  )

  if (!validation.allowed) {
    return {
      success: false,
      blockers: validation.blockers,
      error: `Stage advancement blocked: ${validation.blockers.join(", ")}`
    }
  }

  // 3. Update stage and status.
  // stage holds the UPPERCASE state-machine value (transactions_stage_check); status holds the
  // LOWERCASE coarse status (transactions_status_check). Writing the UPPERCASE stage straight into
  // status violated the status CHECK, so Postgres rejected the WHOLE row and no advance past
  // UNDER_CONTRACT ever persisted. Map stage → the valid status value instead.
  const stageUpdate = {
    stage: params.targetStage,
    status: STAGE_TO_STATUS_MAP[params.targetStage],
    updated_at: new Date().toISOString()
  }
  // tenant anchor (scope burn-down): pinned to the caller's transaction + brokerage
  const { error: updateError } = await supabase
    .from("transactions")
    .update(stageUpdate)
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  // 4. Emit lifecycle event via kernel
  await transitionLifecycle({
    brokerageId:  params.brokerageId,
    entityType:   "transaction",
    entityId:     params.transactionId,
    fromState:    currentStage,
    toState:      params.targetStage,
    actorUserId:  params.userId,
    actorRole:    "tc",
    eventType:    "stage.advanced",
    metadata:     { reason: params.reason ?? null },
  })

  // 5. Seed stage auto-tasks for the new stage
  await seedStageAutoTasks({
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    stage:         params.targetStage,
    userId:        params.userId,
  }).catch(error => {
    console.error("[stage-progression] seedStageAutoTasks failed:", error)
  })

  // 6. On INSPECTION stage, seed transaction compliance checks
  if (params.targetStage === "INSPECTION") {
    await seedTransactionComplianceChecks({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
      userId:        params.userId,
    }).catch(error => {
      console.error("[stage-progression] seedTransactionComplianceChecks failed:", error)
    })
  }

  // 7. Trigger commission calculations based on stage
  if (params.targetStage === "CLOSING_PREP") {
    // Trigger preview commission calculation
    const { calculateCommission } = await import("@/lib/commission/engine")
    await calculateCommission({
      transactionId: params.transactionId,
      brokerageId: params.brokerageId,
      calculationMode: 'preview',
      triggeredBy: params.userId
    }).catch(error => {
      console.error("[v0] Commission preview calculation failed:", error)
      // Don't block stage advancement on commission calculation failure
    })

    // ── Buyer move-in concierge (Deal Coordinator) ────────────────────────────
    // Entering CLOSING_PREP is when the buyer's second job begins — turn on utilities, change address,
    // book movers. Stand up the dated move-in checklist now so the guided-DIY concierge (and the
    // handoff recommendation) is ready before move-in. Buyer-side only; best-effort — never blocks the
    // stage advance. The Utility Connect EXTERNAL handoff stays gated behind a feature flag.
    try {
      const { ensureBuyerMoveCase } = await import("@/lib/transactions/buyer-move")
      await ensureBuyerMoveCase(supabase, {
        transactionId: params.transactionId,
        brokerageId: params.brokerageId,
      })
    } catch (e) {
      console.error("[stage-progression] buyer move-case ensure failed:", e)
    }

    // ── Proactive closing-cost push (Deal Coordinator) ────────────────────────
    // The buyer closing-cost estimator + portal card (BuyerClosingCostsCard on
    // /portal/[contactId]/transaction/[transactionId]) already exist, but nothing pushed them —
    // entering CLOSING_PREP is exactly when "what do I actually bring to closing?" becomes the
    // buyer's live question. Propose a GATED client message (proposeClientMessage — a human
    // approves; nothing auto-sends) deep-linking the existing card. Idempotent per transaction
    // via the rationale tag. Buyer-side only: skipped when we don't represent the buyer
    // (deal_type seller/sale) or the deal has no price yet — the card itself renders nothing
    // without a price, so we never push a hollow estimate. Best-effort, never blocks the advance.
    try {
      const { data: txForCosts } = await supabase
        .from("transactions")
        .select("buyer_contact_id, contact_id, purchase_price, deal_type, property_address, property_state")
        .eq("id", params.transactionId)
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()
      const buyerContactId = (txForCosts?.buyer_contact_id ?? txForCosts?.contact_id ?? null) as string | null
      const dealType = String(txForCosts?.deal_type ?? "")
      const price = Number(txForCosts?.purchase_price ?? 0)
      const costsTag = `[CLOSING_COSTS_READY] [${params.transactionId}]`
      if (buyerContactId && Number.isFinite(price) && price > 0 && dealType !== "seller" && dealType !== "sale") {
        const { data: dupMsg } = await supabase
          .from("agent_client_messages")
          .select("id")
          .eq("brokerage_id", params.brokerageId)
          .ilike("rationale", `%${costsTag}%`)
          .limit(1)
          .maybeSingle()
        if (!dupMsg) {
          const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
          await proposeClientMessage({
            brokerageId: params.brokerageId,
            agentKind: "deal_coordinator",
            entityType: "transaction",
            entityId: params.transactionId,
            recipientContactId: buyerContactId,
            audience: "buyer",
            subject: "Your estimated closing costs are ready",
            body: `Your estimated closing costs are ready — a plain-numbers breakdown of what to plan for beyond your down payment${txForCosts?.property_address ? ` on ${txForCosts.property_address}` : ""}. Each line is labeled with where its number comes from: your lender's real terms where we have them, and ${txForCosts?.property_state ? `${txForCosts.property_state} closing conventions (a labeled regional estimate)` : "your state's closing conventions (a labeled regional estimate)"} where we don't — your lender's Loan Estimate is the authority on the lender lines. Walk through them before closing day so nothing at the table is a surprise: open your deal page at /portal/${buyerContactId}/transaction/${params.transactionId} and look for "Your closing costs, in plain numbers." Questions on any line? Just reply — happy to go through it together.`,
            rationale: `${costsTag} — the deal entered closing prep; the buyer's closing-cost estimate card is live on their portal and this is the moment they need it. Drafted for approval, never auto-sent.`,
            channel: "portal",
            outreachReason: "milestone_update",
          })
        }
      }
    } catch (e) {
      console.error("[stage-progression] closing-cost push propose failed:", e)
    }
  } else if (params.targetStage === "CLOSED") {
    // Trigger final commission calculation
    const { calculateCommission } = await import("@/lib/commission/engine")
    await calculateCommission({
      transactionId: params.transactionId,
      brokerageId: params.brokerageId,
      calculationMode: 'final',
      triggeredBy: params.userId
    }).catch(error => {
      console.error("[stage-progression] Final commission calculation failed:", error)
    })

    // ── AMOUNT SET IN STONE AT CLOSE (close ≠ paid) ───────────────────────────
    // The deal is CLOSED (final CD, both signed). The final calc above FROZE the commission amount —
    // it can't change now. Close does NOT pay: the ledger tracks the money AFTER close (the brokerage
    // receives the deposit at the closing table, then disburses the agent's split; 'paid' is stamped
    // at DISBURSEMENT, not here). For a NON-CDA brokerage there is no CDA broker-sign, so closing the
    // deal auto-APPROVES the earnings record (pending → approved) to keep the later disbursement path
    // uniform; a CDA brokerage was already approved by the broker's CDA signature. Best-effort.
    try {
      const { finalizeCommissionAtClose } = await import("@/lib/commission/reconcile-tracking")
      await finalizeCommissionAtClose(supabase, {
        transactionId: params.transactionId,
        brokerageId:   params.brokerageId,
        actorUserId:   params.userId,
      })
    } catch (e) {
      console.error("[stage-progression] commission finalize-on-close failed:", e)
    }

    // ── CLOSING-COST ACCURACY FLYWHEEL (owner round 34, rec 5) ────────────────
    // The deal just CLOSED. If a scanned Closing Disclosure is on the document
    // kernel rail, grade the regional closing-cost estimate against the CD's
    // provenance-checked extracted figures and record one accuracy observation
    // (per-state report on the superadmin platform page arms the yearly finance
    // review — the convention table itself stays code and is never auto-tuned).
    // The recorder is honest at every exit (no CD / no state / no mappable
    // figure → nothing recorded) and idempotent. Best-effort; never blocks close.
    try {
      const { recordClosingCostAccuracy } = await import("@/lib/offers/closing-cost-accuracy")
      await recordClosingCostAccuracy(supabase as any, {
        transactionId: params.transactionId,
        brokerageId: params.brokerageId,
      })
    } catch (e) {
      console.error("[stage-progression] closing-cost accuracy observation failed:", e)
    }

    // ── NET-SHEET SURPRISE GUARD at close (drift fix, round 34 audit) ─────────
    // The guard's only previous trigger lived in lib/documents/auto-filer.ts,
    // which has no runtime callers — so the seller estimate-vs-settlement
    // reconciliation never actually fired. Close is the moment the final
    // settlement figures exist; the runner is idempotent, read-only on the deal,
    // and no-ops honestly when no settlement document/figures are on file.
    try {
      const { runNetSheetSurpriseGuard } = await import("@/lib/net-sheet/net-sheet-guard-runner")
      // agentUserId intentionally omitted — the runner alerts the transaction's
      // own agent (t.agent_id), not whoever clicked the stage change.
      await runNetSheetSurpriseGuard({
        brokerageId: params.brokerageId,
        transactionId: params.transactionId,
      })
    } catch (e) {
      console.error("[stage-progression] net-sheet surprise guard failed:", e)
    }

    // ── Session D: Close Listing requirements ─────────────────────────────────
    // 1. Get transaction to find seller_contact_id and listing_id
    const { data: closedTxn } = await supabase
      .from("transactions")
      .select("seller_contact_id, buyer_contact_id, contact_id, listing_id, close_date")
      .eq("id", params.transactionId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()

    // ── AI-PREDICTION CLOSE-TIME GRADER (owner round 36) ──────────────────────
    // The deal just CLOSED — the one moment the real outcome exists. Stamp
    // actual_outcome on every ungraded transaction-entity ai_predictions row
    // (frozen win-probability snapshots + deal_close_probability calls) so the
    // deal_outcome accuracy rail grades from real events only, and mark the
    // deal's contacts' lead_conversion predictions converted (ledger
    // completeness — deliberately NOT rail-graded; positives-only would be
    // survivorship). Idempotent; best-effort — grading never blocks a close.
    try {
      const { gradeTransactionPredictionOutcomes, markLeadConversionOutcomes } =
        await import("@/lib/analytics/ai-prediction-outcomes")
      const outcomeDate = (closedTxn?.close_date as string | null) ?? new Date().toISOString()
      await gradeTransactionPredictionOutcomes(supabase as any, {
        transactionId: params.transactionId,
        outcome: "closed",
        outcomeDate,
      })
      await markLeadConversionOutcomes(supabase as any, {
        contactIds: [closedTxn?.contact_id, closedTxn?.buyer_contact_id, closedTxn?.seller_contact_id],
        transactionId: params.transactionId,
        outcomeDate,
      })
    } catch (e) {
      console.error("[stage-progression] ai-prediction close-time grading failed:", e)
    }

    // 2. Update seller contact_type to the CANONICAL lifetime_customer (migration 433) so they enter the
    //    past-client journey AND every contact_type reader (reel persona, referral radar, portal role)
    //    recognizes them. Writing the legacy 'lifetime' here drifted from the listing close path.
    if (closedTxn?.seller_contact_id) {
      await supabase
        .from("contacts")
        .update({
          contact_type: LIFETIME_CUSTOMER_TYPE,
          updated_at: new Date().toISOString(),
        })
        .eq("id", closedTxn.seller_contact_id)

      // Promote the past client into the FB retargeting audiences (brokerage + agent) —
      // past clients are the highest-ROI referral/repeat + lookalike-seed audience, and the
      // lifetime transition previously had no audience hook. Consent-gated, idempotent,
      // non-blocking (a sync hiccup never blocks closing the deal).
      try {
        const { onContactBecameLifetimeForAudience } = await import("@/lib/audiences/audience-sync")
        void onContactBecameLifetimeForAudience({
          contactId: closedTxn.seller_contact_id, brokerageId: params.brokerageId,
        }).catch((e) => console.error("[stage-progression] lifetime audience promote failed:", e))
      } catch { /* best-effort */ }

      // Content channel — keep the past client on the AGENT's newsletter (source 'auto_lifetime').
      try {
        const { enrollContactInNewsletter } = await import("@/lib/content/newsletter-enrollment")
        void enrollContactInNewsletter({ contactId: closedTxn.seller_contact_id, brokerageId: params.brokerageId, tier: "lifetime" })
          .catch((e) => console.error("[stage-progression] lifetime newsletter enroll failed:", e))
      } catch { /* best-effort */ }

      // 3. Grant portal access to the sold listing view if not already enabled
      await supabase
        .from("contact_portal_modules")
        .upsert({
          contact_id: closedTxn.seller_contact_id,
          module_key: "sold_listing",
          is_enabled: true,
          // FKs agents(id), not users(id) — a raw user id is FK-rejected (agent-identity rule).
          enabled_by_agent_id: await resolveAgentId(supabase, params.userId),
          enabled_at: new Date().toISOString(),
        }, { onConflict: "contact_id,module_key" })
    }

    // 4. Mark the listing as sold
    if (closedTxn?.listing_id) {
      await supabase
        .from("listings")
        .update({
          status: "sold",
          lifecycle_stage: "CLOSED",
          stage_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", closedTxn.listing_id)
        .eq("brokerage_id", params.brokerageId)
    }

    // 5. Auto-schedule review request draft (5 days post-close)
    // Creates a draft in review_requests so it's ready; agent is notified via task at day 5
    void (async () => {
      try {
        // ai-review-automation takes an AGENTS id (m346). This passed
        // params.userId, so the action's `.from("agents").eq("id", …).single()`
        // found nothing and threw — the draft was never generated, and the catch
        // below swallowed it as "non-blocking". The activities insert three lines
        // down already resolved the right id; it is now resolved once, for both.
        const agentRecordId = await resolveAgentId(supabase, params.userId)
        if (agentRecordId) {
          const { aiGenerateReviewRequest } = await import("@/app/actions/ai-review-automation")
          await aiGenerateReviewRequest({
            transactionId: params.transactionId,
            agentId: agentRecordId,
            platform: "google",
            channel: "email",
          })
        }

        // Schedule an agent notification 5 days from now to send the review
        const sendDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
        await supabase.from("activities").insert({
          brokerage_id: params.brokerageId,
          // FKs agents(id), not users(id) — a raw user id is FK-rejected (agent-identity rule).
          agent_id: agentRecordId,
          activity_type: "review_request_scheduled",
          title: "Review request ready to send",
          notes: `Auto-generated review request draft created. Recommend sending on ${sendDate.toLocaleDateString()}.`,
          entity_type: "transaction",
          entity_id: params.transactionId,
          status: "pending",
          scheduled_at: sendDate.toISOString(),
        })
      } catch {
        // Non-blocking — review request draft failure doesn't affect close
      }
    })()
  } else if (params.targetStage === "LOST") {
    // ── AI-PREDICTION CLOSE-TIME GRADER, lost side (owner round 36) ───────────
    // LOST is the other REAL terminal event — grading only wins would inflate
    // every probability rail. Stamp the loss on every ungraded transaction-
    // entity prediction for this deal. Idempotent; never blocks the stage move.
    try {
      const { gradeTransactionPredictionOutcomes } = await import("@/lib/analytics/ai-prediction-outcomes")
      await gradeTransactionPredictionOutcomes(supabase as any, {
        transactionId: params.transactionId,
        outcome: "lost",
        outcomeDate: new Date().toISOString(),
      })
    } catch (e) {
      console.error("[stage-progression] ai-prediction lost-grading failed:", e)
    }
  }

  return {
    success: true,
    newStage: params.targetStage
  }
}
