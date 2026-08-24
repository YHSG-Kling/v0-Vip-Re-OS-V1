// lib/billing/stripe-account-scope.ts
// ═══════════════════════════════════════════════════════════════════════════
// WHICH STRIPE ACCOUNT — the rule, stated once, as data. PURE: no I/O, no
// `server-only`, so the guard can assert it without a database.
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER RULING (verbatim): "the stripe account will be per tenant and platform so
// no configuration should be hardcoded."
//
// That REPLACES the architecture the previous wave documented, which was one
// global `STRIPE_SECRET_KEY` for everybody. lib/providers/tenancy-matrix.ts said
// it outright — "Never tenant-owned keys" — and ENV_CONFIGURATION.md,
// PRODUCTION-READINESS.md, lib/platform/launch-checklist.ts and
// lib/platform/go-live-readiness.ts all wrote that single key into a go-live
// board. All five are corrected.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
// A Stripe API call is made BY a merchant of record. The merchant is the party
// that COLLECTS the money, never the party that happens to trigger the request.
// So:
//
//   payee === "platform"   →  the PLATFORM's Stripe account
//   payee is anyone else   →  that TENANT's own Stripe account
//
// There is no third answer and, deliberately, no default. The failure this file
// exists to prevent is a tenant-side charge quietly landing on the platform's
// account (the platform collects money it did not earn, on a customer it does not
// have) or the reverse (a tenant's account is charged for the platform's own
// invoice). Both are money defects — a wrong Stripe account is a wrong invoice,
// a wrong 1099 and a wrong refund destination — so the resolver
// (lib/billing/resolve-stripe-account.ts) REFUSES rather than falling back.
//
// ── WHY THE PAYEE AND NOT THE TENANT ───────────────────────────────────────
//
// "Per tenant" does not mean "every Stripe call a tenant causes runs on their
// account". A brokerage paying us for its seats is a payment TO the platform: the
// platform is the merchant, the platform's account is charged, the platform's
// webhook secret signs the receipt. The tenant's own account is for the money the
// tenant collects — vendor package fees, client payments — and for the money it
// pays out. Reading the direction off the payer instead of the payee inverts
// exactly the SaaS-subscription path, which is the one with live tiers behind it.
//
// The vendor money paths already have their directions pinned as data in
// lib/vendors/vendor-money-directions.ts; the sides below agree with that file
// path-for-path, and the guard asserts the agreement rather than trusting it.

/** Who can hold money in this product. Same vocabulary as
 *  lib/vendors/vendor-money-directions.ts :: MoneyParty, widened to the owner
 *  scopes lib/connections/scope.ts cascades over. */
export type StripeMoneyParty = "platform" | "brokerage" | "team" | "agent" | "vendor" | "contact"

/** The two Stripe accounts that exist. "tenant" resolves through the ownership
 *  cascade (agent → team → brokerage); "platform" resolves to the product's own. */
export type StripeAccountSide = "platform" | "tenant"

/**
 * THE RULE. Pure, total, and with no default branch: every party is either the
 * platform or is not.
 */
export function stripeAccountSideFor(payee: StripeMoneyParty): StripeAccountSide {
  return payee === "platform" ? "platform" : "tenant"
}

export interface StripeMoneyPath {
  /** Stable id — used in assertions and refusal messages, never renamed lightly. */
  readonly id: string
  readonly payer: StripeMoneyParty
  readonly payee: StripeMoneyParty
  /** Where the call is made from, so a reader can check the claim against code. */
  readonly livesIn: string
  /** One sentence a human can hold against the owner ruling. */
  readonly says: string
}

/**
 * EVERY Stripe money path this repo has, with its payee named. The guard walks
 * this list and asserts each path's side against `stripeAccountSideFor`, so a new
 * path cannot be added without stating who collects.
 *
 * This is a roster of DIRECTIONS, not of call sites — several paths share a file.
 */
export const STRIPE_MONEY_PATHS: readonly StripeMoneyPath[] = [
  {
    id: "tenant_saas_subscription",
    payer: "brokerage",
    payee: "platform",
    livesIn: "app/actions/billing.ts · lib/billing/subscription-activation.ts · app/api/billing/webhook/route.ts",
    says: "A brokerage pays the platform for its plan. The platform is the merchant; the platform's Stripe account is charged.",
  },
  {
    id: "tenant_ai_overage",
    payer: "brokerage",
    payee: "platform",
    livesIn: "lib/billing/ai-overage.ts · app/api/cron/ai-overage-billing/route.ts",
    says: "Per-tier AI overage is platform revenue on the platform's account — CLAUDE.md §5, 'AI is platform-covered, with per-tier overage'.",
  },
  {
    id: "vendor_platform_tier",
    payer: "vendor",
    payee: "platform",
    livesIn: "app/api/webhooks/stripe/vendor/route.ts · lib/kernel/vendor-subscription.ts",
    says: "A marketplace vendor pays the PLATFORM for its own tier — VENDOR_PLATFORM_TIER in lib/vendors/vendor-money-directions.ts. Not a brokerage's money.",
  },
  {
    id: "vendor_package",
    payer: "vendor",
    payee: "brokerage",
    livesIn: "lib/vendors/premium-placement.ts · app/actions/vendor-payments.ts (vendor_invoices, billed_to='vendor')",
    says: "A vendor pays the BROKERAGE for a package in that brokerage's marketplace — VENDOR_PACKAGE. The brokerage collects, so the brokerage's Stripe account is the merchant.",
  },
  {
    id: "vendor_job_bill",
    payer: "brokerage",
    payee: "vendor",
    livesIn: "app/actions/vendor-payments.ts (vendor_invoices, billed_to='brokerage')",
    says: "A vendor invoices the brokerage per job. The money leaves the brokerage, so it leaves the BROKERAGE's Stripe account — never the platform's.",
  },
  {
    id: "agent_payout",
    payer: "brokerage",
    payee: "agent",
    livesIn: "lib/providers/payment/index.ts :: createTransfer",
    says: "A brokerage disburses to its agent. The brokerage's account funds the transfer; the agent's Connect account receives it.",
  },
  {
    id: "client_payment",
    payer: "contact",
    payee: "brokerage",
    livesIn: "lib/providers/payment/index.ts :: createPaymentIntent",
    says: "A client pays the brokerage. The brokerage is the merchant of record and its own Stripe account settles the charge.",
  },
] as const

/** Pure: look one up by id. Returns null rather than throwing — a caller that
 *  cannot name its path must refuse, and refusing needs a value, not an exception. */
export function stripeMoneyPath(id: string): StripeMoneyPath | null {
  return STRIPE_MONEY_PATHS.find((p) => p.id === id) ?? null
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RESIDUAL, NAMED — tenant money still running on the PLATFORM's key.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Stating it as DATA rather than as a note, for the reason
 * lib/vendors/vendor-money-directions.ts states its own directions as data: a
 * known-wrong money path that lives only in prose gets re-derived as correct by
 * the next reader.
 *
 * `app/actions/vendor-payments.ts` still imports the synchronous `stripe` proxy
 * from lib/stripe.ts — i.e. the PLATFORM's env key — for calls whose payee is
 * NOT the platform. That file belongs to the vendor-billing lane and was
 * explicitly out of scope for the wave that built this resolver, so it is
 * recorded here rather than half-changed.
 *
 * `scripts/stripe-account-scope-simulator.ts` holds the importer roster of
 * lib/stripe.ts against this list, so the set can SHRINK but a new tenant-money
 * importer cannot be added quietly.
 *
 * THE FIX, per call site, is one line each: resolve the brokerage from the
 * session (it is already in scope at every one of them), call
 * `resolveTenantStripeAccount`, and construct the client from the resolved
 * `secretKey` — passing `Stripe-Account` when `mode === "connect"`. The refusal
 * path is already written; only the call sites need repointing.
 */
export interface StripeAccountResidual {
  readonly file: string
  /** The line as of 2026-08-24, for orientation — not asserted (lines move). */
  readonly at: string
  readonly pathId: string
  readonly why: string
}

export const TENANT_MONEY_ON_PLATFORM_KEY: readonly StripeAccountResidual[] = [
  {
    file: "app/actions/vendor-payments.ts",
    at: "stripe.transfers.create()",
    pathId: "vendor_job_bill",
    why: "Pays a vendor for a job the BROKERAGE commissioned. The funds should leave the brokerage's balance; today they leave the platform's.",
  },
  {
    file: "app/actions/vendor-payments.ts",
    at: "stripe.checkout.sessions.create()",
    pathId: "client_payment",
    why: "A contact paying a vendor invoice through the portal. The merchant of record should be the brokerage (or the vendor's Connect account under it), not the platform.",
  },
] as const

/**
 * THE ONE ENVIRONMENT VARIABLES THAT MAY STILL HOLD A STRIPE SECRET, AND WHOSE
 * THEY ARE.
 *
 * The owner's ruling forbids hardcoded CONFIGURATION, not the platform having a
 * home for its own credential. The platform is a single, known party with exactly
 * one Stripe account; storing that account's key in the platform's own deployment
 * environment is not configuration a tenant could ever need to override, and it is
 * the credential that has to exist BEFORE any database row can be read (the
 * bootstrap: `platform_credentials` holds 0 rows today).
 *
 * So env stays — as the PLATFORM's credential of last resort, and nothing else:
 *
 *   · lib/billing/resolve-stripe-account.ts :: resolvePlatformStripeAccount reads
 *     it only after the platform-owned `platform_credentials` row has been looked
 *     for, and only for owner_type='platform'.
 *   · resolveTenantStripeAccount NEVER reads it. A tenant with no credential is a
 *     refusal, not a fallback — falling back would charge the platform's account
 *     for a tenant's money.
 *   · scripts/stripe-account-scope-simulator.ts asserts both halves of that,
 *     including that no tenant-side code path reads these names.
 */
export const PLATFORM_ONLY_STRIPE_ENV = [
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_VENDOR_WEBHOOK_SECRET",
] as const

/**
 * The two Stripe webhook endpoints this app exposes. They are SEPARATE Stripe
 * endpoint registrations even on one account, so each has its own signing secret
 * — a secret verifies deliveries for the endpoint it was minted for and no other.
 */
export type StripeWebhookEndpoint = "tenant_billing" | "vendor_marketplace"

/** The route each endpoint is registered at, so an operator instruction and the
 *  code cannot drift. This repo has already shipped a launch checklist that told
 *  operators to register `/api/webhooks/stripe`, which is a 404. */
export const STRIPE_WEBHOOK_ROUTES: Record<StripeWebhookEndpoint, string> = {
  tenant_billing: "/api/billing/webhook",
  vendor_marketplace: "/api/webhooks/stripe/vendor",
}

/**
 * The config-blob keys a stored Stripe credential may carry each endpoint's
 * WEBHOOK signing secret under. Closed on purpose — a config blob is
 * caller-supplied, and scanning it for anything that "looks like" a signing
 * secret would let a user-typed key become one. Same discipline, and the same
 * reason, as lib/connections/credential-secret.ts :: CONFIG_SECRET_KEYS.
 */
export const STRIPE_WEBHOOK_CONFIG_KEYS: Record<StripeWebhookEndpoint, readonly string[]> = {
  tenant_billing: ["webhook_secret", "stripe_webhook_secret", "signing_secret"],
  vendor_marketplace: ["vendor_webhook_secret", "stripe_vendor_webhook_secret"],
}

/** The env var holding the PLATFORM account's signing secret for each endpoint.
 *  Platform scope only — a tenant's signing secret is never an env var, because
 *  there are N tenants and env vars are singular by construction. */
export const PLATFORM_WEBHOOK_ENV: Record<StripeWebhookEndpoint, string> = {
  tenant_billing: "STRIPE_WEBHOOK_SECRET",
  vendor_marketplace: "STRIPE_VENDOR_WEBHOOK_SECRET",
}

/** Pure: the signing secret for one endpoint out of a credential row's config
 *  blob, or null when it carries none. An empty string is NOT a secret — a blank
 *  form box writes `""`, and `""` passed to signature verification rejects every
 *  delivery with an opaque error instead of an honest "no secret stored". */
export function webhookSecretFromConfig(
  config: unknown,
  endpoint: StripeWebhookEndpoint = "tenant_billing",
): string | null {
  if (!config || typeof config !== "object") return null
  const blob = config as Record<string, unknown>
  for (const key of STRIPE_WEBHOOK_CONFIG_KEYS[endpoint]) {
    const v = blob[key]
    if (typeof v === "string" && v.trim() !== "") return v
  }
  return null
}
