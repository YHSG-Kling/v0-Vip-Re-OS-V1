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
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { normalizeOverrideType } from "@/lib/kernel/override-vocab"
import { parseSeatOverride, seatLimitForTier, effectiveSeatLimit, SEAT_ROLES } from "@/lib/kernel/tier-role-matrix"
import { TENANT_AUTONOMY_FEATURE_KEY, loadTenantAutonomyHalt, __clearAutonomyCache } from "@/lib/managers/autonomy-gate"
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
export interface TenantSeatInfo {
  /** Active seat-role users right now. */
  inUse: number
  /** The tier's default seat limit (null = unlimited). */
  tierLimit: number | null
  /** Staff-set per-tenant override (billing_metadata.seat_override); null = tier default. */
  override: number | null
  /** The keep-one resolved limit the invite gates enforce (override ?? tier). */
  effectiveLimit: number | null
}
export interface TenantEntitlements {
  tier: string | null
  features: TenantFeatureRow[]
  quota: { used: number; limit: number; percent: number; status: string }
  grants: TenantQuotaGrant[]
  seats: TenantSeatInfo
}

export async function getTenantEntitlementsAction(brokerageId: string): Promise<{ ok: true; data: TenantEntitlements } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!brokerageId) return { ok: false, error: "Brokerage required" }
  const svc = createServiceClient()

  const { data: brk } = await svc.from("brokerages").select("plan_tier, billing_metadata").eq("id", brokerageId).maybeSingle()
  const tier = (brk as any)?.plan_tier ?? null
  const accessCol = TIER_ACCESS_COL[tier ?? ""] ?? "brokerage_access"

  const [{ data: flags }, { data: overrides }, { data: quota }, { data: grants }, { count: seatCount }] = await Promise.all([
    svc.from("feature_flags").select("feature_key, display_name, category, superadmin_only, solo_agent_access, team_access, brokerage_access, multi_location_access")
      .eq("enabled", true).eq("deprecated", false).order("category").order("display_name").limit(500),
    svc.from("feature_access_overrides").select("feature_key, override_type, trial_ends_at").eq("brokerage_id", brokerageId).is("user_id", null).is("team_id", null),
    svc.from("v_brokerage_ai_quota").select("tokens_used, token_limit, percent_used, quota_status").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("ai_quota_overrides").select("id, extra_tokens, reason, effective_until, approved_at").eq("brokerage_id", brokerageId).eq("status", "approved").order("approved_at", { ascending: false }).limit(50),
    // Same seat definition the invite gates enforce: active SEAT_ROLES users.
    svc.from("users").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
      .in("user_type", SEAT_ROLES as unknown as string[]).neq("status", "suspended"),
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
      seats: (() => {
        const override = parseSeatOverride((brk as any)?.billing_metadata)
        return {
          inUse: seatCount ?? 0,
          tierLimit: seatLimitForTier(tier),
          override,
          effectiveLimit: effectiveSeatLimit(tier, override).limit,
        }
      })(),
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

// ─────────────────────────────────────────────────────────────────────────────
// PER-TENANT AUTONOMY HALT (cert blocker #3) — the staff lever between the platform god switch and
// the tenant's own broker-set posture. Stored as a brokerage-scoped feature_access_overrides
// 'disable' on the 'autonomy' feature key — the one brokerage-anchored kill the tenant cannot
// silently clear (no tenant-side write path exists to that table; managed_agents.config and the
// brokerages row are tenant-writable). Enforced by resolveManagerAutonomy at the exact same hook
// point as the global halt: autonomous manager sends are held; human-approved sends unaffected.

/** Resolve the acting platform-staff email for the audit ledger. */
async function staffEmail(svc: ReturnType<typeof createServiceClient>, userId: string): Promise<string> {
  const { data } = await svc.from("users").select("email").eq("id", userId).maybeSingle()
  return (data as any)?.email ?? "platform-staff"
}

export interface TenantAutonomyState { halted: boolean; reason: string | null; haltedAt: string | null }

export async function getTenantAutonomyStateAction(brokerageId: string): Promise<{ ok: true; data: TenantAutonomyState } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!brokerageId) return { ok: false, error: "Brokerage required" }
  __clearAutonomyCache() // staff console reads must be live, never the 20s gate cache
  const halt = await loadTenantAutonomyHalt(brokerageId, createServiceClient())
  return { ok: true, data: { halted: halt.halted, reason: halt.reason, haltedAt: halt.haltedAt } }
}

/** Halt (or resume) ALL autonomous AI manager sends for ONE tenant. Reason required — it is
 *  audited AND shown to the tenant on their Command Center banner. */
export async function setTenantAutonomyHaltAction(params: {
  brokerageId: string
  halt: boolean
  reason: string
}): Promise<{ ok: boolean; error?: string }> {
  const gate = await requirePlatformCapability("tenants", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!params.brokerageId) return { ok: false, error: "Brokerage required" }
  const reason = params.reason?.trim()
  if (!reason) return { ok: false, error: "A reason is required (audited + shown to the tenant)" }
  const svc = createServiceClient()

  // Replace any existing BROKERAGE-scoped 'autonomy' override (never touches user/team scope).
  const { error: delErr } = await svc.from("feature_access_overrides").delete()
    .eq("brokerage_id", params.brokerageId).eq("feature_key", TENANT_AUTONOMY_FEATURE_KEY)
    .is("user_id", null).is("team_id", null)
  if (delErr) return { ok: false, error: delErr.message }

  if (params.halt) {
    // Ensure the 'autonomy' feature key exists in feature_flags (FK-safe + shows honestly in the
    // feature matrix). It is enabled for every tier by default — only the override kills it.
    const { data: flag } = await svc.from("feature_flags").select("feature_key").eq("feature_key", TENANT_AUTONOMY_FEATURE_KEY).maybeSingle()
    if (!flag) {
      await svc.from("feature_flags").insert({
        feature_key: TENANT_AUTONOMY_FEATURE_KEY,
        display_name: "Autonomous AI managers",
        description: "Unattended AI manager sends (the autonomous dispatch path). Disabling this for a tenant halts their autonomy; approved/human sends are unaffected.",
        category: "governance",
        enabled: true, superadmin_only: false,
        solo_agent_access: true, team_access: true, brokerage_access: true, multi_location_access: true,
      })
    }
    const { error } = await svc.from("feature_access_overrides").insert({
      brokerage_id: params.brokerageId, feature_key: TENANT_AUTONOMY_FEATURE_KEY, override_type: "disable",
      disabled_reason: reason, created_by: gate.userId, notes: reason,
    })
    if (error) return { ok: false, error: error.message }
  }

  // In-process caches drop now; other instances converge within the gate's 20s TTL.
  __clearAutonomyCache()

  await audit(gate.userId, await staffEmail(svc, gate.userId), params.halt ? "tenant.autonomy_halted" : "tenant.autonomy_resumed", params.brokerageId, { reason })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/admin/command-center")
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-TENANT SEAT OVERRIDE (cert blocker #4) — staff-set integer on
// brokerages.billing_metadata.seat_override (null = tier default). Read by the SAME keep-one
// resolution (effectiveSeatLimit) the invite gates and the seat meter use: override wins when set.

/** Set (integer ≥ 0) or clear (null) the per-tenant seat override. Audited with old/new. */
export async function setTenantSeatOverrideAction(params: {
  brokerageId: string
  seatOverride: number | null
  reason: string
}): Promise<{ ok: boolean; error?: string }> {
  const gate = await requirePlatformCapability("tenants", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!params.brokerageId) return { ok: false, error: "Brokerage required" }
  if (params.seatOverride !== null && (!Number.isInteger(params.seatOverride) || params.seatOverride < 0)) {
    return { ok: false, error: "Seat override must be a whole number ≥ 0, or null to restore the tier default" }
  }
  const reason = params.reason?.trim()
  if (!reason) return { ok: false, error: "A reason is required (audited)" }
  const svc = createServiceClient()

  const { data: brk, error: brkErr } = await svc.from("brokerages").select("plan_tier, billing_metadata").eq("id", params.brokerageId).maybeSingle()
  if (brkErr) return { ok: false, error: brkErr.message }
  if (!brk) return { ok: false, error: "Brokerage not found" }

  const bm = (brk as any).billing_metadata
  const old = parseSeatOverride(bm)
  const next: Record<string, unknown> = { ...(bm && typeof bm === "object" ? bm : {}) }
  if (params.seatOverride === null) delete next.seat_override
  else next.seat_override = params.seatOverride

  const { error } = await svc.from("brokerages").update({ billing_metadata: next, updated_at: new Date().toISOString() }).eq("id", params.brokerageId)
  if (error) return { ok: false, error: error.message }

  await audit(gate.userId, await staffEmail(svc, gate.userId), "tenant.seat_override_set", params.brokerageId, {
    old, new: params.seatOverride, tier_default: seatLimitForTier((brk as any).plan_tier), reason,
  })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/admin/users")
  return { ok: true }
}
