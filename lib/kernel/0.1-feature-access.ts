// lib/kernel/0.1-feature-access.ts
// LAYER 0.1 — tier gating and feature access resolution.
// Runs before any application logic. No side effects except DB writes
// in incrementFeatureUsage, grantFeatureTrial, and disableFeatureFor.
// canAccessFeature is read-only.

import { createClient } from "@/lib/supabase/server"
import type { UserTier, FeatureAccessCheck } from "./types"
import { resolveEntitlement, rolloutBucket } from "@/lib/entitlements/resolve"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type { UserTier, FeatureAccessCheck }

// ─── TIER MAP ─────────────────────────────────────────────────────────────────

const USER_TYPE_TO_TIER: Record<string, UserTier> = {
  solo_agent: "solo_agent",
  agent: "solo_agent",
  team_lead: "team",
  team_member: "team",
  broker: "brokerage",
  broker_admin: "brokerage",
  admin: "brokerage",
  multi_location: "multi_location",
  superadmin: "multi_location",
}

/**
 * Maps a user_type string (from users.user_type) to a billing UserTier.
 * If brokerageId + teamId are provided, team takes priority over brokerage.
 */
export function mapUserTypeToTier(
  userType: string,
  brokerageId?: string,
  teamId?: string
): UserTier {
  // If they have a team, they're on the team tier regardless of user_type
  if (teamId && brokerageId) return "team"
  // If they have a brokerage but no team, brokerage tier
  if (brokerageId && !teamId) {
    const mapped = USER_TYPE_TO_TIER[userType]
    if (mapped === "solo_agent") return "brokerage"
    return mapped ?? "brokerage"
  }
  return USER_TYPE_TO_TIER[userType] ?? "solo_agent"
}

// ─── ACCESS COLUMN MAP ────────────────────────────────────────────────────────

const TIER_ACCESS_COLUMN: Record<UserTier, keyof FeatureFlagRow> = {
  solo_agent: "solo_agent_access",
  team: "team_access",
  brokerage: "brokerage_access",
  multi_location: "multi_location_access",
}

const TIER_LIMIT_COLUMN: Record<UserTier, keyof FeatureFlagRow> = {
  solo_agent: "solo_agent_limit",
  team: "team_limit",
  brokerage: "brokerage_limit",
  multi_location: "multi_location_limit",
}

// Internal shape from feature_flags table
interface FeatureFlagRow {
  feature_key: string
  enabled: boolean
  superadmin_only: boolean
  solo_agent_access: boolean
  team_access: boolean
  brokerage_access: boolean
  multi_location_access: boolean
  solo_agent_limit: number | null
  team_limit: number | null
  brokerage_limit: number | null
  multi_location_limit: number | null
  beta: boolean
  deprecated: boolean
  sunset_date: string | null
  rollout_percentage: number | null
}

// ─── canAccessFeature ─────────────────────────────────────────────────────────

/**
 * Full feature gate check — read-only, no side effects.
 * Order of checks:
 *   1. Feature exists + is enabled
 *   2. Not deprecated / sunsetted
 *   3. superadmin_only gate
 *   4. Rollout cohort (percentage rollout, deterministic per-tenant bucket)
 *   5. Trial override (granted early access, may have expiry — can pull a
 *      tenant into a partial rollout)
 *   6. Disabled override (explicit disable for scope)
 *   7. Tier access check
 *   8. Usage limit check (current billing period)
 */
export async function canAccessFeature(
  userId: string,
  featureKey: string,
  userTier?: UserTier
): Promise<FeatureAccessCheck> {
  const supabase = await createClient()

  // ── 1. Load feature flag ───────────────────────────────────────────────────
  const { data: flagRaw, error: flagError } = await supabase
    .from("feature_flags")
    .select(
      "feature_key, enabled, superadmin_only, solo_agent_access, team_access, " +
      "brokerage_access, multi_location_access, solo_agent_limit, team_limit, " +
      "brokerage_limit, multi_location_limit, beta, deprecated, sunset_date, rollout_percentage"
    )
    .eq("feature_key", featureKey)
    .maybeSingle()

  if (flagError) throw new Error(`[FeatureAccess] Failed to load feature_flag: ${flagError.message}`)
  const flag = flagRaw as FeatureFlagRow | null

  // ── Resolve user tier (+ superadmin proxy) ─────────────────────────────────
  let resolvedTier = userTier
  let isSuperadmin = resolvedTier === "multi_location"
  if (!resolvedTier) {
    const { data: user, error: userError } = await supabase
      .from("users").select("user_type, team_id, brokerage_id, platform_role").eq("id", userId).maybeSingle()
    if (userError) throw new Error(`[FeatureAccess] Failed to load user: ${userError.message}`)
    if (!user) return { allowed: false, reason: "User not found" }
    resolvedTier = mapUserTypeToTier(user.user_type, user.brokerage_id, user.team_id)
    isSuperadmin = user.user_type === "superadmin" || (user as any).platform_role === "superadmin"
  }

  // ── Platform hard rule (god-switch) — the highest-precedence gate. Superadmins
  //    are exempt; a read error fails OPEN so a monitoring blip can't lock features. ──
  let platformHalt: { blocked: boolean; reason?: string } | null = null
  try {
    if (!isSuperadmin) {
      const { loadPlatformHalt } = await import("@/lib/platform/platform-controls")
      const halt = await loadPlatformHalt()
      if (halt.halted) platformHalt = { blocked: true, reason: halt.reason ?? "Platform is temporarily paused" }
    }
  } catch { /* fail-open */ }

  // ── Most-specific override (user → team → brokerage) ──────────────────────
  let override: { type: string | null; trialEndsAt: string | null; disabledReason: string | null } | null = null
  if (flag) {
    const { data: overrides, error: overrideError } = await supabase
      .from("feature_access_overrides")
      .select("override_type, trial_ends_at, disabled_reason, user_id, team_id, brokerage_id")
      .eq("feature_key", featureKey)
      .or(`user_id.eq.${userId},team_id.not.is.null,brokerage_id.not.is.null`)
      .order("created_at", { ascending: false })
    if (overrideError) throw new Error(`[FeatureAccess] Failed to load overrides: ${overrideError.message}`)
    const o = overrides?.find((x) => x.user_id === userId) ?? overrides?.[0] ?? null
    if (o) override = { type: o.override_type, trialEndsAt: o.trial_ends_at, disabledReason: o.disabled_reason }
  }

  // ── Tier access + limit columns → usage (only when a limit applies) ────────
  const tierHasAccess = flag ? ((flag as unknown as Record<string, unknown>)[TIER_ACCESS_COLUMN[resolvedTier]] as boolean) : false
  const tierLimit = flag ? ((flag as unknown as Record<string, unknown>)[TIER_LIMIT_COLUMN[resolvedTier]] as number | null) : null
  let usageCurrent = 0
  if (flag && tierLimit !== null) {
    const periodStart = new Date(); periodStart.setDate(1); periodStart.setHours(0, 0, 0, 0)
    const { data: usage, error: usageError } = await supabase
      .from("feature_usage_tracking")
      .select("usage_count, period_start")
      .eq("feature_key", featureKey).eq("user_id", userId)
      .gte("period_start", periodStart.toISOString().slice(0, 10)).maybeSingle()
    if (usageError) throw new Error(`[FeatureAccess] Failed to load usage: ${usageError.message}`)
    usageCurrent = usage?.usage_count ?? 0
  }

  // ── Rollout cohort bucket (only computed when the flag is partially rolled out).
  //    The bucket keys on the TENANT (brokerage) so a whole office flips together;
  //    a user with no brokerage buckets on their own id. ──
  let bucket: number | null = null
  if (flag && flag.rollout_percentage != null && flag.rollout_percentage < 100 && !isSuperadmin) {
    const { data: u2 } = await supabase.from("users").select("brokerage_id").eq("id", userId).maybeSingle()
    bucket = rolloutBucket(featureKey, (u2 as any)?.brokerage_id ?? userId)
  }

  // ── ONE resolution order (lib/entitlements/resolve.ts) ─────────────────────
  return resolveEntitlement({
    platformHalt,
    flag: flag ? {
      enabled: flag.enabled, deprecated: flag.deprecated, sunsetDate: flag.sunset_date,
      superadminOnly: flag.superadmin_only, tierHasAccess, tierLimit,
      rolloutPercentage: flag.rollout_percentage,
    } : null,
    isSuperadmin,
    rolloutBucket: bucket,
    override,
    usageCurrent,
    tier: resolvedTier,
  })
}

// ─── incrementFeatureUsage ────────────────────────────────────────────────────

/**
 * Increments the usage counter for the current billing period.
 * Upserts a tracking row if one doesn't exist yet.
 * Call this AFTER the feature action succeeds, not before.
 */
export async function incrementFeatureUsage(
  userId: string,
  featureKey: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const now = new Date()
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10)
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10)

  // Resolve user context for team/brokerage association
  const { data: user } = await supabase
    .from("users")
    .select("team_id, brokerage_id")
    .eq("id", userId)
    .maybeSingle()

  // Try to find existing row for this user + feature + period
  const { data: existing } = await supabase
    .from("feature_usage_tracking")
    .select("id, usage_count, limit_amount")
    .eq("feature_key", featureKey)
    .eq("user_id", userId)
    .eq("period_start", periodStart)
    .maybeSingle()

  if (existing) {
    const newCount = (existing.usage_count ?? 0) + 1
    const exceeded = existing.limit_amount !== null && newCount >= existing.limit_amount

    const { error } = await supabase
      .from("feature_usage_tracking")
      .update({
        usage_count: newCount,
        exceeded,
        last_incremented: now.toISOString(),
      })
      .eq("id", existing.id)

    if (error) return { success: false, error: error.message }
    return { success: true }
  }

  // No row yet — insert fresh
  const { error } = await supabase.from("feature_usage_tracking").insert({
    user_id: userId,
    team_id: user?.team_id ?? null,
    brokerage_id: user?.brokerage_id ?? null,
    feature_key: featureKey,
    usage_count: 1,
    limit_amount: null, // will be reconciled next canAccessFeature call
    exceeded: false,
    period_start: periodStart,
    period_end: periodEnd,
    last_incremented: now.toISOString(),
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── grantFeatureTrial ────────────────────────────────────────────────────────

/**
 * Superadmin only — grants temporary trial access for a user.
 * Does NOT validate that caller is superadmin; that is the caller's responsibility.
 */
export async function grantFeatureTrial(
  userId: string,
  featureKey: string,
  trialDaysFromNow: number,
  createdByUserId: string,
  notes?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const trialEndsAt = new Date()
  trialEndsAt.setDate(trialEndsAt.getDate() + trialDaysFromNow)

  // Remove any existing disabled override so the trial takes effect
  await supabase
    .from("feature_access_overrides")
    .delete()
    .eq("feature_key", featureKey)
    .eq("user_id", userId)
    .eq("override_type", "disable")

  const { error } = await supabase.from("feature_access_overrides").insert({
    user_id: userId,
    feature_key: featureKey,
    override_type: "grant_trial",
    trial_ends_at: trialEndsAt.toISOString(),
    created_by: createdByUserId,
    notes: notes ?? null,
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── disableFeatureFor ────────────────────────────────────────────────────────

/**
 * Superadmin only — disables a feature for a specific scope (user, team, or brokerage).
 * At least one of userId, brokerageId, or teamId must be provided.
 * Does NOT validate that caller is superadmin; that is the caller's responsibility.
 */
export async function disableFeatureFor(
  featureKey: string,
  userId?: string,
  brokerageId?: string,
  teamId?: string,
  disabledReason?: string,
  createdByUserId?: string
): Promise<{ success: boolean; error?: string }> {
  if (!userId && !brokerageId && !teamId) {
    return { success: false, error: "At least one scope (userId, brokerageId, teamId) is required" }
  }

  const supabase = await createClient()

  // Remove any existing trial override so disable takes immediate effect
  const deleteQuery = supabase
    .from("feature_access_overrides")
    .delete()
    .eq("feature_key", featureKey)
    .eq("override_type", "grant_trial")

  if (userId) deleteQuery.eq("user_id", userId)
  else if (teamId) deleteQuery.eq("team_id", teamId)
  else if (brokerageId) deleteQuery.eq("brokerage_id", brokerageId)

  await deleteQuery

  const { error } = await supabase.from("feature_access_overrides").insert({
    feature_key: featureKey,
    user_id: userId ?? null,
    brokerage_id: brokerageId ?? null,
    team_id: teamId ?? null,
    override_type: "disable",
    disabled_reason: disabledReason ?? null,
    created_by: createdByUserId ?? null,
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
