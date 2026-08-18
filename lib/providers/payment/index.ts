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

// ─── KEPT, RECORDED AS A BUILD LINE (orphan burn-down, lane O) ───────────────
//
// `getStripeBalance()` has no caller and, unlike the two functions deleted
// around it, no survivor either — nothing else in this repo reads the platform
// Stripe balance. It is NOT deleted, because deleting it would remove a real
// capability rather than a duplicate.
//
// THE BLOCKER, precisely: there is no platform-treasury surface to hang it on,
// and choosing one is an owner decision, not a wiring decision. Every financial
// surface in this product deliberately reads OS LEDGERS (see
// lib/finance/qb-reconciliation.ts, whose whole contract is "OS ledgers vs
// OS-recorded exports, never a live provider pull"), so a live balance read is
// a new KIND of number here, not a missing caller. When it is wired: it is a
// superadmin-only read, and it must not become a `"use server"` export — the
// balance belongs to the platform, so no tenant-facing action should be able to
// ask for it.

export interface StripeBalanceResult {
  success: boolean
  /** Available balance in major units (e.g. dollars), summed per currency. */
  available?: Record<string, number>
  pending?: Record<string, number>
  error?: string
}

export async function getStripeBalance(): Promise<StripeBalanceResult> {
  const secretKey = getStripeKey()
  if (!secretKey) return { success: false, error: "Stripe not configured." }

  const res = await stripeReq<{ available: Array<{ amount: number; currency: string }>; pending: Array<{ amount: number; currency: string }> }>(secretKey, "v1/balance")
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || `Stripe balance error (${res.status ?? "—"})` }
  }
  const data = res.data
  const sum = (rows: Array<{ amount: number; currency: string }> = []) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.currency] = (acc[r.currency] ?? 0) + r.amount / 100
      return acc
    }, {})
  return { success: true, available: sum(data.available), pending: sum(data.pending) }
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
