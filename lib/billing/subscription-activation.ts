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
  /** The recurring plan line. */
  lineItems: Array<Record<string, unknown>>
  /** The one-time setup-fee line (no `recurring`) — charged on the FIRST invoice
   *  only. It goes into the Checkout Session's `line_items` beside the plan:
   *  `line_items: [...lineItems, ...addInvoiceItems]`. Lane 79D: it used to be
   *  sent as `subscription_data.add_invoice_items`, which is a Subscriptions-API
   *  parameter the Checkout Sessions API does not accept ("Received unknown
   *  parameter: subscription_data[add_invoice_items]") — so the moment a tier
   *  carried a fee, EVERY paid activation would have been refused at Stripe. It
   *  never surfaced because every live tier's setup_fee_cents is still 0. */
  addInvoiceItems: Array<Record<string, unknown>>
}

/** Build the Stripe Checkout config: the recurring plan line item + a one-time
 *  setup-fee add-invoice-item (only when the tier carries a setup fee, and only
 *  when it has not been WAIVED — a waiver is a platform-staff decision recorded
 *  and audited by the caller, lib/kernel/tenant-creation.ts; this builder only
 *  honours the flag it is handed). */
export function buildCheckoutConfig(
  tier: CheckoutTier,
  billingCycle: "monthly" | "annual",
  opts: { waiveSetupFee?: boolean } = {},
): CheckoutConfig {
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

  const setup = opts.waiveSetupFee === true ? 0 : (tier.setup_fee_cents ?? 0)
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

// ── IMPURE: the HOSTED activation checkout (wave 78A) ─────────────────────────
//
// Owner, 2026-09-22: "not all converts or tenant creations are going to enroll
// in the trial. there is a setup fee." The in-app checkout survivor
// (app/actions/billing.ts::startSubscriptionCheckout) is EMBEDDED and
// session-gated — it needs a signed-in tenant admin, which a prospect saying
// "activate me now" on the phone, in the chat, or on /get-started does not yet
// have. This is the same checkout (the SAME buildCheckoutConfig line items,
// the SAME add_invoice_items setup fee, the SAME tax flag, the SAME
// metadata the webhook's checkout.session.completed branch resolves the
// tenant from) as a HOSTED session with a URL that can be sent by email/SMS or
// redirected to. It is not a second Stripe client: it rides
// lib/stripe.ts::getPlatformStripe, the platform's account, because a tenant
// paying the platform for its plan is the platform's money
// (lib/billing/stripe-account-scope.ts STRIPE_MONEY_PATHS
// tenant_saas_subscription — this file is already named in its livesIn).
//
// WHAT IT RECORDS: the setup fee is a line on the FIRST Stripe invoice, so the
// ledger the OS already keeps (billing_invoices, written by the webhook's
// invoice.paid branch from amount_paid) carries it without a new table. The
// session and subscription metadata also carry setup_fee_cents and
// setup_fee_waived so the invoice can be read back against what was quoted.

export interface ActivationCheckoutInput {
  brokerageId: string
  tierId: string
  billingCycle: "monthly" | "annual"
  /** Where Stripe sends the payer afterwards. */
  successUrl: string
  cancelUrl: string
  /** Pre-fills the hosted page; ignored when the brokerage already has a Stripe customer. */
  customerEmail?: string | null
  /** A platform-staff waiver the caller has ALREADY audited (tenant-creation.ts). */
  waiveSetupFee?: boolean
}

export type ActivationCheckoutResult =
  | { ok: true; url: string; sessionId: string; setupFeeCents: number; setupFeeWaived: boolean; recurringCents: number }
  | { ok: false; error: string; notConfigured?: boolean }

export async function createActivationCheckout(svc: any, input: ActivationCheckoutInput): Promise<ActivationCheckoutResult> {
  const { data: tier, error: tierErr } = await svc
    .from("subscription_tiers")
    .select("id, tier_name, display_name, monthly_price_cents, annual_price_cents, setup_fee_cents, is_active")
    .eq("id", input.tierId)
    .maybeSingle()
  if (tierErr) return { ok: false, error: `Plan tier read refused: ${tierErr.message}` }
  if (!tier) return { ok: false, error: "Plan tier not found — the activation checkout has no price to charge." }

  const { data: brokerage, error: bErr } = await svc
    .from("brokerages").select("name, email").eq("id", input.brokerageId).maybeSingle()
  if (bErr) return { ok: false, error: `Brokerage read refused: ${bErr.message}` }
  if (!brokerage) return { ok: false, error: "Brokerage not found — nothing to activate." }

  // Reuse an existing Stripe customer (the staff door may have minted one).
  const { data: existingSub, error: subErr } = await svc
    .from("subscriptions").select("stripe_customer_id").eq("brokerage_id", input.brokerageId)
    .not("stripe_customer_id", "is", null).limit(1).maybeSingle()
  if (subErr) return { ok: false, error: `Subscription read refused: ${subErr.message}` }
  const customerId = (existingSub as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null

  const { lineItems, addInvoiceItems } = buildCheckoutConfig(tier as CheckoutTier, input.billingCycle, { waiveSetupFee: input.waiveSetupFee === true })
  const { data: platformRow } = await svc.from("platform_settings").select("collect_tax").limit(1).maybeSingle()
  const taxConfig = buildCheckoutTaxConfig((platformRow as { collect_tax?: boolean } | null)?.collect_tax === true)

  const setupFeeCents = input.waiveSetupFee === true ? 0 : Number((tier as { setup_fee_cents?: number | null }).setup_fee_cents ?? 0)
  const recurringCents = input.billingCycle === "annual"
    ? Number((tier as { annual_price_cents?: number | null }).annual_price_cents ?? 0)
    : Number((tier as { monthly_price_cents?: number | null }).monthly_price_cents ?? 0)
  const metadata = {
    brokerage_id: input.brokerageId,
    tier_id: input.tierId,
    tier_name: String((tier as { tier_name: string }).tier_name),
    billing_cycle: input.billingCycle,
    setup_fee_cents: String(setupFeeCents),
    setup_fee_waived: input.waiveSetupFee === true ? "true" : "false",
    activation: "hosted_checkout",
  }

  try {
    const { getPlatformStripe } = await import("@/lib/stripe")
    const stripe = await getPlatformStripe()
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(customerId ? { customer: customerId } : { customer_email: (input.customerEmail ?? (brokerage as { email?: string | null }).email ?? undefined) || undefined }),
      ...(taxConfig as Record<string, never>),
      // One-time prices in subscription-mode line_items land on the initial
      // invoice only (Stripe Checkout docs) — that IS the setup fee.
      line_items: [...lineItems, ...addInvoiceItems] as never,
      subscription_data: { metadata },
      metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    })
    if (!session.url) return { ok: false, error: "Stripe returned no hosted checkout URL" }
    return { ok: true, url: session.url, sessionId: session.id, setupFeeCents, setupFeeWaived: input.waiveSetupFee === true, recurringCents }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // No platform Stripe credential is an honest "not configured", not a bug —
    // the tenant still exists and the in-app paywall collects when keys land.
    const notConfigured = /STRIPE_SECRET_KEY|no stripe|not configured|credential/i.test(msg)
    return { ok: false, error: `Activation checkout could not be created: ${msg}`, notConfigured }
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
