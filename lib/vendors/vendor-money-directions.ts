// lib/vendors/vendor-money-directions.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// THE THREE VENDOR MONEY PATHS, NAMED ONCE, WITH THEIR DIRECTION PINNED
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS FILE EXISTS. Two waves ago `vendor_plans` / `vendor_subscriptions`
// shipped modelling a BROKERAGE PAYING A VENDOR A MONTHLY SUBSCRIPTION. That
// direction does not exist in this product. The owner ruling, verbatim:
//
//   "vendor packages are for brokerages to charge the vendor on a subscription
//    to the platform. vendors do bill the brokerages for jobs but not a monthly
//    subscription."
//
// So the recurring money between a brokerage and a vendor flows VENDOR →
// BROKERAGE, and the money flowing BROKERAGE → VENDOR is PER JOB and never
// recurring. The shipped model had both halves backwards at once, which is why
// it read as plausible: a "subscription" table with a brokerage_id and a
// vendor_id is symmetric, and nothing in it said which one pays.
//
// THE FIX IS NOT ONLY SCHEMA. A direction that lives only in a table comment
// gets re-inverted by the next reader who sees two id columns and guesses. So
// the direction is stated here as DATA, asserted by
// scripts/vendor-package-direction-simulator.ts, imported by every writer, and
// pinned in the database by m497 (a single-valued CHECK on
// vendor_subscriptions.billing_direction, plus a composite FK that makes a
// cross-tenant enrolment unrepresentable).
//
// ── WHAT THE LIVE DATABASE ALREADY SAID, BEFORE ANY OF THIS ────────────────
//
// The live RLS on `vendor_subscriptions` (measured on project hrvaqgvukzxfskkcrwbt)
// has always been:
//
//   INSERT/UPDATE/DELETE  is_platform_admin()
//                         OR (has_brokerage_access(brokerage_id)
//                             AND is_brokerage_finance_admin())
//   SELECT                … OR the vendor themself
//
// Only the BROKERAGE'S FINANCE ADMIN may write the row; the vendor may only
// READ it. That is the shape of a bill you ISSUE, not one you RECEIVE — it is
// byte-for-byte the same policy set as `vendor_invoices`, which is the
// brokerage's own ledger. The database was already describing the corrected
// direction while the application code above it described the opposite one.
//
// ── THE THREE PATHS ────────────────────────────────────────────────────────

/** Who ends up holding the money. Never inferred from a column name. */
export type MoneyParty = "vendor" | "brokerage" | "platform"

/** Recurring on a period, or raised once against a piece of work. */
export type MoneyCadence = "recurring" | "per_job"

export interface VendorMoneyPath {
  /** Stable id. Used in assertions and in ledger annotations — never renamed lightly. */
  readonly id: string
  /** Who the money leaves. */
  readonly payer: MoneyParty
  /** Who the money reaches. */
  readonly payee: MoneyParty
  readonly cadence: MoneyCadence
  /** The table that RECORDS the arrangement (not necessarily where cash moves). */
  readonly recordedIn: string
  /** The table the collectable amount is billed through, or null when the path is not billed here. */
  readonly billedThrough: string | null
  /** One sentence a human can check against the ruling. */
  readonly says: string
}

/**
 * PATH 1 — VENDOR PACKAGE. The brokerage sells a vendor recurring access and
 * placement in that brokerage's marketplace. Money: vendor → brokerage, monthly
 * (or annual). `vendor_plans` is the brokerage's package CATALOGUE;
 * `vendor_subscriptions` is one vendor's ENROLMENT in one package.
 *
 * COLLECTION IS NOT A SECOND RAIL. The amount is billed through the existing
 * `vendor_invoices` lane with billed_to='vendor' — the same lane
 * app/actions/vendor-payments.ts :: issueVendorCharge and
 * lib/vendors/premium-placement.ts already use, and for the same reason: this
 * repo has exactly ONE tenant→vendor billing ledger and a second one would make
 * "what does this vendor owe us" a question with two answers.
 */
export const VENDOR_PACKAGE: VendorMoneyPath = {
  id: "vendor_package",
  payer: "vendor",
  payee: "brokerage",
  cadence: "recurring",
  recordedIn: "vendor_subscriptions",
  billedThrough: "vendor_invoices",
  says: "The brokerage charges the vendor a recurring fee for a package in the brokerage's marketplace.",
} as const

/**
 * PATH 2 — VENDOR JOB BILL. The vendor did work for the brokerage and invoices
 * for it. Money: brokerage → vendor, PER JOB. This is `vendor_invoices` with
 * billed_to='brokerage'. There is deliberately no recurring form of this path —
 * the ruling names its absence explicitly ("not a monthly subscription").
 */
export const VENDOR_JOB_BILL: VendorMoneyPath = {
  id: "vendor_job_bill",
  payer: "brokerage",
  payee: "vendor",
  cadence: "per_job",
  recordedIn: "vendor_invoices",
  billedThrough: "vendor_invoices",
  says: "The vendor invoices the brokerage for a job it performed. Never a monthly subscription.",
} as const

/**
 * PATH 3 — VENDOR PLATFORM TIER. The vendor's own subscription to the platform
 * itself: `vendor_marketplace_profiles.subscription_tier` / `subscription_status`
 * / `stripe_customer_id` / `stripe_subscription_id`, catalogued in
 * lib/kernel/vendor-subscription.ts and proven by test:vendor-subscription.
 *
 * PRE-EXISTING AND ALREADY CORRECT — listed here only so the next reader does
 * not mistake PATH 1 for it. Both are vendor-outbound and recurring; they differ
 * in WHO COLLECTS (the platform vs one brokerage) and in WHICH ID SPACE the
 * vendor is identified in (vendor_marketplace_profiles.id vs vendors.id — two
 * disjoint spaces, see m440).
 */
export const VENDOR_PLATFORM_TIER: VendorMoneyPath = {
  id: "vendor_platform_tier",
  payer: "vendor",
  payee: "platform",
  cadence: "recurring",
  recordedIn: "vendor_marketplace_profiles",
  billedThrough: null, // Stripe-native, off this ledger entirely
  says: "The vendor pays the platform for its own marketplace tier. Not a brokerage's money.",
} as const

export const VENDOR_MONEY_PATHS = [VENDOR_PACKAGE, VENDOR_JOB_BILL, VENDOR_PLATFORM_TIER] as const

/**
 * The ONE literal `vendor_subscriptions.billing_direction` may hold. m497 puts a
 * single-valued CHECK behind it, so writing the inverted direction fails in the
 * database rather than in review. Writers import this instead of typing it.
 */
export const VENDOR_PACKAGE_BILLING_DIRECTION = "vendor_pays_brokerage" as const

/**
 * TRUE only for the one direction a vendor package may ever have. Deliberately
 * not a generic comparator: the point is that there is nothing to configure.
 */
export function isVendorPackageDirection(payer: MoneyParty, payee: MoneyParty): boolean {
  return payer === VENDOR_PACKAGE.payer && payee === VENDOR_PACKAGE.payee
}

/**
 * THE INVERSION THAT SHIPPED, kept as a named value so a test can assert it is
 * NOT what the code does. Deleting the wrong answer makes it easy to arrive at
 * again; naming it makes the regression checkable.
 */
export const RETIRED_INVERTED_VENDOR_PACKAGE = {
  id: "brokerage_subscribes_to_vendor_plan",
  payer: "brokerage",
  payee: "vendor",
  cadence: "recurring",
  why: "Shipped two waves ago and WRONG. A brokerage never pays a vendor a monthly subscription; " +
    "a vendor bills a brokerage per job (VENDOR_JOB_BILL) and pays the brokerage for a package " +
    "(VENDOR_PACKAGE). Corrected by m497.",
} as const

/**
 * Human-readable direction label for a UI. Kept beside the data so a screen can
 * never say the opposite of what the writer does — the failure this whole file
 * exists to prevent was, in the end, a schema and a screen disagreeing.
 */
export function describeDirection(path: VendorMoneyPath): string {
  const cadence = path.cadence === "recurring" ? "every billing period" : "per job"
  return `${path.payer} pays ${path.payee}, ${cadence}`
}
