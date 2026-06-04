"use server"

/**
 * app/actions/marketing-agent-resolutions.ts
 *
 * Wave 34 — server actions for the admin/approval UI to read pending
 * marketing-agent resolutions and approve them. Approval fires the
 * handler (lib/agents/marketing-agent-actions.ts::executeAction) and
 * returns the outcome.
 *
 * Permission gate: only brokerage admins / brokers / compliance
 * officers can approve (resolvePolicyScopeAccess returns
 * canEditBrokerage=true). Solo agents who own the brokerage trivially
 * pass the check via the same path.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { createServiceClient } from "@/lib/supabase/service"
import { executeAction } from "@/lib/agents/marketing-agent-actions"
import { revalidatePath } from "next/cache"

export interface PendingActionRow {
  id:           string
  action_type:  string
  action_input: Record<string, unknown>
  rationale:    string | null
  status:       string
  proposed_at:  string
  result:       Record<string, unknown> | null
}

export async function getPendingMarketingActions(): Promise<{
  success: boolean; error?: string; actions?: PendingActionRow[]
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage) {
    return { success: false, error: "Forbidden — brokerage admin only" }
  }

  const svc = createServiceClient()
  const { data, error } = await svc.from("marketing_agent_actions")
    .select("id, action_type, action_input, rationale, status, proposed_at, result")
    .eq("brokerage_id", ctx.brokerageId)
    .in("status", ["proposed", "succeeded", "failed", "skipped"])
    .order("proposed_at", { ascending: false })
    .limit(50)
  if (error) return { success: false, error: error.message }
  return { success: true, actions: (data ?? []) as PendingActionRow[] }
}

export async function approveMarketingAction(actionId: string): Promise<{
  success: boolean; error?: string; status?: string; result?: Record<string, unknown>
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage) {
    return { success: false, error: "Forbidden — brokerage admin only" }
  }

  // Tenant scope check on the action row before claiming.
  const svc = createServiceClient()
  const { data: row } = await svc.from("marketing_agent_actions")
    .select("brokerage_id, status")
    .eq("id", actionId)
    .maybeSingle()
  const a = row as { brokerage_id: string | null; status: string } | null
  if (!a || a.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Action not found or tenant mismatch" }
  }
  if (a.status !== "proposed") {
    return { success: false, error: `Action is already ${a.status}` }
  }

  const outcome = await executeAction(actionId, ctx.userId)
  revalidatePath("/dashboard/admin/marketing-agent-actions")
  return { success: true, status: outcome.status, result: outcome.result }
}
