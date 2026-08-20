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
// ── validateVendorPlan — WIRED, AND ITS SUBJECT CORRECTED (m497) ─────────────
//
// WHAT A "PLAN" IS. `vendor_plans` is A BROKERAGE'S VENDOR PACKAGE CATALOGUE:
// each row is a recurring package the brokerage SELLS TO VENDORS for access and
// placement in that brokerage's marketplace. MONEY FLOWS VENDOR → BROKERAGE.
// The owner ruling, verbatim:
//
//   "vendor packages are for brokerages to charge the vendor on a subscription
//    to the platform. vendors do bill the brokerages for jobs but not a monthly
//    subscription."
//
// The three money paths are named once, in lib/vendors/vendor-money-directions.ts.
// This validator only ever touches PATH 1's price sheet.
//
// HISTORY, kept because the corrections are the point.
//
//  1. An early note said "`vendor_plans` does NOT exist in any migration" —
//     measured against migration FILES, not the database. It exists live.
//
//  2. A later note kept the validator unwired, calling the owner question open:
//     "who may publish a plan — the vendor, or brokerage staff on the vendor's
//     behalf".
//
//  3. The wave after that declared the question ALREADY ANSWERED BY THE DATABASE,
//     citing vendor_plans' RLS:
//
//       vendor_plans_vendor_manage_own    ALL     is_current_user_marketplace_vendor(vendor_id)
//       vendor_plans_platform_manage      ALL     is_platform_staff()
//       vendor_plans_authenticated_browse SELECT  status = 'active'
//
//     and built the catalogue as A VENDOR'S OWN PRICE LIST that brokerages
//     subscribed to. THAT WAS THE WRONG DIRECTION, and the citation is why it
//     was believable: those policies do say a vendor may write vendor_plans
//     rows, which is exactly what you would expect of a catalogue the vendor
//     owns — and they say NOTHING about which way money moves. The schema was
//     read where it agreed and not where it did not: the policies on
//     `vendor_subscriptions` (brokerage finance admin WRITES, vendor READS only)
//     were describing the corrected direction the entire time.
//
//  4. m497 repoints it. vendor_plans.vendor_id is GONE — a package sold by a
//     brokerage has no owning vendor — replaced by brokerage_id NOT NULL, with
//     vendor_plans_brokerage_manage_own on the same finance tier that already
//     guards vendor_subscriptions and vendor_invoices. The writer is
//     app/actions/vendors/vendor-plans.ts; the authoring surface is the
//     brokerage's /dashboard/vendors Packages tab; /vendor/plans is the payer's
//     READ-ONLY view of what it is being charged.
//
// NOTHING BELOW CHANGED IN m497. The DIRECTION moved; the field rules did not.
// Every rule here is still the live CHECK on the same column, verbatim.
//
// ── EVERY LIVE CHECK IS COVERED, AND NOTHING BEYOND THEM ─────────────────────
// Verified against pg_constraint on the live table:
//
//   name                   text     NOT NULL                        → required
//   price_per_month        numeric  NOT NULL, CHECK (>= 0)          → required, >= 0
//   price_per_credit       numeric  CHECK (>= 0)                    → >= 0 when set
//   billing_cycle          text     CHECK IN ('monthly','annual')   → EXACTLY this list
//   max_credits_per_month  integer  CHECK (NULL OR > 0)             → > 0 when set
//   trial_days             integer  CHECK (>= 0)                    → >= 0 when set
//   status                 text     CHECK IN ('active','archived')  → EXACTLY this list
//
// TWO DRIFTS FIXED, in opposite directions, and both directions matter:
//
//  1. TOO PERMISSIVE (fixed in the previous pass; confirmed present and correct
//     below). The original body accepted max_credits_per_month === 0, because
//     `data.max_credits_per_month && … < 0` is false for 0, while
//     `vendor_plans_max_credits_per_month_check` REFUSES 0. A validator that passes
//     a value the database rejects turns a clear form error into a 23514 from
//     Postgres. The test is now an explicit null/undefined check.
//
//  2. TOO STRICT (fixed here). The old price rule was `!price || price <= 0` with
//     the message 'Price must be greater than 0' — but the live CHECK is
//     `price_per_month >= 0`. A $0 monthly plan is not a mistake the schema forgot
//     to forbid; it is the model the schema is built for: `price_per_credit` and
//     `trial_days` exist precisely so a vendor can publish a no-monthly-fee,
//     pay-per-credit tier. Refusing a row the database accepts is the same defect
//     class as accepting one it rejects — the validator invents a product rule that
//     no owner set and that no surface can override. So price_per_month must now be
//     PRESENT and NON-NEGATIVE, which is what the column actually says. (`!price`
//     also swallowed a missing price and a zero price into one message; those are
//     now distinct errors, because they are distinct mistakes.)
//
// The validator adds no rule the database does not already enforce. Its value is
// that the vendor gets a sentence naming the field instead of a constraint name.

/** The live `vendor_plans_billing_cycle_check` list, verbatim. */
export const VENDOR_PLAN_BILLING_CYCLES = ['monthly', 'annual'] as const;
/** The live `vendor_plans_status_check` list, verbatim. */
export const VENDOR_PLAN_STATUSES = ['active', 'archived'] as const;

export type VendorPlanBillingCycle = (typeof VENDOR_PLAN_BILLING_CYCLES)[number];
export type VendorPlanStatus = (typeof VENDOR_PLAN_STATUSES)[number];

/** True for a value that was supplied at all (null and undefined both mean "not set"). */
function isSet(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

/** A finite number, or null. Rejects NaN, Infinity and non-numeric strings — Postgres would too. */
function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function validateVendorPlan(data: any) {
  const errors: string[] = [];

  if (!data?.name || String(data.name).trim().length === 0) {
    errors.push('Plan name is required');
  }

  // price_per_month is NOT NULL with CHECK (>= 0). Missing and negative are separate mistakes.
  if (!isSet(data?.price_per_month)) {
    errors.push('Monthly price is required (use 0 for a pay-per-credit plan with no monthly fee)');
  } else {
    const price = asFiniteNumber(data.price_per_month);
    if (price === null) errors.push('Monthly price must be a number');
    else if (price < 0) errors.push('Monthly price cannot be negative');
  }

  // price_per_credit is nullable with CHECK (>= 0) — only validated when supplied.
  if (isSet(data?.price_per_credit)) {
    const perCredit = asFiniteNumber(data.price_per_credit);
    if (perCredit === null) errors.push('Price per credit must be a number');
    else if (perCredit < 0) errors.push('Price per credit cannot be negative');
  }

  if (!VENDOR_PLAN_BILLING_CYCLES.includes(data?.billing_cycle)) {
    errors.push(`Billing cycle must be one of: ${VENDOR_PLAN_BILLING_CYCLES.join(', ')}`);
  }

  // Live CHECK: (max_credits_per_month IS NULL OR max_credits_per_month > 0).
  // Explicit null/undefined test — 0 must FAIL here, and `if (0 && …)` never runs.
  if (data?.max_credits_per_month !== null && data?.max_credits_per_month !== undefined
      && data?.max_credits_per_month !== '') {
    const credits = asFiniteNumber(data.max_credits_per_month);
    if (credits === null || !Number.isInteger(credits)) {
      errors.push('Max credits per month must be a whole number');
    } else if (!(credits > 0)) {
      errors.push('Max credits per month must be greater than 0 when set');
    }
  }

  // trial_days: integer, CHECK (>= 0). 0 is legal here (no trial) — unlike credits.
  if (isSet(data?.trial_days)) {
    const trial = asFiniteNumber(data.trial_days);
    if (trial === null || !Number.isInteger(trial)) errors.push('Trial days must be a whole number');
    else if (trial < 0) errors.push('Trial days cannot be negative');
  }

  // status defaults to 'active' in the database, so only a SUPPLIED value is checked.
  if (isSet(data?.status) && !VENDOR_PLAN_STATUSES.includes(data.status)) {
    errors.push(`Status must be one of: ${VENDOR_PLAN_STATUSES.join(', ')}`);
  }

  return errors;
}
