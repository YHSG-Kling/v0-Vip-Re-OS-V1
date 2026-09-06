// lib/finance/tax-assistance.ts
//
// TAX ASSISTANCE AS A TENANT OPTION (owner ruling, 2026-08-27: "tax assistance
// tech is an option for tenants built out"). The tax tech — the 1099 tax-planning
// engine (lib/finance/tax-planning.ts + app/actions/tax-planning.ts + the
// financials tax set-aside panel) and the autonomous quarterly-tax concierge
// (lib/finance/quarterly-tax-concierge.ts, daily cron) — previously ran for every
// brokerage unconditionally. It is now gated on ONE brokerage-level enablement:
//
//   brokerages.tax_assistance_enabled   (m574, boolean not null default false)
//
// FAIL DIRECTION — decided from how this repo's optional features already gate:
// farm mail (`.eq("farm_mail_enabled", true)` in the weekly cron), revenue share
// (m264, default false, backfilled true only where demonstrably in use), and the
// showing financial gate (m377, default false) are all OPT-IN, fail-closed.
// Tax assistance follows: default false; m574 backfills true only for brokerages
// with agent_tax_profile rows (the feature demonstrably in use), so no working
// tenant regresses. A gate that cannot read the setting REFUSES — an error or a
// missing row is "not enabled", never "enabled".
//
// TIER COMPOSITION. Tax tech carries NO feature key in feature_flags today
// (verified 2026-08-27: no tax key in the tier-entitlement simulator, plan
// catalog, or tenant capabilities), so the brokerage option gates alone. If a
// tax feature key is ever added, this resolver is where the tier check composes:
// BOTH the tier entitlement (lib/kernel/0.1-feature-access.ts canAccessFeature)
// AND the brokerage option must allow — the option never replaces the tier.
//
// WRITER: app/actions/settings/revenue-share-setting.ts (the one brokerage-
// offerings settings home) — setBenefitOffering("tax_assistance", …).

/** Minimal client shape — callers hand their service client through. */
type SupabaseLike = { from: (table: string) => any }

export interface TaxAssistanceDecision {
  enabled: boolean
  /** Why — surfaced in refusal messages so "off" and "could not check" stay distinguishable in logs. */
  reason: "enabled" | "disabled_by_brokerage" | "read_failed" | "no_brokerage"
}

/** The sentinel the actions return so the UI can distinguish "your brokerage
 *  hasn't enabled this" from a real failure and render quietly instead of red. */
export const TAX_ASSISTANCE_DISABLED_ERROR =
  "tax_assistance_disabled: Tax assistance isn't enabled for your brokerage. A broker or admin can turn it on under Settings → Commission & Offerings."

/**
 * Resolve whether tax-assistance tech is enabled for a brokerage. FAIL-CLOSED:
 * the error is read (supabase-js resolves refusals), and a failed read or a
 * missing row refuses rather than passing.
 */
export async function resolveTaxAssistanceEnabled(
  svc: SupabaseLike,
  brokerageId: string | null | undefined,
): Promise<TaxAssistanceDecision> {
  if (!brokerageId) return { enabled: false, reason: "no_brokerage" }
  const { data, error } = await svc
    .from("brokerages")
    .select("tax_assistance_enabled")
    .eq("id", brokerageId)
    .maybeSingle()
  if (error || !data) return { enabled: false, reason: "read_failed" }
  const on = (data as { tax_assistance_enabled?: boolean | null }).tax_assistance_enabled === true
  return on ? { enabled: true, reason: "enabled" } : { enabled: false, reason: "disabled_by_brokerage" }
}
