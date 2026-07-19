"use server"

/**
 * Transaction milestone actions — agent / TC facing wrappers around the
 * canonical milestone-service helpers. Each one:
 *   1. Updates the transaction row (where the structured field lives)
 *   2. Calls completeMilestone / setMilestoneDate which fans out to
 *      buyer / seller / lender / title portals via emitTransactionEvent
 *      (already wired in milestone-service.ts).
 *
 * Created to cover the appraisal / walkthrough / repair lifecycle paths
 * that the kernel event enum already names but didn't have action mutators:
 *   - APPRAISAL_COMPLETED
 *   - WALKTHROUGH_DUE / final_walkthrough_scheduled
 *   - LISTING_REPAIR_COMPLETED
 *
 * All actions are brokerage-scoped via auth; agents may only mutate
 * transactions in their own brokerage.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import {
  completeMilestone,
  overrideMilestone,
  setMilestoneDate,
} from "@/lib/transactions/milestone-service"
import { requireOverrideActor } from "@/lib/kernel/portal-auth"

interface ScopedParams {
  transactionId: string
  brokerageId:   string
}

// ─── Generic complete + override ─────────────────────────────────────────────
// Thin agent-facing wrappers used by the milestone row UI. completeMilestone
// + overrideMilestone in lib/transactions/milestone-service already handle
// deadline mirror, lifecycle audit log, and fan-out — the wrappers just add
// brokerage scope verification + revalidation.

export interface CompleteMilestoneActionParams extends ScopedParams {
  milestoneName: string
}

export async function completeMilestoneAction(
  params: CompleteMilestoneActionParams,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found in your brokerage" }

  try {
    await completeMilestone({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
      milestoneName: params.milestoneName,
      completedBy:   user.id,
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Milestone complete failed" }
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

export interface OverrideMilestoneActionParams extends ScopedParams {
  milestoneName:   string
  overrideReason:  string
}

/**
 * Override an overdue / blocked milestone. Requires broker / admin /
 * superadmin / compliance via requireOverrideActor, plus a written reason
 * (min 10 chars) for the audit trail. Writes 'milestone.overridden'
 * lifecycle event.
 */
export async function overrideMilestoneAction(
  params: OverrideMilestoneActionParams,
): Promise<{ success: boolean; error?: string }> {
  let overrideCtx
  try {
    overrideCtx = await requireOverrideActor(params.overrideReason)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Override authorization failed" }
  }
  if (overrideCtx.brokerageId !== params.brokerageId) {
    return { success: false, error: "Brokerage mismatch" }
  }

  try {
    await overrideMilestone({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
      milestoneName: params.milestoneName,
      overrideBy:    overrideCtx.userId,
      overrideReason: overrideCtx.reason,
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Override failed" }
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── Appraisal completion ────────────────────────────────────────────────────

export interface MarkAppraisalCompleteParams extends ScopedParams {
  appraisalValue?:    number
  appraisalReportUrl?: string
  appraiserName?:     string
}

export async function markAppraisalCompleteAction(
  params: MarkAppraisalCompleteParams,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Verify transaction belongs to caller's brokerage
  const { data: tx } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found in your brokerage" }

  // Update structured appraisal fields on transactions row
  const updatePayload: Record<string, unknown> = {
    appraisal_completed_date: new Date().toISOString().slice(0, 10),
  }
  if (params.appraisalValue != null) updatePayload.appraisal_value = params.appraisalValue
  await supabase
    .from("transactions")
    .update(updatePayload)
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  // Complete the appraisal_completed milestone — fan-out fires here.
  try {
    await completeMilestone({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
      milestoneName: "appraisal_completed",
      completedBy:   user.id,
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Milestone complete failed" }
  }

  // ── Appraisal-came-in-low detector (silent-risk close) ─────────────────────
  // Recording the value used to be the END of the story — nothing ever compared
  // it to the contract price. Compare here, and when it's short: emit the real
  // APPRAISAL_GAP_DETECTED kernel event (staff notify + the calm buyer/seller
  // portal cards) and convene the deal-save huddle. Best-effort — the milestone
  // completion above must never fail on the detector.
  if (params.appraisalValue != null) {
    try {
      await runAppraisalGapDetection({
        transactionId:  params.transactionId,
        brokerageId:    params.brokerageId,
        actorUserId:    user.id,
        appraisalValue: params.appraisalValue,
      })
    } catch (err) {
      console.error("[markAppraisalCompleteAction] appraisal-gap detection failed (non-blocking):", err)
    }
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// Not exported ('use server' files may only export async Server Actions; this is an
// internal helper of markAppraisalCompleteAction).
//
// THE GAP RULE: any shortfall triggers (there is no "small enough to ignore" —
// severity lives in the copy + huddle risk level, which scale with the % gap).
// Price source: transactions.purchase_price — the canonical contract price column
// (per lib/kernel/transactions.ts: "purchase_price (not contract_price)").
// Idempotent per (transaction, appraisal value) via the lifecycle_events ledger:
// re-marking the same value never re-fires; a CORRECTED value fires fresh.
async function runAppraisalGapDetection(args: {
  transactionId:  string
  brokerageId:    string
  actorUserId:    string
  appraisalValue: number
}): Promise<void> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data: tx } = await svc
    .from("transactions")
    .select("purchase_price, deal_name, property_address")
    .eq("id", args.transactionId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()

  // Null-guarded: no contract price on file (or unparsable) → nothing to compare against.
  const contractPrice = Number((tx as { purchase_price?: number | string | null } | null)?.purchase_price ?? 0)
  if (!tx || !Number.isFinite(contractPrice) || contractPrice <= 0) return
  if (!Number.isFinite(args.appraisalValue) || args.appraisalValue <= 0) return
  if (args.appraisalValue >= contractPrice) return  // appraisal met/beat the price — no gap

  const gapAmount = contractPrice - args.appraisalValue
  const gapPct    = Math.round((gapAmount / contractPrice) * 1000) / 10

  // Idempotency — the emitted event's own ledger row is the dedupe key. emitTransactionEvent
  // writes lifecycle_events with our metadata, so an identical (transaction, appraisal_value)
  // detection has a row here and is skipped.
  const { data: already } = await svc
    .from("lifecycle_events")
    .select("id")
    .eq("entity_type", "transaction")
    .eq("entity_id", args.transactionId)
    .eq("event_type", "appraisal_gap_detected")
    .contains("metadata", { appraisal_value: args.appraisalValue })
    .limit(1)
    .maybeSingle()
  if (already) return

  // Severity scales with the % gap — one framing token drives both portal-card copy
  // (via {gap_framing}) and the huddle's risk level.
  const gapFraming =
    gapPct >= 5 ? "a significant gap" : gapPct >= 2 ? "a meaningful gap" : "a modest gap"
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`

  // (a) The REAL kernel event: staff notifications (default rules resolve agent + TC for
  // appraisal events) + the APPRAISAL_GAP_DETECTED portal template in event-fanout — the
  // calm "appraisal came in at $X vs $Y — here are the paths forward" card to the buyer,
  // and the seller-appropriate version on inside (dual) deals.
  const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
  const { KernelEvent }          = await import("@/lib/kernel/events")
  await emitTransactionEvent({
    event:       KernelEvent.APPRAISAL_GAP_DETECTED,
    brokerageId: args.brokerageId,
    entityId:    args.transactionId,
    actorUserId: args.actorUserId,
    metadata: {
      appraisal_value:     args.appraisalValue,
      contract_price:      contractPrice,
      gap_amount:          gapAmount,
      gap_pct:             gapPct,
      appraisal_value_fmt: usd(args.appraisalValue),
      contract_price_fmt:  usd(contractPrice),
      gap_amount_fmt:      usd(gapAmount),
      gap_framing:         gapFraming,
    },
  })

  // (b) Convene the deal-save huddle through its EXISTING contract: an appraisal shortfall
  // is a failing LENDER (valuation/financing) component, which runDealSaveHuddle routes to
  // the Finance Manager over the manager-signals bus. The huddle is idempotent per open
  // (deal, manager) signal, so a re-detection while the signal is open never double-convenes.
  // Best-effort — the kernel event above already informed the humans.
  try {
    const { runDealSaveHuddle } = await import("@/lib/kernel/deal-save-huddle")
    const dealRow = tx as { deal_name?: string | null; property_address?: string | null }
    await runDealSaveHuddle({
      transactionId: args.transactionId,
      brokerageId:   args.brokerageId,
      riskLevel:     gapPct >= 5 ? "critical" : "at_risk",
      components: [{
        category: "LENDER",
        score:    0,
        issues: [
          `Appraisal came in low: ${usd(args.appraisalValue)} vs ${usd(contractPrice)} contract (${gapFraming} — ${usd(gapAmount)}, ${gapPct}%). Paths: renegotiate price, buyer covers the difference, or challenge the appraisal with comps — confirm the lender's read and the appraisal-contingency clock.`,
        ],
      }],
      dealName: dealRow?.deal_name ?? dealRow?.property_address ?? null,
    }, svc)
  } catch (err) {
    console.error("[runAppraisalGapDetection] deal-save huddle convene failed (non-blocking):", err)
  }
}

// ─── Final walkthrough scheduling + completion ───────────────────────────────

export interface ScheduleFinalWalkthroughParams extends ScopedParams {
  walkthroughDate: string // YYYY-MM-DD
  notes?:          string
}

export async function scheduleFinalWalkthroughAction(
  params: ScheduleFinalWalkthroughParams,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found in your brokerage" }

  try {
    await setMilestoneDate(
      params.transactionId,
      params.brokerageId,
      "final_walkthrough_scheduled",
      params.walkthroughDate,
      user.id,
      params.notes ?? "Final walkthrough scheduled",
    )
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Schedule failed" }
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

export async function completeFinalWalkthroughAction(
  params: ScopedParams,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found in your brokerage" }

  try {
    await completeMilestone({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
      milestoneName: "final_walkthrough_scheduled",
      completedBy:   user.id,
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Walkthrough complete failed" }
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── Repair negotiation tracking ─────────────────────────────────────────────
// Uses transaction_repair_negotiations + completeMilestone for the wrap-up
// event. Repair items are individual line-items; the "repair_completed"
// milestone fires when all are resolved.

export interface RequestRepairParams extends ScopedParams {
  itemDescription: string
  estimatedCost?:  number
  priority?:       "critical" | "high" | "medium" | "low"
  requestedBy?:    "buyer" | "seller"  // defaults to "buyer"
}

export async function requestRepairAction(
  params: RequestRepairParams,
): Promise<{ success: boolean; repairId?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found in your brokerage" }

  const { data, error } = await supabase
    .from("transaction_repair_negotiations")
    .insert({
      transaction_id:    params.transactionId,
      brokerage_id:      params.brokerageId,
      requested_by:      params.requestedBy ?? "buyer",
      item_description:  params.itemDescription,
      estimated_cost:    params.estimatedCost ?? null,
      priority:          params.priority ?? "medium",
      status:            "requested",
    })
    .select("id")
    .maybeSingle()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Repair request insert failed" }
  }

  // Fan-out via the kernel event so the other side of the deal sees the request
  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitTransactionEvent({
      event:       KernelEvent.LISTING_REPAIR_REQUIRED,
      brokerageId: params.brokerageId,
      entityId:    params.transactionId,
      actorUserId: user.id,
      metadata: {
        repair_id:        data.id,
        item_description: params.itemDescription,
        estimated_cost:   params.estimatedCost ?? null,
        priority:         params.priority ?? "medium",
        requested_by:     params.requestedBy ?? "buyer",
      },
    })
  } catch (err) {
    console.error("[requestRepairAction] fan-out failed (non-blocking)", err)
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true, repairId: data.id }
}

export interface CompleteRepairParams extends ScopedParams {
  repairId:   string
  actualCost?: number
  notes?:     string
}

export async function completeRepairAction(
  params: CompleteRepairParams,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Verify repair row belongs to this brokerage + transaction
  const { data: repair } = await supabase
    .from("transaction_repair_negotiations")
    .select("id, item_description")
    .eq("id", params.repairId)
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!repair) return { success: false, error: "Repair not found" }

  const { error } = await supabase
    .from("transaction_repair_negotiations")
    .update({
      status:        "completed",
      actual_cost:   params.actualCost ?? null,
      response_note: params.notes ?? null,
      responded_at:  new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    })
    .eq("id", params.repairId)

  if (error) return { success: false, error: error.message }

  // Fan-out — buyer + seller portals show the repair as completed.
  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitTransactionEvent({
      event:       KernelEvent.LISTING_REPAIR_COMPLETED,
      brokerageId: params.brokerageId,
      entityId:    params.transactionId,
      actorUserId: user.id,
      metadata: {
        repair_id:        params.repairId,
        item_description: repair.item_description,
        actual_cost:      params.actualCost ?? null,
      },
    })
  } catch (err) {
    console.error("[completeRepairAction] fan-out failed (non-blocking)", err)
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}
