"use server"

// app/actions/superadmin/ai-ops.ts
// ─────────────────────────────────────────────────────────────────────────────
// Platform AI OPERATIONS — cross-tenant view of the autonomous layer + safe operator actions. Read is
// platform-staff (superadmin/support); the two write actions (replay a dead-letter signal, resolve an
// automation error) are audited to superadmin_audit_log.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { loadAiOps, type AiOps } from "@/lib/platform/ai-ops"
import { loadManagerOps, type ManagerOps } from "@/lib/platform/manager-ops"
import { loadRotationRisks, type RotationRisk } from "@/lib/security/credential-rotation"
import { runCredentialRefresh } from "@/lib/security/oauth-refresh"

async function requireStaff(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const isStaff = ["superadmin", "support"].includes((data as any)?.user_type) || ["superadmin", "support"].includes((data as any)?.platform_role)
  if (!isStaff) return { ok: false, error: "Forbidden — platform staff only" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetType: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: targetType, target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[ai-ops audit] failed:", err) }
}

export async function getAiOpsAction(windowHours = 24): Promise<{ ok: true; data: AiOps } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  return { ok: true, data: await loadAiOps(createServiceClient(), new Date(), windowHours) }
}

/** Per-manager cost / latency (p95) / error-rate + SLO status, cross-tenant. */
export async function getManagerOpsAction(windowHours = 24): Promise<{ ok: true; data: ManagerOps } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  return { ok: true, data: await loadManagerOps(createServiceClient(), windowHours) }
}

/** Expired / expiring-soon integration credentials that need rotation, cross-tenant. */
export async function getCredentialRotationAction(): Promise<{ ok: true; data: RotationRisk[] } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  return { ok: true, data: await loadRotationRisks(createServiceClient()) }
}

/** Attempt an automatic OAuth refresh of expiring credentials (provider-gated) — the rotation
 *  monitor becoming rotation automation. Audited. */
export async function runCredentialRefreshAction(): Promise<{ ok: boolean; attempted?: number; refreshed?: number; skipped?: number; failed?: number; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const r = await runCredentialRefresh(svc)
  await audit(auth.userId, auth.email, "credential.refresh_sweep", "platform", "credentials", { attempted: r.attempted, refreshed: r.refreshed, skipped: r.skipped, failed: r.failed })
  return { ok: true, attempted: r.attempted, refreshed: r.refreshed, skipped: r.skipped, failed: r.failed }
}

/** REPLAY a dead-letter signal — expire the stuck one + re-publish (re-invokes the manager handler). */
export async function replaySignalAction(signalId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: sig } = await svc.from("manager_signals")
    .select("brokerage_id, from_manager, to_manager, signal_type, message, entity_type, entity_id, contact_id, payload, status")
    .eq("id", signalId).maybeSingle()
  if (!sig) return { ok: false, error: "Signal not found" }
  if ((sig as any).status !== "open") return { ok: false, error: "Only an open (stuck) signal can be replayed" }

  // Expire the stuck one so the re-publish isn't deduped, then re-publish → the handler runs again.
  await svc.from("manager_signals").update({ status: "expired" }).eq("id", signalId)
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const s = sig as any
  const r = await publishManagerSignal({
    brokerageId: s.brokerage_id, fromManager: s.from_manager, toManager: s.to_manager, signalType: s.signal_type,
    message: s.message ?? "", entityType: s.entity_type, entityId: s.entity_id, contactId: s.contact_id, payload: s.payload ?? {},
    dedupe: false,
  } as any, svc as any)
  if (!r.ok) return { ok: false, error: r.reason ?? "replay failed" }

  await audit(auth.userId, auth.email, "ai_ops.signal_replayed", "manager_signals", signalId, { to_manager: s.to_manager, signal_type: s.signal_type, new_signal_id: r.signalId })
  revalidatePath("/dashboard/superadmin/ai-ops")
  return { ok: true }
}

/** Acknowledge / resolve an automation error from the console. */
export async function resolveAutomationErrorAction(errorId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { error } = await svc.from("automation_errors")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: auth.userId })
    .eq("id", errorId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "ai_ops.error_resolved", "automation_errors", errorId, {})
  revalidatePath("/dashboard/superadmin/ai-ops")
  return { ok: true }
}
