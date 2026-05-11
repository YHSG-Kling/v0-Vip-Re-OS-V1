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

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
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
