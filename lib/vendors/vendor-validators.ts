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
// ── validateVendorPlan — KEPT, unwired. The blocker is NO WRITER, not no table ─
//
// CORRECTION TO THE PREVIOUS NOTE HERE, which said "`vendor_plans` does NOT exist
// in any migration". That was measured against migration FILES. Measured against
// the LIVE database (project hrvaqgvukzxfskkcrwbt), `public.vendor_plans` exists
// and this validator matches it field for field:
//
//   name                   text     NOT NULL                → 'Plan name is required'
//   price_per_month        numeric  NOT NULL, CHECK >= 0     → the price check
//   billing_cycle          text     CHECK IN ('monthly','annual')
//                                                            → EXACTLY this list
//   max_credits_per_month  integer  CHECK (NULL OR > 0)      → the credits check
//
// It is also FK-anchored and in use by the schema: vendor_plans.vendor_id →
// vendor_marketplace_profiles(id) ON DELETE CASCADE, and
// vendor_subscriptions.plan_id → vendor_plans(id) ON DELETE RESTRICT.
//
// So it is neither wrong nor speculative. What it does not have is anything to
// validate: NOTHING in app/ or lib/ inserts or updates a `vendor_plans` row —
// scripts/writerless-read-sweep.ts:37 lists `vendor_plans` in its own
// known-writerless set, and the live table holds 0 rows. Vendor billing that DOES
// exist works off `vendor_marketplace_profiles.subscription_tier` (app/actions/
// vendor-billing.ts, app/api/webhooks/stripe/vendor/route.ts) and never touches
// this table.
//
// LEFT, deliberately, rather than deleted or wired:
//   · Deleting it would be deleting a correct, schema-accurate validator to move
//     the orphan count — and it would be deleted again the day someone builds the
//     per-vendor plan catalogue the two FKs above already expect.
//   · Wiring it means BUILDING that catalogue: a vendor-facing plan CRUD surface
//     plus the "use server" writer behind it. That is a feature with an owner
//     decision in it (who may publish a plan — the vendor, or brokerage staff on
//     the vendor's behalf), not a wiring gap, and it is outside this pass.
//
// NOT A GATE THAT IS OPEN. It enforces nothing the database does not already
// enforce itself: every rule below has a matching CHECK constraint, so no path can
// currently write a plan that violates it. Its value when wired is the error
// MESSAGE, not the refusal.
//
// One drift fixed while here, against the live CHECK: the old body accepted
// max_credits_per_month === 0 (`data.max_credits_per_month && … < 0` is false for
// 0) while `vendor_plans_max_credits_per_month_check` REFUSES 0. A validator that
// passes a value the database rejects is worse than no validator.

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

  // Live CHECK: (max_credits_per_month IS NULL OR max_credits_per_month > 0).
  // Explicit null/undefined test — 0 must FAIL here, and `if (0 && …)` never runs.
  if (data.max_credits_per_month !== null && data.max_credits_per_month !== undefined
      && !(data.max_credits_per_month > 0)) {
    errors.push('Max credits per month must be greater than 0 when set');
  }

  return errors;
}
