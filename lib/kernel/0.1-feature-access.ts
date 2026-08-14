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
    if (!user) {
      // TENANT-ID FALLBACK — some rails (competitor monitor ingest/insights) gate
      // by the TENANT, passing a brokerages.id here. Tier is a tenant property, so
      // resolve it from brokerages.plan_tier instead of hard-failing "User not
      // found" (which silently killed those features for every tier).
      const { data: brkAsId } = await supabase
        .from("brokerages").select("plan_tier").eq("id", userId).maybeSingle()
      const bt = (brkAsId as { plan_tier?: string } | null)?.plan_tier
      if (bt === "solo_agent" || bt === "team" || bt === "brokerage" || bt === "multi_location") {
        resolvedTier = bt
      } else if (brkAsId) {
        resolvedTier = "brokerage" // legacy/unbackfilled tenant — pre-matrix behavior
      } else {
        return { allowed: false, reason: "User not found" }
      }
      isSuperadmin = false
    } else {
    resolvedTier = mapUserTypeToTier(user.user_type, user.brokerage_id, user.team_id)
    isSuperadmin = user.user_type === "superadmin" || (user as any).platform_role === "superadmin"
    // BILLED-TIER TRUTH: the tenant's brokerages.plan_tier is what the customer
    // pays for — it wins over user_type inference. Without this, a solo_agent
    // tenant's owner (user_type='admin') was gated by the *brokerage* columns and
    // a brokerage tenant's team members were gated by the *team* columns (wrong
    // access + wrong per-tier limits). Inference remains the legacy fallback for
    // unbackfilled/unknown plan_tier values.
    if (!isSuperadmin && user.brokerage_id) {
      const { data: brk } = await supabase
        .from("brokerages").select("plan_tier").eq("id", user.brokerage_id).maybeSingle()
      const planTier = (brk as { plan_tier?: string } | null)?.plan_tier
      if (planTier === "solo_agent" || planTier === "team" || planTier === "brokerage" || planTier === "multi_location") {
        resolvedTier = planTier
      }
    }
    }
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
    // MOST-SPECIFIC-FIRST, AND NEVER SOMEBODY ELSE'S ROW. A user-scoped override
    // carries a brokerage_id too (that is what makes it visible to the tenant's
    // governance screen — see grantFeatureTrial / feature-governance-client), so
    // it also satisfies the `brokerage_id.not.is.null` arm of the .or() above.
    // The old fallback was `overrides?.[0]`, the most RECENT row of any scope —
    // which meant one teammate's personal trial or personal disable became the
    // answer for every other user in the brokerage. The tenant-wide fallback is
    // only ever a row that names no user.
    const o = overrides?.find((x) => x.user_id === userId) ?? overrides?.find((x) => x.user_id === null) ?? null
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

  // THE GRANTEE IS THE TENANT. A user-scoped override still belongs to the
  // brokerage that user belongs to, and the feature-governance screen lists
  // overrides with a flat `.eq("brokerage_id", brokerageId)`
  // (app/dashboard/admin/feature-governance/page.tsx) — user_id rows included.
  // The UI's own grant path already writes BOTH columns for this exact
  // operation (feature-governance-client.tsx), so a trial granted through this
  // kernel function landed as a row no admin screen could list and no admin
  // could revoke. Resolved from users.brokerage_id, the same lookup
  // incrementFeatureUsage above already performs — never from a caller-supplied
  // value, and never from createdByUserId, who may be a superadmin in no tenant.
  const { data: granteeRow, error: granteeError } = await supabase
    .from("users")
    .select("brokerage_id, team_id")
    .eq("id", userId)
    .maybeSingle()
  if (granteeError) {
    return { success: false, error: `Could not resolve the grantee's brokerage: ${granteeError.message}` }
  }

  // Remove any existing disabled override so the trial takes effect
  await supabase
    .from("feature_access_overrides")
    .delete()
    .eq("feature_key", featureKey)
    .eq("user_id", userId)
    .eq("override_type", "disable")

  const { error } = await supabase.from("feature_access_overrides").insert({
    user_id: userId,
    brokerage_id: granteeRow?.brokerage_id ?? null,
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

  // Same tenant rule as grantFeatureTrial: a user-scoped disable still belongs to
  // that user's brokerage, and the governance screen lists by brokerage_id alone.
  // Only resolve when the caller named a user and no explicit brokerage — a
  // team- or brokerage-scoped call already carries its own anchor.
  let resolvedBrokerageId = brokerageId ?? null
  if (!resolvedBrokerageId && userId) {
    const { data: targetRow, error: targetError } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", userId)
      .maybeSingle()
    if (targetError) {
      return { success: false, error: `Could not resolve the target user's brokerage: ${targetError.message}` }
    }
    resolvedBrokerageId = targetRow?.brokerage_id ?? null
  }

  const { error } = await supabase.from("feature_access_overrides").insert({
    feature_key: featureKey,
    user_id: userId ?? null,
    brokerage_id: resolvedBrokerageId,
    team_id: teamId ?? null,
    override_type: "disable",
    disabled_reason: disabledReason ?? null,
    created_by: createdByUserId ?? null,
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
