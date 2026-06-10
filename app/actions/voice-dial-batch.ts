"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { proposeIsaDialBatch, approveIsaDialBatch } from "@/lib/ai-isa/voice-dial-batch"

interface Actor { userId: string; brokerageId: string; agentId: string | null; isManager: boolean }

/** Resolve the caller. AGENT-FIRST: the agent who owns the contacts approves their own
 *  batch; brokers/admins (managers) can also approve as the 4h escalation override. */
async function requireActor(): Promise<Actor | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Unauthorized" }
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { error: "Unauthorized" }
  const isManager = ["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(u.user_type ?? "")
  const { data: a } = await supabase.from("agents").select("id").eq("user_id", user.id).eq("brokerage_id", u.brokerage_id).maybeSingle()
  const agentId = (a as { id: string } | null)?.id ?? null
  if (!isManager && !agentId) return { error: "Forbidden" }
  return { userId: user.id, brokerageId: u.brokerage_id, agentId, isManager }
}

/** Propose a fresh ISA dial batch from the AGENT's own consented hot-list. */
export async function proposeDialBatchAction(): Promise<{ ok: boolean; eligibleCount?: number; error?: string }> {
  const actor = await requireActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  // Agent-scoped: an agent proposes from their own contacts. A manager with no agent record
  // proposes brokerage-wide (agentId null).
  const res = await proposeIsaDialBatch({ brokerageId: actor.brokerageId, agentId: actor.agentId }, createServiceClient())
  revalidatePath("/dashboard/admin/voice-dial-batches")
  return res.proposed ? { ok: true, eligibleCount: res.eligibleCount } : { ok: false, error: res.reason }
}

/** Approve a proposed batch — re-checks consent, dials, records each attempt. The agent who
 *  owns the batch approves it; a manager can override (escalation). */
export async function approveDialBatchAction(batchId: string): Promise<{ ok: boolean; dialedCount?: number; droppedForConsent?: number; error?: string }> {
  const actor = await requireActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  // Authorization: the batch's responsible agent OR a manager (escalation override).
  const { data: batch } = await svc.from("ai_isa_call_batches")
    .select("proposed_by_agent_id").eq("id", batchId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (!batch) return { ok: false, error: "Batch not found" }
  const ownsIt = (batch as any).proposed_by_agent_id && (batch as any).proposed_by_agent_id === actor.agentId
  if (!ownsIt && !actor.isManager) return { ok: false, error: "Forbidden — not your batch" }

  const res = await approveIsaDialBatch({ batchId, brokerageId: actor.brokerageId, approverUserId: actor.userId }, svc)
  revalidatePath("/dashboard/admin/voice-dial-batches")
  return res.ok ? { ok: true, dialedCount: res.dialedCount, droppedForConsent: res.droppedForConsent } : { ok: false, error: res.error }
}

/** Reject a proposed batch (the responsible agent or a manager). */
export async function rejectDialBatchAction(batchId: string): Promise<{ ok: boolean; error?: string }> {
  const actor = await requireActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  const svc = createServiceClient()
  const { data: batch } = await svc.from("ai_isa_call_batches")
    .select("proposed_by_agent_id").eq("id", batchId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (!batch) return { ok: false, error: "Batch not found" }
  const ownsIt = (batch as any).proposed_by_agent_id && (batch as any).proposed_by_agent_id === actor.agentId
  if (!ownsIt && !actor.isManager) return { ok: false, error: "Forbidden — not your batch" }

  const { data } = await svc.from("ai_isa_call_batches")
    .update({ status: "rejected", approved_by: actor.userId, approved_at: new Date().toISOString() })
    .eq("id", batchId).eq("brokerage_id", actor.brokerageId).eq("status", "proposed").select("id").maybeSingle()
  revalidatePath("/dashboard/admin/voice-dial-batches")
  return { ok: !!data, error: data ? undefined : "not in proposed state" }
}
