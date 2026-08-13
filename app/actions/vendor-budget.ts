"use server"

// Vendor-budget surfaces, role-scoped. PRIVACY CONTRACT (enforced here, server-side):
//   • Brokerage/subscriber users  → coarse level + a (superadmin-toggled) warning.
//     NEVER dollar amounts, ceiling, percent, or vendor names.
//   • Platform staff (superadmin, admin, marketing, support — the owner's roster,
//     resolved from users.platform_role) → full spend + per-vendor breakdown.
//   • Only superadmin may flip the brokerage-warning visibility toggle.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import {
  checkVendorBudget,
  getBrokerageBudgetWarningEnabled,
  getVendorSpendBreakdown,
  getBudgetBlockedSendCount,
} from "@/lib/vendor-governance/budget-gate"
import { redactBudgetForActor, type BudgetView } from "@/lib/vendor-governance/budget-visibility"
import { aggregateBrokerageSpend, type BrokerageSpendRow } from "@/lib/vendor-governance/budget-eval"

/**
 * `platform_role` IS SELECTED HERE, AND ITS ABSENCE WAS THE BUG.
 *
 * The two platform-staff gates below used to read `isPlatformStaff(actor.userType)`
 * against a roster of platform_role values. Measured on the live database, that gate
 * admitted NOBODY who should have passed and one class who should not:
 *
 *   • the platform's ONLY superadmin is (user_type='admin', platform_role='superadmin')
 *     → refused, so the vendor-spend console was dark for the one person who owns it;
 *   • a `marketing` staffer carries user_type='system' ('marketing' is not even a legal
 *     user_type) → refused, permanently, whatever the roster said;
 *   • a `support` staffer carries user_type='support' → admitted, but so would any
 *     TENANT user whose user_type is 'support', which is a tenant role unconnected to
 *     platform employment. That is a privacy gate on vendor names and dollar amounts.
 */
async function resolveActor(): Promise<{ userId: string; userType: string; platformRole: string | null; brokerageId: string | null; email: string } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from("users")
    .select("user_type, platform_role, brokerage_id, email")
    .eq("id", user.id)
    .maybeSingle()
  return {
    userId: user.id,
    userType: data?.user_type ?? "agent",
    platformRole: (data as { platform_role?: string | null } | null)?.platform_role ?? null,
    brokerageId: data?.brokerage_id ?? null,
    email: data?.email ?? user.email ?? "",
  }
}

/**
 * The current brokerage user's budget view — ALWAYS redacted (level + warning only).
 * Returns null when unauthenticated / no brokerage.
 */
export async function getBrokerageBudgetWarning(): Promise<BudgetView | null> {
  const actor = await resolveActor()
  if (!actor?.brokerageId) return null
  const [budget, warningEnabled] = await Promise.all([
    checkVendorBudget({ brokerageId: actor.brokerageId }),
    getBrokerageBudgetWarningEnabled(),
  ])
  // Force isPlatformStaff:false here — this surface is for the brokerage's own view.
  return redactBudgetForActor(budget, { isPlatformStaff: false, showBrokerageWarning: warningEnabled })
}

/**
 * How many outbound sends the vendor-budget gate refused in the last 30 days for the
 * CURRENT brokerage — derived from the egress-refusal ledger (self_heal_events), no new
 * tables. A coarse COUNT only (no vendor names, no dollar amounts), so it respects the
 * privacy contract above. Returns 0 when unauthenticated, warning-hidden, or nothing
 * was blocked — the banner simply omits the line.
 */
export async function getBudgetBlockedSendCount30d(): Promise<number> {
  const actor = await resolveActor()
  if (!actor?.brokerageId) return 0
  const warningEnabled = await getBrokerageBudgetWarningEnabled()
  if (!warningEnabled) return 0 // superadmin hid the budget surface from brokerages
  return getBudgetBlockedSendCount(actor.brokerageId, 30)
}

/**
 * Full vendor-spend view for a brokerage — PLATFORM STAFF ONLY (superadmin/support).
 * Includes spend, ceiling, percent, and per-vendor breakdown (vendor names).
 */
export async function getPlatformVendorBudget(brokerageId: string): Promise<
  { ok: true; view: BudgetView } | { ok: false; error: string }
> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Unauthenticated" }
  if (!isPlatformStaffIdentity(actor.userType, actor.platformRole)) return { ok: false, error: "Platform staff access required" }

  const [budget, vendors] = await Promise.all([
    checkVendorBudget({ brokerageId }),
    getVendorSpendBreakdown(brokerageId),
  ])
  return { ok: true, view: redactBudgetForActor(budget, { isPlatformStaff: true, showBrokerageWarning: true, vendors }) }
}

/**
 * Cross-brokerage vendor-spend overview — PLATFORM STAFF ONLY (superadmin/support).
 * Powers the read-only support console; sorted closest-to-limit first.
 */
export async function getPlatformVendorSpendOverview(): Promise<
  { ok: true; rows: BrokerageSpendRow[] } | { ok: false; error: string }
> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Unauthenticated" }
  if (!isPlatformStaffIdentity(actor.userType, actor.platformRole)) return { ok: false, error: "Platform staff access required" }

  const svc = createServiceClient()
  const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
  // `error` is destructured on BOTH reads. supabase-js RESOLVES a refused query, so
  // `{ data }` alone read a denial as "no spend" — and the support console renders
  // that as "All brokerages within budget", a false all-clear on the platform's
  // spend-control surface.
  const [{ data: usage, error: usageError }, { data: brokerages, error: brokeragesError }] = await Promise.all([
    svc.from("vendor_usage_tracking").select("brokerage_id, total_cost").gte("created_at", startOfMonth),
    svc.from("brokerages").select("id, name, plan_tier"),
  ])
  if (usageError) return { ok: false, error: usageError.message }
  if (brokeragesError) return { ok: false, error: brokeragesError.message }
  return { ok: true, rows: aggregateBrokerageSpend(usage ?? [], brokerages ?? []) }
}

/**
 * Toggle whether brokerage users see the "approaching usage limit" warning.
 * SUPERADMIN ONLY — deliberately NOT the four-role staff roster, because this is
 * platform CONFIGURATION (it hides a cost signal from every tenant at once), not
 * catalogue maintenance. Audit-logged.
 *
 * The superadmin test reads BOTH columns for the same reason the staff test does:
 * `actor.userType !== "superadmin"` alone refused the platform's only superadmin,
 * whose row is (user_type='admin', platform_role='superadmin'). This is the exact
 * shape used by public.is_platform_admin() in RLS and by requireSuperadmin() in
 * app/actions/superadmin/platform-staff.ts — narrowing to superadmin means
 * platform_role='superadmin' OR the legacy user_type marker, never user_type alone.
 */
export async function setBrokerageBudgetWarningVisibility(enabled: boolean): Promise<
  { ok: true; enabled: boolean } | { ok: false; error: string }
> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Unauthenticated" }
  if (actor.userType !== "superadmin" && actor.platformRole !== "superadmin") {
    return { ok: false, error: "Superadmin access required" }
  }

  const svc = createServiceClient()
  const { error } = await svc
    .from("platform_settings")
    .update({ show_brokerage_budget_warning: enabled })
    .eq("id", true)
  if (error) return { ok: false, error: error.message }

  await svc.from("superadmin_audit_log").insert({
    actor_user_id: actor.userId,
    actor_email: actor.email,
    action: "set_brokerage_budget_warning_visibility",
    target_type: "platform_settings",
    details: { enabled },
  }).then(() => {}, () => {})

  return { ok: true, enabled }
}
