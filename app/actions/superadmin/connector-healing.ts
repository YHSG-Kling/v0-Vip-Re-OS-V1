"use server"

import { headers } from "next/headers"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { revalidatePath } from "next/cache"

/**
 * Platform-staff actions for the AI connector-healing proposals queue.
 *
 * Authorization: the `providers` platform capability, which is the SAME authority the
 * queue's own page (`/dashboard/superadmin/connector-healing`) requires to render.
 *
 * PRIVILEGE GAP FIXED (medium). This file previously gated on
 * `user_type === "superadmin" || isPlatformStaff(platform_role)`, and
 * `PLATFORM_STAFF_ROLES` is `["superadmin","admin","marketing","support"]` — but the
 * capability matrix in `lib/platform/platform-staff-roster.ts` grants `providers` only to
 * `superadmin` and `admin`. So a **marketing or support** platform employee was redirected
 * away from the page by `requirePlatformCapability("providers")` and could then call these
 * `"use server"` exports directly to read the queue (vendor doc URLs, raw failure samples,
 * proposal payloads) and to approve or reject proposals. The page gate and the endpoint gate
 * are now the same gate, and the per-role capability OVERRIDES a superadmin may have set are
 * honoured here too — `isPlatformStaff` never consulted them.
 *
 * Writes go through the service client (RLS bypass) — RLS on connector_healing_proposals is
 * intentionally restrictive (no anon SELECT) since these rows can leak vendor doc URLs and
 * internal failure details.
 */

async function assertProvidersCapability(
  opts: { requireWrite?: boolean } = {},
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("providers", opts)
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  return { ok: true, userId: gate.userId }
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
  const gate = await assertProvidersCapability()
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

/**
 * Recent FINALIZED proposals — the history strip beside the pending queue.
 *
 * MERGED from the page's inline duplicate (`/dashboard/superadmin/connector-healing`),
 * which is now wired to this action. Two behaviours came from there and were missing here:
 *  - `.neq("status", "pending")` — without it this returned the pending rows a second time,
 *    so "recent history" duplicated the actionable queue rendered right above it.
 *  - the page's default page size of 25.
 * `failure_signature` is kept from this side (the page's version dropped it, and it is what
 * tells an operator whether two proposals are the same underlying breakage).
 */
export async function listRecentProposalsAction(limit = 25): Promise<{
  success: boolean
  proposals?: Array<Record<string, unknown>>
  error?: string
}> {
  const gate = await assertProvidersCapability()
  if (!gate.ok) return { success: false, error: gate.error }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("connector_healing_proposals")
    .select("id, connector, detected_at, failure_signature, proposal_kind, proposal_summary, confidence, status, applied_at, applied_by")
    .neq("status", "pending")
    .order("detected_at", { ascending: false })
    .limit(Math.max(1, Math.min(500, limit)))
  if (error) return { success: false, error: error.message }
  return { success: true, proposals: data ?? [] }
}

export async function approveProposalAction(params: {
  proposalId: string
  notes?:     string
}): Promise<{ success: boolean; error?: string }> {
  const gate = await assertProvidersCapability({ requireWrite: true })
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
  const gate = await assertProvidersCapability({ requireWrite: true })
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
