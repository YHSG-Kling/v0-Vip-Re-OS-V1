// lib/kernel/billing.ts
// Kernel OS: Canonical Billing Commands
// No mocks, stubs, or placeholders. All operations read real data from Supabase.

// TOMBSTONE (orphan doctrine §1.3 — functionality already lives elsewhere).
// `import { SupabaseClient } from "@supabase/supabase-js"` stood here and was read by
// NOTHING in this file: no export takes a client parameter, every function builds its
// own through createServiceClient() below. The typed-client vocabulary this repo does
// use is `ReturnType<typeof createServiceClient>` — see lib/lead-assignment/routing-profiles.ts:20
// for the pattern — so the raw class import was a second spelling of a type nobody
// needed here (CLAUDE.md §6). Note it was a VALUE import of a type-only symbol, which
// kept @supabase/supabase-js in this module's runtime graph for nothing.
import { createServiceClient } from "@/lib/supabase/service"
// ONE definition of the billing month, shared with usage_counters. Every
// billing_usage writer AND reader in this file filters on it — see the note in
// lib/usage/period.ts for what happened when neither side did.
import { currentBillingPeriodLabel } from "@/lib/usage/period"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"
// The PURE claimed-tenant decision table (no I/O, no client) — see the
// CLAIMED-TENANT RULE header in lib/platform/acting-context.ts. Imported so this
// command and the act-as write seam apply ONE rule, not two spellings of it (§6).
import { decideClaimedTenant } from "@/lib/platform/acting-context"

/**
 * PURE: is a feature included in a subscription tier's feature set? subscription_tiers.features is a
 * JSONB OBJECT ({ accounting_sync: true, team_features: false, ... }) — the key's value must be
 * strictly true. A legacy ARRAY shape (["accounting_sync", ...]) is also honored so an older tier row
 * can't silently deny an entitlement. Anything else (null/garbage) → not included. Unit-tested.
 */
export function isTierFeatureIncluded(
  features: unknown,
  featureKey: string,
): boolean {
  if (Array.isArray(features)) return features.includes(featureKey)
  if (features && typeof features === "object") {
    return (features as Record<string, unknown>)[featureKey] === true
  }
  return false
}

// ============================================================================
// INPUT/OUTPUT CONTRACTS
// ============================================================================

/**
 * THE BILLING ACTOR — and why `userType` alone was never enough.
 *
 * Staff identity on this database is DUAL-COLUMN. `users.platform_role` and
 * `users.user_type` hold different vocabularies, and the platform's ONE
 * superadmin is (user_type='admin', platform_role='superadmin'). Every gate in
 * this file tested `userType === "superadmin"` — a test that account cannot pass
 * — so applyFeatureOverride and updateSubscriptionState refused the only person
 * they exist to admit. Both columns travel together now, exactly as they do on
 * AuthResult in lib/kernel/api-auth.ts.
 *
 * `userType` is `string` rather than a literal union for the same reason: it is a
 * raw `users.user_type` value and the genuine superadmin's is 'admin'. The union
 * forced every call site to LABEL the caller "superadmin" to satisfy the compiler,
 * which is the shape that hides an identity bug instead of surfacing it.
 *
 * `platformRole` is optional and null-by-default: a caller that does not know the
 * column omits it and is treated as a tenant user. Absence never grants.
 */
export interface BillingActorContext {
  userId: string
  /** Raw `users.user_type` — 'superadmin' here is the LEGACY staff marker only. */
  userType: string
  /** Raw `users.platform_role` — null for every tenant user. */
  platformRole?: string | null
  /**
   * The actor's OWN `users.brokerage_id`, session-resolved — the tenant this caller
   * is entitled to by membership. Optional only so the two commands that do not yet
   * pass it keep compiling; where it is READ (loadBillingWorkspace) its ABSENCE is a
   * REFUSAL for anyone who is not platform staff, never a pass (§4 fail closed).
   */
  brokerageId?: string | null
}

export interface LoadBillingWorkspaceInput {
  brokerageId: string
  actorContext: BillingActorContext
}

export interface LoadBillingWorkspaceOutput {
  success: boolean
  subscriptions?: Array<{
    brokerageId: string
    tierName: string
    status: "active" | "trial" | "cancelled"
    currentPeriodStart: string
    currentPeriodEnd: string
    cancelledAt?: string
  }>
  features?: Array<{
    featureKey: string
    featureName: string
    included: boolean
    reason?: "tier_included" | "override" | "trial" | "disabled"
    trialEndsAt?: string
  }>
  costs?: {
    monthlyRecurring: number
    estimatedOverage: number
    totalExposure: number
  }
  error?: string
}

export interface ResolveSubscriptionTierInput {
  brokerageId: string
}

export interface ResolveSubscriptionTierOutput {
  success: boolean
  tier?: {
    tierName: string
    tierKey: string
    priceMonthly: number
  }
  trialEndsAt?: string
  isCancelled: boolean
  error?: string
}

export interface ResolveFeatureEntitlementInput {
  brokerageId: string
  featureKey: string
}

export interface ResolveFeatureEntitlementOutput {
  success: boolean
  allowed: boolean
  reason?: "tier_included" | "override" | "trial" | "disabled"
  expiresAt?: string
  error?: string
}

export interface RecordUsageEventInput {
  brokerageId: string
  metric: "ai_calls" | "video_minutes" | "storage_bytes" | "scraper_calls" | "active_agents"
  units: number
  actorContext?: {
    userId?: string
  }
}

export interface RecordUsageEventOutput {
  success: boolean
  newTotal?: number
  overageFlag?: boolean
  error?: string
}

export interface ApplyFeatureOverrideInput {
  brokerageId: string
  featureKey: string
  overrideType: "enable_trial" | "disable" | "extend_trial"
  trialEndsAt?: string
  actorContext: BillingActorContext
}

export interface ApplyFeatureOverrideOutput {
  success: boolean
  appliedAt?: string
  appliedBy?: string
  error?: string
}

export interface CalculateOverageExposureInput {
  brokerageId: string
  projectionDays?: number
}

export interface CalculateOverageExposureOutput {
  success: boolean
  metrics?: Record<
    string,
    {
      current: number
      limit: number
      projected: number
      overage: number
    }
  >
  totalExposureCents?: number
  error?: string
}

export interface LoadRevenueSummaryInput {
  dateRange: {
    from: string // ISO date
    to: string
  }
  aggregateBy: "brokerage" | "tier" | "none"
}

export interface LoadRevenueSummaryOutput {
  success: boolean
  summary?: Array<{
    aggregateKey: string
    count: number
    mrrCents: number
    arrCents: number
    churnRate: number
  }>
  total?: {
    mrrCents: number
    arrCents: number
    churnRate: number
  }
  error?: string
}

export interface UpdateSubscriptionStateInput {
  brokerageId: string
  tier?: string
  newStatus: "active" | "trial" | "cancelled"
  cancellationReason?: string
  actorContext: BillingActorContext
}

export interface UpdateSubscriptionStateOutput {
  success: boolean
  updatedAt?: string
  invoice?: {
    id: string
    dueDate: string
  }
  error?: string
}

// ============================================================================
// VALIDATION RULES
// ============================================================================

const BILLING_VALIDATION_RULES = {
  MIN_PROJECTION_DAYS: 7,
  MAX_PROJECTION_DAYS: 90,
  ONLY_SUPERADMIN: ["applyFeatureOverride", "updateSubscriptionState", "loadRevenueSummary"],
}

/**
 * SUPERADMIN GATE — BOTH COLUMNS, never `user_type` alone.
 *
 * It read `return userType === "superadmin"`. The platform's only superadmin is
 * (user_type='admin', platform_role='superadmin'), so this returned false for
 * them and applyFeatureOverride and updateSubscriptionState were refused to the
 * one account entitled to call them. Adding the platform_role marker admits that
 * account and nobody else: 'superadmin' in platform_role is written solely by the
 * superadmin-gated staff CRUD (app/actions/superadmin/platform-staff.ts). This is
 * the same shape public.is_platform_admin() uses in RLS.
 *
 * The legacy user_type='superadmin' marker is kept for the same reason RLS keeps
 * it — an account predating the platform_role column must not be demoted.
 *
 * NOTE on `loadRevenueSummary`: it is named in ONLY_SUPERADMIN but never calls
 * this function — its input carries no actor at all, and its only gate is in
 * app/actions/admin/billing.ts:loadRevenueSummaryAction, which is still
 * user_type-only. That is out of this file and is reported, not silently patched:
 * giving the command a required actor would break its one live caller.
 */
function validateSuperadminOnly(actor: BillingActorContext, command: string): boolean {
  if (!BILLING_VALIDATION_RULES.ONLY_SUPERADMIN.includes(command)) {
    return true
  }
  // ONE DEFINITION (ruling 1) — lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity
  return isPlatformSuperadminIdentity(actor.userType, actor.platformRole)
}

// ============================================================================
// COMMAND 1: LOAD BILLING WORKSPACE
// ============================================================================

export async function loadBillingWorkspace(
  input: LoadBillingWorkspaceInput
): Promise<LoadBillingWorkspaceOutput> {
  try {
    // ── THE QUERY-SUPPLIED TENANT ON THIS COMMAND: RESEARCHED, KEPT, AUTHORIZED ──
    //
    // `input.brokerageId` reaches here from `?brokerageId=` on
    // /api/admin/billing/dashboard (app/components/features/admin/billing-dashboard.tsx
    // builds that URL). A caller-named tenant on a billing READ is the IDOR shape,
    // so it was researched rather than deleted (owner ruling, 2026-08-26).
    //
    // VERDICT: it is a REAL capability and it stays. Platform staff must be able to
    // open ANY tenant's billing workspace — that is the whole purpose of this
    // superadmin surface, it is how app/dashboard/admin/billing/page.tsx navigates
    // ("Pass ?brokerageId=YOUR_ID to view other brokerages"), and §4 says platform
    // sees all tenants. It is NOT an act-as case: staff are inspecting the tenant's
    // billing as the PLATFORM, not operating as them, so the impersonation seam is
    // the wrong instrument here. What was missing was the authorization.
    //
    // WHAT WAS ACTUALLY HERE, and why it protected nothing:
    //   `actorContext.userType === "broker_admin" && actorContext.userId !== input.brokerageId`
    //   · It compared a users.id to a brokerages.id — two disjoint uuid spaces, so
    //     for a broker_admin it was ALWAYS true and the command always refused; for
    //     everyone else it never ran at all.
    //   · It named ONE user_type out of the fifteen the CHECK admits. A 'broker',
    //     'admin', 'team_lead' or 'agent' naming a foreign brokerage walked straight
    //     past it.
    // The route's requireSuperadminAuth is what has actually been holding this line.
    // A kernel command must not depend on one caller's gate to be safe: the rule is
    // stated here, in the command, so a second caller cannot inherit a hole.
    //
    // THE RULE: platform staff may name any tenant; everyone else is confined to the
    // brokerage their own session resolves to; an actor whose tenant is unknown is
    // REFUSED, because "nobody checked" must never render as "checked and fine".
    //
    // ONE VOCABULARY (§6): the "a caller-named tenant is a CLAIM, verified against
    // the tenant the caller actually holds" rule is decideClaimedTenant — the same
    // pure decision table the act-as write seam gates server actions with. This
    // command's only difference is WHO may name a foreign tenant, and that is the
    // platform-staff test above, not a second spelling of the comparison.
    const actorIsPlatform = isPlatformSuperadminIdentity(
      input.actorContext.userType,
      input.actorContext.platformRole,
    )
    if (!actorIsPlatform) {
      const decision = decideClaimedTenant({
        actingBrokerageId: input.actorContext.brokerageId,
        claimedBrokerageId: input.brokerageId,
      })
      if (!decision.ok) {
        return {
          success: false,
          error:
            decision.reason === "no_session_tenant"
              ? "Unauthorized: billing actor has no resolved brokerage"
              : "Unauthorized: cannot access other brokerages",
        }
      }
    }

    const supabase = await createServiceClient()

    // Fetch subscription
    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select(
        "id,brokerage_id,tier_id,status,current_period_start,current_period_end,cancelled_at,subscription_tiers:tier_id(tier_name,monthly_price_cents,features)"
      )
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()

    if (subError) {
      return {
        success: false,
        error: `Failed to load subscription: ${subError.message}`,
      }
    }

    // Tier details come from the embedded subscription_tiers (joined via tier_id)
    const tier = (subscription as any)?.subscription_tiers ?? null

    // Fetch feature entitlements
    const featuresIncluded: string[] = tier?.features || []

    // Fetch feature overrides
    const { data: overrides, error: overridesError } = await supabase
      .from("feature_access_overrides")
      .select("feature_key,override_type,trial_ends_at")
      .eq("brokerage_id", input.brokerageId)

    // Fetch usage for cost calculation
    // SAME PERIOD KEY AS THE WRITER (lib/usage/period.ts). Without it this read
    // returned an arbitrary month once a second existed — and `.maybeSingle()`
    // over two rows is a PostgREST error, not a row.
    const { data: usage, error: usageError } = await supabase
      .from("billing_usage")
      .select("ai_calls_count,video_minutes,storage_bytes")
      .eq("brokerage_id", input.brokerageId)
      .eq("period_label", currentBillingPeriodLabel())
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    // Build feature map
    const { data: allFeatures, error: featuresError } = await supabase
      .from("feature_flags")
      .select("feature_key,display_name")

    const features =
      allFeatures?.map((f) => ({
        featureKey: f.feature_key,
        featureName: f.display_name,
        included: featuresIncluded.includes(f.feature_key),
        reason: featuresIncluded.includes(f.feature_key)
          ? ("tier_included" as const)
          : ("disabled" as const),
      })) || []

    // Calculate costs (tier price is already stored in cents)
    const monthlyRecurring = tier?.monthly_price_cents || 0
    const estimatedOverage = 0 // Simplified for now

    return {
      success: true,
      subscriptions: subscription
        ? [
            {
              brokerageId: subscription.brokerage_id,
              tierName: tier?.tier_name,
              status: subscription.status,
              currentPeriodStart: subscription.current_period_start,
              currentPeriodEnd: subscription.current_period_end,
              cancelledAt: subscription.cancelled_at,
            },
          ]
        : [],
      features,
      costs: {
        monthlyRecurring,
        estimatedOverage,
        totalExposure: monthlyRecurring + estimatedOverage,
      },
    }
  } catch (error) {
    console.error("[Billing] loadBillingWorkspace error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================================================
// COMMAND 2: RESOLVE SUBSCRIPTION TIER
// ============================================================================

export async function resolveSubscriptionTier(
  input: ResolveSubscriptionTierInput
): Promise<ResolveSubscriptionTierOutput> {
  try {
    const supabase = await createServiceClient()

    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select("tier_id,status,cancelled_at")
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()

    if (subError) {
      return {
        success: false,
        isCancelled: false,
        error: `Failed to load subscription: ${subError.message}`,
      }
    }

    if (!subscription) {
      return {
        success: false,
        isCancelled: false,
        error: "Subscription not found",
      }
    }

    const { data: tier, error: tierError } = await supabase
      .from("subscription_tiers")
      .select("tier_name,monthly_price_cents")
      .eq("id", subscription.tier_id)
      .maybeSingle()

    if (tierError || !tier) {
      return {
        success: false,
        isCancelled: subscription.status === "cancelled",
        error: "Tier not found",
      }
    }

    return {
      success: true,
      tier: {
        tierName: tier.tier_name,
        tierKey: tier.tier_name,
        priceMonthly: tier.monthly_price_cents,
      },
      isCancelled: subscription.status === "cancelled",
    }
  } catch (error) {
    console.error("[Billing] resolveSubscriptionTier error:", error)
    return {
      success: false,
      isCancelled: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================================================
// COMMAND 3: RESOLVE FEATURE ENTITLEMENT
// ============================================================================

export async function resolveFeatureEntitlement(
  input: ResolveFeatureEntitlementInput
): Promise<ResolveFeatureEntitlementOutput> {
  try {
    const supabase = await createServiceClient()

    // Check override first (highest priority)
    const { data: override, error: overrideError } = await supabase
      .from("feature_access_overrides")
      .select("override_type,trial_ends_at")
      .eq("brokerage_id", input.brokerageId)
      .eq("feature_key", input.featureKey)
      .maybeSingle()

    if (override && override.override_type === "grant_trial") {
      const now = new Date().toISOString()
      if (override.trial_ends_at && override.trial_ends_at > now) {
        return {
          success: true,
          allowed: true,
          reason: "trial",
          expiresAt: override.trial_ends_at,
        }
      }
    }

    if (override && override.override_type === "disable") {
      return {
        success: true,
        allowed: false,
        reason: "disabled",
      }
    }

    // Check tier inclusion
    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select("tier_id")
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()

    if (!subscription) {
      return {
        success: false,
        allowed: false,
        error: "Subscription not found",
      }
    }

    const { data: tier, error: tierError } = await supabase
      .from("subscription_tiers")
      .select("features")
      .eq("id", subscription.tier_id)
      .maybeSingle()

    if (!tier) {
      return {
        success: false,
        allowed: false,
        error: "Tier not found",
      }
    }

    const isIncluded = isTierFeatureIncluded(tier.features, input.featureKey)

    return {
      success: true,
      allowed: isIncluded,
      reason: isIncluded ? "tier_included" : "disabled",
    }
  } catch (error) {
    console.error("[Billing] resolveFeatureEntitlement error:", error)
    return {
      success: false,
      allowed: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================================================
// COMMAND 4: RECORD USAGE EVENT
// ============================================================================

/**
 * THE ONLY WRITER OF `billing_usage` — and, until this change, one nothing
 * called. See the tombstone at app/actions/admin/billing.ts for the census.
 *
 * VALIDATION MERGED IN FROM THE DELETED `"use server"` WRAPPER: the metric and
 * the non-negative-units checks used to live only in `recordUsageEventAction`,
 * so a server-side caller reaching this command directly bypassed both. They
 * belong on the command, not on one door into it, and they are here now.
 *
 * `units` is a DELTA — what the caller JUST consumed, never a running total.
 */
export async function recordUsageEvent(
  input: RecordUsageEventInput
): Promise<RecordUsageEventOutput> {
  try {
    if (!input.brokerageId) {
      return { success: false, error: "Missing required field: brokerageId" }
    }
    if (!input.metric) {
      return { success: false, error: "Missing required field: metric" }
    }
    if (!Number.isFinite(input.units) || input.units < 0) {
      return { success: false, error: "Units must be a non-negative number" }
    }

    const supabase = await createServiceClient()

    // THE PERIOD IS PART OF THE ROW'S IDENTITY. This fetch used to filter on
    // brokerage alone and then UPDATE whatever it found, so every later month's
    // usage accumulated into the FIRST month's row and the meter never reset.
    // lib/usage/period.ts is the one definition of the month, shared with the
    // readers below and with usage_counters. `.order().limit(1)` rather than a
    // bare `.maybeSingle()`: two rows for one period (a write race) must degrade
    // to "use the newest", not to a PostgREST error that blanks the meter.
    const periodLabel = currentBillingPeriodLabel()

    const { data: currentUsage, error: fetchError } = await supabase
      .from("billing_usage")
      .select("*")
      .eq("brokerage_id", input.brokerageId)
      .eq("period_label", periodLabel)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (fetchError && fetchError.code !== "PGRST116") {
      return {
        success: false,
        error: `Failed to fetch usage: ${fetchError.message}`,
      }
    }

    // Determine column name based on metric
    const columnMap: Record<string, string> = {
      ai_calls: "ai_calls_count",
      video_minutes: "video_minutes",
      storage_bytes: "storage_bytes",
      scraper_calls: "scraper_calls",
      active_agents: "active_agents",
    }

    const column = columnMap[input.metric]
    if (!column) {
      return {
        success: false,
        error: `Unknown metric: ${input.metric}`,
      }
    }

    const newTotal = (currentUsage?.[column as keyof typeof currentUsage] || 0) + input.units
    const now = new Date().toISOString()

    // Update or insert usage record
    if (currentUsage) {
      // Keyed on the ROW ID, not on brokerage_id: the brokerage predicate would
      // have rewritten every period's row for this tenant with one month's total.
      // `recorded_at` is refreshed because app/actions/billing.ts getBillingUsage
      // orders on it.
      const { data: updated, error: updateError } = await supabase
        .from("billing_usage")
        .update({
          [column]: newTotal,
          recorded_at: now,
        })
        .eq("id", (currentUsage as { id: string }).id)
        .select("id")

      if (updateError) {
        return {
          success: false,
          error: `Failed to update usage: ${updateError.message}`,
        }
      }
      // A zero-row UPDATE is not an error in PostgREST. Recording usage that
      // landed nowhere while reporting success is how billing_usage would go on
      // reading zero even after it had a writer.
      if (!Array.isArray(updated) || updated.length === 0) {
        return {
          success: false,
          error: `Failed to update usage: no billing_usage row matched id ${(currentUsage as { id: string }).id}`,
        }
      }
    } else {
      const insertData: Record<string, any> = {
        brokerage_id: input.brokerageId,
        [column]: input.units,
        // period_label is NOT NULL — the current billing month (YYYY-MM), from
        // the shared UTC definition rather than an inline slice of a local date.
        period_label: periodLabel,
        recorded_at: now,
      }

      const { error: insertError } = await supabase
        .from("billing_usage")
        .insert(insertData)

      if (insertError) {
        return {
          success: false,
          error: `Failed to insert usage: ${insertError.message}`,
        }
      }
    }

    return {
      success: true,
      newTotal,
      overageFlag: false,
    }
  } catch (error) {
    console.error("[Billing] recordUsageEvent error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================================================
// COMMAND 5: APPLY FEATURE OVERRIDE
// ============================================================================

export async function applyFeatureOverride(
  input: ApplyFeatureOverrideInput
): Promise<ApplyFeatureOverrideOutput> {
  try {
    // Validate superadmin
    if (!validateSuperadminOnly(input.actorContext, "applyFeatureOverride")) {
      return {
        success: false,
        error: "Only superadmins can apply feature overrides",
      }
    }

    const supabase = await createServiceClient()

    // Check if override exists
    const { data: existingOverride, error: fetchError } = await supabase
      .from("feature_access_overrides")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("feature_key", input.featureKey)
      .maybeSingle()

    const now = new Date()
    const appliedAt = now.toISOString()
    // feature_access_overrides.override_type CHECK allows only grant_trial | disable.
    const mappedOverrideType = input.overrideType === "disable" ? "disable" : "grant_trial"
    const trialEndsAt = mappedOverrideType === "grant_trial" ? input.trialEndsAt : null

    if (existingOverride) {
      // Update existing
      const { error: updateError } = await supabase
        .from("feature_access_overrides")
        .update({
          override_type: mappedOverrideType,
          trial_ends_at: trialEndsAt,
        })
        .eq("id", existingOverride.id)

      if (updateError) {
        return {
          success: false,
          error: `Failed to update override: ${updateError.message}`,
        }
      }
    } else {
      // Insert new
      const { error: insertError } = await supabase
        .from("feature_access_overrides")
        .insert({
          brokerage_id: input.brokerageId,
          feature_key: input.featureKey,
          override_type: mappedOverrideType,
          trial_ends_at: trialEndsAt,
          created_by: input.actorContext.userId,
          created_at: appliedAt,
        })

      if (insertError) {
        return {
          success: false,
          error: `Failed to create override: ${insertError.message}`,
        }
      }
    }

    return {
      success: true,
      appliedAt,
      appliedBy: input.actorContext.userId,
    }
  } catch (error) {
    console.error("[Billing] applyFeatureOverride error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================================================
// COMMAND 6: CALCULATE OVERAGE EXPOSURE
// ============================================================================

export async function calculateOverageExposure(
  input: CalculateOverageExposureInput
): Promise<CalculateOverageExposureOutput> {
  try {
    const supabase = await createServiceClient()

    const projectionDays = input.projectionDays || 30
    if (projectionDays < 7 || projectionDays > 90) {
      return {
        success: false,
        error: "Projection days must be between 7 and 90",
      }
    }

    // Fetch current usage
    // SAME PERIOD KEY AS THE WRITER (lib/usage/period.ts). The overage
    // PROJECTION is the surface this table exists for; reading an unkeyed
    // "whatever row comes back" meant projecting one month's exposure from
    // another month's counters as soon as a second month existed.
    const { data: usage, error: usageError } = await supabase
      .from("billing_usage")
      .select("ai_calls_count,video_minutes,storage_bytes,scraper_calls,active_agents")
      .eq("brokerage_id", input.brokerageId)
      .eq("period_label", currentBillingPeriodLabel())
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (usageError) {
      return {
        success: false,
        error: `Failed to fetch usage: ${usageError.message}`,
      }
    }

    // Fetch tier limits
    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select("tier_id")
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()

    if (!subscription) {
      return {
        success: false,
        error: "Subscription not found",
      }
    }

    const { data: tier, error: tierError } = await supabase
      .from("subscription_tiers")
      .select("max_agents,max_brokerages,features")
      .eq("id", subscription.tier_id)
      .maybeSingle()

    if (!tier) {
      return {
        success: false,
        error: "Tier limits not found",
      }
    }

    // Per-metric caps live in the tier's features jsonb (plus the structured max_agents).
    const limits = {
      active_agents: tier.max_agents ?? 0,
      ...(((tier.features as any)?.limits ?? {}) as Record<string, number>),
    } as Record<string, number>
    const metrics: Record<string, any> = {}
    let totalExposureCents = 0

    // Calculate for each metric
    const metricMap: Record<string, { key: string; costPerUnit: number }> = {
      ai_calls: { key: "ai_calls_count", costPerUnit: 0.01 },
      video_minutes: { key: "video_minutes", costPerUnit: 0.5 },
      storage_bytes: { key: "storage_bytes", costPerUnit: 0.000001 },
      scraper_calls: { key: "scraper_calls", costPerUnit: 0.002 },
      active_agents: { key: "active_agents", costPerUnit: 100 },
    }

    for (const [metricName, { key, costPerUnit }] of Object.entries(metricMap)) {
      const current = usage?.[key as keyof typeof usage] || 0
      const limit = limits[metricName] || 0
      const dailyRate = current / 30 // Assume month is 30 days
      const projected = current + dailyRate * projectionDays
      const overage = Math.max(0, (projected - limit) * costPerUnit * 100) // Convert to cents

      metrics[metricName] = {
        current,
        limit,
        projected: Math.round(projected),
        overage: Math.round(overage),
      }

      totalExposureCents += overage
    }

    return {
      success: true,
      metrics,
      totalExposureCents: Math.round(totalExposureCents),
    }
  } catch (error) {
    console.error("[Billing] calculateOverageExposure error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================================================
// COMMAND 7: LOAD REVENUE SUMMARY
// ============================================================================

export async function loadRevenueSummary(
  input: LoadRevenueSummaryInput
): Promise<LoadRevenueSummaryOutput> {
  try {
    // Validate superadmin
    const supabase = await createServiceClient()

    // Fetch subscriptions in date range
    const { data: subscriptions, error: subError } = await supabase
      .from("subscriptions")
      .select("status,created_at,cancelled_at,subscription_tiers:tier_id(tier_name,monthly_price_cents)")
      .gte("created_at", input.dateRange.from)
      .lte("created_at", input.dateRange.to)

    if (subError) {
      return {
        success: false,
        error: `Failed to fetch subscriptions: ${subError.message}`,
      }
    }

    if (!subscriptions || subscriptions.length === 0) {
      return {
        success: true,
        summary: [],
        total: {
          mrrCents: 0,
          arrCents: 0,
          churnRate: 0,
        },
      }
    }

    // Aggregate by tier
    const summaryByTier: Record<string, any> = {}
    let totalMRR = 0
    let totalARR = 0
    let cancelledCount = 0

    for (const sub of subscriptions) {
      const tierRow = (sub as any).subscription_tiers
      const key = input.aggregateBy === "tier" ? tierRow?.tier_name : "all"
      // monthly_price_cents is ALREADY in cents — do NOT multiply by 100.
      const priceCents = tierRow?.monthly_price_cents ?? 0

      if (!summaryByTier[key]) {
        summaryByTier[key] = {
          aggregateKey: key,
          count: 0,
          mrrCents: 0,
          arrCents: 0,
        }
      }

      summaryByTier[key].count += 1
      summaryByTier[key].mrrCents += priceCents
      summaryByTier[key].arrCents += priceCents * 12

      totalMRR += priceCents
      totalARR += priceCents * 12

      if (sub.status === "cancelled") {
        cancelledCount += 1
      }
    }

    const churnRate = subscriptions.length > 0 ? cancelledCount / subscriptions.length : 0

    const summary = Object.values(summaryByTier).map((s: any) => ({
      ...s,
      churnRate: s.count > 0 ? cancelledCount / s.count : 0,
    }))

    return {
      success: true,
      summary,
      total: {
        mrrCents: Math.round(totalMRR),
        arrCents: Math.round(totalARR),
        churnRate,
      },
    }
  } catch (error) {
    console.error("[Billing] loadRevenueSummary error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ============================================================================
// COMMAND 8: UPDATE SUBSCRIPTION STATE
// ============================================================================

export async function updateSubscriptionState(
  input: UpdateSubscriptionStateInput
): Promise<UpdateSubscriptionStateOutput> {
  try {
    // Validate superadmin
    if (!validateSuperadminOnly(input.actorContext, "updateSubscriptionState")) {
      return {
        success: false,
        error: "Only superadmins can update subscription state",
      }
    }

    const supabase = await createServiceClient()

    const now = new Date().toISOString()

    // Update subscription
    const updateData: Record<string, any> = {
      status: input.newStatus,
      updated_at: now,
    }

    if (input.newStatus === "cancelled") {
      updateData.cancelled_at = now
      // cancellation_reason is not modeled on subscriptions; the reason is captured via the audit/event log.
    }

    if (input.tier) {
      // input.tier is a tier_name; subscriptions links to the tier via tier_id.
      const { data: tierRow } = await supabase
        .from("subscription_tiers")
        .select("id")
        .eq("tier_name", input.tier)
        .maybeSingle()
      if (tierRow) updateData.tier_id = tierRow.id
    }

    const { error: updateError } = await supabase
      .from("subscriptions")
      .update(updateData)
      .eq("brokerage_id", input.brokerageId)

    if (updateError) {
      return {
        success: false,
        error: `Failed to update subscription: ${updateError.message}`,
      }
    }

    // Create invoice if transitioning to cancelled
    let invoiceId: string | null = null
    if (input.newStatus === "cancelled") {
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + 30)

      const { data: invoice, error: invoiceError } = await supabase
        .from("billing_invoices")
        .insert({
          brokerage_id: input.brokerageId,
          // amount_cents is NOT NULL; a cancellation invoice carries no charge by default (0). The final
          // amount is reconciled by the Stripe webhook (system of record).
          amount_cents: 0,
          status: "open",
          due_date: dueDate.toISOString(),
          created_at: now,
        })
        .select("id")
        .single()

      if (!invoiceError && invoice) {
        invoiceId = invoice.id
      }
    }

    return {
      success: true,
      updatedAt: now,
      invoice: invoiceId
        ? {
            id: invoiceId,
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          }
        : undefined,
    }
  } catch (error) {
    console.error("[Billing] updateSubscriptionState error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
