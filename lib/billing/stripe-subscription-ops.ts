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

import { normalizeStripeStatus } from "./stripe-status"

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
    // The PLAN line is the first LICENSED item — never a metered overage item
    // (wave 87C, lib/billing/stripe-overage-meter.ts), which a tier change must
    // not reprice onto the plan price.
    const items = ((sub as any).items?.data ?? []) as Array<{ id: string; price?: { recurring?: { usage_type?: string } | null } | string }>
    const itemId = items.find((it) => typeof it.price !== "object" || (it.price?.recurring?.usage_type ?? "licensed") === "licensed")?.id
    if (!itemId) return { applied: false, skipped: false, error: "subscription has no line item to reprice" }
    await stripe.subscriptions.update(subscriptionId, { items: [{ id: itemId, price: newPriceId }], proration_behavior: "create_prorations" })
    return { applied: true, skipped: false }
  } catch (err: any) { return { applied: false, skipped: false, error: err?.message ?? String(err) } }
}

// ── SEAT PACKAGES + CATALOGUE READS (wave 79A) ───────────────────────────────
// The only Stripe calls the seat door, the daily reconcile and the superadmin
// catalogue sync make. They live HERE — beside stripeSwapPrice — because this
// file is already on the platform-client roster (scripts/stripe-account-scope-
// simulator.ts PLATFORM_CLIENT_IMPORTERS: platform_payee), so no new importer
// of the platform key is minted for them.

export interface SeatItemOpResult extends StripeOpResult {
  /** The seat-package subscription item id after the write (null when skipped / errored). */
  itemId?: string | null
  quantity?: number
}

/**
 * Set the tenant's seat-package QUANTITY on its Stripe subscription: updates
 * the existing item on `seatPriceId` or adds one (Stripe: one item per price;
 * a quantity change prorates the remainder of the period —
 * proration_behavior create_prorations, docs.stripe.com/billing/subscriptions/
 * prorations). Quantity 0 removes the item. Fails closed on a missing price
 * or subscription: nothing is charged and nothing is recorded as bought.
 */
export async function stripeSetSeatPackages(
  subscriptionId: string | null | undefined,
  seatPriceId: string | null | undefined,
  quantity: number,
): Promise<SeatItemOpResult> {
  if (!isStripeConfigured() || !subscriptionId) return skip()
  if (!seatPriceId) return { applied: false, skipped: false, error: "this plan has no Stripe seat-package price linked — seats cannot be sold until the catalogue is synced" }
  const qty = Math.max(0, Math.floor(quantity))
  try {
    const { stripe } = await import("@/lib/stripe")
    const sub = await stripe.subscriptions.retrieve(subscriptionId)
    const items = ((sub as any).items?.data ?? []) as Array<{ id: string; price?: { id?: string } | string }>
    const existing = items.find((it) => (typeof it.price === "string" ? it.price : it.price?.id) === seatPriceId)
    if (existing) {
      if (qty === 0) {
        await stripe.subscriptions.update(subscriptionId, { items: [{ id: existing.id, deleted: true }], proration_behavior: "create_prorations" })
        return { applied: true, skipped: false, itemId: null, quantity: 0 }
      }
      await stripe.subscriptions.update(subscriptionId, { items: [{ id: existing.id, quantity: qty }], proration_behavior: "create_prorations" })
      return { applied: true, skipped: false, itemId: existing.id, quantity: qty }
    }
    if (qty === 0) return { applied: true, skipped: false, itemId: null, quantity: 0 }
    const updated = await stripe.subscriptions.update(subscriptionId, { items: [{ price: seatPriceId, quantity: qty }], proration_behavior: "create_prorations" })
    const added = (((updated as any).items?.data ?? []) as Array<{ id: string; price?: { id?: string } | string }>)
      .find((it) => (typeof it.price === "string" ? it.price : it.price?.id) === seatPriceId)
    return { applied: true, skipped: false, itemId: added?.id ?? null, quantity: qty }
  } catch (err: any) { return { applied: false, skipped: false, error: err?.message ?? String(err) } }
}

/** Retrieve a subscription with its items (for the webhook-free reconcile).
 *  Returns the raw SDK object; lib/billing/seat-packages.ts narrows it. */
export async function stripeRetrieveSubscription(subscriptionId: string): Promise<{ ok: true; sub: any } | { ok: false; skipped: boolean; error?: string }> {
  if (!isStripeConfigured() || !subscriptionId) return { ok: false, skipped: true }
  try {
    const { stripe } = await import("@/lib/stripe")
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] })
    return { ok: true, sub }
  } catch (err: any) { return { ok: false, skipped: false, error: err?.message ?? String(err) } }
}

/** List every ACTIVE recurring price with its product expanded, newest first
 *  (Stripe's default order) — the catalogue source for the superadmin sync. */
export async function stripeListActivePrices(): Promise<{ ok: true; prices: any[] } | { ok: false; skipped: boolean; error?: string }> {
  if (!isStripeConfigured()) return { ok: false, skipped: true }
  try {
    const { stripe } = await import("@/lib/stripe")
    const prices: any[] = []
    let startingAfter: string | undefined
    for (let page = 0; page < 20; page++) {
      const res = await stripe.prices.list({ active: true, type: "recurring", limit: 100, expand: ["data.product"], ...(startingAfter ? { starting_after: startingAfter } : {}) })
      prices.push(...(res.data ?? []))
      if (!res.has_more || res.data.length === 0) break
      startingAfter = res.data[res.data.length - 1]!.id
    }
    return { ok: true, prices }
  } catch (err: any) { return { ok: false, skipped: false, error: err?.message ?? String(err) } }
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

/** Apply a published Stripe coupon to a live subscription (retention save-offer,
 *  manual redemption). Skips honestly when Stripe is unconfigured, the
 *  subscription isn't Stripe-linked, or the coupon was only mock-published
 *  (mock_… ids never reach Stripe) — the local redemption ledger is the source
 *  of intent either way. */
export function stripeApplyCoupon(
  subscriptionId: string | null | undefined,
  stripeCouponId: string | null | undefined,
): Promise<StripeOpResult> {
  if (!stripeCouponId || stripeCouponId.startsWith("mock_")) return Promise.resolve(skip())
  return guard(subscriptionId, async (stripe) => {
    await stripe.subscriptions.update(subscriptionId!, { discounts: [{ coupon: stripeCouponId }] })
  })
}

/** Refund the subscription's most recent PAID invoice (full or partial cents).
 *  The refund lands on the invoice's charge/payment_intent — the only honest
 *  refund target for subscription billing (never a blind charge search). */
export async function stripeRefundLatestInvoice(
  subscriptionId: string | null | undefined,
  amountCents?: number | null,
): Promise<StripeOpResult & { refundedCents?: number }> {
  if (!isStripeConfigured() || !subscriptionId) return skip()
  try {
    const { stripe } = await import("@/lib/stripe")
    const invoices = await stripe.invoices.list({ subscription: subscriptionId, status: "paid", limit: 1 })
    const invoice = invoices?.data?.[0]
    const paymentIntent = (invoice as any)?.payment_intent
    const charge = (invoice as any)?.charge
    if (!invoice || (!paymentIntent && !charge)) {
      return { applied: false, skipped: false, error: "No paid invoice with a refundable payment found" }
    }
    const refund = await stripe.refunds.create({
      ...(paymentIntent ? { payment_intent: typeof paymentIntent === "string" ? paymentIntent : paymentIntent.id } : { charge: typeof charge === "string" ? charge : charge.id }),
      ...(amountCents && amountCents > 0 ? { amount: Math.floor(amountCents) } : {}),
    })
    return { applied: true, skipped: false, refundedCents: (refund as any)?.amount ?? amountCents ?? null } as any
  } catch (err: any) {
    return { applied: false, skipped: false, error: err?.message ?? String(err) }
  }
}

// ─── TRIAL / RENEWAL LIFECYCLE (wave 99A) ─────────────────────────────────────
//
// What was missing (gap map row 7 (d)): nothing ever ENDED a trial. The paywall
// refused an expired trial at login, but the row stayed 'trialing' forever, no
// one converted a trial that had a card on file, and nobody was told before the
// trial ended or before a renewal charged. This block finishes the loop on the
// survivors: Stripe stays the source of truth for Stripe-linked rows (the
// webhook + the daily reconcile in lib/billing/seat-sync.ts mirror its status);
// this sweep owns only what Stripe cannot see — LOCAL trials (self-serve signup
// creates no Stripe subscription) — plus the reminders, sent through the ONE
// egress (dispatchEmail) with an action-ledger cycle so each goes out once.
// Deterministic code only: no model is in this path (LAW 4), and every state
// change leaves a kernel event + an action-ledger row (LAW 5).

const DAY_MS = 86_400_000

/** Stripe's own customer.subscription.trial_will_end lead time — the sweep matches it. */
const TRIAL_REMINDER_DAYS = 3
/** Renewal notice lead time (auto-renewal notice before the charge). */
const RENEWAL_REMINDER_DAYS = 7

export type LifecycleReminderKind = "trial_end" | "renewal"

export interface LifecycleSubRow {
  id: string
  brokerage_id: string
  status: string | null
  trial_end: string | null
  current_period_end: string | null
  cancel_at: string | null
  stripe_subscription_id: string | null
  stripe_customer_id: string | null
  tier_id: string | null
}

/** PURE: the ledger cycle of a reminder — one per (kind, the date it is about). An extended
 *  trial or a new period is a NEW date and therefore a new reminder; the same date never twice. */
export function reminderCycle(kind: LifecycleReminderKind, aboutIso: string): string {
  return `${kind}:${new Date(Date.parse(aboutIso)).toISOString().slice(0, 10)}`
}

/** @proofSeam the lifecycle sweep below is its runtime caller; scripts/billing-access-simulator.ts Layer 1d asserts the windows directly.
 *  PURE: the reminder due for this row right now — or null. `tenantTrialEnd` is the
 *  brokerages.trial_ends_at fallback loadBillingAccess also honours. */
export function planLifecycleReminder(
  sub: Pick<LifecycleSubRow, "status" | "trial_end" | "current_period_end" | "cancel_at" | "stripe_subscription_id">,
  now: Date,
  tenantTrialEnd: string | null = null,
): { kind: LifecycleReminderKind; cycle: string; aboutIso: string } | null {
  const status = normalizeStripeStatus(sub.status)
  if (status === "trialing") {
    const iso = sub.trial_end ?? tenantTrialEnd
    const end = iso ? Date.parse(iso) : NaN
    if (!Number.isFinite(end)) return null
    const left = end - now.getTime()
    return left > 0 && left <= TRIAL_REMINDER_DAYS * DAY_MS ? { kind: "trial_end", cycle: reminderCycle("trial_end", iso!), aboutIso: iso! } : null
  }
  // A renewal only charges on a Stripe-linked subscription that is not set to cancel.
  if (status === "active" && sub.stripe_subscription_id && !sub.cancel_at && sub.current_period_end) {
    const end = Date.parse(sub.current_period_end)
    if (!Number.isFinite(end)) return null
    const left = end - now.getTime()
    return left > 0 && left <= RENEWAL_REMINDER_DAYS * DAY_MS ? { kind: "renewal", cycle: reminderCycle("renewal", sub.current_period_end), aboutIso: sub.current_period_end } : null
  }
  return null
}

export type TrialEndAction = "none" | "defer_to_stripe" | "convert" | "expire"

// PURE: what happens to a trial. Stripe-linked → Stripe decides (it charges the card or
// pauses/cancels per its trial settings) and the reconcile mirrors it. A LOCAL trial that
// has ended converts when a payment method is on file, otherwise it is moved to 'paused' —
// Stripe's own state for "trial ended, no payment method" (trial_settings.end_behavior.
// missing_payment_method = pause), refused by the paywall, and NOT 'past_due', which would
// start the dunning ladder's "your payment failed" copy for a payment nobody attempted.
/** @proofSeam the lifecycle sweep below is its runtime caller; scripts/billing-access-simulator.ts Layer 1d asserts the decision matrix directly. */
export function planTrialEnd(i: { trialEnded: boolean; stripeLinked: boolean; hasPaymentMethod: boolean }): TrialEndAction {
  if (!i.trialEnded) return "none"
  if (i.stripeLinked) return "defer_to_stripe"
  return i.hasPaymentMethod ? "convert" : "expire"
}

/** Emit the kernel event for a subscription status transition (webhook, reconcile, sweep). */
export async function emitSubscriptionTransition(t: {
  brokerageId: string
  subscriptionId: string
  from: string | null
  to: string
  source: "webhook" | "reconcile" | "sweep"
  detail?: Record<string, unknown>
}): Promise<{ ok: boolean; error: string | null }> {
  const { emitKernelEvent } = await import("@/lib/kernel/emit")
  const { KernelEvent } = await import("@/lib/kernel/events")
  const converted = normalizeStripeStatus(t.from) === "trialing" && t.to === "active"
  const r = converted
    ? await emitKernelEvent({
        event: KernelEvent.SUBSCRIPTION_TRIAL_CONVERTED, brokerageId: t.brokerageId,
        entityType: "subscription", entityId: t.subscriptionId,
        source: t.source === "webhook" ? "webhook" : "cron",
        metadata: { from: t.from, to: t.to, via: t.source, ...(t.detail ?? {}) },
        dedupeKey: `${t.from}->${t.to}`,
      })
    : await emitKernelEvent({
        event: KernelEvent.SUBSCRIPTION_STATUS_CHANGED, brokerageId: t.brokerageId,
        entityType: "subscription", entityId: t.subscriptionId,
        source: t.source === "webhook" ? "webhook" : "cron",
        metadata: { from: t.from, to: t.to, via: t.source, ...(t.detail ?? {}) },
        dedupeKey: `${t.from}->${t.to}`,
      })
  return { ok: !r.error, error: r.error }
}

/** Does this Stripe customer have a payment method on file? Unconfigured / unlinked → false. */
async function stripeCustomerHasPaymentMethod(customerId: string | null | undefined): Promise<{ ok: boolean; has: boolean; error?: string }> {
  if (!isStripeConfigured() || !customerId) return { ok: true, has: false }
  try {
    const { stripe } = await import("@/lib/stripe")
    const pms = await stripe.paymentMethods.list({ customer: customerId, limit: 1 })
    return { ok: true, has: ((pms as any)?.data ?? []).length > 0 }
  } catch (err: any) { return { ok: false, has: false, error: err?.message ?? String(err) } }
}

/**
 * Convert a LOCAL trial into a Stripe subscription on the tier's price, charging the card on
 * file. Stripe idempotency key = (row, trial end): two sweeps can never create two
 * subscriptions. The webhook (customer.subscription.created) links the new subscription to
 * the existing row through upsertBrokerageSubscription — this op writes nothing locally.
 */
async function stripeConvertTrial(args: {
  customerId: string; priceId: string; brokerageId: string; idempotencyKey: string
}): Promise<StripeOpResult & { stripeSubscriptionId?: string }> {
  if (!isStripeConfigured()) return skip()
  try {
    const { stripe } = await import("@/lib/stripe")
    const created = await stripe.subscriptions.create(
      { customer: args.customerId, items: [{ price: args.priceId }], metadata: { brokerage_id: args.brokerageId } },
      { idempotencyKey: args.idempotencyKey },
    )
    return { applied: true, skipped: false, stripeSubscriptionId: (created as any)?.id }
  } catch (err: any) { return { applied: false, skipped: false, error: err?.message ?? String(err) } }
}

/**
 * Send one lifecycle reminder to the tenant's commerce admins (the seats that may obligate
 * the brokerage to pay — TENANT_COMMERCE_ADMIN_USER_TYPES) through dispatchEmail. Each
 * recipient's send carries the ledger cycle `${cycle}:${userId}` on subject = the
 * subscription, so the action ledger's idempotency key makes it at-most-once per cycle no
 * matter how many sweeps or webhook deliveries ask. systemSource 'billing_lifecycle' is a
 * BILLING_NOTICE_SOURCE — it reaches a lapsed tenant (that is its job).
 */
export async function sendSubscriptionReminder(
  svc: any,
  sub: Pick<LifecycleSubRow, "id" | "brokerage_id">,
  plan: { kind: LifecycleReminderKind; cycle: string; aboutIso: string },
  deps?: {
    send?: (p: any) => Promise<{ success: boolean; providerKey?: string; error?: string }>
    /** Kernel-event seam (default: emitKernelEvent). */
    emit?: (e: { event: string; brokerageId: string; entityType: string; entityId: string; source: "cron"; metadata: Record<string, unknown>; dedupeKey: string; dedupeWindowSec: number }) => Promise<unknown>
  },
): Promise<{ attempted: number; sent: number; error: string | null }> {
  const { TENANT_COMMERCE_ADMIN_USER_TYPES } = await import("@/lib/auth/resolve-user-role")
  const [{ data: admins, error: aErr }, { data: brk, error: bErr }] = await Promise.all([
    svc.from("users").select("id, email").eq("brokerage_id", sub.brokerage_id)
      .in("user_type", [...TENANT_COMMERCE_ADMIN_USER_TYPES]).not("email", "is", null).limit(10),
    svc.from("brokerages").select("name").eq("id", sub.brokerage_id).maybeSingle(),
  ])
  if (aErr) return { attempted: 0, sent: 0, error: `admin read refused: ${aErr.message}` }
  const name = (!bErr && (brk as { name?: string } | null)?.name) || "your brokerage"
  const date = new Date(Date.parse(plan.aboutIso)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  const { siteUrl } = await import("@/lib/platform/site-url")
  const billingUrl = `${siteUrl() || ""}/dashboard/admin/billing`
  const subject = plan.kind === "trial_end" ? `Your ${name} trial ends on ${date}` : `Your ${name} subscription renews on ${date}`
  const body = plan.kind === "trial_end"
    ? `Your free trial for ${name} ends on ${date}. If a payment method is on file, your plan continues automatically. If not, access pauses when the trial ends — nothing is deleted, and adding a payment method restores it. Manage billing: ${billingUrl}`
    : `Your subscription for ${name} renews automatically on ${date} at your plan's current price. To change or cancel before then, visit your billing page: ${billingUrl}`
  const send = deps?.send ?? (async (p: any) => (await import("@/lib/providers/dispatch")).dispatchEmail(p))
  let attempted = 0, sent = 0
  for (const a of (admins ?? []) as Array<{ id: string; email: string | null }>) {
    if (!a.email) continue
    attempted += 1
    const r = await send({
      brokerageId: sub.brokerage_id, to: a.email, subject, html: `<p>${body}</p>`, text: body,
      systemSource: "billing_lifecycle", channelPurpose: "transactional",
      ledger: { subject: { type: "subscription", id: sub.id }, reasonCode: "COMPLIANCE_NOTICE", reasonDetail: `${plan.kind} reminder`, cycle: `${plan.cycle}:${a.id}` },
    })
    if (r.success) sent += 1
  }
  // `sent` counts DELIVERED-OR-ALREADY-DELIVERED: a ledger replay returns success too. The
  // action ledger (idempotency key per recipient + cycle) is the once-only guarantee, and the
  // event below is deduped on the cycle for 7 days — longer than either reminder window.
  if (sent > 0) {
    const { KernelEvent } = await import("@/lib/kernel/events")
    const emit = deps?.emit ?? (async (e: Parameters<NonNullable<NonNullable<typeof deps>["emit"]>>[0]) => (await import("@/lib/kernel/emit")).emitKernelEvent(e))
    await emit({
      event: KernelEvent.SUBSCRIPTION_REMINDER_SENT, brokerageId: sub.brokerage_id,
      entityType: "subscription", entityId: sub.id, source: "cron",
      metadata: { kind: plan.kind, cycle: plan.cycle, about: plan.aboutIso, recipients: sent },
      dedupeKey: plan.cycle, dedupeWindowSec: 7 * 86_400,
    })
  }
  return { attempted, sent, error: null }
}

export interface LifecycleSweepResult {
  scanned: number
  converted: number
  expired: number
  remindersAttempted: number
  remindersSent: number
  errors: string[]
}

export interface LifecycleSweepDeps {
  hasPaymentMethod?: (customerId: string | null) => Promise<{ ok: boolean; has: boolean; error?: string }>
  convert?: typeof stripeConvertTrial
  send?: (p: any) => Promise<{ success: boolean; providerKey?: string; error?: string }>
  /** Ledger client seam (default: the service client inside withActionLedger). */
  ledgerClient?: { from: (table: string) => any }
}

/**
 * THE DAILY SWEEP — rides /api/cron/billing-dunning (step 3, after the Stripe reconcile so
 * Stripe-linked rows already carry Stripe's status). Every state write is COUNTED and runs
 * inside withActionLedger with cycle = the trial end it is about, so it happens once.
 */
export async function runSubscriptionLifecycleSweep(svc: any, now: Date = new Date(), deps: LifecycleSweepDeps = {}): Promise<LifecycleSweepResult> {
  const out: LifecycleSweepResult = { scanned: 0, converted: 0, expired: 0, remindersAttempted: 0, remindersSent: 0, errors: [] }
  const { data: rows, error } = await svc
    .from("subscriptions")
    .select("id, brokerage_id, status, trial_end, current_period_end, cancel_at, stripe_subscription_id, stripe_customer_id, tier_id")
    .in("status", ["trialing", "active"])
    .limit(1000)
  if (error) { out.errors.push(`subscriptions read refused: ${error.message}`); return out }
  const list = (rows ?? []) as LifecycleSubRow[]
  out.scanned = list.length

  // brokerages.trial_ends_at — the fallback loadBillingAccess honours for a NULL trial_end.
  const trialIds = [...new Set(list.filter((r) => normalizeStripeStatus(r.status) === "trialing" && !r.trial_end).map((r) => r.brokerage_id))]
  const tenantTrialEnd = new Map<string, string | null>()
  if (trialIds.length > 0) {
    const { data: brks, error: bErr } = await svc.from("brokerages").select("id, trial_ends_at").in("id", trialIds)
    if (bErr) out.errors.push(`brokerages read refused: ${bErr.message}`)
    for (const b of (brks ?? []) as Array<{ id: string; trial_ends_at: string | null }>) tenantTrialEnd.set(b.id, b.trial_ends_at)
  }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const hasPm = deps.hasPaymentMethod ?? stripeCustomerHasPaymentMethod
  const convert = deps.convert ?? stripeConvertTrial
  const ledgerOpts = deps.ledgerClient ? { client: deps.ledgerClient } : undefined

  for (const row of list) {
    try {
      const fallback = tenantTrialEnd.get(row.brokerage_id) ?? null
      const trialIso = row.trial_end ?? fallback
      const isTrial = normalizeStripeStatus(row.status) === "trialing"
      const trialEnded = isTrial && !!trialIso && Number.isFinite(Date.parse(trialIso)) && Date.parse(trialIso) <= now.getTime()

      if (trialEnded) {
        const stripeLinked = !!row.stripe_subscription_id
        const pm = stripeLinked ? { ok: true, has: false } : await hasPm(row.stripe_customer_id)
        if (!pm.ok) { out.errors.push(`${row.id}: payment-method check failed (${pm.error}) — trial left for the next sweep`); continue }
        const action = planTrialEnd({ trialEnded, stripeLinked, hasPaymentMethod: pm.has })
        const cycle = reminderCycle("trial_end", trialIso!)

        if (action === "convert") {
          const { data: tier, error: tErr } = await svc.from("subscription_tiers").select("stripe_price_id").eq("id", row.tier_id).maybeSingle()
          const priceId = (tier as { stripe_price_id?: string | null } | null)?.stripe_price_id ?? null
          if (tErr || !priceId) { out.errors.push(`${row.id}: no Stripe price for tier ${row.tier_id} (${tErr?.message ?? "unpriced"}) — cannot convert`); continue }
          const res = await withActionLedger<StripeOpResult & { stripeSubscriptionId?: string }>(
            { brokerageId: row.brokerage_id, action: "billing.subscription.convert_trial", actor: { type: "system" },
              subject: { type: "subscription", id: row.id }, reasonCode: "SUBSCRIPTION_LIFECYCLE",
              reasonDetail: "trial ended with a payment method on file", cycle, riskClass: "FINANCIAL",
              systemSource: "billing_lifecycle", detail: { trial_end: trialIso, price_id: priceId } },
            () => convert({ customerId: row.stripe_customer_id!, priceId, brokerageId: row.brokerage_id, idempotencyKey: `trial-convert:${row.id}:${cycle}` }),
            {
              settle: (r) => ({ status: r.applied ? "executed" : "failed", outcome: r.applied ? "converted" : (r.skipped ? "stripe_unconfigured" : "stripe_refused"), provider: "stripe", providerRef: r.stripeSubscriptionId ?? null, error: r.error ?? null }),
              replay: () => ({ applied: false, skipped: true }),
            },
            ledgerOpts,
          )
          // The kernel event is NOT emitted here: money has not moved until Stripe says so. The
          // webhook's customer.subscription.created links the new subscription to this row and
          // emits SUBSCRIPTION_TRIAL_CONVERTED on the trialing → active transition it observes.
          if (res.applied) out.converted += 1
          else if (res.error) out.errors.push(`${row.id}: convert failed — ${res.error}`)
          continue
        }

        if (action === "expire") {
          const res = await withActionLedger<{ moved: number; error: string | null }>(
            { brokerageId: row.brokerage_id, action: "billing.subscription.expire_trial", actor: { type: "system" },
              subject: { type: "subscription", id: row.id }, reasonCode: "SUBSCRIPTION_LIFECYCLE",
              reasonDetail: "trial ended with no payment method — access paused until one is added", cycle, riskClass: "FINANCIAL",
              systemSource: "billing_lifecycle", detail: { trial_end: trialIso, from: row.status, to: "paused" } },
            async () => {
              const { data: moved, error: mErr } = await svc.from("subscriptions")
                .update({ status: "paused", updated_at: now.toISOString() })
                .eq("id", row.id).eq("status", row.status as string)
                .select("id")
              return { moved: ((moved ?? []) as unknown[]).length, error: mErr?.message ?? null }
            },
            {
              settle: (r) => ({ status: r.error ? "failed" : "executed", outcome: r.error ? "refused" : r.moved === 1 ? "paused" : "already_moved", error: r.error }),
              replay: () => ({ moved: 0, error: null }),
            },
            ledgerOpts,
          )
          if (res.error) { out.errors.push(`${row.id}: expire refused — ${res.error}`); continue }
          if (res.moved === 1) {
            out.expired += 1
            const { emitKernelEvent } = await import("@/lib/kernel/emit")
            const { KernelEvent } = await import("@/lib/kernel/events")
            await emitKernelEvent({
              event: KernelEvent.SUBSCRIPTION_TRIAL_EXPIRED, brokerageId: row.brokerage_id,
              entityType: "subscription", entityId: row.id, source: "cron",
              metadata: { trial_end: trialIso, from: row.status, to: "paused", reason: "no_payment_method" },
              dedupeKey: cycle, dedupeWindowSec: 7 * 86_400,
            })
          }
          continue
        }
        // defer_to_stripe: the reconcile (seat-sync) already mirrored Stripe's status.
        continue
      }

      const reminder = planLifecycleReminder(row, now, fallback)
      if (reminder) {
        const r = await sendSubscriptionReminder(svc, row, reminder, { send: deps.send })
        out.remindersAttempted += r.attempted
        out.remindersSent += r.sent
        if (r.error) out.errors.push(`${row.id}: ${r.error}`)
      }
    } catch (e) {
      out.errors.push(`${row.id}: ${(e as Error)?.message ?? String(e)}`)
    }
  }
  return out
}
