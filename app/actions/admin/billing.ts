// app/actions/admin/billing.ts
// Billing server actions with validation + contract enforcement
//
// Previously every export trusted caller-supplied brokerageId with NO
// auth gate. Concrete impact: recordUsageEventAction could fabricate
// usage events on any tenant's billing meter (overage padding);
// calculateOverageExposureAction leaked projection data; and the
// "(superadmin only)" loadRevenueSummaryAction had no enforcement —
// any caller got cross-tenant revenue aggregates. All three were given
// session auth, and revenue summary additionally requires superadmin.
//
// `recordUsageEventAction` has since been REMOVED entirely (tombstone below):
// the meter it wrote is now written server-side at the three points where the
// usage is actually consumed, so there is no longer a browser-reachable
// endpoint whose purpose is to move a billing meter. The two surviving exports
// still go through requireBillingCaller().

"use server"

import { createClient } from "@/lib/supabase/server"
import {
  calculateOverageExposure,
  loadRevenueSummary,
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

/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `recordUsageEventAction` was REMOVED (orphan census, category C).
 *
 * SURVIVOR: `recordUsageEvent` at lib/kernel/billing.ts:525 — the kernel command
 * this action wrapped, and the only writer of `billing_usage` there has ever been.
 *
 * IT WAS A DUPLICATE DOOR, NOT A CAPABILITY. It contained no behaviour of its own
 * beyond an auth gate and two validations; every byte of the actual write was the
 * survivor's. The finding it carried was correct and has now been ACTED ON rather
 * than restated: `billing_usage` HAD NO WRITER ANYWHERE IN THE PRODUCT, so the
 * tenant usage bars (app/settings/billing/usage-section.tsx, via
 * app/actions/billing.ts getBillingUsage) and the overage EXPOSURE projection
 * (app/components/features/admin/overage-calculator.tsx, via
 * calculateOverageExposure below) read zero for every tenant, forever — and an
 * overage projection from an unwritten meter reads as "no exposure".
 *
 * THE THREE CALL SITES ARE NOW WIRED, all SERVER-SIDE, straight to the survivor:
 *   · app/actions/scrape-social-media.ts  → metric "scraper_calls" (counted at the
 *     scraper invocation, before the return)
 *   · lib/usage/log-media-usage.ts        → metric "video_minutes" (beside its two
 *     existing usage_events / usage_counters writes)
 *   · lib/ai/cost-tracking.ts             → metric "ai_calls" (one per completed
 *     model call, beside the ai_usage_log / ai_usage_monthly / usage_counters writes)
 *
 * WHY THE `"use server"` DOOR WENT RATHER THAN GETTING A CALLER. The previous note
 * here proposed wiring the one client that exists
 * (app/dashboard/admin/lead-intake/social-scrape-trigger.tsx) to record
 * "scraper_calls". That is the wrong place and the reason is not stylistic:
 *   · the client cannot see how many scraper calls were made, only how many posts
 *     came back — so the number it would report is not the number being billed;
 *   · a tab closed mid-run records nothing, while the credits are already spent;
 *   · a client-callable usage writer IS a public HTTP endpoint whose whole purpose
 *     is to move a billing meter. Any authenticated user could then pad their own
 *     tenant's usage by calling it, or under-report by never calling it. The
 *     brokerageId override this action performed prevented CROSS-tenant padding; it
 *     could not prevent self-padding, because self-padding is the endpoint working
 *     as designed.
 *
 * THE AUTH GATE IS NOT REGRESSED — it is superseded. `requireBillingCaller()` still
 * gates the two actions that remain in this file. What this action gated no longer
 * exists as a reachable endpoint at all: the meter is now written only from server
 * modules that already hold the session (scrape-social-media resolves brokerageId
 * from getAgentContext behind an admin check) or are service-credentialed and
 * unreachable from a browser. Removing an endpoint is strictly stronger than
 * gating it.
 *
 * MERGED ONTO THE SURVIVOR BEFORE DELETING, so nothing this action did is lost:
 * the "Missing required field: metric" and "Units must be non-negative" checks now
 * live on `recordUsageEvent` itself (lib/kernel/billing.ts:528-536), where they
 * also cover the server-side callers that previously bypassed them entirely.
 * ───────────────────────────────────────────────────────────────────────────── */

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
