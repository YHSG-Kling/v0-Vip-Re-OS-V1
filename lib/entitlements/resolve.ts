// lib/entitlements/resolve.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE unified entitlement resolution ORDER, as ONE pure function. The DB loads
// live in lib/kernel/0.1-feature-access.ts (canAccessFeature) which delegates here,
// so the decision logic is provable by a single test matrix instead of being
// scattered/implicit. This is the "rules engine" resolution order:
//
//   1. Platform hard rule    (god-switch / emergency halt / global feature kill)
//   2. Feature exists + on   (enabled, not deprecated, not sunset)
//   3. superadmin_only gate
//   4. Rollout cohort         (percentage rollout by deterministic tenant bucket;
//                              an EXPLICIT override below still wins — grant_trial
//                              can pull one tenant into a partial rollout)
//   5. Tenant override        (grant_trial → allow; disable → deny)  [most-specific scope]
//   6. Plan / tier access     (the plan the customer bought)
//   7. Runtime usage cap       (limit for this billing period)
//
// A tenant gets the feature only if EVERY gate passes.

export interface EntitlementInputs {
  /** Platform hard rule — the god-switch. When blocked, nothing below matters
   *  (superadmins are exempted by the caller before this is set). */
  platformHalt?: { blocked: boolean; reason?: string } | null
  /** The feature_flags row for this feature (null = feature doesn't exist). */
  flag: {
    enabled: boolean
    deprecated: boolean
    sunsetDate: string | null
    superadminOnly: boolean
    tierHasAccess: boolean
    tierLimit: number | null
    /** 0–100; null/100 = fully rolled out. */
    rolloutPercentage?: number | null
  } | null
  isSuperadmin?: boolean
  /** Deterministic 0–99 bucket for this (tenant, feature) — see rolloutBucket(). */
  rolloutBucket?: number | null
  /** The most-specific matching override (user → team → brokerage), if any. */
  override?: { type: string | null; trialEndsAt: string | null; disabledReason: string | null } | null
  /** Usage this billing period (only consulted when the tier carries a limit). */
  usageCurrent?: number
  tier: string
  now?: Date
}

export interface EntitlementDecision {
  allowed: boolean
  reason?: string
  trial?: boolean
  trial_expires_at?: string
  disabled?: boolean
  disabled_reason?: string
  usage?: { current: number; limit: number; remaining: number }
}

const isTrial = (t: string | null | undefined) => t === "grant_trial" || t === "trial"
const isDisable = (t: string | null | undefined) => t === "disable" || t === "disabled"

/** PURE: deterministic 0–99 rollout bucket for (feature, tenant) — FNV-1a over
 *  the pair, so a tenant's bucket is stable per feature (no flapping between
 *  requests) but DIFFERENT across features (one unlucky tenant isn't last for
 *  every rollout). */
export function rolloutBucket(featureKey: string, tenantKey: string): number {
  const s = `${featureKey}:${tenantKey}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 100
}

/** PURE: resolve a feature entitlement decision by walking the canonical order. */
export function resolveEntitlement(i: EntitlementInputs): EntitlementDecision {
  const now = i.now ?? new Date()

  // 1. Platform hard rule (god-switch). Highest precedence.
  if (i.platformHalt?.blocked) {
    return { allowed: false, reason: i.platformHalt.reason ?? "Platform is temporarily paused" }
  }

  // 2. Feature exists + enabled + not deprecated/sunset.
  if (!i.flag) return { allowed: false, reason: "Feature does not exist" }
  if (!i.flag.enabled) return { allowed: false, reason: "Feature is not enabled" }
  if (i.flag.deprecated) return { allowed: false, reason: "Feature is deprecated" }
  if (i.flag.sunsetDate && new Date(i.flag.sunsetDate) <= now) {
    return { allowed: false, reason: `Feature was sunset on ${i.flag.sunsetDate}` }
  }

  // 3. superadmin_only gate.
  if (i.flag.superadminOnly && !i.isSuperadmin) {
    return { allowed: false, reason: "This feature requires superadmin access" }
  }

  // 4. Rollout cohort — percentage rollout by deterministic tenant bucket.
  //    Checked BEFORE overrides so an explicit grant_trial can pull a specific
  //    tenant into a partial rollout; superadmins always see the feature.
  const pct = i.flag.rolloutPercentage
  if (pct != null && pct < 100 && !i.isSuperadmin) {
    const bucket = i.rolloutBucket ?? 0
    const inCohort = bucket < Math.max(0, pct)
    if (!inCohort && !isTrial(i.override?.type)) {
      return { allowed: false, reason: `Feature is rolling out gradually (${pct}% of tenants) — not enabled for your account yet` }
    }
  }

  // 5. Tenant override (most-specific scope already selected by the caller).
  if (isTrial(i.override?.type)) {
    const expired = i.override!.trialEndsAt && new Date(i.override!.trialEndsAt) <= now
    if (!expired) return { allowed: true, trial: true, trial_expires_at: i.override!.trialEndsAt ?? undefined }
    // expired trial → fall through to plan check
  }
  if (isDisable(i.override?.type)) {
    return { allowed: false, disabled: true, disabled_reason: i.override!.disabledReason ?? "Access has been disabled for your account" }
  }

  // 5. Plan / tier access.
  if (!i.flag.tierHasAccess) {
    return { allowed: false, reason: `Your plan (${i.tier}) does not include access to this feature` }
  }

  // 6. Runtime usage cap.
  if (i.flag.tierLimit !== null) {
    const current = i.usageCurrent ?? 0
    const limit = i.flag.tierLimit
    if (current >= limit) {
      return { allowed: false, reason: `Usage limit reached (${current}/${limit} this billing period)`, usage: { current, limit, remaining: 0 } }
    }
    return { allowed: true, usage: { current, limit, remaining: Math.max(0, limit - current) } }
  }

  return { allowed: true }
}
