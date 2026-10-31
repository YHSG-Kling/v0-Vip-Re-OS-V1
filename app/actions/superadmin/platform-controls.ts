"use server"

// app/actions/superadmin/platform-controls.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin god-switch actions — read + flip the platform_settings singleton (emergency mode / AI engine /
// global rate limit). Every mutation is superadmin-gated and written to superadmin_audit_log with IP + UA.

import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { getPlatformControls, setPlatformControls, type PlatformControls } from "@/lib/platform/platform-controls"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { requirePlatformCapability } from "@/lib/platform/require-capability"

// TOMBSTONE: local requireSuperadmin merged onto lib/auth/platform-guard.ts:91
// requireSuperadmin (imported above) — §1/§6 SAME BODY census round 3,
// 2026-09-09.

export async function getPlatformControlsAction(): Promise<{ ok: true; controls: PlatformControls } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  return { ok: true, controls: await getPlatformControls() }
}

export async function setPlatformControlsAction(
  patch: Partial<PlatformControls>,
): Promise<{ ok: true; controls: PlatformControls } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const before = await getPlatformControls(svc)
  const controls = await setPlatformControls(svc, patch)

  // Audit — the god switch is the most consequential lever on the platform.
  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: auth.userId, actor_email: auth.email,
      action: "platform_controls_update", target_type: "platform_settings", target_id: null,
      details: { patch, before, after: controls },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[platform-controls] audit write failed:", err)
  }
  return { ok: true, controls }
}

// ── TENANT-FACING STATUS NOTICE ──────────────────────────────────────────────
// The platform → tenant incident broadcast (platform_settings.status_notice —
// see lib/platform/status-notice.ts). platform_announcements reach STAFF only;
// this is what a TENANT sees on /dashboard/whats-new during an incident or
// maintenance window. Superadmin-gated + audited like the god switch.

export async function setStatusNoticeAction(input: {
  active: boolean
  severity: "info" | "degraded" | "outage"
  message: string
}): Promise<
  | { ok: true; notice: import("@/lib/platform/status-notice").StatusNotice }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (input.active && !(input.message ?? "").trim()) {
    return { ok: false, error: "An active status notice needs a message" }
  }

  const { loadStatusNotice, saveStatusNotice } = await import("@/lib/platform/status-notice")
  const svc = createServiceClient()
  try {
    const before = await loadStatusNotice(svc)
    const notice = await saveStatusNotice(svc, {
      active: input.active,
      severity: input.severity,
      message: input.message,
      // Keep the original start time while an already-active incident is being updated.
      startedAt: input.active && before.active ? before.startedAt : null,
    })

    try {
      const hdrs = await headers()
      await svc.from("superadmin_audit_log").insert({
        actor_user_id: auth.userId, actor_email: auth.email,
        action: notice.active ? "status_notice.set" : "status_notice.cleared",
        target_type: "platform_settings", target_id: null,
        details: { before, after: notice },
        ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
        user_agent: hdrs.get("user-agent"),
      })
    } catch (err) {
      console.error("[status-notice] audit write failed:", err)
    }
    return { ok: true, notice }
  } catch (err: any) {
    return { ok: false, error: `${err?.message ?? "Write failed"} — has scripts/l61-s01-retention-offer-status-notice.sql been applied?` }
  }
}

// ── HEALTH-CHECK PROPOSED NOTICE (publish / dismiss) ─────────────────────────
// The health-check cron stores a PROPOSED notice in the same status_notice
// jsonb when a platform-critical provider fails consecutive checks. These
// actions are the staff side of that loop: read the pending proposal, publish
// it one-click, or dismiss it. Same gate + audit trail as every notice write.

export async function getStatusNoticeStateAction(): Promise<
  | { ok: true; state: import("@/lib/platform/status-notice").StatusNoticeState }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const { loadStatusNoticeState } = await import("@/lib/platform/status-notice")
  return { ok: true, state: await loadStatusNoticeState(createServiceClient()) }
}

export async function publishProposedStatusNoticeAction(): Promise<
  | { ok: true; notice: import("@/lib/platform/status-notice").StatusNotice }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const { loadStatusNoticeState, saveStatusNotice } = await import("@/lib/platform/status-notice")
  const svc = createServiceClient()
  try {
    const state = await loadStatusNoticeState(svc)
    if (!state.proposed) return { ok: false, error: "No proposed notice to publish — it may have been withdrawn after recovery" }
    const notice = await saveStatusNotice(svc, {
      active: true,
      severity: state.proposed.severity,
      message: state.proposed.message,
      // Same idiom as manual updates: an already-active incident keeps its
      // original start time; a fresh publish starts the clock now.
      startedAt: state.notice.active ? state.notice.startedAt : null,
      clearProposed: true,
    })

    try {
      const hdrs = await headers()
      await svc.from("superadmin_audit_log").insert({
        actor_user_id: auth.userId, actor_email: auth.email,
        action: "status_notice.proposal_published",
        target_type: "platform_settings", target_id: null,
        details: { proposed: state.proposed, before: state.notice, after: notice },
        ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
        user_agent: hdrs.get("user-agent"),
      })
    } catch (err) {
      console.error("[status-notice] audit write failed:", err)
    }
    return { ok: true, notice }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Publish failed" }
  }
}

export async function dismissProposedStatusNoticeAction(): Promise<
  | { ok: true; state: import("@/lib/platform/status-notice").StatusNoticeState }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const { loadStatusNoticeState, clearProposedStatusNotice } = await import("@/lib/platform/status-notice")
  const svc = createServiceClient()
  try {
    const before = await loadStatusNoticeState(svc)
    const state = await clearProposedStatusNotice(svc)

    if (before.proposed) {
      try {
        const hdrs = await headers()
        await svc.from("superadmin_audit_log").insert({
          actor_user_id: auth.userId, actor_email: auth.email,
          action: "status_notice.proposal_dismissed",
          target_type: "platform_settings", target_id: null,
          details: { dismissed: before.proposed },
          ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
          user_agent: hdrs.get("user-agent"),
        })
      } catch (err) {
        console.error("[status-notice] audit write failed:", err)
      }
    }
    return { ok: true, state }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Dismiss failed" }
  }
}

// ── SELF-HEALING POLICY CEILING + HEALING CONSOLE (wave 139, lane 139F) ─────────────────────────
// The platform ceiling (platform_settings.self_healing_ceilings, m753) no tenant `self_healing` policy can exceed
// (lib/kernel/healing-policy.ts — the ONE reader resolves tenant UNDER ceiling), and the per-incident console over
// the healers' own ledger / self_heal_events / proposal rows (lib/kernel/self-heal-ledger.ts loadHealingIncidents).

/** The healing console for platform staff: every tenant's incidents + the current ceiling (sentinel capability). */
export async function getHealingConsoleAction(): Promise<
  | { ok: true; incidents: import("@/lib/kernel/self-heal-ledger").HealingIncident[]; windowDays: number; ceiling: Record<string, unknown> | null; ceilingApplied: boolean; defaults: Record<string, unknown>; actingClasses: string[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden — requires platform 'sentinel' capability" }
  const svc = createServiceClient()
  const { loadHealingIncidents } = await import("@/lib/kernel/self-heal-ledger")
  const { platformScope } = await import("@/lib/kernel/tenant-scope")
  const { loadPlatformHealingCeilings, HEALING_POLICY_DEFAULTS } = await import("@/lib/kernel/healing-policy")
  const { SELF_HEAL_PLAYBOOKS } = await import("@/lib/kernel/self-healing")
  const [inc, ceil] = await Promise.all([
    loadHealingIncidents(svc, platformScope("platform staff healing console — sentinel capability verified")),
    loadPlatformHealingCeilings(svc),
  ])
  if (!inc.ok) return { ok: false, error: inc.error }
  if (!ceil.ok) return { ok: false, error: ceil.error }
  const actingClasses = Object.entries(SELF_HEAL_PLAYBOOKS).filter(([, p]) => p.acts).map(([k]) => k)
  return { ok: true, incidents: inc.incidents, windowDays: inc.windowDays, ceiling: ceil.raw, ceilingApplied: ceil.applied, defaults: { ...HEALING_POLICY_DEFAULTS }, actingClasses }
}

/** Set the platform self-healing ceiling (superadmin only; audited like the god switch). */
export async function setHealingCeilingsAction(input: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { setPlatformHealingCeilings } = await import("@/lib/kernel/healing-policy")
  const { SELF_HEAL_PLAYBOOKS } = await import("@/lib/kernel/self-healing")
  const declared = Object.entries(SELF_HEAL_PLAYBOOKS).filter(([, p]) => p.acts).map(([k]) => k)
  const r = await setPlatformHealingCeilings(svc, input && typeof input === "object" ? input : {}, declared)
  if (!r.ok) return r
  // LAW 5 — who changed the platform ceiling, from what to what.
  try {
    const hdrs = await headers()
    const { error: auditErr } = await svc.from("superadmin_audit_log").insert({
      actor_user_id: auth.userId, actor_email: auth.email,
      action: "self_healing_ceilings.set", target_type: "platform_settings", target_id: null,
      details: { before: r.before, after: r.after },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
    if (auditErr) console.error("[healing-ceilings] audit write refused:", auditErr.message)
  } catch (err) {
    console.error("[healing-ceilings] audit write failed:", err)
  }
  return { ok: true }
}
