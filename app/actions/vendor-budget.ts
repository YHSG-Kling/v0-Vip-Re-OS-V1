"use server"

// Vendor-budget surfaces, role-scoped. PRIVACY CONTRACT (enforced here, server-side):
//   • Brokerage/subscriber users  → coarse level + a (superadmin-toggled) warning.
//     NEVER dollar amounts, ceiling, percent, or vendor names.
//   • Platform staff (superadmin/support) → full spend + per-vendor breakdown.
//   • Only superadmin may flip the brokerage-warning visibility toggle.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import {
  checkVendorBudget,
  getBrokerageBudgetWarningEnabled,
  getVendorSpendBreakdown,
} from "@/lib/vendor-governance/budget-gate"
import { redactBudgetForActor, type BudgetView } from "@/lib/vendor-governance/budget-visibility"
import { aggregateBrokerageSpend, type BrokerageSpendRow } from "@/lib/vendor-governance/budget-eval"

async function resolveActor(): Promise<{ userId: string; userType: string; brokerageId: string | null; email: string } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from("users")
    .select("user_type, brokerage_id, email")
    .eq("id", user.id)
    .maybeSingle()
  return {
    userId: user.id,
    userType: data?.user_type ?? "agent",
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
 * Full vendor-spend view for a brokerage — PLATFORM STAFF ONLY (superadmin/support).
 * Includes spend, ceiling, percent, and per-vendor breakdown (vendor names).
 */
export async function getPlatformVendorBudget(brokerageId: string): Promise<
  { ok: true; view: BudgetView } | { ok: false; error: string }
> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Unauthenticated" }
  if (!isPlatformStaff(actor.userType)) return { ok: false, error: "Platform staff access required" }

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
  if (!isPlatformStaff(actor.userType)) return { ok: false, error: "Platform staff access required" }

  const svc = createServiceClient()
  const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
  const [{ data: usage }, { data: brokerages }] = await Promise.all([
    svc.from("vendor_usage_tracking").select("brokerage_id, total_cost").gte("created_at", startOfMonth),
    svc.from("brokerages").select("id, name, plan_tier"),
  ])
  return { ok: true, rows: aggregateBrokerageSpend(usage ?? [], brokerages ?? []) }
}

/**
 * Toggle whether brokerage users see the "approaching usage limit" warning.
 * SUPERADMIN ONLY (not support — this is platform configuration). Audit-logged.
 */
export async function setBrokerageBudgetWarningVisibility(enabled: boolean): Promise<
  { ok: true; enabled: boolean } | { ok: false; error: string }
> {
  const actor = await resolveActor()
  if (!actor) return { ok: false, error: "Unauthenticated" }
  if (actor.userType !== "superadmin") return { ok: false, error: "Superadmin access required" }

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
