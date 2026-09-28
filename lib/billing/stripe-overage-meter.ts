// lib/billing/stripe-overage-meter.ts
// ─────────────────────────────────────────────────────────────────────────────
// OVERAGE ON STRIPE BILLING SUBSCRIPTIONS — Billing Meters + a metered price
// (wave 87C, owner verbatim 2026-09-28: "make video overage rate and option that
// the platform could charge on stripe billing subscriptions").
//
// WHAT ALREADY EXISTED (reused, not rebuilt): the per-tier terms live on
// plan_limits (overage_allowed + overage_rate_cents_per_1k, m479/m666); the
// overage is DERIVED at period close by lib/billing/ai-overage.ts
// (deriveAIOverage / getAIOverageStatus — one usage canon, usage_counters) and
// written through runAIOverageBilling, which CLAIMS the ai_overage_invoices
// UNIQUE(brokerage_id, period_start, metric) row before Stripe is called. That
// writethrough charged by a one-off Stripe INVOICE ITEM. This module adds the
// second channel the owner asked for — the overage billed ON the tenant's Stripe
// subscription as a metered line — without a second biller: the same claim, the
// same derivation, the same ledger row; only the provider call differs.
//
// STRIPE'S CURRENT MODEL (researched with Exa 2026-09-28, docs.stripe.com):
//   · Billing METERS aggregate meter events per customer over the billing period
//     (POST /v1/billing/meters: event_name, default_aggregation.formula=sum,
//     customer_mapping by_id on stripe_customer_id, value_settings.value).
//   · A metered PRICE is attached to the meter (recurring.usage_type=metered +
//     recurring.meter) and the price is an ITEM on the subscription (no quantity).
//   · Usage is reported as METER EVENTS (POST /v1/billing/meter_events:
//     event_name, payload{stripe_customer_id, value}, identifier — Stripe
//     enforces identifier uniqueness over a rolling ≥24h window).
//   · LEGACY usage records (subscriptionItems.createUsageRecord / usage record
//     summaries, aggregate_usage) were REMOVED in API version 2025-03-31.basil,
//     and a metered price without a meter is refused at creation. This repo pins
//     STRIPE_API_VERSION '2026-02-25.clover' (lib/stripe.ts), so meters are the
//     only usage-based path available — nothing here touches usage records.
//
// WHAT IS REPORTED: the OVERAGE units only (max(0, used − included), the
// derivation's overageTokens), never raw usage — the price is the tier's
// overage rate, so Stripe's line = units × rate/1000 cents. The rate is
// integer cents per 1K units; Stripe prices accept `unit_amount_decimal` in
// cents with up to 12 decimals, so the per-unit price is rate/1000 EXACTLY
// (50000 ¢/1K minutes → "50" ¢/minute; 2 ¢/1K tokens → "0.002" ¢/token).
// Rounding: the ledger row's amount_cents is ceil(units × rate / 1000) (the
// derivation's contract); Stripe rounds the line total to the cent, so the two
// can differ by < 1¢ on a fractional-cent AI total. Video rates are whole cents
// per minute and never differ.
//
// ORDER AND IDEMPOTENCY: the ai_overage_invoices claim is taken BEFORE any
// Stripe call (lib/billing/ai-overage.ts); the meter event carries a
// DETERMINISTIC identifier per brokerage + metric + period (and the same value
// as the request idempotency key), so a rerun after an ambiguous network
// failure re-sends the SAME event and Stripe folds it — never a second charge.
//
// FAIL SAFE, NEVER DOUBLE: when the tier has no published metered price, the
// published rate no longer matches plan_limits, the tenant has no Stripe
// subscription, the subscription bills on another interval, or the metered item
// cannot be linked — the run falls back to the EXISTING invoice-item path, which
// bills the same derived amount. A metered item that receives no meter event
// bills $0, so the two channels can never both charge one period.
//
// PUBLISHING IS AN OWNER ACTION. Nothing in this module runs on its own: the
// meter and the price are created only when platform staff press "Publish
// metered price" on /dashboard/superadmin/plans (wave 80 ruling: "i do not want
// to setup the packages yet in stripe until we are ready to push production
// rollout"). Until then every tier bills through the invoice-item fallback.
//
// NOT server-only and NO import of @/lib/stripe: the Stripe client is INJECTED
// (the caller passes the platform client), so this module adds no importer to
// the platform-key roster (scripts/stripe-account-scope-simulator.ts) and the
// proof drives it with a stub.

import {
  CANONICAL_TIERS,
  OVERAGE_METRIC_UNIT,
  isOverageBilledMetric,
  type CanonicalTierName,
  type OverageBilledMetric,
} from "./plan-catalog"

// ── PURE: names, identifiers, the price ──────────────────────────────────────

/** The meter's event name for a billed metric — derived from the ONE metric
 *  vocabulary, so a second spelling cannot exist. ≤ 100 chars (Stripe limit). */
export function overageMeterEventName(metric: OverageBilledMetric): string {
  return `overage_${metric}`
}

/** The deterministic meter-event identifier for one brokerage's overage in one
 *  closed period. Stable across reruns (idempotency), ≤ 100 chars. */
export function overageMeterIdentifier(brokerageId: string, metric: OverageBilledMetric, periodStartIso: string): string {
  return `ovg_${metric}_${periodStartIso.slice(0, 10)}_${brokerageId}`.slice(0, 100)
}

/** Strip a decimal string to its canonical form ("50.000" → "50", "0.0020" → "0.002"). */
export function normalizeDecimalString(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = String(v).trim()
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const [int, frac = ""] = s.split(".")
  const i = int!.replace(/^0+(?=\d)/, "")
  const f = frac.replace(/0+$/, "")
  return f ? `${i}.${f}` : i
}

/**
 * PURE: the per-unit Stripe price (`unit_amount_decimal`, in CENTS) for an
 * integer rate of cents per 1,000 units — rate/1000 by string arithmetic, so no
 * float ever touches money. Refuses (null) a rate that is not a positive integer:
 * a metered price is only ever published for terms that charge something.
 */
export function meteredUnitAmountDecimal(rateCentsPer1k: number): string | null {
  if (!Number.isInteger(rateCentsPer1k) || rateCentsPer1k <= 0) return null
  const s = String(rateCentsPer1k).padStart(4, "0")
  return normalizeDecimalString(`${s.slice(0, -3)}.${s.slice(-3)}`)
}

/** PURE: does a published price still charge the tier's CURRENT rate? */
export function meteredPriceMatchesRate(unitAmountDecimal: string | null | undefined, rateCentsPer1k: number): boolean {
  const want = meteredUnitAmountDecimal(rateCentsPer1k)
  return want !== null && normalizeDecimalString(unitAmountDecimal) === want
}

// ── PURE: which channel bills this period ────────────────────────────────────

/** The tier's published Stripe link, as stored on plan_limits (m669). */
export interface MeteredPriceLink {
  meterId: string
  priceId: string
  /** The rate the price was published at — a rate edit makes the price stale. */
  rateCentsPer1k: number
}

export type OverageChannel = "meter_event" | "invoice_item"

export interface ChannelDecision {
  channel: OverageChannel
  reason: string
}

/**
 * PURE: bill this tenant's overage as a METER EVENT on its subscription, or fall
 * back to the invoice item. Every "no" names why; nothing here charges.
 */
export function chooseOverageChannel(input: {
  link: MeteredPriceLink | null
  /** Set when the plan_limits Stripe columns could not be read (e.g. m669 not applied). */
  linkReadError?: string | null
  currentRateCentsPer1k: number
  stripeSubscriptionId: string | null
}): ChannelDecision {
  if (input.linkReadError) return { channel: "invoice_item", reason: `metered_link_unreadable: ${input.linkReadError}` }
  if (!input.link) return { channel: "invoice_item", reason: "no_metered_price_published_for_tier" }
  if (input.link.rateCentsPer1k !== input.currentRateCentsPer1k) {
    return { channel: "invoice_item", reason: `metered_price_stale_rate (published ${input.link.rateCentsPer1k}, terms ${input.currentRateCentsPer1k} ¢/1K) — republish` }
  }
  if (!input.stripeSubscriptionId) return { channel: "invoice_item", reason: "no_stripe_subscription" }
  return { channel: "meter_event", reason: "metered_price_on_subscription" }
}

/** One subscription item, narrowed to what the link decision needs. */
export interface SubscriptionItemFacts {
  id: string
  priceId: string | null
  /** price.recurring.meter — set only on a meter-backed metered price. */
  meterId: string | null
  usageType: string | null
  interval: string | null
}

/** Narrow a Stripe subscription's items (price expanded, the SDK default). */
export function subscriptionItemFactsOf(sub: { items?: { data?: any[] } | null } | null | undefined): SubscriptionItemFacts[] {
  return (sub?.items?.data ?? []).map((it: any) => {
    const price = typeof it?.price === "object" && it.price ? it.price : null
    return {
      id: String(it?.id ?? ""),
      priceId: price ? String(price.id ?? "") || null : (typeof it?.price === "string" ? it.price : null),
      meterId: price?.recurring?.meter ?? null,
      usageType: price?.recurring?.usage_type ?? null,
      interval: price?.recurring?.interval ?? null,
    }
  })
}

export type MeteredItemPlan =
  | { ok: true; add: boolean; removeItemIds: string[] }
  | { ok: false; reason: string }

/**
 * PURE: what must change on a subscription so it carries EXACTLY ONE item on
 * this meter, and that item is the tier's current price.
 *
 *  · missing → add the price (no quantity; Stripe meters the usage);
 *  · an item on the SAME meter with ANOTHER price (an old rate, or the tenant's
 *    previous tier) → remove it — two prices on one meter would BOTH aggregate
 *    the customer's events and charge the overage twice;
 *  · the plan (licensed) items bill on another interval than the monthly
 *    metered price → refuse (Stripe bills a subscription's items on one cycle;
 *    an annual tenant's overage stays on the invoice-item path).
 */
export function planMeteredItemChanges(items: SubscriptionItemFacts[], link: Pick<MeteredPriceLink, "meterId" | "priceId">): MeteredItemPlan {
  const licensed = items.filter((it) => (it.usageType ?? "licensed") === "licensed")
  const planInterval = licensed[0]?.interval ?? null
  if (planInterval && planInterval !== "month") return { ok: false, reason: `subscription_interval_${planInterval}` }
  const onMeter = items.filter((it) => it.meterId === link.meterId)
  const add = !onMeter.some((it) => it.priceId === link.priceId)
  const removeItemIds = onMeter.filter((it) => it.priceId !== link.priceId).map((it) => it.id)
  return { ok: true, add, removeItemIds }
}

// ── IMPURE (injected client) ─────────────────────────────────────────────────

/** The slice of the Stripe SDK this module calls. The platform client
 *  (lib/stripe.ts) satisfies it; the proof passes a stub. */
export interface OverageStripeClient {
  billing: {
    meters: {
      list(params: any): Promise<{ data: any[]; has_more?: boolean }>
      create(params: any): Promise<any>
    }
    meterEvents: {
      create(params: any, options?: any): Promise<any>
    }
  }
  prices: { create(params: any): Promise<any> }
  subscriptions: {
    retrieve(id: string, params?: any): Promise<any>
    update(id: string, params: any): Promise<any>
  }
}

/** Find the active meter for this metric's event name, or create it. A meter's
 *  event name is unique on the account, so reuse is by event name. */
export async function ensureOverageMeter(
  stripe: OverageStripeClient,
  metric: OverageBilledMetric,
  knownMeterId?: string | null,
): Promise<{ ok: true; meterId: string; created: boolean } | { ok: false; error: string }> {
  if (knownMeterId) return { ok: true, meterId: knownMeterId, created: false }
  const eventName = overageMeterEventName(metric)
  try {
    let startingAfter: string | undefined
    for (let page = 0; page < 10; page++) {
      const res = await stripe.billing.meters.list({ status: "active", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
      const hit = (res.data ?? []).find((m: any) => m?.event_name === eventName)
      if (hit?.id) return { ok: true, meterId: String(hit.id), created: false }
      if (!res.has_more || (res.data ?? []).length === 0) break
      startingAfter = String(res.data[res.data.length - 1]?.id)
    }
    const meter = await stripe.billing.meters.create({
      display_name: `${OVERAGE_METRIC_UNIT[metric].label} overage (${OVERAGE_METRIC_UNIT[metric].plural})`,
      event_name: eventName,
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    })
    if (!meter?.id) return { ok: false, error: "Stripe returned no meter id" }
    return { ok: true, meterId: String(meter.id), created: true }
  } catch (err: any) {
    return { ok: false, error: `meter lookup/create refused: ${err?.message ?? String(err)}` }
  }
}

/** Create the tier's monthly metered price on the meter at the tier's rate. */
export async function createOverageMeteredPrice(
  stripe: OverageStripeClient,
  input: { meterId: string; metric: OverageBilledMetric; planTier: CanonicalTierName; tierDisplayName?: string | null; rateCentsPer1k: number },
): Promise<{ ok: true; priceId: string; unitAmountDecimal: string } | { ok: false; error: string }> {
  const unitAmountDecimal = meteredUnitAmountDecimal(input.rateCentsPer1k)
  if (!unitAmountDecimal) return { ok: false, error: `no metered price for a rate of ${input.rateCentsPer1k} ¢/1K — turn overage on with a positive rate first (a price is never invented)` }
  const unit = OVERAGE_METRIC_UNIT[input.metric]
  try {
    const price = await stripe.prices.create({
      currency: "usd",
      billing_scheme: "per_unit",
      unit_amount_decimal: unitAmountDecimal,
      recurring: { interval: "month", usage_type: "metered", meter: input.meterId },
      product_data: { name: `${input.tierDisplayName ?? input.planTier} — ${unit.label} overage (per ${unit.singular})` },
      metadata: {
        kind: "overage_metered",
        tier_name: input.planTier,
        metric: input.metric,
        rate_cents_per_1k: String(input.rateCentsPer1k),
      },
    })
    if (!price?.id) return { ok: false, error: "Stripe returned no price id" }
    // Read the price back: a price Stripe stored at another amount must never
    // be linked (it would bill a rate nobody configured).
    if (price.unit_amount_decimal != null && !meteredPriceMatchesRate(String(price.unit_amount_decimal), input.rateCentsPer1k)) {
      return { ok: false, error: `metered price ${price.id} came back at ${price.unit_amount_decimal}¢/unit, not the configured ${unitAmountDecimal}¢ — not linked` }
    }
    return { ok: true, priceId: String(price.id), unitAmountDecimal }
  } catch (err: any) {
    return { ok: false, error: `metered price create refused: ${err?.message ?? String(err)}` }
  }
}

export type LinkOutcome =
  | { ok: true; added: boolean; removed: number }
  | { ok: false; reason: string }

/** Make the subscription carry exactly the tier's metered item (see
 *  planMeteredItemChanges). No proration: a metered item has no fixed amount. */
export async function linkMeteredPriceOnSubscription(
  stripe: OverageStripeClient,
  subscriptionId: string,
  link: Pick<MeteredPriceLink, "meterId" | "priceId">,
): Promise<LinkOutcome> {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] })
    const status = String(sub?.status ?? "")
    if (status === "canceled" || status === "incomplete_expired") return { ok: false, reason: `subscription_${status}` }
    const plan = planMeteredItemChanges(subscriptionItemFactsOf(sub), link)
    if (!plan.ok) return { ok: false, reason: plan.reason }
    if (!plan.add && plan.removeItemIds.length === 0) return { ok: true, added: false, removed: 0 }
    await stripe.subscriptions.update(subscriptionId, {
      items: [
        ...plan.removeItemIds.map((id) => ({ id, deleted: true })),
        ...(plan.add ? [{ price: link.priceId }] : []),
      ],
      proration_behavior: "none",
    })
    return { ok: true, added: plan.add, removed: plan.removeItemIds.length }
  } catch (err: any) {
    return { ok: false, reason: `link refused: ${err?.message ?? String(err)}` }
  }
}

/** Report one period's overage units for one customer as ONE meter event. */
export async function reportOverageMeterEvent(
  stripe: OverageStripeClient,
  input: { metric: OverageBilledMetric; stripeCustomerId: string; units: number; identifier: string },
): Promise<{ ok: true; identifier: string } | { ok: false; error: string }> {
  const units = Math.floor(input.units)
  if (!(units > 0)) return { ok: false, error: "nothing to report — overage units must be > 0" }
  try {
    const ev = await stripe.billing.meterEvents.create(
      {
        event_name: overageMeterEventName(input.metric),
        payload: { stripe_customer_id: input.stripeCustomerId, value: String(units) },
        identifier: input.identifier,
      },
      { idempotencyKey: input.identifier },
    )
    return { ok: true, identifier: String(ev?.identifier ?? input.identifier) }
  } catch (err: any) {
    return { ok: false, error: `meter event refused: ${err?.message ?? String(err)}` }
  }
}

// ── The owner's "Publish metered price" action, as a core ────────────────────

export interface PublishMeteredPriceResult {
  ok: true
  planTier: CanonicalTierName
  metric: OverageBilledMetric
  meterId: string
  meterCreated: boolean
  priceId: string
  unitAmountDecimal: string
  /** Stripe-linked subscriptions on the tier that now carry the metered item. */
  linked: number
  /** Subscriptions that could not carry it (annual cycle, canceled, refused) — they bill by invoice item. */
  notLinked: Array<{ brokerageId: string; reason: string }>
}

/**
 * Publish the tier's overage terms to Stripe: reuse/create the metric's meter,
 * create a metered price at the tier's CURRENT rate, store the link on the
 * plan_limits row (COUNTED — a write that matched nothing is a refusal), then
 * attach the price to every Stripe-linked subscription on the tier. The caller
 * has already gated on platform staff and audits the result.
 *
 * Refuses (nothing created) when the terms are off or the rate is 0 — the
 * price is the platform's configured rate, never an invented one.
 */
export async function publishOverageMeteredPrice(
  svc: any,
  stripe: OverageStripeClient,
  input: { planTier: string; metric: string },
): Promise<PublishMeteredPriceResult | { ok: false; error: string }> {
  const planTier = (input.planTier ?? "").trim()
  if (!(CANONICAL_TIERS as readonly string[]).includes(planTier)) return { ok: false, error: `plan_tier must be one of: ${CANONICAL_TIERS.join(", ")}` }
  if (!isOverageBilledMetric(input.metric)) return { ok: false, error: `'${input.metric}' is not a billed overage metric` }
  const metric = input.metric

  const { data: row, error: rowErr } = await svc
    .from("plan_limits")
    .select("id, overage_allowed, overage_rate_cents_per_1k, stripe_meter_id")
    .eq("plan_tier", planTier)
    .eq("metric", metric)
    .maybeSingle()
  if (rowErr) return { ok: false, error: `plan_limits read refused: ${rowErr.message}` }
  if (!row) return { ok: false, error: `no plan_limits row for (${planTier}, ${metric}) — seed the included limit first` }
  if (!row.overage_allowed) return { ok: false, error: `overage is OFF for ${planTier} ${metric} — a tier with overage off never reports usage, so there is nothing to publish` }
  const rate = Number(row.overage_rate_cents_per_1k ?? 0)

  // One meter per metric, shared by every tier: reuse any tier's stored id.
  const { data: siblings, error: sibErr } = await svc
    .from("plan_limits")
    .select("stripe_meter_id")
    .eq("metric", metric)
    .not("stripe_meter_id", "is", null)
    .limit(1)
  if (sibErr) return { ok: false, error: `plan_limits meter read refused: ${sibErr.message}` }
  const knownMeterId = (row.stripe_meter_id as string | null) ?? ((siblings ?? [])[0]?.stripe_meter_id as string | undefined) ?? null

  const meter = await ensureOverageMeter(stripe, metric, knownMeterId)
  if (!meter.ok) return { ok: false, error: meter.error }

  const { data: tierRow } = await svc.from("subscription_tiers").select("display_name").eq("tier_name", planTier).maybeSingle()
  const price = await createOverageMeteredPrice(stripe, {
    meterId: meter.meterId, metric, planTier: planTier as CanonicalTierName,
    tierDisplayName: (tierRow?.display_name as string | undefined) ?? null, rateCentsPer1k: rate,
  })
  if (!price.ok) return { ok: false, error: price.error }

  const { data: written, error: writeErr } = await svc
    .from("plan_limits")
    .update({
      stripe_meter_id: meter.meterId,
      stripe_metered_price_id: price.priceId,
      stripe_metered_rate_cents_per_1k: rate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select("id")
  if (writeErr) return { ok: false, error: `plan_limits link write refused (price ${price.priceId} exists in Stripe unlinked): ${writeErr.message}` }
  if (!written || written.length === 0) return { ok: false, error: `plan_limits link write matched no row (price ${price.priceId} exists in Stripe unlinked)` }

  // Attach to every Stripe-linked subscription on the tier.
  const { data: tenants, error: tenantsErr } = await svc.from("brokerages").select("id").eq("plan_tier", planTier)
  const notLinked: Array<{ brokerageId: string; reason: string }> = []
  let linked = 0
  if (tenantsErr) {
    notLinked.push({ brokerageId: "*", reason: `brokerages read refused: ${tenantsErr.message} — the period-close run links each subscription on demand` })
  } else {
    const ids = ((tenants ?? []) as Array<{ id: string }>).map((t) => t.id)
    if (ids.length > 0) {
      const { data: subs, error: subsErr } = await svc
        .from("subscriptions")
        .select("brokerage_id, stripe_subscription_id")
        .in("brokerage_id", ids)
        .not("stripe_subscription_id", "is", null)
      if (subsErr) {
        notLinked.push({ brokerageId: "*", reason: `subscriptions read refused: ${subsErr.message} — the period-close run links each subscription on demand` })
      } else {
        for (const s of (subs ?? []) as Array<{ brokerage_id: string; stripe_subscription_id: string }>) {
          const r = await linkMeteredPriceOnSubscription(stripe, s.stripe_subscription_id, { meterId: meter.meterId, priceId: price.priceId })
          if (r.ok) linked++
          else notLinked.push({ brokerageId: s.brokerage_id, reason: r.reason })
        }
      }
    }
  }

  return {
    ok: true, planTier: planTier as CanonicalTierName, metric,
    meterId: meter.meterId, meterCreated: meter.created,
    priceId: price.priceId, unitAmountDecimal: price.unitAmountDecimal,
    linked, notLinked,
  }
}
