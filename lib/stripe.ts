import 'server-only'

import Stripe from 'stripe'
import { resolvePlatformStripeAccount } from '@/lib/billing/resolve-stripe-account'

export const STRIPE_API_VERSION = '2026-02-25.clover' as const

// ═══════════════════════════════════════════════════════════════════════════
// THIS FILE IS THE **PLATFORM'S** STRIPE ACCOUNT. NOTHING ELSE.
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER RULING (verbatim): "the stripe account will be per tenant and platform so
// no configuration should be hardcoded."
//
// So there are TWO doors, and which one you take is a money decision:
//
//   getPlatformStripe()   the PLATFORM's account — a client for money the
//                         PLATFORM collects or pays: tenant subscriptions, AI
//                         overage, vendor marketplace tiers, the platform's own
//                         Connect platform. Resolves the platform-owned
//                         `platform_credentials` row FIRST and falls back to
//                         STRIPE_SECRET_KEY, which is the platform's own
//                         credential and no one else's.
//
//   lib/billing/resolve-stripe-account.ts :: resolveTenantStripeAccount
//                         a TENANT's account — a client for money a BROKERAGE
//                         collects or pays. It never reads an env var and REFUSES
//                         when the tenant has no credential, because the
//                         alternative is settling a tenant's money into the
//                         product's Stripe account.
//
// lib/billing/stripe-account-scope.ts holds the rule for deciding which: the
// account belongs to the party that COLLECTS (the payee), never to the party that
// triggered the request. STRIPE_MONEY_PATHS in that file names every path in this
// repo and which side it is on, and scripts/stripe-account-scope-simulator.ts
// keeps this file's importers honest against it.
//
// ── WHY AN ENV VAR SURVIVES HERE, AND ONLY HERE ────────────────────────────
//
// The ruling forbids hardcoded CONFIGURATION — a single global key standing in
// for N tenants' accounts. The platform is not one of those N: it is a single,
// known party with exactly one Stripe account, and that account's key must be
// readable BEFORE any database row can be (`platform_credentials` holds 0 rows
// today, so a DB-only platform credential would be an unbootstrappable product).
// A tenant could never want to override it, which is what makes it a credential
// rather than a configuration knob. It is therefore kept — as the PLATFORM's
// credential of last resort, read only after the platform-owned row is looked for,
// and never reachable from a tenant-side path.

let _stripe: Stripe | null = null

/**
 * The PLATFORM's Stripe client, resolved.
 *
 * Order: platform-owned `platform_credentials` row (owner_type='platform',
 * platform='stripe') → STRIPE_SECRET_KEY. A stored credential WINS, so rotating
 * the platform's Stripe account is a database write rather than a redeploy.
 *
 * THROWS with the resolver's own sentence when neither exists, and deliberately
 * does not cache the failure: the whole point of the DB tier is that it can start
 * existing without a restart.
 *
 * Not cached across resolutions either — resolution is one indexed read, and a
 * cached client would keep serving a rotated-away key until the lambda recycled.
 */
export async function getPlatformStripe(): Promise<Stripe> {
  const resolved = await resolvePlatformStripeAccount()
  if (resolved.status !== 'resolved') {
    throw new Error(`[Stripe/platform] ${resolved.message}`)
  }
  return new Stripe(resolved.account.secretKey, { apiVersion: STRIPE_API_VERSION, typescript: true })
}

/**
 * LEGACY SYNCHRONOUS PLATFORM CLIENT — env only, and PLATFORM SCOPE ONLY.
 *
 * Lazy: STRIPE_SECRET_KEY is required at first USE, not at module load, so static
 * page collection (`next build`) succeeds in an environment without runtime env
 * vars.
 *
 * ── DO NOT REACH FOR THIS ON A TENANT-SIDE PATH. ──
 * It is the platform's account by construction. A brokerage's vendor invoice, a
 * client payment, an agent payout — anything whose payee is not the platform —
 * must go through `resolveTenantStripeAccount`, which refuses instead of
 * substituting this key. `scripts/stripe-account-scope-simulator.ts` asserts the
 * importer roster of this module against STRIPE_MONEY_PATHS so a tenant-side
 * import cannot be added quietly.
 *
 * Kept (rather than deleted for `getPlatformStripe`) because three modules on the
 * PLATFORM side still consume it synchronously and belong to other lanes this
 * wave: app/actions/vendor-billing.ts, app/actions/vendor-payments.ts and
 * app/actions/admin/create-subscriber.ts. Their money paths are platform-payee
 * (vendor marketplace tier, subscriber provisioning) or Connect transfers made on
 * the platform's Connect platform, so the account this hands them is the correct
 * one today — the debt is the SOURCE (env rather than the resolver), not the
 * account. Migrating them is a one-line `await getPlatformStripe()` per call site.
 */
function getStripe(): Stripe {
  if (_stripe) return _stripe
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error(
      "STRIPE_SECRET_KEY is required: it is the PLATFORM's own Stripe credential (platform-scope only — a tenant's account is resolved from platform_credentials, never from the environment)",
    )
  }
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
  })
  return _stripe
}

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const s = getStripe() as any
    const v = s[prop]
    return typeof v === 'function' ? v.bind(s) : v
  },
})
