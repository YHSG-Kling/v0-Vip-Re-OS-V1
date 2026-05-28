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

  return { success: true, accountId: account.id, onboardingUrl: linkRes.data?.url }
}

// ─── Account health / balance / payouts ─────────────────────────────────────────

export interface StripeAccountStatus {
  success: boolean
  accountId?: string
  chargesEnabled?: boolean
  payoutsEnabled?: boolean
  detailsSubmitted?: boolean
  /** Requirements still owed before the account is fully enabled. */
  currentlyDue?: string[]
  error?: string
}

/** Liveness + auth + onboarding-state probe. With no accountId, reads the platform account
 *  (GET /v1/account); with one, reads that connected account. Used by the connector probe. */
export async function getStripeAccountStatus(accountId?: string): Promise<StripeAccountStatus> {
  const secretKey = getStripeKey()
  if (!secretKey) return { success: false, error: "Stripe not configured." }

  const path = accountId ? `v1/accounts/${encodeURIComponent(accountId)}` : "v1/account"
  const res = await stripeReq<any>(secretKey, path)
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || `Stripe account error (${res.status ?? "—"})` }
  }
  const data = res.data
  return {
    success: true,
    accountId: data.id,
    chargesEnabled: !!data.charges_enabled,
    payoutsEnabled: !!data.payouts_enabled,
    detailsSubmitted: !!data.details_submitted,
    currentlyDue: data.requirements?.currently_due ?? [],
  }
}

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

export interface CreatePayoutParams {
  amount: number
  currency?: string
  /** Connected account to pay out FROM (Stripe-Account header), when applicable. */
  stripeAccountId?: string
  description?: string
}

export interface CreatePayoutResult {
  success: boolean
  payoutId?: string
  amount?: number
  error?: string
}

export async function createPayout(params: CreatePayoutParams): Promise<CreatePayoutResult> {
  const secretKey = getStripeKey()
  if (!secretKey) return { success: false, error: "Stripe not configured." }

  const form: Record<string, string> = {
    amount: Math.round(params.amount * 100).toString(),
    currency: params.currency || "usd",
  }
  if (params.description) form.description = params.description

  const res = await stripeReq<{ id: string; amount: number }>(secretKey, "v1/payouts", {
    form,
    stripeAccount: params.stripeAccountId,
  })
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || `Stripe payout error (${res.status ?? "—"})` }
  }
  return { success: true, payoutId: res.data.id, amount: res.data.amount / 100 }
}
