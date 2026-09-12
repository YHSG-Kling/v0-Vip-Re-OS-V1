// lib/billing/stripe-webhook-secrets.ts
// ═══════════════════════════════════════════════════════════════════════════
// PER-ACCOUNT WEBHOOK VERIFICATION. A webhook has no session, so the sender is
// established by WHICH SIGNING SECRET VERIFIES THE SIGNATURE — never by anything
// the request says about itself.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS REPLACES. Both Stripe endpoints verified against ONE hardcoded env
// secret:
//
//   app/api/billing/webhook/route.ts       process.env.STRIPE_WEBHOOK_SECRET
//   app/api/webhooks/stripe/vendor/route.ts process.env.STRIPE_VENDOR_WEBHOOK_SECRET
//
// One secret is one Stripe account. The owner's ruling — "the stripe account will
// be per tenant and platform" — makes N+1 accounts, and a delivery from a
// tenant's own account cannot verify against the platform's secret. Under the old
// shape those deliveries arrive, fail verification, and are answered with
// "Invalid signature": indistinguishable from an attacker, so nobody investigates
// and the tenant's billing lifecycle silently never reconciles.
//
// ── WHY A CANDIDATE WALK, AND WHY THAT IS NOT A GUESS ──────────────────────
//
// The signature IS the identity claim, and it is cryptographic: an HMAC-SHA256
// over `${timestamp}.${payload}` verifies under exactly one secret and no other.
// So trying the platform's secret and then each tenant's is not "guessing which
// tenant" — it is checking a proof N times. A forged body verifies under none of
// them, and the answer is a refusal.
//
// The alternative — reading a tenant id out of the payload and looking up that
// tenant's secret — is the IDOR shape CLAUDE.md §4 names, wearing a webhook. The
// payload is unverified at the moment you would have to trust it.
//
// PLATFORM FIRST, on purpose. It is the account nearly every delivery is from,
// and putting it first means the common path is one HMAC.
//
// ── THE COST, PUBLISHED RATHER THAN HIDDEN ─────────────────────────────────
//
// The walk is O(tenants-with-a-webhook-secret) HMACs in the worst case (a forged
// or unknown delivery), bounded by TENANT_WEBHOOK_CANDIDATE_LIMIT (500). Past
// that bound a delivery from an unlisted tenant is REFUSED with a message saying
// the roster was capped — honest and loud. It is not silently dropped, and it is
// not waved through. As of 2026-08-24, `platform_credentials` holds 0 rows, so
// every delivery costs exactly one HMAC today.
//
// ── WHAT THE CALLER GETS, AND WHY IT MATTERS MORE THAN THE EVENT ───────────
//
// A verified result names the OWNER whose secret verified. That owner — not
// `event.data.object.metadata.brokerage_id` — is the authenticated principal of
// the delivery, and the routes use it to refuse cross-tenant attribution. See
// app/api/billing/webhook/route.ts: a delivery signed by tenant X carrying
// metadata naming tenant Y is a refusal, because on that path metadata is written
// by whoever owns the signing account.

import "server-only"
import Stripe from "stripe"
import {
  PLATFORM_WEBHOOK_ENV,
  STRIPE_WEBHOOK_ROUTES,
  type StripeWebhookEndpoint,
} from "./stripe-account-scope"
import {
  readTenantStripeWebhookCredentials,
  resolvePlatformStripeAccount,
  TENANT_WEBHOOK_CANDIDATE_LIMIT,
  type StripeOwnerScope,
} from "./resolve-stripe-account"

/**
 * ONE Stripe client, used ONLY for `webhooks.constructEvent`.
 *
 * `constructEvent` is pure crypto: it recomputes an HMAC-SHA256 of
 * `${timestamp}.${payload}` under the SIGNING secret and compares it in constant
 * time. It makes no network call and never reads the API key, so which key the
 * client was constructed with cannot affect the verdict. Constructing one client
 * per candidate would allocate N clients per delivery to no purpose.
 *
 * The placeholder is spelled out rather than borrowed from the environment so no
 * reader can mistake this for a call that authenticates as the platform.
 */
const VERIFIER_KEY_IS_UNUSED = "sk_signature_verification_only_never_sent_to_stripe"
let _verifier: Stripe | null = null
function verifier(): Stripe {
  if (!_verifier) _verifier = new Stripe(VERIFIER_KEY_IS_UNUSED, { apiVersion: "2026-02-25.clover", typescript: true })
  return _verifier
}

export interface WebhookCandidate {
  ownerType: StripeOwnerScope
  ownerId: string
  webhookSecret: string
  credentialId: string | null
}

export type StripeWebhookVerification =
  | {
      status: "verified"
      event: Stripe.Event
      /** The authenticated principal of this delivery. Trust THIS, not the payload. */
      ownerType: StripeOwnerScope
      ownerId: string
      credentialId: string | null
      /** How many secrets were available; published beside the verdict. */
      candidateCount: number
    }
  /** Every available secret was tried and none verified. */
  | { status: "unverified"; candidateCount: number; tenantRosterCapped: boolean; message: string }
  /** No secret exists at all for this endpoint — nothing could have been checked. */
  | { status: "no_candidates"; message: string }
  /** A source of secrets could not be READ. Refuse: an unread roster may hold the
   *  very secret that would have verified this delivery, and answering "invalid
   *  signature" would blame the sender for our outage. */
  | { status: "unreadable"; message: string }

/**
 * Build the candidate roster for one endpoint: the platform's secret first, then
 * every tenant credential that stores one.
 *
 * Reports `unreadable` rather than returning a short roster when the platform
 * credential or the tenant roster cannot be read — a partial roster produces a
 * confident "invalid signature" about a delivery that would have verified.
 */
export async function stripeWebhookCandidates(
  endpoint: StripeWebhookEndpoint,
): Promise<
  | { status: "ok"; candidates: WebhookCandidate[]; tenantRosterCapped: boolean }
  | { status: "unreadable"; message: string }
> {
  const candidates: WebhookCandidate[] = []

  const platform = await resolvePlatformStripeAccount(endpoint)
  if (platform.status === "unreadable") {
    return { status: "unreadable", message: `platform Stripe credential unreadable — ${platform.message}` }
  }
  if (platform.status === "resolved" && platform.account.webhookSecret) {
    candidates.push({
      ownerType: "platform",
      ownerId: "platform",
      webhookSecret: platform.account.webhookSecret,
      credentialId: platform.account.credentialId,
    })
  }

  const tenants = await readTenantStripeWebhookCredentials(endpoint)
  if (tenants.status === "unreadable") {
    return { status: "unreadable", message: `tenant Stripe credential roster unreadable — ${tenants.message}` }
  }
  for (const row of tenants.rows) {
    candidates.push({
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      webhookSecret: row.webhookSecret,
      credentialId: row.credentialId,
    })
  }

  return { status: "ok", candidates, tenantRosterCapped: tenants.capped }
}

/**
 * Verify a delivery against every account that could have sent it, and report WHO
 * signed it.
 *
 * FAIL-CLOSED at every branch: no roster, an unreadable roster and a signature
 * that matches nothing are three different answers, and not one of them is
 * "process it anyway".
 */
export async function verifyStripeWebhook(args: {
  endpoint: StripeWebhookEndpoint
  /** The RAW request body. Must be the exact bytes Stripe signed — never re-serialized JSON. */
  body: string
  signature: string
}): Promise<StripeWebhookVerification> {
  const roster = await stripeWebhookCandidates(args.endpoint)
  if (roster.status === "unreadable") {
    return {
      status: "unreadable",
      message:
        `Cannot verify a Stripe delivery to ${STRIPE_WEBHOOK_ROUTES[args.endpoint]}: ${roster.message}. ` +
        `Refusing rather than answering "invalid signature" — the roster we could not read may hold the secret that verifies this delivery.`,
    }
  }

  if (roster.candidates.length === 0) {
    return {
      status: "no_candidates",
      message:
        `No Stripe webhook signing secret is configured for ${STRIPE_WEBHOOK_ROUTES[args.endpoint]}. ` +
        `Set ${PLATFORM_WEBHOOK_ENV[args.endpoint]} for the PLATFORM's account, or store a signing secret on the ` +
        `owning tenant's Stripe credential in platform_credentials (config.${args.endpoint === "vendor_marketplace" ? "vendor_webhook_secret" : "webhook_secret"}). ` +
        `Until one exists every delivery to this endpoint is refused, which is why nothing reconciles.`,
    }
  }

  const client = verifier()
  for (const candidate of roster.candidates) {
    try {
      const event = client.webhooks.constructEvent(args.body, args.signature, candidate.webhookSecret)
      return {
        status: "verified",
        event: event as Stripe.Event,
        ownerType: candidate.ownerType,
        ownerId: candidate.ownerId,
        credentialId: candidate.credentialId,
        candidateCount: roster.candidates.length,
      }
    } catch {
      // A failed verification against ONE candidate is the normal case for every
      // candidate but the sender's. It is not an error and is not logged: logging
      // it would emit N-1 scary lines per successful delivery.
      continue
    }
  }

  return {
    status: "unverified",
    candidateCount: roster.candidates.length,
    tenantRosterCapped: roster.tenantRosterCapped,
    message:
      `Stripe signature did not verify against any of the ${roster.candidates.length} configured signing secret(s) for ` +
      `${STRIPE_WEBHOOK_ROUTES[args.endpoint]}` +
      (roster.tenantRosterCapped
        ? `. NOTE: the tenant roster was capped at ${TENANT_WEBHOOK_CANDIDATE_LIMIT} rows, so a tenant beyond that cap would also land here.`
        : `.`),
  }
}
