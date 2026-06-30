import { createServiceClient } from "@/lib/supabase/service"
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
      .in("status", ["unresolved", "flagged"])

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

  // 3. Update stage and status
  const { error: updateError } = await supabase
    .from("transactions")
    .update({
      // stage holds the UPPERCASE state-machine value (transactions_stage_check); status holds the
      // LOWERCASE coarse status (transactions_status_check). Writing the UPPERCASE stage straight into
      // status violated the status CHECK, so Postgres rejected the WHOLE row and no advance past
      // UNDER_CONTRACT ever persisted. Map stage → the valid status value instead.
      stage: params.targetStage,
      status: STAGE_TO_STATUS_MAP[params.targetStage],
      updated_at: new Date().toISOString()
    })
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

    // ── Session D: Close Listing requirements ─────────────────────────────────
    // 1. Get transaction to find seller_contact_id and listing_id
    const { data: closedTxn } = await supabase
      .from("transactions")
      .select("seller_contact_id, listing_id")
      .eq("id", params.transactionId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()

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
          enabled_by_agent_id: params.userId,
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
        const { aiGenerateReviewRequest } = await import("@/app/actions/ai-review-automation")
        await aiGenerateReviewRequest({
          transactionId: params.transactionId,
          agentId: params.userId,
          platform: "google",
          channel: "email",
        })

        // Schedule an agent notification 5 days from now to send the review
        const sendDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
        await supabase.from("activities").insert({
          brokerage_id: params.brokerageId,
          agent_id: params.userId,
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
  }

  return {
    success: true,
    newStage: params.targetStage
  }
}
