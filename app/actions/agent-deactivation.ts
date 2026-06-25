'use server'

// app/actions/agent-deactivation.ts
// ─────────────────────────────────────────────────────────────────────────────
// Admin user-management actions for deactivating an agent and consciously handling
// their book (reassign to a successor / archive the agent's own contract book). Gated
// to brokerage admins/brokers — a regular agent can never reassign another agent's book.

import { createServiceClient } from '@/lib/supabase/service'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import {
  planAgentDeactivation,
  executeAgentDeactivation,
  type AgentBookDisposition,
  type DeactivationPlan,
  type DeactivationResult,
} from '@/lib/agents/agent-deactivation'

const ADMIN_ROLES = new Set(['broker', 'broker_owner', 'broker_admin', 'admin', 'superadmin'])

async function requireAdmin() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false as const, reason: 'Unauthorized' }
  if (!ADMIN_ROLES.has(ctx.role)) return { ok: false as const, reason: 'Forbidden — admin only' }
  return { ok: true as const, brokerageId: ctx.brokerageId, actorUserId: ctx.userId }
}

/** Resolve an agent's user_id (source_agent_id may be stored as either id). */
async function resolveAgentUserId(svc: ReturnType<typeof createServiceClient>, brokerageId: string, agentId: string) {
  const { data } = await svc.from('agents').select('user_id').eq('id', agentId).eq('brokerage_id', brokerageId).maybeSingle()
  return (data as { user_id: string | null } | null)?.user_id ?? null
}

/** READ-ONLY preview the admin UI renders before confirming a deactivation. */
export async function previewAgentDeactivation(
  agentId: string,
): Promise<{ ok: true; plan: DeactivationPlan } | { ok: false; reason: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, reason: auth.reason }
  const svc = createServiceClient()
  const userId = await resolveAgentUserId(svc, auth.brokerageId, agentId)
  const plan = await planAgentDeactivation(svc, { brokerageId: auth.brokerageId, agentId, userId })
  return { ok: true, plan }
}

/** Execute the deactivation: reassign system book + leads + in-flight deals to the
 *  successor; reassign-or-archive the agent's own book per disposition; deactivate. */
export async function deactivateAgent(input: {
  agentId: string
  successorAgentId: string | null
  agentBookDisposition: AgentBookDisposition
}): Promise<{ ok: true; result: DeactivationResult } | { ok: false; reason: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, reason: auth.reason }
  const svc = createServiceClient()
  const userId = await resolveAgentUserId(svc, auth.brokerageId, input.agentId)
  const result = await executeAgentDeactivation(svc, {
    brokerageId: auth.brokerageId,
    agentId: input.agentId,
    userId,
    successorAgentId: input.successorAgentId,
    agentBookDisposition: input.agentBookDisposition,
    actorUserId: auth.actorUserId,
  })
  if (!result.ok) return { ok: false, reason: result.reason ?? 'deactivation failed' }
  return { ok: true, result }
}
