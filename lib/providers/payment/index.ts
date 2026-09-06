/**
 * PAYMENT PROVIDER
 * Owns all payment API calls: Stripe.
 * No business logic — pure API client wrappers.
 */

// ─── STRIPE ────────────────────────────────────────────────────────────────────

import { callConnector, type GatewayResponse } from "@/lib/agentic-os/connector-gateway"
import {
  resolvePlatformStripeAccount,
  resolveTenantStripeAccount,
  type ResolvedStripeAccount,
  type TenantStripeContext,
} from "@/lib/billing/resolve-stripe-account"
import { connectDestinationReachable } from "@/lib/billing/stripe-account-scope"

const STRIPE_BASE = "https://api.stripe.com"

// ═══════════════════════════════════════════════════════════════════════════
// WHOSE STRIPE ACCOUNT EACH CALL IS MADE ON — stated at the call, not assumed.
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER RULING (verbatim): "the stripe account will be per tenant and platform so
// no configuration should be hardcoded."
//
// This module used to answer that question with `process.env.STRIPE_SECRET_KEY`
// and a header comment reading "Stripe is a PLATFORM connector (one
// STRIPE_SECRET_KEY)". Under the ruling that is the defect: a brokerage paying a
// vendor, or a client paying a brokerage, is the TENANT's money, and settling it
// on the product's account issues a receipt naming the wrong merchant, refunds
// from the wrong balance, and puts the amount on the wrong entity's books.
//
// So the two MONEY-MOVING calls — `createTransfer` and `createPaymentIntent` —
// now take an explicit `StripeCallScope`. There is no default: a default is how
// the wrong account gets picked silently, and the payee is a fact the caller
// knows and this module does not. lib/billing/stripe-account-scope.ts holds the
// rule (the account belongs to the PAYEE) and names every path in the repo.
//
// The three ACCOUNT-ADMIN calls below (`createConnectedAccount`,
// `createAccountLink`, `getStripeBalance`) stay platform-scoped and say so in
// their own doc-comments: minting a Connect account happens on the Connect
// PLATFORM, and the balance probe is a reachability check on the platform's own
// credential.

/** Which account a call is made on. `tenant` REFUSES when that tenant has no
 *  Stripe credential — it never falls through to the platform's. */
export type StripeCallScope = { side: "platform" } | ({ side: "tenant" } & TenantStripeContext)

/** Resolve the account a call runs on, fail-closed, with the refusal as a value. */
async function resolveCallAccount(
  on: StripeCallScope,
): Promise<{ ok: true; account: ResolvedStripeAccount } | { ok: false; error: string; notConfigured: boolean }> {
  const res =
    on.side === "platform"
      ? await resolvePlatformStripeAccount()
      : await resolveTenantStripeAccount({ brokerageId: on.brokerageId, teamId: on.teamId, agentUserId: on.agentUserId })
  if (res.status === "resolved") return { ok: true, account: res.account }
  return { ok: false, error: res.message, notConfigured: res.status === "missing" }
}

/** Single egress choke point — every Stripe API call leaves through the connector-gateway. Stripe
 *  is form-urlencoded (gateway "form" bodyType); a connected-account call sets the Stripe-Account
 *  header. The KEY is resolved per call scope (platform vs tenant), never read from a global. */
function stripeReq<T = any>(
  secretKey: string,
  path: string,
  opts: { method?: "GET" | "POST"; form?: Record<string, string>; stripeAccount?: string } = {},
): Promise<GatewayResponse<T>> {
  return callConnector<T>({
    connector: "stripe",
    baseUrl: STRIPE_BASE,
    path,
    method: opts.method ?? (opts.form ? "POST" : "GET"),
    auth: { style: "bearer", token: secretKey },
    ...(opts.form ? { body: opts.form, bodyType: "form" as const } : {}),
    ...(opts.stripeAccount ? { headers: { "Stripe-Account": opts.stripeAccount } } : {}),
  })
}

/**
 * A payer label an operator can act on, built from the resolved account rather
 * than from whatever the caller happened to know. Used only in refusals.
 */
function payerLabel(account: ResolvedStripeAccount): string {
  return account.side === "platform" ? "The platform" : `${account.ownerType} ${account.ownerId}`
}

/**
 * THE SECOND HALF OF THE RULING, applied once for every money-moving call that
 * names a `destination`: the right account must also be able to ADDRESS the
 * payee. lib/billing/stripe-account-scope.ts :: connectDestinationReachable holds
 * the rule; this is the one place the resolved `mode` and a destination meet, so
 * it is the one place that can ask.
 *
 * Returns the refusal SENTENCE, or null when the pairing is addressable.
 */
function destinationRefusal(account: ResolvedStripeAccount, destinationAccountId?: string): string | null {
  if (!destinationAccountId) return null
  const reach = connectDestinationReachable({
    payerMode: account.mode,
    payerLabel: payerLabel(account),
    destinationAccountId,
  })
  return reach.ok ? null : reach.reason
}

export interface CreateTransferParams {
  amount: number
  destinationAccountId: string
  description?: string
  transactionId?: string
  /** Flat metadata carried onto the Stripe object. Form-encoded as metadata[k]. */
  metadata?: Record<string, string>
}

export interface CreateTransferResult {
  success: boolean
  transferId?: string
  amount?: number
  error?: string
  mock?: boolean
}

/**
 * Move money from an account's balance to a connected account (an agent's or a
 * vendor's payout).
 *
 * `on` is REQUIRED and has no default. The funds leave the payer's balance, so a
 * brokerage disbursing to its agent — or paying a vendor for a job it commissioned
 * — must pass `{ side: "tenant", brokerageId }`. `{ side: "platform" }` would pay
 * that vendor out of the PRODUCT's balance, which is not a smaller version of the
 * same thing.
 *
 * WIRED: `app/actions/vendor-payments.ts :: initiateVendorPayout` is this
 * function's caller. It previously called `stripe.transfers.create()` on the
 * platform seam directly — the `vendor_job_bill` residual named in
 * TENANT_MONEY_ON_PLATFORM_KEY — and was repointed here rather than growing a
 * second transfer implementation (CLAUDE.md §6).
 *
 * A Stripe API failure comes back as `{ success: false, error }` rather than as a
 * throw: every caller is a `"use server"` action whose client renders `error`, and
 * a thrown provider error there renders as "Unexpected error" with the reason lost.
 */
export async function createTransfer(params: CreateTransferParams, on: StripeCallScope): Promise<CreateTransferResult> {
  const resolved = await resolveCallAccount(on)
  if (!resolved.ok) {
    return { success: false, error: resolved.error, mock: resolved.notConfigured }
  }
  const { secretKey, connectedAccountId, mode } = resolved.account

  const unreachable = destinationRefusal(resolved.account, params.destinationAccountId)
  if (unreachable) return { success: false, error: unreachable }

  const form: Record<string, string> = {
    amount: Math.round(params.amount * 100).toString(),
    currency: "usd",
    destination: params.destinationAccountId,
    description: params.description || "Commission transfer",
  }
  for (const [k, v] of Object.entries(params.metadata ?? {})) form[`metadata[${k}]`] = v

  const res = await stripeReq<{ id: string; amount: number }>(secretKey, "v1/transfers", {
    form,
    // A `connect`-mode tenant banks through an acct_… under the platform's Connect
    // platform: the platform's key signs and the header addresses the tenant. Omit
    // it and the same key debits the PLATFORM's balance instead — the substitution
    // this whole module was changed to prevent.
    ...(mode === "connect" && connectedAccountId ? { stripeAccount: connectedAccountId } : {}),
  })
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || `Stripe transfer error (${res.status ?? "—"})` }
  }
  return { success: true, transferId: res.data.id, amount: res.data.amount / 100 }
}

export interface CreatePaymentIntentParams {
  amount: number
  currency?: string
  description?: string
  metadata?: Record<string, string>
}

export interface CreatePaymentIntentResult {
  success: boolean
  clientSecret?: string
  paymentIntentId?: string
  error?: string
  mock?: boolean
}

/**
 * Take a payment. `on` is REQUIRED: the merchant of record is whoever COLLECTS,
 * and a client paying a brokerage is the brokerage's charge — its statement
 * descriptor, its balance, its refund, its 1099. Passing `{ side: "platform" }`
 * for that would make the product the merchant on a sale it had no part in.
 */
export async function createPaymentIntent(
  params: CreatePaymentIntentParams,
  on: StripeCallScope,
): Promise<CreatePaymentIntentResult> {
  const resolved = await resolveCallAccount(on)
  if (!resolved.ok) {
    return { success: false, error: resolved.error, mock: resolved.notConfigured }
  }
  const { secretKey, connectedAccountId, mode } = resolved.account

  const form: Record<string, string> = {
    amount: Math.round(params.amount * 100).toString(),
    currency: params.currency || "usd",
  }
  if (params.description) form.description = params.description
  if (params.metadata) {
    for (const [key, value] of Object.entries(params.metadata)) form[`metadata[${key}]`] = value
  }

  const res = await stripeReq<{ client_secret: string; id: string }>(secretKey, "v1/payment_intents", {
    form,
    ...(mode === "connect" && connectedAccountId ? { stripeAccount: connectedAccountId } : {}),
  })
  if (!res.ok || !res.data) throw new Error(res.error || "Stripe PaymentIntent error")
  return { success: true, clientSecret: res.data.client_secret, paymentIntentId: res.data.id }
}

// ═══════════════════════════════════════════════════════════════════════════
// HOSTED CHECKOUT — the payer is a person on a page, so the merchant is visible.
// ═══════════════════════════════════════════════════════════════════════════
//
// BUILT (CLAUDE.md §1.2 — no duplicate existed): `createPaymentIntent` above takes
// a payment, but it returns a client secret for an in-page element. The portal
// pay-online lane needs a HOSTED Stripe Checkout URL, and there was no
// scope-carrying way to make one — `app/actions/vendor-payments.ts` reached for
// the platform seam instead, which is the `client_payment` residual that was named
// in TENANT_MONEY_ON_PLATFORM_KEY.
//
// This matters more here than on any other path, because Checkout is the one place
// the merchant of record is SHOWN: Stripe's hosted page carries the account's
// business name, its support email and its statement descriptor, and the card
// statement carries them again. On the platform's key a buyer paying their
// brokerage's vendor saw the PRODUCT's name on the page and on their statement,
// and their refund would have come from the product's balance.
//
// `on` is REQUIRED, for the same reason it is on the two calls above.

export interface CreateCheckoutSessionParams {
  /** Major units (dollars). Converted to the smallest unit here, once. */
  amount: number
  currency?: string
  /** What the payer sees as the line item. */
  productName: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  /** DESTINATION CHARGE: the connected account the funds settle onto. Must belong
   *  to the same Connect platform as the account resolved from `on` — asserted, and
   *  refused with a sentence rather than an opaque Stripe error. */
  destinationAccountId?: string
  /** Metadata on the Checkout Session itself (read back by the confirm path). */
  metadata?: Record<string, string>
  /** Metadata on the resulting PaymentIntent (what a webhook sees). */
  paymentIntentMetadata?: Record<string, string>
}

export interface CreateCheckoutSessionResult {
  success: boolean
  url?: string
  sessionId?: string
  error?: string
  /** TRUE when the refusal is "this party has no Stripe account", not "Stripe said no". */
  notConfigured?: boolean
}

export async function createCheckoutSession(
  params: CreateCheckoutSessionParams,
  on: StripeCallScope,
): Promise<CreateCheckoutSessionResult> {
  const resolved = await resolveCallAccount(on)
  if (!resolved.ok) {
    return { success: false, error: resolved.error, notConfigured: resolved.notConfigured }
  }
  const { secretKey, connectedAccountId, mode } = resolved.account

  const unreachable = destinationRefusal(resolved.account, params.destinationAccountId)
  if (unreachable) return { success: false, error: unreachable }

  const amountMinor = Math.round(params.amount * 100)
  if (!(amountMinor > 0)) return { success: false, error: "Checkout amount must be greater than zero" }

  // The gateway's "form" bodyType takes a FLAT map with pre-flattened keys.
  const form: Record<string, string> = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": params.currency || "usd",
    "line_items[0][price_data][unit_amount]": amountMinor.toString(),
    "line_items[0][price_data][product_data][name]": params.productName,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  }
  if (params.customerEmail) form.customer_email = params.customerEmail
  if (params.destinationAccountId) {
    form["payment_intent_data[transfer_data][destination]"] = params.destinationAccountId
  }
  for (const [k, v] of Object.entries(params.metadata ?? {})) form[`metadata[${k}]`] = v
  for (const [k, v] of Object.entries(params.paymentIntentMetadata ?? {})) {
    form[`payment_intent_data[metadata][${k}]`] = v
  }

  const res = await stripeReq<{ id: string; url: string | null }>(secretKey, "v1/checkout/sessions", {
    form,
    // Same header, same reason as createTransfer: omit it on a connect-mode tenant
    // and the platform becomes the merchant of record on the hosted page.
    ...(mode === "connect" && connectedAccountId ? { stripeAccount: connectedAccountId } : {}),
  })
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || `Stripe Checkout error (${res.status ?? "—"})` }
  }
  if (!res.data.url) return { success: false, error: "Stripe did not return a checkout URL" }
  return { success: true, url: res.data.url, sessionId: res.data.id }
}

export interface RetrievedCheckoutSession {
  success: boolean
  paymentStatus?: string
  metadata?: Record<string, string>
  paymentIntentId?: string | null
  error?: string
  notConfigured?: boolean
}

/**
 * Read a Checkout Session back — the settlement half of the pair above.
 *
 * `on` is REQUIRED and MUST name the same account the session was created on. A
 * session lives on ONE Stripe account: retrieving it with a different key returns
 * "No such checkout session", which the confirm path would read as a mismatched or
 * unpaid session and refuse to mark a genuinely paid invoice as paid. That is why
 * this moved out of the platform seam together with its creator rather than after
 * it.
 */
export async function retrieveCheckoutSession(
  sessionId: string,
  on: StripeCallScope,
): Promise<RetrievedCheckoutSession> {
  const resolved = await resolveCallAccount(on)
  if (!resolved.ok) {
    return { success: false, error: resolved.error, notConfigured: resolved.notConfigured }
  }
  const { secretKey, connectedAccountId, mode } = resolved.account

  const res = await stripeReq<{
    id: string
    payment_status: string
    metadata: Record<string, string> | null
    payment_intent: string | { id: string } | null
  }>(secretKey, `v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    ...(mode === "connect" && connectedAccountId ? { stripeAccount: connectedAccountId } : {}),
  })
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || `Stripe Checkout read error (${res.status ?? "—"})` }
  }
  const pi = res.data.payment_intent
  return {
    success: true,
    paymentStatus: res.data.payment_status,
    metadata: res.data.metadata ?? {},
    paymentIntentId: typeof pi === "string" ? pi : pi?.id ?? null,
  }
}

export interface CreateConnectedAccountResult {
  success: boolean
  accountId?: string
  onboardingUrl?: string
  error?: string
  mock?: boolean
}

/** PLATFORM-SCOPED BY CONSTRUCTION. A Connect account is minted UNDER a Connect
 *  platform, and this product has exactly one — so this call is the platform's
 *  even when the account it creates will belong to an agent, a team or a vendor.
 *  Ownership of the resulting acct_… is recorded owner-scoped in
 *  platform_credentials by app/actions/connections/connection-center.ts. */
export async function createConnectedAccount(email: string): Promise<CreateConnectedAccountResult> {
  const resolved = await resolveCallAccount({ side: "platform" })
  if (!resolved.ok) {
    return { success: false, error: resolved.error, mock: resolved.notConfigured }
  }
  const secretKey = resolved.account.secretKey

  const accountRes = await stripeReq<{ id: string }>(secretKey, "v1/accounts", {
    form: { type: "express", email, "capabilities[transfers][requested]": "true" },
  })
  if (!accountRes.ok || !accountRes.data) throw new Error(accountRes.error || "Stripe account creation error")
  const account = accountRes.data

  const linkRes = await stripeReq<{ url: string }>(secretKey, "v1/account_links", {
    form: {
      account: account.id,
      refresh_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/payments`,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/payments?success=true`,
      type: "account_onboarding",
    },
  })
  // The account exists even if the onboarding link failed — surface the link error so the caller
  // doesn't dead-end with an undefined onboardingUrl and a misleading success:true.
  if (!linkRes.ok || !linkRes.data?.url) {
    return { success: false, accountId: account.id, error: linkRes.error || "Stripe account_links error" }
  }

  return { success: true, accountId: account.id, onboardingUrl: linkRes.data.url }
}

/** Create a fresh Account Link to (re)onboard an EXISTING Connect account. Used when the owner
 *  already has a stripe account_id and needs to resume/refresh onboarding. */
export async function createAccountLink(
  accountId: string,
  returnPath = "/settings/payments",
): Promise<{ success: boolean; onboardingUrl?: string; error?: string }> {
  // PLATFORM-SCOPED for the same reason as createConnectedAccount: an account link
  // is issued by the Connect platform that owns the acct_….
  const resolved = await resolveCallAccount({ side: "platform" })
  if (!resolved.ok) return { success: false, error: resolved.error }
  const secretKey = resolved.account.secretKey
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  const res = await stripeReq<{ url: string }>(secretKey, "v1/account_links", {
    form: {
      account: accountId,
      refresh_url: `${appUrl}${returnPath}?stripe=refresh`,
      return_url: `${appUrl}${returnPath}?stripe=complete`,
      type: "account_onboarding",
    },
  })
  if (!res.ok || !res.data?.url) return { success: false, error: res.error || "Stripe account_links error" }
  return { success: true, onboardingUrl: res.data.url }
}

// ─── Account health / balance / payouts ─────────────────────────────────────────

// ─── REMOVED in the orphan burn-down (lane O) ────────────────────────────────
//
// `getStripeAccountStatus(accountId?)` + its StripeAccountStatus interface —
// DELETED.
// SURVIVOR: lib/agentic-os/connector-probe.ts:84 — the `stripe` probe spec,
// which hits the SAME endpoint (https://api.stripe.com/v1/account) and reads the
// same fields (`id`, `charges_enabled`).
//
// Its own doc-comment claimed "Used by the connector probe". It was not: the
// probe is spec-driven and declares its own health URL, auth style and tolerant
// response shape, so it never imported this. That stale claim is the reason
// this sat unreferenced without anyone noticing.
//
// The probe is the more complete of the two on the axis that matters here: it
// classifies the result into the connector-health status vocabulary and reports
// SHAPE DRIFT when Stripe renames a field, which this bare mapper could not do
// — it would have silently produced `chargesEnabled: false` on a rename and
// read as a disabled account rather than a vendor change. Nothing needed
// merging; the two extra fields this returned (`details_submitted`,
// `requirements.currently_due`) have no reader, and a probe spec gains a field
// by declaring it, not by growing a second function.

// ─── KEPT AND DELIBERATELY NOT WIRED — OWNER DECISION, SETTLED (lane L) ──────
//
// `getStripeBalance()` has no caller and no survivor: nothing else in this repo
// reads the platform Stripe balance. It is not deleted, because deleting it
// removes a capability rather than a duplicate. It is also NOT being wired, and
// that is now a decision rather than a deferral. Re-verified this pass:
//
//   · NO CALLER. `grep -rn getStripeBalance` over the tree returns this
//     definition and this comment, nothing else.
//   · THE ENDPOINT IS ALREADY REACHED, FOR A DIFFERENT PURPOSE. `v1/balance` is
//     hit by app/api/cron/health-check/route.ts:110 and
//     lib/platform/go-live-readiness.ts:137 — both as a CREDENTIAL-REACHABILITY
//     probe that cares only whether the call succeeds. Neither reads a figure.
//     So what is unreferenced here is not the request; it is the SUMMED BALANCE.
//   · NO SURFACE, BY DESIGN. Every financial surface in this product reads OS
//     LEDGERS. lib/finance/qb-reconciliation.ts states the contract outright —
//     OS ledgers against OS-recorded exports, never a live provider pull — and
//     app/api/cron/stripe-drift/route.ts, the one place that does compare against
//     live Stripe, compares CONFIGURATION (a tier's price) and explicitly
//     auto-fixes nothing.
//
// WHAT BUILDING IT WOULD MEAN, stated so the cost is visible before anyone spends
// it: a platform-treasury surface introduces a number that is authoritative, that
// no OS ledger produced, and that no OS ledger can be reconciled against — the
// Stripe balance nets settlement timing, refunds, disputes, fees and payouts in
// ways the ledgers deliberately do not model. Putting it on a screen next to
// ledger figures invites exactly the comparison it cannot survive, and the first
// time the two disagree the ledger is what someone will "correct". It would also
// need a new authority tier: a superadmin-only read that must never be a
// `"use server"` export, because the balance belongs to the platform and no
// tenant-facing action should be able to ask for it. That is a product decision
// about what this system claims to know about money, not a wiring gap — so it
// stays unwired until an owner asks for it in those terms.
//
// ── RE-EXAMINED (next burn-down wave), AND THERE IS A WIRING THAT DOES NOT COST
//    THE PRODUCT DECISION ABOVE. Recorded rather than done, because the two files
//    it touches belong to other lanes.
//
// The adjudication above is upheld: no treasury SURFACE, no `"use server"` export,
// no ledger-adjacent figure on a screen. But the second bullet of that adjudication
// is itself a DUPLICATE finding that was left un-acted-on. `v1/balance` is requested
// twice more in this tree, each time as a hand-rolled fetch:
//   · app/api/cron/health-check/route.ts:110
//   · lib/platform/go-live-readiness.ts:137
// Both want ONE bit — did the credential work — and each re-implements the key
// lookup and the request to get it. This function already does both, better, and
// returns `{ success, error }`, which is exactly that bit plus a reason.
//
// So the merge direction is INWARD, and it costs nothing the note above defends:
// both probes call `getStripeBalance()` and read ONLY `success` / `error`, never
// `available` or `pending`. No figure is surfaced, no new authority tier is needed,
// the balance still reaches no screen — and the two inline copies of the request go
// away. Anything else that later wants the SUM still has to make the product
// decision above first.
//
// ── DONE, not reported. This lane owns lib/providers/payment/** this wave and
//    the two probe files are not another lane's, so the wiring above is MADE:
//      · app/api/cron/health-check/route.ts   (stripe checkFn)
//      · lib/platform/go-live-readiness.ts    (the Stripe money check)
//    Both now call getStripeBalance() and read ONLY the credential-reachability
//    fields — `success`, `error`, `httpStatus`, `notConfigured`, `livemode`.
//    Neither reads `available` or `pending`; no figure reaches a screen; the
//    product decision above is untouched. Two hand-rolled copies of the key
//    lookup and the /v1/balance request are gone.
//
//    THREE FIELDS WERE ADDED TO THE RESULT so the probes lose nothing they had:
//    `httpStatus` (health-check records httpStatusCode and distinguishes
//    "degraded" from "down" by whether a status came back at all), `livemode`
//    (go-live-readiness tells an operator TEST-mode keys apart from LIVE ones —
//    shipping without that check is how a launch charges nobody), and
//    `notConfigured` (an unset key is "not configured", not "broken", and the
//    two are different verdicts to an operator). None of them is a balance.

export interface StripeBalanceResult {
  success: boolean
  /** Available balance in major units (e.g. dollars), summed per currency. */
  available?: Record<string, number>
  pending?: Record<string, number>
  error?: string
  /** HTTP status Stripe returned, or null if the request never got one. */
  httpStatus?: number | null
  /** TRUE when the PLATFORM has no Stripe credential at all — no platform-owned
   *  platform_credentials row AND no STRIPE_SECRET_KEY. Distinct from a rejected
   *  key, and distinct again from a credential store that could not be READ,
   *  which comes back `success:false` with `notConfigured` false. */
  notConfigured?: boolean
  /** Stripe's own `livemode` flag: false means a TEST key. */
  livemode?: boolean
}

/** PLATFORM-SCOPED. This is the credential-reachability probe for the PLATFORM's
 *  own Stripe account, read by app/api/cron/health-check and
 *  lib/platform/go-live-readiness. It resolves the platform credential the same
 *  way every other platform call does, so a stored platform row is probed rather
 *  than a stale env key. A tenant's account is probed through its own connection
 *  health, never here. */
export async function getStripeBalance(): Promise<StripeBalanceResult> {
  const resolved = await resolveCallAccount({ side: "platform" })
  if (!resolved.ok) {
    return {
      success: false,
      notConfigured: resolved.notConfigured,
      httpStatus: null,
      error: resolved.error,
    }
  }
  const secretKey = resolved.account.secretKey

  const res = await stripeReq<{
    available: Array<{ amount: number; currency: string }>
    pending: Array<{ amount: number; currency: string }>
    livemode?: boolean
  }>(secretKey, "v1/balance")
  if (!res.ok || !res.data) {
    return {
      success: false,
      httpStatus: res.status,
      error: res.error || `Stripe balance error (${res.status ?? "\u2014"})`,
    }
  }
  const data = res.data
  const sum = (rows: Array<{ amount: number; currency: string }> = []) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.currency] = (acc[r.currency] ?? 0) + r.amount / 100
      return acc
    }, {})
  return {
    success: true,
    httpStatus: res.status,
    livemode: data.livemode === true,
    available: sum(data.available),
    pending: sum(data.pending),
  }
}

// ─── REMOVED in the orphan burn-down (lane O) ────────────────────────────────
//
// `createPayout(params)` + CreatePayoutParams / CreatePayoutResult — DELETED.
// SURVIVOR: `createTransfer` at the top of this file — exported through
// lib/providers/index.ts:37 and reached from app/actions/external-services.ts,
// i.e. the lane the Agent Payouts surface
// (app/config/navigation-config.ts:418 → /dashboard/financials/payouts) and the
// vendor payments flow (app/actions/vendor-payments.ts) actually run on.
//
// These are NOT the same Stripe operation and only one of them is this
// product's. `createTransfer` moves platform money TO a connected account —
// paying an agent or a vendor, which is what this system does. `v1/payouts`
// moves a Stripe BALANCE to a BANK ACCOUNT; with no `destination` in the form
// it targets the account's default external account, so on the platform key it
// was "sweep the platform's Stripe balance to the platform's bank". No surface
// in this repo asks for that, and it is the last function that should be one
// import away from a `"use server"` boundary that takes a caller-supplied
// amount.
//
// Nothing was lost: paying someone still works, through the transfer that is
// already wired. If a treasury sweep is ever genuinely wanted it is an
// operator/admin decision with its own gate and its own ledger row, not a
// revival of this.
