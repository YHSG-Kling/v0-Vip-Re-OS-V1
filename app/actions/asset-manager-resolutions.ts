"use server"

/**
 * app/actions/asset-manager-resolutions.ts
 *
 * Wave 37 — server actions for the asset manager admin queue.
 * Mirrors app/actions/marketing-agent-resolutions.ts (Wave 34b).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { executeAssetManagerAction } from "@/lib/agents/asset-manager-actions"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export interface PendingAssetActionRow {
  id:           string
  action_type:  string
  action_input: Record<string, unknown>
  rationale:    string | null
  status:       string
  result:       Record<string, unknown> | null
  proposed_at:  string
}

export async function getPendingAssetManagerActions(): Promise<{
  success: boolean
  actions?: PendingAssetActionRow[]
  error?:   string
}> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("asset_manager_actions")
    .select("id, action_type, action_input, rationale, status, result, proposed_at")
    .eq("brokerage_id", access.brokerageScopeId)
    .order("proposed_at", { ascending: false })
    .limit(50)
  if (error) return { success: false, error: error.message }
  return { success: true, actions: (data ?? []) as PendingAssetActionRow[] }
}

export async function approveAssetManagerAction(actionId: string): Promise<{
  success: boolean
  status?: string
  result?: Record<string, unknown>
  error?:  string
}> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  // Tenant gate: action must belong to this brokerage.
  const { data: row } = await svc
    .from("asset_manager_actions")
    .select("brokerage_id")
    .eq("id", actionId)
    .maybeSingle()
  if (!row) return { success: false, error: "action_not_found" }
  if ((row.brokerage_id as string) !== access.brokerageScopeId) {
    return { success: false, error: "tenant_mismatch" }
  }

  const outcome = await executeAssetManagerAction(actionId, ctx.userId)
  revalidatePath("/dashboard/admin/asset-manager-actions")
  return { success: outcome.status !== "failed", status: outcome.status, result: outcome.result }
}
