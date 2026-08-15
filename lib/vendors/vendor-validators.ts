// lib/vendors/vendor-validators.ts
//
// ── validateVendor — DELETED (orphan burn-down w44) ──────────────────────────
// It was not unwired-but-correct. Its category gate was
//   ['api', 'service', 'tool', 'integration']
// and NOT ONE of those four values is admissible in `vendors.category`. The live
// CHECK is the 38-value lowercase_snake taxonomy in lib/kernel/vendor-categories.ts
// ('lender', 'title', 'inspector', 'stager', 'contractor', …), shared verbatim with
// vendor_directory.category since m304. Wiring this would have rejected every real
// vendor on the bench and admitted only categories the database itself refuses.
//
// It was also a SIXTH copy of a vocabulary this repo deliberately consolidated:
// lib/kernel/vendor-categories.ts's own header lists the five duplicates it
// replaced and why ("the broker's lender panel showed 0 lenders" — case-sensitive
// comparison against a stale spelling). The category axis is validated by importing
// VENDOR_CATEGORIES / VendorCategory from there; `vendors.default_revenue_share_percent`,
// the other column it checked, does not exist (revenue share is a COMMISSION concept —
// lib/commission/waterfall/09-revenue-share.ts, gated on brokerages.revenue_share_enabled).
//
// ── validateVendorPlan — KEPT, unwired, needs an owner ruling ────────────────
// This one is not wrong, it is EARLY. It is the input gate for the vendor paid
// add-on that app/actions/vendor-contact-access.ts declares as future work
// ("vendor_subscriptions / vendor_plans tables already exist … commit-G will add
// the billing path"). Measured against the migrations: `vendor_subscriptions` DOES
// exist (m439 records that its only numeric column is credits_used_this_period, so
// it carries no money), and `vendor_plans` does NOT exist in any migration. Nothing
// in app/ or lib/ reads or writes either table.
//
// Left in place rather than deleted because the capability is real and declared;
// it is NOT adoptable as written, since its 'monthly' | 'annual' billing vocabulary
// and per-plan price live on a table that has to be designed first. When that
// ruling lands, the price half belongs on subscription_tiers via
// lib/billing/plan-catalog.ts:validatePlanTierInput — the superadmin-owned catalog
// whose whole point is that NOTHING hardcodes tier price or copy.

export function validateVendorPlan(data: any) {
  const errors: string[] = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push('Plan name is required');
  }

  if (!data.price_per_month || data.price_per_month <= 0) {
    errors.push('Price must be greater than 0');
  }

  if (!['monthly', 'annual'].includes(data.billing_cycle)) {
    errors.push('Invalid billing cycle');
  }

  if (data.max_credits_per_month && data.max_credits_per_month < 0) {
    errors.push('Max credits cannot be negative');
  }

  return errors;
}
