// app/actions/admin/billing.ts
// Billing server actions with validation + contract enforcement
//
// Previously every export trusted caller-supplied brokerageId with NO
// auth gate. Concrete impact: recordUsageEventAction could fabricate
// usage events on any tenant's billing meter (overage padding);
// calculateOverageExposureAction leaked projection data; and the
// "(superadmin only)" loadRevenueSummaryAction had no enforcement —
// any caller got cross-tenant revenue aggregates. All three now require
// session auth, and revenue summary additionally requires superadmin.

"use server"

import { createClient } from "@/lib/supabase/server"
import {
  recordUsageEvent,
  calculateOverageExposure,
  loadRevenueSummary,
  type RecordUsageEventInput,
  type RecordUsageEventOutput,
  type CalculateOverageExposureInput,
  type CalculateOverageExposureOutput,
  type LoadRevenueSummaryInput,
  type LoadRevenueSummaryOutput,
} from "@/lib/kernel/billing"

async function requireBillingCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string; platformRole: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: profile } = await supabase
    .from("users").select("brokerage_id, user_type, platform_role").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return {
    ok: true,
    userId: user.id,
    brokerageId: profile.brokerage_id,
    userType: profile.user_type ?? "agent",
    platformRole: (profile as { platform_role?: string | null }).platform_role ?? null,
  }
}

/**
 * Record a usage event from within the app
 * Input contract: RecordUsageEventInput
 * Output contract: RecordUsageEventOutput
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORPHAN BURN-DOWN — NOT WIRED, AND THE REASON IS BIGGER THAN THIS EXPORT.
 * Measured this pass, not assumed. Read this before giving it a caller.
 *
 * `billing_usage` HAS NO WRITER ANYWHERE IN THE PRODUCT. `grep -rn billing_usage`
 * over app/ and lib/ returns six sites and every one of them is inside the billing
 * kernel or a read:
 *   · lib/kernel/billing.ts:512/546/567 — recordUsageEvent, the only INSERT/UPDATE,
 *     reachable from the product through this action alone;
 *   · lib/kernel/billing.ts:297 and :695 — reads (entitlement, overage projection);
 *   · app/actions/billing.ts:243 — getBillingUsage, the tenant read.
 * This action is that one writer's only door, and it has no caller. So the table has
 * never been written by the running product.
 *
 * TWO LIVE SURFACES READ IT AND THEREFORE SHOW ZERO, ALWAYS:
 *   · app/settings/billing/usage-section.tsx — the tenant's Active Agents / AI Calls /
 *     Storage / Video bars, fed by getBillingUsage;
 *   · app/components/features/admin/overage-calculator.tsx (rendered by
 *     app/dashboard/admin/billing/page.tsx:125) — projects overage EXPOSURE from
 *     calculateOverageExposure, which selects exactly those five columns.
 * An overage projection computed from an unwritten meter is not a small gap: it reads
 * as "no exposure" for every tenant, forever.
 *
 * IT IS NOT A DUPLICATE OF THE METERS THAT DO WORK, checked both ways:
 *   · lib/usage.ts:incrementUsage writes `usage_counters` (the AI-quota rail, joined
 *     by v_brokerage_ai_quota);
 *   · lib/usage/log-media-usage.ts writes `usage_events` + `usage_counters`.
 * Neither touches `billing_usage`, and `billing_usage`'s readers do not read theirs.
 * So deleting this would not "move the capability elsewhere" — it would leave the two
 * surfaces above reading a table nothing can ever write.
 *
 * WHY NO SURFACE IS BUILT FOR IT HERE. This is a `"use server"` export, so its
 * legitimate caller is a CLIENT that just consumed a metered resource — not a form for
 * typing usage in by hand. Inventing an admin data-entry screen would give the export
 * a caller while leaving both readers projecting from numbers nobody produces: a
 * rename of the orphan, which the wired-surface ratchet forbids in as many words.
 * The finish is call sites in files this lane does not own, and they are REPORTED.
 * THIS action is the door for a CLIENT caller — verified, exactly one exists:
 *   · app/dashboard/admin/lead-intake/social-scrape-trigger.tsx ("use client",
 *     calls scrapeSocialMedia) → metric "scraper_calls".
 * The other two are SERVER-side and must call the kernel command directly
 * (lib/kernel/billing.ts:recordUsageEvent) rather than this wrapper — a server module
 * routing through a `"use server"` action would be gating itself against a session it
 * may not have:
 *   · lib/usage/log-media-usage.ts → "video_minutes" beside its existing two writes;
 *   · lib/ai/cost-tracking.ts → "ai_calls" beside its incrementUsage call.
 * Note the units are DELTAS (`newTotal = current + units`), so any caller must add
 * what it just consumed, never restate a running total.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function recordUsageEventAction(
  input: RecordUsageEventInput
): Promise<RecordUsageEventOutput> {
  try {
    const auth = await requireBillingCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    // Always override caller-supplied brokerageId with session's —
    // recording usage events on another tenant's meter could pad their
    // overage charges.
    const safeInput = { ...input, brokerageId: auth.brokerageId }

    if (!safeInput.metric) {
      return {
        success: false,
        error: "Missing required field: metric",
      }
    }
    if (safeInput.units < 0) {
      return {
        success: false,
        error: "Units must be non-negative",
      }
    }

    return await recordUsageEvent(safeInput)
  } catch (error) {
    console.error("[Action] recordUsageEventAction error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Calculate overage exposure projection
 * Input contract: CalculateOverageExposureInput
 * Output contract: CalculateOverageExposureOutput
 */
export async function calculateOverageExposureAction(
  input: CalculateOverageExposureInput
): Promise<CalculateOverageExposureOutput> {
  try {
    const auth = await requireBillingCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    // Scope to caller's brokerage; superadmin can pass cross-tenant
    const safeInput = { ...input, brokerageId: auth.brokerageId }

    const projectionDays = safeInput.projectionDays || 30
    if (projectionDays < 7 || projectionDays > 90) {
      return {
        success: false,
        error: "Projection days must be between 7 and 90",
      }
    }

    return await calculateOverageExposure(safeInput)
  } catch (error) {
    console.error("[Action] calculateOverageExposureAction error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Load revenue summary (superadmin only)
 * Input contract: LoadRevenueSummaryInput
 * Output contract: LoadRevenueSummaryOutput
 */
export async function loadRevenueSummaryAction(
  input: LoadRevenueSummaryInput
): Promise<LoadRevenueSummaryOutput> {
  try {
    // SUPERADMIN gate — cross-tenant aggregate, was previously open.
    const auth = await requireBillingCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    // BOTH identity columns. `auth.userType` alone refused the platform's ONLY
    // superadmin, whose row is (user_type='admin', platform_role='superadmin') —
    // so the one real gate on the cross-tenant revenue aggregate refused the one
    // account meant to pass it, and the kernel command behind it has no gate of
    // its own. Same shape as public.is_platform_admin() in RLS; the reasoning is
    // written out in app/actions/vendor-budget.ts:136-147.
    //
    // 'super_admin' is kept only as the legacy spelling it always was: it is not
    // one of the 14 values users_user_type_check admits, so it matches nobody and
    // widens this roster to nobody — the safe direction.
    const isSuperadmin =
      ["superadmin", "super_admin"].includes(auth.userType) ||
      auth.platformRole === "superadmin"
    if (!isSuperadmin) {
      return { success: false, error: "Forbidden: superadmin only" }
    }

    // Validate dates
    const fromDate = new Date(input.dateRange.from)
    const toDate = new Date(input.dateRange.to)

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return {
        success: false,
        error: "Invalid date format",
      }
    }

    if (fromDate >= toDate) {
      return {
        success: false,
        error: "From date must be before to date",
      }
    }

    return await loadRevenueSummary(input)
  } catch (error) {
    console.error("[Action] loadRevenueSummaryAction error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
