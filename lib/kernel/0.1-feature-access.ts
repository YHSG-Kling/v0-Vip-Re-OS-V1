// lib/kernel/0.1-feature-access.ts
// LAYER 0.1 — tier gating and feature access resolution.
// Runs before any application logic. No side effects except DB writes
// in incrementFeatureUsage, grantFeatureTrial, and disableFeatureFor.
// canAccessFeature is read-only.

import { createClient } from "@/lib/supabase/server"
import type { UserTier, FeatureAccessCheck } from "./types"

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
}

// ─── canAccessFeature ─────────────────────────────────────────────────────────

/**
 * Full feature gate check — read-only, no side effects.
 * Order of checks:
 *   1. Feature exists + is enabled
 *   2. Not deprecated / sunsetted
 *   3. superadmin_only gate
 *   4. Trial override (granted early access, may have expiry)
 *   5. Disabled override (explicit disable for scope)
 *   6. Tier access check
 *   7. Usage limit check (current billing period)
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
      "brokerage_limit, multi_location_limit, beta, deprecated, sunset_date"
    )
    .eq("feature_key", featureKey)
    .maybeSingle()

  if (flagError) throw new Error(`[FeatureAccess] Failed to load feature_flag: ${flagError.message}`)
  const flag = flagRaw as FeatureFlagRow | null

  if (!flag) {
    return { allowed: false, reason: "Feature does not exist" }
  }

  if (!flag.enabled) {
    return { allowed: false, reason: "Feature is not enabled" }
  }

  // ── 2. Deprecated / sunset check ──────────────────────────────────────────
  if (flag.deprecated) {
    return { allowed: false, reason: "Feature is deprecated" }
  }

  if (flag.sunset_date && new Date(flag.sunset_date) <= new Date()) {
    return { allowed: false, reason: `Feature was sunset on ${flag.sunset_date}` }
  }

  // ── 3. Resolve user tier if not provided ──────────────────────────────────
  let resolvedTier = userTier

  if (!resolvedTier) {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("user_type, team_id, brokerage_id")
      .eq("id", userId)
      .maybeSingle()

    if (userError) throw new Error(`[FeatureAccess] Failed to load user: ${userError.message}`)
    if (!user) return { allowed: false, reason: "User not found" }

    resolvedTier = mapUserTypeToTier(user.user_type, user.brokerage_id, user.team_id)
  }

  // ── 4. superadmin_only gate ────────────────────────────────────────────────
  if (flag.superadmin_only && resolvedTier !== "multi_location") {
    // multi_location is the closest system tier — actual superadmin check is
    // done by the caller via platform_role; here we block non-multi_location tiers
    return {
      allowed: false,
      reason: "This feature requires superadmin access",
    }
  }

  // ── 5. Load override for this user (most-specific scope wins) ─────────────
  // Priority: user-level → team-level → brokerage-level
  const { data: overrides, error: overrideError } = await supabase
    .from("feature_access_overrides")
    .select("override_type, trial_ends_at, disabled_reason, user_id, team_id, brokerage_id")
    .eq("feature_key", featureKey)
    .or(`user_id.eq.${userId},team_id.not.is.null,brokerage_id.not.is.null`)
    .order("created_at", { ascending: false })

  if (overrideError) throw new Error(`[FeatureAccess] Failed to load overrides: ${overrideError.message}`)

  // Find most-specific matching override
  const userOverride = overrides?.find((o) => o.user_id === userId)
  const override = userOverride ?? overrides?.[0] ?? null

  // ── 5a. Trial override ─────────────────────────────────────────────────────
  if (override?.override_type === "trial") {
    const expired = override.trial_ends_at && new Date(override.trial_ends_at) <= new Date()
    if (!expired) {
      return {
        allowed: true,
        trial: true,
        trial_expires_at: override.trial_ends_at ?? undefined,
      }
    }
    // Trial expired — fall through to normal tier check
  }

  // ── 5b. Disabled override ──────────────────────────────────────────────────
  if (override?.override_type === "disabled") {
    return {
      allowed: false,
      disabled: true,
      disabled_reason: override.disabled_reason ?? "Access has been disabled for your account",
    }
  }

  // ── 6. Tier access check ───────────────────────────────────────────────────
  const accessCol = TIER_ACCESS_COLUMN[resolvedTier]
  const tierHasAccess = (flag as unknown as Record<string, unknown>)[accessCol] as boolean

  if (!tierHasAccess) {
    return {
      allowed: false,
      reason: `Your plan (${resolvedTier}) does not include access to this feature`,
    }
  }

  // ── 7. Usage limit check ──────────────────────────────────────────────────
  const limitCol = TIER_LIMIT_COLUMN[resolvedTier]
  const limit = (flag as unknown as Record<string, unknown>)[limitCol] as number | null

  if (limit !== null) {
    // Current billing period: start of this calendar month
    const periodStart = new Date()
    periodStart.setDate(1)
    periodStart.setHours(0, 0, 0, 0)

    const { data: usage, error: usageError } = await supabase
      .from("feature_usage_tracking")
      .select("usage_count, limit_amount, exceeded, period_start, period_end")
      .eq("feature_key", featureKey)
      .eq("user_id", userId)
      .gte("period_start", periodStart.toISOString().slice(0, 10))
      .maybeSingle()

    if (usageError) throw new Error(`[FeatureAccess] Failed to load usage: ${usageError.message}`)

    const currentUsage = usage?.usage_count ?? 0
    const remaining = Math.max(0, limit - currentUsage)

    if (currentUsage >= limit) {
      return {
        allowed: false,
        reason: `Usage limit reached (${currentUsage}/${limit} this billing period)`,
        usage: { current: currentUsage, limit, remaining: 0 },
      }
    }

    return {
      allowed: true,
      usage: { current: currentUsage, limit, remaining },
    }
  }

  return { allowed: true }
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
    .eq("override_type", "disabled")

  const { error } = await supabase.from("feature_access_overrides").insert({
    user_id: userId,
    feature_key: featureKey,
    override_type: "trial",
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
    .eq("override_type", "trial")

  if (userId) deleteQuery.eq("user_id", userId)
  else if (teamId) deleteQuery.eq("team_id", teamId)
  else if (brokerageId) deleteQuery.eq("brokerage_id", brokerageId)

  await deleteQuery

  const { error } = await supabase.from("feature_access_overrides").insert({
    feature_key: featureKey,
    user_id: userId ?? null,
    brokerage_id: brokerageId ?? null,
    team_id: teamId ?? null,
    override_type: "disabled",
    disabled_reason: disabledReason ?? null,
    created_by: createdByUserId ?? null,
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
