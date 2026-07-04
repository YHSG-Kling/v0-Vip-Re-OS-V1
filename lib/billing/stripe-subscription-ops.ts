// lib/billing/stripe-subscription-ops.ts
//
// STRIPE SUBSCRIPTION WRITE-THROUGH — the money-movement layer the superadmin lifecycle actions were
// missing. cancel / reactivate / tier-change / extend-trial / pause previously wrote LOCAL Postgres only, so
// they never changed what the customer is actually billed. Each op here calls the Stripe SDK when it is
// configured (STRIPE_SECRET_KEY present) and the subscription is Stripe-linked; otherwise it is a clean
// no-op so the god layer still works before Stripe creds are added (the caller always mirrors intent to the
// local DB regardless). Best-effort: a Stripe error is returned, never thrown — the local write is the
// source of intent and the billing webhook reconciles the rest.

// NOTE: @/lib/stripe is `server-only` and requires STRIPE_SECRET_KEY at first use — it is imported LAZILY,
// only AFTER the isStripeConfigured() guard, so the unconfigured path (and unit tests) never load it.

export interface StripeOpResult {
  /** true ⇒ the change was pushed to Stripe. false ⇒ skipped (unconfigured / not Stripe-linked) or errored. */
  applied: boolean
  /** true ⇒ intentionally skipped (no creds or no stripe_subscription_id), not an error. */
  skipped: boolean
  error?: string
}

/** Whether a live Stripe key is present in the runtime. */
export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}

function skip(): StripeOpResult { return { applied: false, skipped: true } }

async function guard(subscriptionId: string | null | undefined, fn: (stripe: any) => Promise<void>): Promise<StripeOpResult> {
  if (!isStripeConfigured() || !subscriptionId) return skip()
  try {
    const { stripe } = await import("@/lib/stripe")
    await fn(stripe)
    return { applied: true, skipped: false }
  } catch (err: any) { return { applied: false, skipped: false, error: err?.message ?? String(err) } }
}

/** Cancel at period end (keeps service through the paid period; stops the next charge). */
export function stripeCancelAtPeriodEnd(subscriptionId: string | null | undefined): Promise<StripeOpResult> {
  return guard(subscriptionId, async (stripe) => { await stripe.subscriptions.update(subscriptionId!, { cancel_at_period_end: true }) })
}

/** Undo a pending cancel — resume billing at the next period. */
export function stripeResume(subscriptionId: string | null | undefined): Promise<StripeOpResult> {
  return guard(subscriptionId, async (stripe) => { await stripe.subscriptions.update(subscriptionId!, { cancel_at_period_end: false, pause_collection: "" }) })
}

/** Swap the subscription's price to a new tier's Stripe price (repricing on tier change). */
export async function stripeSwapPrice(subscriptionId: string | null | undefined, newPriceId: string | null | undefined): Promise<StripeOpResult> {
  if (!isStripeConfigured() || !subscriptionId || !newPriceId) return skip()
  try {
    const { stripe } = await import("@/lib/stripe")
    const sub = await stripe.subscriptions.retrieve(subscriptionId)
    const itemId = (sub as any).items?.data?.[0]?.id
    if (!itemId) return { applied: false, skipped: false, error: "subscription has no line item to reprice" }
    await stripe.subscriptions.update(subscriptionId, { items: [{ id: itemId, price: newPriceId }], proration_behavior: "create_prorations" })
    return { applied: true, skipped: false }
  } catch (err: any) { return { applied: false, skipped: false, error: err?.message ?? String(err) } }
}

/** Extend the trial to a new end (unix seconds). Comping free time = extending the trial. */
export function stripeExtendTrial(subscriptionId: string | null | undefined, trialEndUnix: number): Promise<StripeOpResult> {
  return guard(subscriptionId, async (stripe) => { await stripe.subscriptions.update(subscriptionId!, { trial_end: trialEndUnix, proration_behavior: "none" }) })
}

/** Pause / resume collection (comp a break without cancelling). */
export function stripePauseCollection(subscriptionId: string | null | undefined, pause: boolean): Promise<StripeOpResult> {
  return guard(subscriptionId, async (stripe) => {
    await stripe.subscriptions.update(subscriptionId!, pause ? { pause_collection: { behavior: "void" } } : { pause_collection: "" })
  })
}

/**
 * PURE: compute the new trial-end ISO from the current end + added days. Extends from the LATER of "now" and
 * the current trial end, so extending an already-lapsed trial still lands in the future. Unit-testable.
 */
export function computeTrialExtension(currentTrialEnd: string | null, addDays: number, now: Date): { iso: string; unix: number } {
  const base = Math.max(now.getTime(), currentTrialEnd && !Number.isNaN(Date.parse(currentTrialEnd)) ? Date.parse(currentTrialEnd) : 0)
  const end = base + Math.max(0, Math.floor(addDays)) * 86_400_000
  return { iso: new Date(end).toISOString(), unix: Math.floor(end / 1000) }
}
