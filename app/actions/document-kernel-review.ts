"use server"

/**
 * app/actions/document-kernel-review.ts
 *
 * THE HUMAN'S SIDE OF THE DOCUMENT KERNEL — the amber proposals the
 * kernel raises on the manager bus become one-click decisions on the
 * Command Center feed. The actual writes live in
 * lib/documents/kernel-review-core.ts (+ autonomy-ratchet.ts), SHARED
 * with the voice admin's kernel_resolve verb — two front-ends, one
 * resolution path, zero drift. These wrappers own cookie auth + roles:
 *
 *   resolveDeadlineConflictAction / approveStageAdvanceAction /
 *   dismissStageCandidateAction — agent/tc/broker/admin.
 *   resolveAutonomyRatchetAction — broker/admin ONLY (granting the
 *   kernel standing autonomy is brokerage policy, not deal work).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  resolveDeadlineConflictCore,
  approveStageAdvanceCore,
  dismissStageCandidateCore,
} from "@/lib/documents/kernel-review-core"
import { resolveAutonomyRatchetCore } from "@/lib/documents/autonomy-ratchet"

const REVIEW_ROLES = new Set(["agent", "tc", "broker", "admin", "super_admin"])
const GRANT_ROLES = new Set(["broker", "admin", "super_admin"])

async function loadActor(allowed: Set<string>): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type, role")
    .eq("id", user.id)
    .maybeSingle()
  const role = String((row as any)?.role ?? (row as any)?.user_type ?? "")
  if (!row?.brokerage_id) return { ok: false, error: "No brokerage" }
  if (!allowed.has(role)) return { ok: false, error: "Not permitted to review kernel proposals" }
  return { ok: true, userId: user.id, brokerageId: (row as any).brokerage_id }
}

export async function resolveDeadlineConflictAction(input: {
  signalId: string
  adopt: boolean
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const actor = await loadActor(REVIEW_ROLES)
  if (!actor.ok) return { ok: false, error: actor.error }
  return resolveDeadlineConflictCore(createServiceClient() as any, actor, input)
}

export async function approveStageAdvanceAction(input: {
  signalId: string
}): Promise<{ ok: boolean; message?: string; blockers?: string[]; error?: string }> {
  const actor = await loadActor(REVIEW_ROLES)
  if (!actor.ok) return { ok: false, error: actor.error }
  return approveStageAdvanceCore(createServiceClient() as any, actor, input)
}

export async function dismissStageCandidateAction(input: {
  signalId: string
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const actor = await loadActor(REVIEW_ROLES)
  if (!actor.ok) return { ok: false, error: actor.error }
  return dismissStageCandidateCore(createServiceClient() as any, actor, input)
}

export async function resolveAutonomyRatchetAction(input: {
  signalId: string
  grant: boolean
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const actor = await loadActor(GRANT_ROLES)
  if (!actor.ok) return { ok: false, error: actor.error }
  return resolveAutonomyRatchetCore(createServiceClient() as any, actor, input)
}

// ── THE EARNED AUTONOMY LEDGER — what the broker granted, with the evidence
//    behind it and every act since; plus one-click revoke. You can't fully
//    trust what you can't see and take back. ──────────────────────────────

export interface EarnedGrant {
  shape: string
  managerKey: string
  /** the policy row that recorded the broker's grant decision. */
  grantedAt: string | null
  /** consecutive approvals the grant was earned on (from the proposal payload). */
  earnedOn: number | null
  /** autonomous acts recorded under this grant since. */
  actsSince: number
}

export async function listEarnedAutonomyAction(): Promise<{
  ok: boolean
  grants?: EarnedGrant[]
  error?: string
}> {
  const actor = await loadActor(GRANT_ROLES)
  if (!actor.ok) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const { loadDocKernelGrants, loadMarketingGrants } = await import("@/lib/documents/autonomy-ratchet")
  const [docGrants, mktGrants] = await Promise.all([
    loadDocKernelGrants(svc as any, actor.brokerageId),
    loadMarketingGrants(svc as any, actor.brokerageId),
  ])
  const shapes: Array<{ shape: string; managerKey: string }> = [
    ...[...docGrants].map((shape) => ({ shape, managerKey: "deal_coordinator" })),
    ...[...mktGrants].map((shape) => ({ shape, managerKey: "campaign_orchestrator" })),
  ]
  if (shapes.length === 0) return { ok: true, grants: [] }

  // Evidence per shape from the SAME policy ledger every decision lives on.
  const { data: grantRows } = await svc.from("policy_decisions")
    .select("target_id, created_at, evidence_json, recommended_action")
    .eq("brokerage_id", actor.brokerageId)
    .eq("target_type", "autonomy_grant")
    .in("recommended_action", ["autonomy_granted", "autonomy_revoked"])
    .order("created_at", { ascending: false })
    .limit(500)
  const latestGrantByShape = new Map<string, { at: string }>()
  for (const r of ((grantRows ?? []) as any[])) {
    if (r.recommended_action !== "autonomy_granted") continue
    if (!latestGrantByShape.has(r.target_id)) latestGrantByShape.set(r.target_id, { at: r.created_at })
  }

  const { data: actRows } = await svc.from("policy_decisions")
    .select("evidence_json")
    .eq("brokerage_id", actor.brokerageId)
    .in("recommended_action", ["auto_adopted_granted", "auto_tracked_granted", "auto_approved_by_grant"])
    .limit(2000)
  const actsByShape = new Map<string, number>()
  for (const r of ((actRows ?? []) as any[])) {
    const s = r.evidence_json?.granted_shape ? String(r.evidence_json.granted_shape) : null
    if (!s) continue
    actsByShape.set(s, (actsByShape.get(s) ?? 0) + 1)
  }

  // The approvals each grant was earned on — from the consumed proposal's payload.
  const { data: proposals } = await svc.from("manager_signals")
    .select("payload")
    .eq("brokerage_id", actor.brokerageId)
    .eq("signal_type", "autonomy_ratchet_proposal")
    .eq("status", "consumed")
    .limit(200)
  const earnedByShape = new Map<string, number>()
  for (const r of ((proposals ?? []) as any[])) {
    const s = r.payload?.shape ? String(r.payload.shape) : null
    const a = Number(r.payload?.approvals ?? NaN)
    if (s && Number.isFinite(a)) earnedByShape.set(s, a)
  }

  return {
    ok: true,
    grants: shapes.map(({ shape, managerKey }) => ({
      shape,
      managerKey,
      grantedAt: latestGrantByShape.get(shape)?.at ?? null,
      earnedOn: earnedByShape.get(shape) ?? null,
      actsSince: actsByShape.get(shape) ?? 0,
    })),
  }
}

export async function revokeAutonomyGrantAction(input: {
  shape: string
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const actor = await loadActor(GRANT_ROLES)
  if (!actor.ok) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const { writeAutonomyGrant } = await import("@/lib/documents/autonomy-ratchet")
  const w = await writeAutonomyGrant(svc as any, { brokerageId: actor.brokerageId, shape: input.shape, grant: false })
  if (!w.ok) return { ok: false, error: w.error ?? "Revoke failed" }

  const { recordPolicyDecision } = await import("@/lib/documents/policy-decisions")
  await recordPolicyDecision(svc as any, {
    brokerageId: actor.brokerageId,
    targetType: "autonomy_grant",
    targetId: input.shape,
    verdict: {
      decision: "green",
      reasons: [`broker revoked autonomy on ${input.shape} — the shape returns to human approval`],
      recommendedAction: "autonomy_revoked",
      requiredApproverRole: null,
    },
    evidence: { revoked_by_user_id: actor.userId, shape: input.shape },
  })
  return { ok: true, message: `Revoked — ${input.shape.replace(/_/g, " ")} is back to human approval.` }
}
