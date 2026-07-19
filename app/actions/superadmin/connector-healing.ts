"use server"

import { headers } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { revalidatePath } from "next/cache"

/**
 * Superadmin / support actions for the AI connector-healing proposals queue.
 *
 * Authorization: every action requires a logged-in user whose `users.user_type` is `superadmin`
 * OR whose `platform_role` is in the platform-staff set (the same gate the existing superadmin
 * pages use). The shared `assertPlatformStaff` helper below short-circuits with a structured
 * `{success:false}` so the UI can show a clear "Not authorized" without throwing.
 *
 * All writes go through the service client (RLS bypass) — RLS on connector_healing_proposals is
 * intentionally restrictive (no anon SELECT) since these rows can leak vendor doc URLs and
 * internal failure details.
 */

async function assertPlatformStaff(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: profile } = await svc.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const allowed = profile?.user_type === "superadmin" || isPlatformStaff(profile?.platform_role)
  if (!allowed) return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id }
}

// Central-ledger audit — approve/reject previously stamped only the proposal row
// (applied_by/applied_at), leaving the platform-action ledger blind to healing
// verdicts. Same conventions as the other superadmin actions: non-fatal.
async function audit(actorUserId: string, action: string, proposalId: string, details: Record<string, unknown>): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (actor as any)?.email ?? null,
      action,
      target_type: "connector_healing_proposal",
      target_id: proposalId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[connector-healing audit] write failed:", err)
  }
}

export async function listPendingProposalsAction(): Promise<{
  success: boolean
  proposals?: Array<Record<string, unknown>>
  error?: string
}> {
  const gate = await assertPlatformStaff()
  if (!gate.ok) return { success: false, error: gate.error }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("connector_healing_proposals")
    .select("id, connector, detected_at, failure_signature, failure_sample, proposal_kind, proposal_summary, proposal_payload, docs_evidence, confidence, status, notes")
    .eq("status", "pending")
    .order("detected_at", { ascending: false })
    .limit(200)
  if (error) return { success: false, error: error.message }
  return { success: true, proposals: data ?? [] }
}

export async function listRecentProposalsAction(limit = 50): Promise<{
  success: boolean
  proposals?: Array<Record<string, unknown>>
  error?: string
}> {
  const gate = await assertPlatformStaff()
  if (!gate.ok) return { success: false, error: gate.error }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("connector_healing_proposals")
    .select("id, connector, detected_at, failure_signature, proposal_kind, proposal_summary, confidence, status, applied_at, applied_by")
    .order("detected_at", { ascending: false })
    .limit(Math.max(1, Math.min(500, limit)))
  if (error) return { success: false, error: error.message }
  return { success: true, proposals: data ?? [] }
}

export async function approveProposalAction(params: {
  proposalId: string
  notes?:     string
}): Promise<{ success: boolean; error?: string }> {
  const gate = await assertPlatformStaff()
  if (!gate.ok) return { success: false, error: gate.error }
  const svc = createServiceClient()
  // Approval marks the proposal as 'applied' with the actor + timestamp. The actual change
  // implementation (endpoint path edit, key rotation, actor swap) is intentionally NOT in this
  // action — approving here is the human go-ahead; the change still lands via a code commit or
  // an `auto_apply` worker honoring the proposal_payload diff. This keeps blast radius bounded.
  // .select().maybeSingle() so we know whether a row actually flipped — otherwise Supabase
  // returns {error:null, data:null} on a no-op (status was already 'applied'/'rejected') and the
  // UI would mis-report success while silently discarding the new note.
  const { data, error } = await svc
    .from("connector_healing_proposals")
    .update({
      status:     "applied",
      applied_at: new Date().toISOString(),
      applied_by: gate.userId,
      notes:      params.notes ?? null,
    })
    .eq("id", params.proposalId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: "Proposal already finalized — refresh to see current state" }
  await audit(gate.userId, "connector_healing.approved", params.proposalId, { notes: params.notes ?? null })
  revalidatePath("/dashboard/superadmin/connector-healing")
  return { success: true }
}

export async function rejectProposalAction(params: {
  proposalId: string
  notes?:     string
}): Promise<{ success: boolean; error?: string }> {
  const gate = await assertPlatformStaff()
  if (!gate.ok) return { success: false, error: gate.error }
  const svc = createServiceClient()
  // Same idempotency contract as approve — only the first concurrent action wins; subsequent
  // attempts must surface "Already finalized" instead of falsely reporting success.
  const { data, error } = await svc
    .from("connector_healing_proposals")
    .update({
      status:     "rejected",
      applied_at: new Date().toISOString(),
      applied_by: gate.userId,
      notes:      params.notes ?? null,
    })
    .eq("id", params.proposalId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: "Proposal already finalized — refresh to see current state" }
  await audit(gate.userId, "connector_healing.rejected", params.proposalId, { notes: params.notes ?? null })
  revalidatePath("/dashboard/superadmin/connector-healing")
  return { success: true }
}
