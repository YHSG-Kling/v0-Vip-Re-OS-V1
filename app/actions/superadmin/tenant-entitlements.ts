"use server"

// app/actions/superadmin/tenant-entitlements.ts
// ─────────────────────────────────────────────────────────────────────────────
// Per-TENANT entitlements from the god console — the platform-only control GHL agencies
// expect: flip a feature for ONE tenant (grant_trial / disable / clear) and grant/revoke
// an AI-token quota override, without touching every other tenant. Reuses the existing
// engines' data model exactly — feature_access_overrides (canonical override_type vocab
// via normalizeOverrideType), ai_quota_overrides (status='approved', summed by fair-use),
// v_brokerage_ai_quota (live usage). Writes go through the service client (cross-tenant),
// superadmin-gated + audited to superadmin_audit_log. No parallel tables.

import { createServiceClient } from "@/lib/supabase/service"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { normalizeOverrideType } from "@/lib/kernel/override-vocab"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

const TIER_ACCESS_COL: Record<string, string> = {
  solo_agent: "solo_agent_access",
  team: "team_access",
  brokerage: "brokerage_access",
  multi_location: "multi_location_access",
}

async function audit(actorUserId: string, actorEmail: string, action: string, brokerageId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const h = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "brokerage", target_id: brokerageId,
      details, ip_address: h.get("x-forwarded-for") ?? h.get("x-real-ip"), user_agent: h.get("user-agent"),
    })
  } catch (err) { console.error("[tenant-entitlements audit] failed:", err) }
}

export interface TenantFeatureRow {
  featureKey: string
  displayName: string
  category: string
  superadminOnly: boolean
  tierDefault: boolean
  override: "grant_trial" | "disable" | null
  trialEndsAt: string | null
}
export interface TenantQuotaGrant { id: string; extraTokens: number; reason: string; effectiveUntil: string | null; approvedAt: string | null }
export interface TenantEntitlements {
  tier: string | null
  features: TenantFeatureRow[]
  quota: { used: number; limit: number; percent: number; status: string }
  grants: TenantQuotaGrant[]
}

export async function getTenantEntitlementsAction(brokerageId: string): Promise<{ ok: true; data: TenantEntitlements } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!brokerageId) return { ok: false, error: "Brokerage required" }
  const svc = createServiceClient()

  const { data: brk } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
  const tier = (brk as any)?.plan_tier ?? null
  const accessCol = TIER_ACCESS_COL[tier ?? ""] ?? "brokerage_access"

  const [{ data: flags }, { data: overrides }, { data: quota }, { data: grants }] = await Promise.all([
    svc.from("feature_flags").select("feature_key, display_name, category, superadmin_only, solo_agent_access, team_access, brokerage_access, multi_location_access")
      .eq("enabled", true).eq("deprecated", false).order("category").order("display_name").limit(500),
    svc.from("feature_access_overrides").select("feature_key, override_type, trial_ends_at").eq("brokerage_id", brokerageId).is("user_id", null).is("team_id", null),
    svc.from("v_brokerage_ai_quota").select("tokens_used, token_limit, percent_used, quota_status").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("ai_quota_overrides").select("id, extra_tokens, reason, effective_until, approved_at").eq("brokerage_id", brokerageId).eq("status", "approved").order("approved_at", { ascending: false }).limit(50),
  ])

  const overrideByKey = new Map<string, { type: string; trialEndsAt: string | null }>()
  for (const o of (overrides ?? []) as any[]) overrideByKey.set(o.feature_key, { type: o.override_type, trialEndsAt: o.trial_ends_at })

  const features: TenantFeatureRow[] = ((flags ?? []) as any[]).map((f) => {
    const ov = overrideByKey.get(f.feature_key)
    return {
      featureKey: f.feature_key, displayName: f.display_name, category: f.category, superadminOnly: !!f.superadmin_only,
      tierDefault: !!f[accessCol],
      override: ov ? normalizeOverrideType(ov.type) : null,
      trialEndsAt: ov?.trialEndsAt ?? null,
    }
  })

  return {
    ok: true,
    data: {
      tier, features,
      quota: {
        used: Number((quota as any)?.tokens_used ?? 0),
        limit: Number((quota as any)?.token_limit ?? -1),
        percent: Number((quota as any)?.percent_used ?? 0),
        status: (quota as any)?.quota_status ?? "ok",
      },
      grants: ((grants ?? []) as any[]).map((g) => ({ id: g.id, extraTokens: Number(g.extra_tokens), reason: g.reason, effectiveUntil: g.effective_until, approvedAt: g.approved_at })),
    },
  }
}

/** Flip a feature for ONE tenant: grant_trial / disable / clear (brokerage-scoped only). */
export async function setTenantFeatureOverrideAction(params: {
  brokerageId: string
  featureKey: string
  action: "grant_trial" | "disable" | "clear"
  trialDays?: number
  reason?: string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!params.brokerageId || !params.featureKey) return { ok: false, error: "Brokerage + feature required" }
  const svc = createServiceClient()

  // Replace any existing BROKERAGE-scoped override for this feature (never touches user/team scope).
  await svc.from("feature_access_overrides").delete()
    .eq("brokerage_id", params.brokerageId).eq("feature_key", params.featureKey).is("user_id", null).is("team_id", null)

  if (params.action !== "clear") {
    const kind = normalizeOverrideType(params.action)
    if (!kind) return { ok: false, error: "Invalid override action" }
    const trialEndsAt = kind === "grant_trial"
      ? new Date(Date.now() + (params.trialDays ?? 30) * 86_400_000).toISOString()
      : null
    const { error } = await svc.from("feature_access_overrides").insert({
      brokerage_id: params.brokerageId, feature_key: params.featureKey, override_type: kind,
      trial_ends_at: trialEndsAt, disabled_reason: kind === "disable" ? (params.reason ?? null) : null,
      created_by: auth.userId, notes: params.reason ?? null,
    })
    if (error) return { ok: false, error: error.message }
  }

  await audit(auth.userId, auth.email, `entitlement.feature.${params.action}`, params.brokerageId, { feature_key: params.featureKey, trial_days: params.trialDays ?? null, reason: params.reason ?? null })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  return { ok: true }
}

/** Grant an AI-token quota override to a tenant (approved immediately — fair-use sums approved rows). */
export async function grantTenantQuotaAction(params: {
  brokerageId: string
  extraTokens: number
  days?: number
  reason: string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!params.brokerageId) return { ok: false, error: "Brokerage required" }
  if (!Number.isFinite(params.extraTokens) || params.extraTokens <= 0) return { ok: false, error: "extraTokens must be a positive number" }
  if (!params.reason?.trim()) return { ok: false, error: "A reason is required (audited)" }
  const svc = createServiceClient()

  const effectiveUntil = params.days && params.days > 0 ? new Date(Date.now() + params.days * 86_400_000).toISOString() : null
  const { error } = await svc.from("ai_quota_overrides").insert({
    brokerage_id: params.brokerageId, requested_by: auth.userId, approved_by: auth.userId,
    extra_tokens: Math.floor(params.extraTokens), reason: params.reason.trim(), status: "approved",
    effective_until: effectiveUntil, approved_at: new Date().toISOString(),
  })
  if (error) return { ok: false, error: error.message }

  await audit(auth.userId, auth.email, "entitlement.quota.grant", params.brokerageId, { extra_tokens: Math.floor(params.extraTokens), days: params.days ?? null, reason: params.reason.trim() })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  return { ok: true }
}

/** Revoke a previously-granted quota override (stops counting immediately). */
export async function revokeTenantQuotaAction(overrideId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: row } = await svc.from("ai_quota_overrides").select("brokerage_id").eq("id", overrideId).maybeSingle()
  if (!row) return { ok: false, error: "Override not found" }
  // status CHECK: pending|approved|denied|expired — 'expired' drops it from fair-use's
  // approved-sum immediately; also stamp effective_until so any legacy reader stops counting it.
  const { error } = await svc.from("ai_quota_overrides").update({ status: "expired", effective_until: new Date().toISOString() }).eq("id", overrideId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "entitlement.quota.revoke", (row as any).brokerage_id, { override_id: overrideId })
  revalidatePath(`/dashboard/superadmin/brokerages/${(row as any).brokerage_id}`)
  return { ok: true }
}
