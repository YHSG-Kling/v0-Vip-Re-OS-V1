// lib/billing/subscription-activation.ts
// ─────────────────────────────────────────────────────────────────────────────
// Closes the money loop: collect a SETUP FEE (one-time) + the recurring plan at
// checkout, and ACTIVATE the account on payment by LINKING the existing (trialing)
// subscription row — never inserting a duplicate.
//
// The bug this fixes: signup creates a `subscriptions` row with NO
// stripe_subscription_id; the webhook upserted by stripe_subscription_id, so a
// real checkout inserted a SECOND row per brokerage instead of linking the first,
// and no checkout.session.completed handler ever flipped the account active. Both
// the checkout.session.completed and customer.subscription.updated branches now
// route through ONE brokerage-keyed writer (upsertBrokerageSubscription) so a
// brokerage can only ever have one live subscription row.

// ── PURE: checkout line items (recurring plan + one-time setup fee) ────────────

export interface CheckoutTier {
  tier_name: string
  display_name: string
  monthly_price_cents: number
  annual_price_cents: number
  setup_fee_cents?: number | null
}

export interface CheckoutConfig {
  lineItems: Array<Record<string, unknown>>
  /** Added to the FIRST invoice only (Stripe subscription-mode one-time charge). */
  addInvoiceItems: Array<Record<string, unknown>>
}

/** Build the Stripe Checkout config: the recurring plan line item + a one-time
 *  setup-fee add-invoice-item (only when the tier carries a setup fee). */
export function buildCheckoutConfig(tier: CheckoutTier, billingCycle: "monthly" | "annual"): CheckoutConfig {
  const priceInCents = billingCycle === "annual" ? tier.annual_price_cents : tier.monthly_price_cents
  const lineItems = [{
    price_data: {
      currency: "usd",
      product_data: { name: tier.display_name, description: `${tier.tier_name} plan - ${billingCycle} billing` },
      unit_amount: priceInCents,
      recurring: { interval: billingCycle === "annual" ? "year" : "month" },
    },
    quantity: 1,
  }]

  const setup = tier.setup_fee_cents ?? 0
  const addInvoiceItems = setup > 0
    ? [{
        price_data: {
          currency: "usd",
          product_data: { name: `${tier.display_name} — one-time setup fee` },
          unit_amount: setup,
        },
        quantity: 1,
      }]
    : []

  return { lineItems, addInvoiceItems }
}

/** PURE: the Stripe-Tax session fragment. Gated on platform_settings.collect_tax
 *  (default OFF — enabling requires a live Stripe Tax registration, so the flag
 *  lives in the DB, never a hardcode). automatic_tax needs a customer address,
 *  hence customer_update address auto-save. */
export function buildCheckoutTaxConfig(collectTax: boolean): Record<string, unknown> {
  if (!collectTax) return {}
  return {
    automatic_tax: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    tax_id_collection: { enabled: true },
  }
}

// ── PURE: the subscription-row patch from a normalized Stripe subscription ─────

export interface NormalizedStripeSub {
  stripeSubscriptionId: string
  stripeCustomerId: string | null
  tierId: string | null
  /** Already mapped to a value subscriptions.status can hold
   *  (lib/billing/stripe-status.ts toStoredSubscriptionStatus). null = a status
   *  we do not recognise; the patch then OMITS status so an unrecognised Stripe
   *  state cannot overwrite — or silently fail to overwrite — a real one. */
  status: string | null
  currentPeriodStart: number | null
  currentPeriodEnd: number | null
  trialEnd: number | null
  cancelAt: number | null
}

const iso = (unix: number | null): string | null => (unix ? new Date(unix * 1000).toISOString() : null)

/** Build the `subscriptions` row patch (never includes brokerage_id — the writer
 *  scopes by that). Pure + unit-testable. */
export function buildSubscriptionPatch(s: NormalizedStripeSub): Record<string, unknown> {
  return {
    stripe_subscription_id: s.stripeSubscriptionId,
    stripe_customer_id: s.stripeCustomerId,
    tier_id: s.tierId,
    // Omitted entirely when null — see NormalizedStripeSub.status. Writing a
    // status the CHECK rejects is worse than writing none: the update is
    // discarded and the row keeps a stale 'active'.
    ...(s.status ? { status: s.status } : {}),
    current_period_start: iso(s.currentPeriodStart),
    current_period_end: iso(s.currentPeriodEnd),
    trial_end: iso(s.trialEnd),
    cancel_at: iso(s.cancelAt),
    updated_at: new Date().toISOString(),
  }
}

// ── IMPURE: the ONE brokerage-keyed writer (no duplicate rows) ─────────────────

export interface UpsertResult { action: "updated" | "inserted"; id: string | null }

/**
 * Link a Stripe subscription to a brokerage's ONE subscription row.
 * Resolution order (so a brokerage can never accumulate rows):
 *   1) an existing row already carrying this stripe_subscription_id → update it,
 *   2) else the brokerage's row that has NO stripe_subscription_id yet (the
 *      trialing row signup created) → link it,
 *   3) else the brokerage's most-recent row → update it,
 *   4) else insert a fresh row.
 */
export async function upsertBrokerageSubscription(
  svc: any,
  brokerageId: string,
  patch: Record<string, unknown>,
): Promise<UpsertResult> {
  const stripeSubId = patch.stripe_subscription_id as string | undefined

  const { data: rows } = await svc
    .from("subscriptions")
    .select("id, stripe_subscription_id, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)
  const list = (rows ?? []) as Array<{ id: string; stripe_subscription_id: string | null }>

  const target =
    list.find((r) => stripeSubId && r.stripe_subscription_id === stripeSubId) ??
    list.find((r) => !r.stripe_subscription_id) ??
    list[0] ??
    null

  // THIS IS THE MONEY PATH — a discarded error here is a tenant who keeps paid
  // access for free. supabase-js RESOLVES on a rejected write ({ error }) rather
  // than throwing, so `await svc.from(...).update(...)` with the result thrown
  // away cannot tell "saved" from "the CHECK refused it". That is exactly how a
  // cancelled subscription kept a stale 'active' status: Stripe's 'canceled'
  // spelling was rejected and nobody heard. Surfaced now — loudly, and to the
  // caller, so a Stripe retry can actually re-deliver the event.
  if (target) {
    const { error } = await svc.from("subscriptions").update(patch).eq("id", target.id)
    if (error) {
      console.error("[billing] subscription UPDATE rejected — access state is now stale:", error.message, patch)
      throw new Error(`subscription update rejected: ${error.message}`)
    }
    return { action: "updated", id: target.id }
  }

  const { data: inserted, error: insertError } = await svc
    .from("subscriptions")
    .insert({ brokerage_id: brokerageId, created_at: new Date().toISOString(), ...patch })
    .select("id")
    .maybeSingle()
  if (insertError) {
    console.error("[billing] subscription INSERT rejected:", insertError.message, patch)
    throw new Error(`subscription insert rejected: ${insertError.message}`)
  }
  return { action: "inserted", id: (inserted as any)?.id ?? null }
}
