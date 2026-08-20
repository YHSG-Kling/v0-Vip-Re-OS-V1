/**
 * PAYMENT PROVIDER
 * Owns all payment API calls: Stripe.
 * No business logic — pure API client wrappers.
 */

// ─── STRIPE ────────────────────────────────────────────────────────────────────

import { callConnector, type GatewayResponse } from "@/lib/agentic-os/connector-gateway"

const STRIPE_BASE = "https://api.stripe.com"

function getStripeKey(): string | null {
  return process.env.STRIPE_SECRET_KEY || null
}

/** Single egress choke point — every Stripe API call leaves through the connector-gateway. Stripe
 *  is form-urlencoded (gateway "form" bodyType); a connected-account call sets the Stripe-Account
 *  header. Stripe is a PLATFORM connector (one STRIPE_SECRET_KEY). */
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

export interface CreateTransferParams {
  amount: number
  destinationAccountId: string
  description?: string
  transactionId?: string
}

export interface CreateTransferResult {
  success: boolean
  transferId?: string
  amount?: number
  error?: string
  mock?: boolean
}

export async function createTransfer(params: CreateTransferParams): Promise<CreateTransferResult> {
  const secretKey = getStripeKey()

  if (!secretKey) {
    return {
      success: false,
      error: "Stripe not configured. Add STRIPE_SECRET_KEY to environment variables.",
      mock: true,
    }
  }

  const res = await stripeReq<{ id: string; amount: number }>(secretKey, "v1/transfers", {
    form: {
      amount: Math.round(params.amount * 100).toString(),
      currency: "usd",
      destination: params.destinationAccountId,
      description: params.description || "Commission transfer",
    },
  })
  if (!res.ok || !res.data) throw new Error(res.error || "Stripe API error")
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

export async function createPaymentIntent(
  params: CreatePaymentIntentParams
): Promise<CreatePaymentIntentResult> {
  const secretKey = getStripeKey()

  if (!secretKey) {
    return {
      success: false,
      error: "Stripe not configured. Add STRIPE_SECRET_KEY to environment variables.",
      mock: true,
    }
  }

  const form: Record<string, string> = {
    amount: Math.round(params.amount * 100).toString(),
    currency: params.currency || "usd",
  }
  if (params.description) form.description = params.description
  if (params.metadata) {
    for (const [key, value] of Object.entries(params.metadata)) form[`metadata[${key}]`] = value
  }

  const res = await stripeReq<{ client_secret: string; id: string }>(secretKey, "v1/payment_intents", { form })
  if (!res.ok || !res.data) throw new Error(res.error || "Stripe PaymentIntent error")
  return { success: true, clientSecret: res.data.client_secret, paymentIntentId: res.data.id }
}

export interface CreateConnectedAccountResult {
  success: boolean
  accountId?: string
  onboardingUrl?: string
  error?: string
  mock?: boolean
}

export async function createConnectedAccount(email: string): Promise<CreateConnectedAccountResult> {
  const secretKey = getStripeKey()

  if (!secretKey) {
    return {
      success: false,
      error: "Stripe not configured.",
      mock: true,
    }
  }

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
  const secretKey = getStripeKey()
  if (!secretKey) return { success: false, error: "Stripe not configured." }
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
  /** TRUE when STRIPE_SECRET_KEY is unset — distinct from a rejected key. */
  notConfigured?: boolean
  /** Stripe's own `livemode` flag: false means a TEST key. */
  livemode?: boolean
}

export async function getStripeBalance(): Promise<StripeBalanceResult> {
  const secretKey = getStripeKey()
  if (!secretKey) {
    return { success: false, notConfigured: true, httpStatus: null, error: "Stripe not configured." }
  }

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
