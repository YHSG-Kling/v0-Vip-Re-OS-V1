"use server"

// app/actions/superadmin/platform-controls.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin god-switch actions — read + flip the platform_settings singleton (emergency mode / AI engine /
// global rate limit). Every mutation is superadmin-gated and written to superadmin_audit_log with IP + UA.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { getPlatformControls, setPlatformControls, type PlatformControls } from "@/lib/platform/platform-controls"

async function requireSuperadmin(): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const isSuper = (data as any)?.user_type === "superadmin" || (data as any)?.platform_role === "superadmin"
  if (!isSuper) return { ok: false, error: "Forbidden — superadmin only" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

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
