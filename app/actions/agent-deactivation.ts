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
import {
  reassignAgentBooks,
  revertBookTransfer,
  listBookTransfers,
  type BookTransferScope,
  type BookTransferRow,
  type ReassignAgentBooksResult,
  type RevertBookTransferResult,
} from '@/lib/agents/agent-books'

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

// ─── BOOKS REASSIGNMENT (wave 81A, owner: "make sure the tenant can assign
//     temporarily or permanently another agents books in case an agent leaves
//     or temporarily leaves.") — same admin gate, tenant from the session, the
//     kernel does the counted writes (lib/agents/agent-books.ts). ───────────

/** Reassign an agent's whole book: temporary (auto-reverts on the daily sweep)
 *  or permanent (the deactivation survivor with disposition "reassign"). */
export async function reassignAgentBooksAction(input: {
  fromAgentId: string
  toAgentId: string
  scope: BookTransferScope
  until?: string | null
  reason?: string | null
  /** permanent only: keep the agent active (role change / restructure) — wave 82E. */
  keepActive?: boolean
}): Promise<{ ok: true; result: ReassignAgentBooksResult } | { ok: false; reason: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, reason: auth.reason }
  const result = await reassignAgentBooks(createServiceClient(), {
    brokerageId: auth.brokerageId,
    fromAgentId: String(input?.fromAgentId ?? ''),
    toAgentId: String(input?.toAgentId ?? ''),
    scope: input?.scope,
    until: input?.until ?? null,
    reason: input?.reason ? String(input.reason).slice(0, 500) : null,
    actorUserId: auth.actorUserId,
    keepActive: input?.keepActive === true,
  })
  if (!result.ok) return { ok: false, reason: result.error ?? 'books reassignment refused' }
  return { ok: true, result }
}

/** The tenant's transfers (active temporary first) for the revert door. */
export async function listBookTransfersAction(): Promise<{ ok: true; transfers: BookTransferRow[] } | { ok: false; reason: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, reason: auth.reason }
  const res = await listBookTransfers(createServiceClient(), auth.brokerageId)
  if (!res.ok) return { ok: false, reason: res.error ?? 'transfers could not be read' }
  return { ok: true, transfers: res.transfers }
}

/** Revert an open temporary transfer early (the sweep would revert it at its end date). */
export async function revertBookTransferAction(transferId: string): Promise<{ ok: true; result: RevertBookTransferResult } | { ok: false; reason: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, reason: auth.reason }
  const result = await revertBookTransfer(createServiceClient(), {
    brokerageId: auth.brokerageId, transferId: String(transferId ?? ''), actorUserId: auth.actorUserId,
  })
  if (!result.ok) return { ok: false, reason: result.error ?? 'revert refused' }
  return { ok: true, result }
}
