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
import { loadManagerOps, type ManagerOps, loadVoiceToolRoundDeadlineStats, type VoiceToolRoundDeadlineStats } from "@/lib/platform/manager-ops"
import { loadRotationRisks, type RotationRisk } from "@/lib/security/credential-rotation"
import { runCredentialRefresh } from "@/lib/security/oauth-refresh"
import { requirePlatformCapability } from "@/lib/platform/require-capability"

/**
 * Platform staff only — through THE ONE capability gate the console page already uses
 * (app/dashboard/superadmin/ai-ops/page.tsx: requirePlatformCapability("ai_ops")).
 *
 * TOMBSTONE (lane 140O, CLAUDE.md §4/§6): this used to re-spell a two-role roster,
 * `["superadmin", "support"]`, matched against BOTH identity columns — which admitted a
 * TENANT user stored as user_type='support' to cross-tenant AI operations (replay a
 * signal, resolve an error) and refused the platform 'admin' the page had just let in.
 * Platform staff live in platform_role (lib/platform/platform-staff-roster.ts); the
 * capability map + superadmin overrides decide who holds 'ai_ops'. The session email is
 * read for the audit row only after the gate admits the caller.
 */
async function requireStaff(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("ai_ops")
  // FAIL CLOSED (§4): a gate that did not admit, or admitted nobody, is a refusal.
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden — platform staff only" }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { ok: true, userId: gate.userId, email: user?.email ?? "" }
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

/** Voice tool-round deadline telemetry (VOICE_TOOL_ROUND_DEADLINE_MS) — how often the
 *  bounded native-tool-calling round on a live call hits its ceiling, and what a
 *  candidate ceiling would have hit against the same sample. Cross-tenant (the
 *  deadline is one platform-wide constant). Blind-spot burn-down, lane 74C 2026-09-18. */
export async function getVoiceToolRoundDeadlineStatsAction(
  windowHours = 24 * 7,
): Promise<{ ok: true; data: VoiceToolRoundDeadlineStats } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  return { ok: true, data: await loadVoiceToolRoundDeadlineStats(createServiceClient(), windowHours) }
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
  const { error: expireErr } = await svc.from("manager_signals").update({ status: "expired" }).eq("id", signalId)
  if (expireErr) return { ok: false, error: `Could not expire the stuck signal (replay would be deduped): ${expireErr.message}` }
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
