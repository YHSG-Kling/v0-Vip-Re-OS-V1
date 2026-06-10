"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { proposeIsaDialBatch, approveIsaDialBatch } from "@/lib/ai-isa/voice-dial-batch"

/** Approvers for the voice dial-batch gate (a binding outbound-calling decision). */
async function requireApprover(): Promise<{ userId: string; brokerageId: string } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Unauthorized" }
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { error: "Unauthorized" }
  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(u.user_type ?? "")) {
    return { error: "Forbidden" }
  }
  return { userId: user.id, brokerageId: u.brokerage_id }
}

/** Propose a fresh ISA dial batch from the brokerage's consented hot-list. */
export async function proposeDialBatchAction(): Promise<{ ok: boolean; eligibleCount?: number; error?: string }> {
  const actor = await requireApprover()
  if ("error" in actor) return { ok: false, error: actor.error }
  const res = await proposeIsaDialBatch({ brokerageId: actor.brokerageId }, createServiceClient())
  revalidatePath("/dashboard/admin/voice-dial-batches")
  return res.proposed ? { ok: true, eligibleCount: res.eligibleCount } : { ok: false, error: res.reason }
}

/** Approve a proposed batch — re-checks consent and returns how many will dial. */
export async function approveDialBatchAction(batchId: string): Promise<{ ok: boolean; dialedCount?: number; droppedForConsent?: number; error?: string }> {
  const actor = await requireApprover()
  if ("error" in actor) return { ok: false, error: actor.error }
  const res = await approveIsaDialBatch({ batchId, brokerageId: actor.brokerageId, approverUserId: actor.userId }, createServiceClient())
  revalidatePath("/dashboard/admin/voice-dial-batches")
  return res.ok ? { ok: true, dialedCount: res.dialedCount, droppedForConsent: res.droppedForConsent } : { ok: false, error: res.error }
}

/** Reject a proposed batch. */
export async function rejectDialBatchAction(batchId: string): Promise<{ ok: boolean; error?: string }> {
  const actor = await requireApprover()
  if ("error" in actor) return { ok: false, error: actor.error }
  const svc = createServiceClient()
  const { data } = await svc.from("ai_isa_call_batches")
    .update({ status: "rejected", approved_by: actor.userId, approved_at: new Date().toISOString() })
    .eq("id", batchId).eq("brokerage_id", actor.brokerageId).eq("status", "proposed").select("id").maybeSingle()
  revalidatePath("/dashboard/admin/voice-dial-batches")
  return { ok: !!data, error: data ? undefined : "not in proposed state" }
}
