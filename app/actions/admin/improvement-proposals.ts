"use server"

/**
 * app/actions/admin/improvement-proposals.ts — the tenant-admin doors of CONTROLLED LEARNING
 * (wave 104, lane 104C; m709; gap map row 20).
 *
 * Every door is tenant-admin only (TENANT_ADMIN_USER_TYPES via isTenantAdminGrantRole), tenant from
 * the SESSION (requireCallerTenant — no argument names a brokerage), gate first, then the service
 * client (CLAUDE.md §4). The decisions themselves live in lib/kernel/improvement-proposals.ts:
 *   listProposals()                       every proposal of this brokerage with its evidence + evaluation
 *   decideProposalAction(id, decision)    EVALUATED → APPROVED / REJECTED (a human on the roster)
 *   promoteProposalAction(id)             APPROVED → PROMOTED through the subject's survivor writer, ledgered
 *   rollbackProposalAction(id)            PROMOTED → ROLLED_BACK (previous value back through the same writer)
 */

import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import {
  decideProposal, listImprovementProposals, promoteProposal, rollbackProposal,
  type ImprovementProposalRow, type ProposalActor,
} from "@/lib/kernel/improvement-proposals"

type AdminGate = { ok: true; brokerageId: string; actor: ProposalActor } | { ok: false; error: string }

async function requireLearningAdmin(reason?: string | null): Promise<AdminGate> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isTenantAdminGrantRole(caller.userType)) {
    return { ok: false, error: "Only a broker, owner, admin, team lead or compliance officer can decide on improvement proposals." }
  }
  return { ok: true, brokerageId: caller.brokerageId, actor: { type: "user", userId: caller.userId, isTenantAdmin: true, reason: reason ?? null } }
}

export async function listProposals(): Promise<{ ok: true; available: boolean; rows: ImprovementProposalRow[] } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  return listImprovementProposals(createServiceClient(), gate.brokerageId, { limit: 100 })
}

export async function decideProposalAction(id: string, decision: "approve" | "reject", reason?: string): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin(reason)
  if (!gate.ok) return { ok: false, error: gate.error }
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: "Decision must be approve or reject." }
  const r = await decideProposal(createServiceClient(), { brokerageId: gate.brokerageId, id: String(id ?? ""), decision, actor: gate.actor, reason: reason ?? null })
  if (r.ok) revalidatePath("/dashboard/admin/manager-trust")
  return r
}

export async function promoteProposalAction(id: string, reason?: string): Promise<{ ok: true; policyVersionRef: string | null; writer: string } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin(reason)
  if (!gate.ok) return { ok: false, error: gate.error }
  const r = await promoteProposal(createServiceClient(), { brokerageId: gate.brokerageId, id: String(id ?? ""), actor: gate.actor })
  if (r.ok) revalidatePath("/dashboard/admin/manager-trust")
  return r.ok ? r : { ok: false, error: r.error }
}

export async function rollbackProposalAction(id: string, reason?: string): Promise<{ ok: true; policyVersionRef: string | null; writer: string } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin(reason)
  if (!gate.ok) return { ok: false, error: gate.error }
  const r = await rollbackProposal(createServiceClient(), { brokerageId: gate.brokerageId, id: String(id ?? ""), actor: gate.actor })
  if (r.ok) revalidatePath("/dashboard/admin/manager-trust")
  return r.ok ? r : { ok: false, error: r.error }
}
