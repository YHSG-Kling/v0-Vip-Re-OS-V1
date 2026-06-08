"use server"

/**
 * app/actions/command-center.ts
 *
 * Approve / reject mutations for the Agent Command Center approval queue.
 * Approve routes through the REAL executors (executeAction /
 * executeAssetManagerAction) so the governance contract holds: a human
 * approver's id is stamped (approved_by) before the action executes — there is
 * no autonomous self-execution. Reject transitions a proposed action to
 * 'skipped' with the same approver provenance.
 */
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { executeAction } from "@/lib/agents/marketing-agent-actions"
import { executeAssetManagerAction } from "@/lib/agents/asset-manager-actions"
import { executeAdManagerAction } from "@/lib/ads/ad-manager"
import { approveContentSource, rejectContentSource, type ContentQueue } from "@/lib/kernel/approval-sources"

type Queue = "marketing" | "asset" | "ads" | ContentQueue
type AgentQueue = "marketing" | "asset" | "ads"
const TABLE: Record<AgentQueue, "marketing_agent_actions" | "asset_manager_actions" | "ad_manager_actions"> = {
  marketing: "marketing_agent_actions",
  asset:     "asset_manager_actions",
  ads:       "ad_manager_actions",
}

/** Resolve the acting user and confirm they may approve agent actions. */
async function requireApprover(): Promise<{ userId: string; brokerageId: string | null; isSuperadmin: boolean } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }
  const { data: u } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const role = u?.user_type ?? "agent"
  if (!["admin", "broker", "superadmin"].includes(role)) return { error: "Not authorized to approve agent actions" }
  return { userId: user.id, brokerageId: u?.brokerage_id ?? null, isSuperadmin: role === "superadmin" }
}

/** Confirm the action exists, is still proposed, and is in the approver's scope. */
async function loadScopedAction(queue: AgentQueue, actionId: string, brokerageId: string | null, isSuperadmin: boolean) {
  const svc = createServiceClient()
  const { data } = await svc.from(TABLE[queue])
    .select("id, brokerage_id, status")
    .eq("id", actionId)
    .maybeSingle()
  if (!data) return { error: "Action not found" as const }
  if (!isSuperadmin && brokerageId && data.brokerage_id !== brokerageId) return { error: "Action outside your brokerage" as const }
  if (data.status !== "proposed") return { error: `Action already ${data.status}` as const }
  return { ok: true as const }
}

export async function approveAgentAction(params: { queue: Queue; actionId: string }) {
  const actor = await requireApprover()
  if ("error" in actor) return { ok: false, error: actor.error }

  // Social posts approve through the existing, self-scoping social action — the
  // Command Center is just a second (unified) surface onto the SAME write.
  if (params.queue === "social") {
    const { approveSocialPost } = await import("@/app/actions/social-media-automation")
    const res = await approveSocialPost(params.actionId)
    revalidatePath("/dashboard/admin/command-center")
    return { ok: !!res.success, status: res.success ? "approved" : "failed", error: res.error }
  }
  // Newsletter + direct-mail + ad-creative release through the content registry.
  if (params.queue === "newsletter" || params.queue === "direct_mail" || params.queue === "ad_creative") {
    const res = await approveContentSource(params.queue, params.actionId, { userId: actor.userId, brokerageId: actor.brokerageId, isSuperadmin: actor.isSuperadmin })
    revalidatePath("/dashboard/admin/command-center")
    return { ok: res.ok, status: res.status, error: res.error }
  }

  const scope = await loadScopedAction(params.queue, params.actionId, actor.brokerageId, actor.isSuperadmin)
  if ("error" in scope) return { ok: false, error: scope.error }

  const result = params.queue === "marketing"
    ? await executeAction(params.actionId, actor.userId)
    : params.queue === "ads"
    ? await executeAdManagerAction(params.actionId, actor.userId)
    : await executeAssetManagerAction(params.actionId, actor.userId)

  revalidatePath("/dashboard/admin/command-center")
  return { ok: result.status !== "failed", status: result.status, result: result.result }
}

export async function rejectAgentAction(params: { queue: Queue; actionId: string }) {
  const actor = await requireApprover()
  if ("error" in actor) return { ok: false, error: actor.error }

  if (params.queue === "social") {
    const { rejectSocialPost } = await import("@/app/actions/social-media-automation")
    const res = await rejectSocialPost(params.actionId, undefined, "Rejected in Command Center")
    revalidatePath("/dashboard/admin/command-center")
    return { ok: !!res.success, status: "rejected" as const, error: res.error }
  }
  if (params.queue === "newsletter" || params.queue === "direct_mail" || params.queue === "ad_creative") {
    const res = await rejectContentSource(params.queue, params.actionId, { userId: actor.userId, brokerageId: actor.brokerageId, isSuperadmin: actor.isSuperadmin })
    revalidatePath("/dashboard/admin/command-center")
    return { ok: res.ok, status: "rejected" as const, error: res.error }
  }

  const scope = await loadScopedAction(params.queue, params.actionId, actor.brokerageId, actor.isSuperadmin)
  if ("error" in scope) return { ok: false, error: scope.error }

  const svc = createServiceClient()
  const { error } = await svc.from(TABLE[params.queue])
    .update({ status: "skipped", approved_by: actor.userId, approved_at: new Date().toISOString() })
    .eq("id", params.actionId)
    .eq("status", "proposed")
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/admin/command-center")
  return { ok: true, status: "skipped" as const }
}
