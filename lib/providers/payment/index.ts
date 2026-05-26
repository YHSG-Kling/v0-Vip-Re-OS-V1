/**
 * PAYMENT PROVIDER
 * Owns all payment API calls: Stripe.
 * No business logic — pure API client wrappers.
 */

// ─── STRIPE ────────────────────────────────────────────────────────────────────

function getStripeKey(): string | null {
  return process.env.STRIPE_SECRET_KEY || null
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

  const response = await fetch("https://api.stripe.com/v1/transfers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      amount: Math.round(params.amount * 100).toString(),
      currency: "usd",
      destination: params.destinationAccountId,
      description: params.description || "Commission transfer",
    }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error?.message || "Stripe API error")
  }

  return {
    success: true,
    transferId: data.id,
    amount: data.amount / 100,
  }
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

  const body = new URLSearchParams({
    amount: Math.round(params.amount * 100).toString(),
    currency: params.currency || "usd",
  })

  if (params.description) body.append("description", params.description)
  if (params.metadata) {
    for (const [key, value] of Object.entries(params.metadata)) {
      body.append(`metadata[${key}]`, value)
    }
  }

  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error?.message || "Stripe PaymentIntent error")
  }

  return {
    success: true,
    clientSecret: data.client_secret,
    paymentIntentId: data.id,
  }
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

  const accountResponse = await fetch("https://api.stripe.com/v1/accounts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      type: "express",
      email,
      "capabilities[transfers][requested]": "true",
    }),
  })

  const account = await accountResponse.json()

  if (!accountResponse.ok) {
    throw new Error(account.error?.message || "Stripe account creation error")
  }

  const linkResponse = await fetch("https://api.stripe.com/v1/account_links", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      account: account.id,
      refresh_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/payments`,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/payments?success=true`,
      type: "account_onboarding",
    }),
  })

  const link = await linkResponse.json()

  return {
    success: true,
    accountId: account.id,
    onboardingUrl: link.url,
  }
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

  const url = accountId
    ? `https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`
    : "https://api.stripe.com/v1/account"
  const response = await fetch(url, { headers: { Authorization: `Bearer ${secretKey}` } })
  const data = await response.json()
  if (!response.ok) {
    return { success: false, error: data.error?.message || `Stripe account error (${response.status})` }
  }
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

  const response = await fetch("https://api.stripe.com/v1/balance", {
    headers: { Authorization: `Bearer ${secretKey}` },
  })
  const data = await response.json()
  if (!response.ok) {
    return { success: false, error: data.error?.message || `Stripe balance error (${response.status})` }
  }
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

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  }
  if (params.stripeAccountId) headers["Stripe-Account"] = params.stripeAccountId

  const body = new URLSearchParams({
    amount: Math.round(params.amount * 100).toString(),
    currency: params.currency || "usd",
  })
  if (params.description) body.append("description", params.description)

  const response = await fetch("https://api.stripe.com/v1/payouts", { method: "POST", headers, body })
  const data = await response.json()
  if (!response.ok) {
    return { success: false, error: data.error?.message || `Stripe payout error (${response.status})` }
  }
  return { success: true, payoutId: data.id, amount: data.amount / 100 }
}
