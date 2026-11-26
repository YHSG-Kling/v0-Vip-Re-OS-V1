"use server"

// app/actions/superadmin/feature-sunset.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MISSING WRITER for feature_flags.sunset_date (orphan tranche X4,
// 2026-09-01). Three readers gate on the column — lib/kernel/0.1-feature-access.ts
// (:148/:272), lib/entitlements/tenant-capabilities.ts (:127/:174) and the
// superadmin rollout board (app/dashboard/superadmin/rollout/page.tsx renders a
// "sunset" status) — and NOTHING in the tree ever set it: the one feature_flags
// insert (tenant-entitlements.ts ensure-row) omits it and no update touched it.
// Per §1 the missing half is BUILT: a platform-staff deprecate/sunset control.
//
// Gating matches the surface it serves: the rollout board is gated by
// requirePlatformCapability("plans"), so the writer requires the same capability
// WITH write access (platform staff live in platform_role — §4; the capability
// gate resolves that identity through the canonical roster). Audited to
// superadmin_audit_log like every sibling superadmin action.

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function audit(actorUserId: string, action: string, featureKey: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    const h = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email:   (actor as { email?: string } | null)?.email ?? "platform-staff",
      action,
      target_type:   "feature_flag",
      target_id:     featureKey,
      details,
      ip_address:    h.get("x-forwarded-for") ?? h.get("x-real-ip"),
      user_agent:    h.get("user-agent"),
    })
  } catch (err) {
    console.error("[feature-sunset audit] failed:", err)
  }
}

/**
 * Set or clear feature_flags.sunset_date for one flag.
 *
 * `sunsetDate` is a calendar date (yyyy-mm-dd) — the day the flag stops being
 * treated as live by the entitlement readers; null clears a scheduled sunset.
 * The update is COUNTED (§3): a refusal or a feature_key that matches nothing
 * is reported, never rendered as success.
 */
export async function setFeatureSunsetDateAction(params: {
  featureKey: string
  sunsetDate: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const gate = await requirePlatformCapability("plans", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }

  const featureKey = params.featureKey?.trim()
  if (!featureKey) return { ok: false, error: "featureKey required" }

  let sunsetDate: string | null = null
  if (params.sunsetDate != null && params.sunsetDate !== "") {
    // Validate BEFORE writing — a malformed date would be refused by Postgres
    // and supabase-js reports that by resolving, not throwing.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.sunsetDate) || Number.isNaN(new Date(params.sunsetDate).getTime())) {
      return { ok: false, error: "sunsetDate must be a valid yyyy-mm-dd date, or null to clear" }
    }
    sunsetDate = params.sunsetDate
  }

  const svc = createServiceClient()
  const { data: prior, error: readErr } = await svc
    .from("feature_flags")
    .select("feature_key, sunset_date")
    .eq("feature_key", featureKey)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!prior) return { ok: false, error: `Feature flag "${featureKey}" not found` }

  const { data: updated, error } = await svc
    .from("feature_flags")
    .update({ sunset_date: sunsetDate, updated_at: new Date().toISOString() })
    .eq("feature_key", featureKey)
    .select("feature_key")
  if (error) return { ok: false, error: error.message }
  if ((updated ?? []).length === 0) {
    // Zero rows here means the flag vanished between read and write — say so.
    return { ok: false, error: `Feature flag "${featureKey}" was not updated (no matching row)` }
  }

  await audit(gate.userId, sunsetDate ? "feature_flag.sunset_set" : "feature_flag.sunset_cleared", featureKey, {
    old: (prior as { sunset_date?: string | null }).sunset_date ?? null,
    new: sunsetDate,
  })
  revalidatePath("/dashboard/superadmin/rollout")
  return { ok: true }
}
