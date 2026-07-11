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
