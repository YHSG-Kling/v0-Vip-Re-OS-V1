#!/usr/bin/env tsx
/**
 * scripts/overage-stripe-metering-simulator.ts — test:overage-stripe-metering
 * ─────────────────────────────────────────────────────────────────────────────
 * OVERAGE IS A PLATFORM OPTION CHARGED ON STRIPE BILLING SUBSCRIPTIONS, AND
 * MULTI-LOCATION IS CUSTOM-PRICED (wave 87, lane 87C).
 *
 * Owner, verbatim 2026-09-28: "make video overage rate and option that the
 * platform could charge on stripe billing subscriptions." + the open wave-86
 * item "Multi-Location shows $1,999 vs custom".
 *
 * PURE      the meter/price/identifier math (rate/1000 as an exact decimal
 *           string), the channel decision, the one-item-per-meter rule, the
 *           widened terms validator, the derived custom-priced predicate and the
 *           public card it drives.
 * EXECUTED  the REAL runAIOverageBilling against scripts/in-memory-supabase.ts
 *           and an injected Stripe stub: a published tier bills ONE meter event
 *           on the subscription; a rerun sends NOTHING more (idempotent); a
 *           tier with overage OFF never reports (no meter event, no invoice
 *           item); unpublished / stale / annual / pre-m669 fall back to the
 *           invoice item; an ambiguous provider failure re-sends the SAME
 *           identifier. The REAL publishOverageMeteredPrice: refuses with
 *           overage off (zero Stripe calls), reuses one meter per metric,
 *           prices at the configured rate, links every subscription on the tier.
 * SOURCE    (comment-blanked) claim-before-provider on the meter path, no
 *           legacy usage-record API anywhere, no platform-key import in the
 *           injected module, both self-serve checkouts refuse a custom tier
 *           before Stripe, the migration's rule, the superadmin surface,
 *           registration. Every absence scan has a positive control.
 *
 * No network. Owner: finance_manager; co-owner data_steward (the plan
 * catalogue and the public pricing surfaces).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  overageMeterEventName, overageMeterIdentifier, meteredUnitAmountDecimal, meteredPriceMatchesRate,
  normalizeDecimalString, chooseOverageChannel, planMeteredItemChanges, subscriptionItemFactsOf,
  publishOverageMeteredPrice, type OverageStripeClient,
} from "../lib/billing/stripe-overage-meter"
import { runAIOverageBilling } from "../lib/billing/ai-overage"
import {
  validateAIOverageTermsInput, OVERAGE_BILLED_METRICS, VIDEO_OVERAGE_METRIC, AI_OVERAGE_METRIC,
  isCustomPricedTier, customPricingCheckoutRefusal, customPricingDoorPath, TIER_SEAT_BANDS, CANONICAL_TIERS,
} from "../lib/billing/plan-catalog"
import { publicTierFromRow, tierPriceLabel, tierCallToAction } from "../lib/platform/public-tiers"
import { createActivationCheckout } from "../lib/billing/subscription-activation"
import { currentUsagePeriod } from "../lib/usage/period"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const code = (s: string) => blankComments(s)
const bare = (s: string) => blankStrings(blankComments(s))
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, (m) => " ".repeat(m.length))

// ── A Stripe stub with just the surface the modules call ─────────────────────
interface StubItem { id: string; price: { id: string; recurring: { interval: string; usage_type: string; meter: string | null } } }
function stripeStub(opts: { subs?: Record<string, { status?: string; items: StubItem[] }>; failMeterEventsOnce?: Set<string> } = {}) {
  const calls: Array<{ op: string; args: any }> = []
  const subs = opts.subs ?? {}
  const priceMeter = new Map<string, string>()
  const meters: Array<{ id: string; event_name: string; status: string }> = []
  const events: Array<{ event_name: string; payload: Record<string, string>; identifier: string }> = []
  let seq = 0
  const failOnce = opts.failMeterEventsOnce ?? new Set<string>()
  const client: OverageStripeClient & { invoiceItems: { create(p: any): Promise<{ id: string }> } } = {
    billing: {
      meters: {
        async list(p: any) { calls.push({ op: "meters.list", args: p }); return { data: meters.filter((m) => m.status === "active"), has_more: false } },
        async create(p: any) { calls.push({ op: "meters.create", args: p }); const m = { id: `mtr_${++seq}`, event_name: p.event_name, status: "active" }; meters.push(m); return m },
      },
      meterEvents: {
        async create(p: any, o?: any) {
          calls.push({ op: "meterEvents.create", args: { ...p, idempotencyKey: o?.idempotencyKey } })
          if (failOnce.has(p.identifier)) { failOnce.delete(p.identifier); throw new Error("socket hang up (ambiguous — Stripe may have accepted it)") }
          // Stripe folds a repeated identifier inside its uniqueness window.
          if (!events.some((e) => e.identifier === p.identifier)) events.push({ event_name: p.event_name, payload: p.payload, identifier: p.identifier })
          return { identifier: p.identifier, event_name: p.event_name, payload: p.payload }
        },
      },
    },
    prices: {
      async create(p: any) { calls.push({ op: "prices.create", args: p }); const id = `price_m${++seq}`; if (p?.recurring?.meter) priceMeter.set(id, p.recurring.meter); return { id, unit_amount_decimal: p.unit_amount_decimal } },
    },
    subscriptions: {
      async retrieve(id: string, p?: any) { calls.push({ op: "subscriptions.retrieve", args: { id, ...p } }); const s = subs[id]; if (!s) throw new Error(`No such subscription: ${id}`); return { id, status: s.status ?? "active", items: { data: s.items } } },
      async update(id: string, p: any) {
        calls.push({ op: "subscriptions.update", args: { id, ...p } })
        const s = subs[id]; if (!s) throw new Error(`No such subscription: ${id}`)
        for (const it of p.items ?? []) {
          if (it.deleted) s.items = s.items.filter((x) => x.id !== it.id)
          else if (it.price) s.items.push({ id: `si_${++seq}`, price: { id: it.price, recurring: { interval: "month", usage_type: "metered", meter: priceMeter.get(it.price) ?? null } } })
        }
        return { id, items: { data: s.items } }
      },
    },
    invoiceItems: { async create(p: any) { calls.push({ op: "invoiceItems.create", args: p }); return { id: `ii_${++seq}` } } },
  }
  return { client, calls, events, meters, priceMeter, subs }
}
const planItem = (interval = "month"): StubItem => ({ id: `si_plan_${interval}`, price: { id: `price_plan_${interval}`, recurring: { interval, usage_type: "licensed", meter: null } } })

async function main() {
  const OVER = read("lib/billing/ai-overage.ts")
  const METER = read("lib/billing/stripe-overage-meter.ts")
  const ACT = read("app/actions/superadmin/plan-catalog.ts")
  const CARD = read("app/dashboard/superadmin/plans/ai-overage-terms-card.tsx")
  const PLANS = read("app/dashboard/superadmin/plans/page.tsx")
  const PRICING = read("app/pricing/page.tsx")
  const BILLING_ACT = read("app/actions/billing.ts")
  const ACTIVATION = read("lib/billing/subscription-activation.ts")
  const MIG = read("supabase/migrations/m669-overage-billed-on-stripe-subscriptions-by-meter.sql")
  const PKG = read("package.json")
  const REG = read("lib/kernel/manager-registry.ts")

  console.log("\n[pure — names, identifiers, the price]")
  {
    const names = OVERAGE_BILLED_METRICS.map((m) => overageMeterEventName(m))
    check("one meter event name per billed metric, derived from the vocabulary (distinct, ≤ 100 chars)", new Set(names).size === OVERAGE_BILLED_METRICS.length && names.every((n) => n.length <= 100) && names.every((n, i) => n.endsWith(OVERAGE_BILLED_METRICS[i]!)))
    const B = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
    const id1 = overageMeterIdentifier(B, VIDEO_OVERAGE_METRIC, "2026-09-01T00:00:00.000Z")
    check("the meter-event identifier is DETERMINISTIC per brokerage + metric + period (rerun → same id)", id1 === overageMeterIdentifier(B, VIDEO_OVERAGE_METRIC, "2026-09-01T00:00:00.000Z") && id1.length <= 100)
    check("...and distinct across metric, period and brokerage", new Set([id1,
      overageMeterIdentifier(B, AI_OVERAGE_METRIC, "2026-09-01T00:00:00.000Z"),
      overageMeterIdentifier(B, VIDEO_OVERAGE_METRIC, "2026-10-01T00:00:00.000Z"),
      overageMeterIdentifier("00000000-0000-4000-8000-000000000000", VIDEO_OVERAGE_METRIC, "2026-09-01T00:00:00.000Z")]).size === 4)
    check("per-unit price = rate/1000 cents, exact: 50000 ¢/1K min → \"50\" ¢/min ($0.50)", meteredUnitAmountDecimal(50000) === "50")
    check("...2 ¢/1K tokens → \"0.002\"; 1 → \"0.001\"; 1500 → \"1.5\"; 12345 → \"12.345\"",
      meteredUnitAmountDecimal(2) === "0.002" && meteredUnitAmountDecimal(1) === "0.001" && meteredUnitAmountDecimal(1500) === "1.5" && meteredUnitAmountDecimal(12345) === "12.345")
    check("no price for a rate that charges nothing or is malformed (0, −1, 2.5) — never invented", meteredUnitAmountDecimal(0) === null && meteredUnitAmountDecimal(-1) === null && meteredUnitAmountDecimal(2.5) === null)
    check("Stripe's padded decimal reads as the same price (\"50.000000000000\" matches 50000)", meteredPriceMatchesRate("50.000000000000", 50000) && normalizeDecimalString("0.0020") === "0.002")
    check("POSITIVE CONTROL — a price at another rate does NOT match", !meteredPriceMatchesRate("50", 40000) && !meteredPriceMatchesRate(null, 50000))
  }

  console.log("\n[pure — which channel bills the period]")
  {
    const link = { meterId: "mtr_1", priceId: "price_1", rateCentsPer1k: 50000 }
    check("no published price → invoice item (the existing path)", chooseOverageChannel({ link: null, currentRateCentsPer1k: 50000, stripeSubscriptionId: "sub_1" }).channel === "invoice_item")
    check("link unreadable (m669 not applied) → invoice item, reason names it", /metered_link_unreadable/.test(chooseOverageChannel({ link: null, linkReadError: "column does not exist", currentRateCentsPer1k: 50000, stripeSubscriptionId: "sub_1" }).reason))
    check("rate edited after publish → STALE → invoice item at the configured rate (never the old rate)", /stale_rate/.test(chooseOverageChannel({ link: { ...link, rateCentsPer1k: 40000 }, currentRateCentsPer1k: 50000, stripeSubscriptionId: "sub_1" }).reason))
    check("no Stripe subscription → invoice item", chooseOverageChannel({ link, currentRateCentsPer1k: 50000, stripeSubscriptionId: null }).channel === "invoice_item")
    check("published + current + subscribed → METER EVENT", chooseOverageChannel({ link, currentRateCentsPer1k: 50000, stripeSubscriptionId: "sub_1" }).channel === "meter_event")

    const L = { meterId: "mtr_1", priceId: "price_new" }
    const facts = (items: StubItem[]) => subscriptionItemFactsOf({ items: { data: items } })
    const missing = planMeteredItemChanges(facts([planItem()]), L)
    check("item missing → ADD the metered price (no quantity)", missing.ok && missing.add && missing.removeItemIds.length === 0)
    const present = planMeteredItemChanges(facts([planItem(), { id: "si_m", price: { id: "price_new", recurring: { interval: "month", usage_type: "metered", meter: "mtr_1" } } }]), L)
    check("already carried → no change (idempotent link)", present.ok && !present.add && present.removeItemIds.length === 0)
    const stale = planMeteredItemChanges(facts([planItem(), { id: "si_old", price: { id: "price_old", recurring: { interval: "month", usage_type: "metered", meter: "mtr_1" } } }]), L)
    check("a STALE price on the SAME meter is removed as the new one is added (one meter, one price — never billed twice)", stale.ok && stale.add && stale.removeItemIds.join() === "si_old")
    const other = planMeteredItemChanges(facts([planItem(), { id: "si_ai", price: { id: "price_ai", recurring: { interval: "month", usage_type: "metered", meter: "mtr_ai" } } }]), L)
    check("an item on ANOTHER meter (the AI overage) is left alone", other.ok && other.add && other.removeItemIds.length === 0)
    const annual = planMeteredItemChanges(facts([planItem("year")]), L)
    check("an ANNUAL plan cycle refuses the monthly metered item (bills by invoice item instead)", !annual.ok && /interval_year/.test((annual as any).reason))
    // POSITIVE CONTROL: the double-bill the removal prevents — two prices on one meter.
    const naive = [planItem(), { id: "si_old", price: { id: "price_old", recurring: { interval: "month", usage_type: "metered", meter: "mtr_1" } } }, { id: "si_new", price: { id: "price_new", recurring: { interval: "month", usage_type: "metered", meter: "mtr_1" } } }]
    const both = facts(naive).filter((f) => f.meterId === "mtr_1").length
    check("POSITIVE CONTROL — without the removal a subscription would carry 2 items on one meter (both aggregate the same events)", both === 2 && planMeteredItemChanges(facts(naive), L).ok && (planMeteredItemChanges(facts(naive), L) as any).removeItemIds.join() === "si_old")
  }

  console.log("\n[pure — one terms mechanism for AI and video]")
  {
    const v = validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 50000, metric: VIDEO_OVERAGE_METRIC })
    check("video_minutes terms validate through the SAME validator (metric kept)", v.ok && v.value.metric === "video_minutes" && v.value.overageRateCentsPer1k === 50000)
    check("AI stays the default metric", (() => { const a = validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 2 }); return a.ok && a.value.metric === "ai_tokens_monthly" })())
    check("a metric outside OVERAGE_BILLED_METRICS is refused (sms_sent)", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 2, metric: "sms_sent" }).ok)
    check("POSITIVE CONTROL — a near spelling (\"video\") is refused, not normalized", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 2, metric: "video" }).ok)
    check("video enabled at 0 ¢ is refused (free unlimited video by accident)", !validateAIOverageTermsInput({ planTier: "team", overageAllowed: true, overageRateCentsPer1k: 0, metric: VIDEO_OVERAGE_METRIC }).ok)
  }

  console.log("\n[executed — the period-close writethrough on the meter channel]")
  {
    const now = new Date("2026-10-05T12:00:00Z")
    const closed = currentUsagePeriod(new Date(Date.parse(currentUsagePeriod(now).periodStartIso) - 1))
    const P = closed.periodStartIso
    const B1 = "b1000000-0000-4000-8000-000000000001" // solo, published → meter event
    const B2 = "b2000000-0000-4000-8000-000000000002" // team, overage OFF → never reports
    const B3 = "b3000000-0000-4000-8000-000000000003" // brokerage, unpublished → invoice item
    const B4 = "b4000000-0000-4000-8000-000000000004" // solo, ambiguous provider failure once
    const B5 = "b5000000-0000-4000-8000-000000000005" // solo, annual cycle → invoice item
    const seed = () => ({
      usage_counters: [
        { brokerage_id: B1, metric: "video_minutes", period_start: P, value: 42 },
        { brokerage_id: B2, metric: "video_minutes", period_start: P, value: 200 },
        { brokerage_id: B3, metric: "video_minutes", period_start: P, value: 310 },
        { brokerage_id: B4, metric: "video_minutes", period_start: P, value: 35 },
        { brokerage_id: B5, metric: "video_minutes", period_start: P, value: 31 },
      ],
      brokerages: [
        { id: B1, plan_tier: "solo_agent" }, { id: B2, plan_tier: "team" }, { id: B3, plan_tier: "brokerage" },
        { id: B4, plan_tier: "solo_agent" }, { id: B5, plan_tier: "solo_agent" },
      ],
      plan_limits: [
        { id: "pl_solo", plan_tier: "solo_agent", metric: "video_minutes", limit_value: 30, overage_allowed: true, overage_rate_cents_per_1k: 50000, stripe_meter_id: "mtr_video", stripe_metered_price_id: "price_solo_video", stripe_metered_rate_cents_per_1k: 50000 },
        { id: "pl_team", plan_tier: "team", metric: "video_minutes", limit_value: 150, overage_allowed: false, overage_rate_cents_per_1k: 0, stripe_meter_id: "mtr_video", stripe_metered_price_id: "price_team_video", stripe_metered_rate_cents_per_1k: 50000 },
        { id: "pl_brok", plan_tier: "brokerage", metric: "video_minutes", limit_value: 300, overage_allowed: true, overage_rate_cents_per_1k: 50000, stripe_meter_id: null, stripe_metered_price_id: null, stripe_metered_rate_cents_per_1k: null },
      ],
      subscriptions: [
        { brokerage_id: B1, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", created_at: "2026-01-01" },
        { brokerage_id: B2, stripe_customer_id: "cus_2", stripe_subscription_id: "sub_2", created_at: "2026-01-01" },
        { brokerage_id: B3, stripe_customer_id: "cus_3", stripe_subscription_id: "sub_3", created_at: "2026-01-01" },
        { brokerage_id: B4, stripe_customer_id: "cus_4", stripe_subscription_id: "sub_4", created_at: "2026-01-01" },
        { brokerage_id: B5, stripe_customer_id: "cus_5", stripe_subscription_id: "sub_5", created_at: "2026-01-01" },
      ],
      ai_overage_invoices: [] as any[],
    })
    const svc = memSupabase(seed())
    const id4 = overageMeterIdentifier(B4, "video_minutes", P)
    const stub = stripeStub({
      subs: {
        sub_1: { items: [planItem(), { id: "si_stale", price: { id: "price_old_solo", recurring: { interval: "month", usage_type: "metered", meter: "mtr_video" } } }] },
        sub_2: { items: [planItem()] }, sub_3: { items: [planItem()] }, sub_4: { items: [planItem()] }, sub_5: { items: [planItem("year")] },
      },
      failMeterEventsOnce: new Set([id4]),
    })
    stub.priceMeter.set("price_solo_video", "mtr_video")

    const r1 = await runAIOverageBilling({ now, metric: VIDEO_OVERAGE_METRIC, deps: { svc, stripe: stub.client } })
    check("the run completes against the injected client + stub", r1.ok === true)
    const out = (b: string) => (r1 as any).outcomes.find((o: any) => o.brokerageId === b)
    const ev1 = stub.events.filter((e) => e.payload.stripe_customer_id === "cus_1")
    check("B1 (published tier) billed as ONE meter event on its subscription", out(B1)?.status === "billed" && out(B1)?.channel === "meter_event" && ev1.length === 1)
    check("...the event reports the OVERAGE units only (42 used − 30 included = 12), keyed by the Stripe customer", ev1[0]?.payload.value === "12" && ev1[0]?.event_name === overageMeterEventName("video_minutes"))
    check("...with the deterministic identifier, also sent as the idempotency key", ev1[0]?.identifier === overageMeterIdentifier(B1, "video_minutes", P)
      && stub.calls.some((c) => c.op === "meterEvents.create" && c.args.identifier === ev1[0]?.identifier && c.args.idempotencyKey === ev1[0]?.identifier))
    const row1 = (svc.tables.ai_overage_invoices ?? []).find((r) => r.brokerage_id === B1)
    check("...the ledger row is billed with billing_channel meter_event + the identifier (amount 12 × $0.50 = 600¢)", row1?.status === "billed" && row1?.billing_channel === "meter_event" && row1?.stripe_meter_event_identifier === ev1[0]?.identifier && row1?.amount_cents === 600)
    const sub1Items = stub.subs.sub_1!.items
    check("...the subscription now carries exactly ONE item on the meter: the tier's current price (stale one removed)", sub1Items.filter((i) => i.price.recurring.meter === "mtr_video").map((i) => i.price.id).join() === "price_solo_video")
    check("B2 (overage OFF for the tier) is skipped — overage_not_allowed_for_tier", out(B2)?.status === "skipped" && out(B2)?.reason === "overage_not_allowed_for_tier")
    check("POSITIVE CONTROL — a tier with overage off NEVER reports: zero meter events, zero invoice items, zero ledger rows, zero subscription edits for B2",
      stub.events.every((e) => e.payload.stripe_customer_id !== "cus_2")
      && !stub.calls.some((c) => c.op === "invoiceItems.create" && c.args.customer === "cus_2")
      && !(svc.tables.ai_overage_invoices ?? []).some((r) => r.brokerage_id === B2)
      && !stub.calls.some((c) => (c.op === "subscriptions.update" || c.op === "subscriptions.retrieve") && c.args.id === "sub_2"))
    check("B3 (no published price) FALLS BACK to the existing invoice item, reason named", out(B3)?.status === "billed" && out(B3)?.channel === "invoice_item" && out(B3)?.channelReason === "no_metered_price_published_for_tier"
      && stub.calls.some((c) => c.op === "invoiceItems.create" && c.args.customer === "cus_3" && c.args.amount === 500))
    check("...and no meter event was sent for B3", stub.events.every((e) => e.payload.stripe_customer_id !== "cus_3"))
    check("B4 ambiguous provider failure → claim RELEASED, refused (nothing marked billed)", out(B4)?.status === "refused" && !(svc.tables.ai_overage_invoices ?? []).some((r) => r.brokerage_id === B4))
    check("B5 (annual cycle) → the metered item is refused, invoice item bills instead", out(B5)?.status === "billed" && out(B5)?.channel === "invoice_item" && /interval_year/.test(out(B5)?.channelReason ?? ""))

    const eventsBefore = stub.events.length
    const meterCallsBefore = stub.calls.filter((c) => c.op === "meterEvents.create").length
    const invoiceCallsBefore = stub.calls.filter((c) => c.op === "invoiceItems.create").length
    const r2 = await runAIOverageBilling({ now, metric: VIDEO_OVERAGE_METRIC, deps: { svc, stripe: stub.client } })
    const out2 = (b: string) => (r2 as any).outcomes.find((o: any) => o.brokerageId === b)
    check("RERUN: B1/B3/B5 already_billed — no second meter event or invoice item for them", out2(B1)?.reason === "already_billed" && out2(B3)?.reason === "already_billed" && out2(B5)?.reason === "already_billed")
    const b4Calls = stub.calls.filter((c) => c.op === "meterEvents.create" && c.args.identifier === id4)
    check("RERUN: B4 re-sends the SAME identifier (Stripe folds a duplicate) and is billed once", out2(B4)?.status === "billed" && b4Calls.length === 2 && b4Calls[0]!.args.identifier === b4Calls[1]!.args.identifier && stub.events.filter((e) => e.identifier === id4).length === 1)
    check("RERUN: exactly one new meter call (B4's retry) and zero new invoice items", stub.calls.filter((c) => c.op === "meterEvents.create").length === meterCallsBefore + 1 && stub.calls.filter((c) => c.op === "invoiceItems.create").length === invoiceCallsBefore && stub.events.length === eventsBefore + 1)
    check("one ledger row per (brokerage, period, metric) — idempotency holds across channels", (svc.tables.ai_overage_invoices ?? []).length === 4)

    // Stale rate → invoice item at the CONFIGURED rate.
    const svcStale = memSupabase({ ...seed(), plan_limits: seed().plan_limits.map((r) => (r.id === "pl_solo" ? { ...r, stripe_metered_rate_cents_per_1k: 40000 } : r)) })
    const stubStale = stripeStub({ subs: { sub_1: { items: [planItem()] }, sub_2: { items: [planItem()] }, sub_3: { items: [planItem()] }, sub_4: { items: [planItem()] }, sub_5: { items: [planItem()] } } })
    const rs = await runAIOverageBilling({ now, metric: VIDEO_OVERAGE_METRIC, deps: { svc: svcStale, stripe: stubStale.client } })
    const s1 = (rs as any).outcomes.find((o: any) => o.brokerageId === B1)
    check("a rate edited after publish bills by invoice item at the NEW rate — never a meter event at the stale price", s1?.channel === "invoice_item" && /stale_rate/.test(s1?.channelReason ?? "") && stubStale.events.length === 0
      && stubStale.calls.some((c) => c.op === "invoiceItems.create" && c.args.customer === "cus_1" && c.args.amount === 600))

    // Pre-m669: the link columns do not exist → the run still bills (invoice item) and names no new column.
    const svcPre = memSupabase(seed(), { missingColumns: { plan_limits: ["stripe_meter_id", "stripe_metered_price_id", "stripe_metered_rate_cents_per_1k"], ai_overage_invoices: ["billing_channel", "stripe_meter_event_identifier"] } })
    const stubPre = stripeStub({ subs: { sub_1: { items: [planItem()] }, sub_3: { items: [planItem()] }, sub_4: { items: [planItem()] }, sub_5: { items: [planItem()] } } })
    const rp = await runAIOverageBilling({ now, metric: VIDEO_OVERAGE_METRIC, deps: { svc: svcPre, stripe: stubPre.client } })
    const p1 = (rp as any).outcomes.find((o: any) => o.brokerageId === B1)
    check("BEFORE m669 is applied the run degrades to the invoice item (link unreadable) and bills — never breaks", (rp as any).ok && p1?.status === "billed" && p1?.channel === "invoice_item" && /metered_link_unreadable/.test(p1?.channelReason ?? "") && stubPre.events.length === 0)
  }

  console.log("\n[executed — the owner's Publish action core]")
  {
    const svc = memSupabase({
      plan_limits: [
        { id: "pl_solo", plan_tier: "solo_agent", metric: "video_minutes", limit_value: 30, overage_allowed: true, overage_rate_cents_per_1k: 50000, stripe_meter_id: null, stripe_metered_price_id: null, stripe_metered_rate_cents_per_1k: null },
        { id: "pl_team", plan_tier: "team", metric: "video_minutes", limit_value: 150, overage_allowed: true, overage_rate_cents_per_1k: 50000, stripe_meter_id: null, stripe_metered_price_id: null, stripe_metered_rate_cents_per_1k: null },
        { id: "pl_multi", plan_tier: "multi_location", metric: "video_minutes", limit_value: -1, overage_allowed: false, overage_rate_cents_per_1k: 0, stripe_meter_id: null, stripe_metered_price_id: null, stripe_metered_rate_cents_per_1k: null },
      ],
      subscription_tiers: [{ tier_name: "solo_agent", display_name: "Solo Agent" }, { tier_name: "team", display_name: "Team" }],
      brokerages: [{ id: "bA", plan_tier: "solo_agent" }, { id: "bB", plan_tier: "solo_agent" }, { id: "bC", plan_tier: "team" }],
      subscriptions: [
        { brokerage_id: "bA", stripe_subscription_id: "sub_A" },
        { brokerage_id: "bB", stripe_subscription_id: "sub_B" },
        { brokerage_id: "bC", stripe_subscription_id: "sub_C" },
      ],
    })
    const stub = stripeStub({ subs: { sub_A: { items: [planItem()] }, sub_B: { items: [planItem("year")] }, sub_C: { items: [planItem()] } } })

    const off = await publishOverageMeteredPrice(svc, stub.client, { planTier: "multi_location", metric: "video_minutes" })
    check("POSITIVE CONTROL — overage OFF (multi_location) → refused and ZERO Stripe calls (nothing published, no price invented)", !off.ok && /overage is OFF/.test((off as any).error) && stub.calls.length === 0)
    check("a metric outside the billed vocabulary is refused before any read", !(await publishOverageMeteredPrice(svc, stub.client, { planTier: "solo_agent", metric: "sms_sent" })).ok && stub.calls.length === 0)

    const solo = await publishOverageMeteredPrice(svc, stub.client, { planTier: "solo_agent", metric: "video_minutes" })
    const mc = stub.calls.find((c) => c.op === "meters.create")?.args
    check("publish creates ONE meter for the metric: sum aggregation, customer by_id on stripe_customer_id, value key", solo.ok && mc?.event_name === "overage_video_minutes" && mc?.default_aggregation?.formula === "sum" && mc?.customer_mapping?.type === "by_id" && mc?.customer_mapping?.event_payload_key === "stripe_customer_id" && mc?.value_settings?.event_payload_key === "value")
    const pc = stub.calls.find((c) => c.op === "prices.create")?.args
    check("...a monthly METERED price on that meter at the CONFIGURED rate (unit_amount_decimal \"50\" = $0.50/min)", pc?.recurring?.usage_type === "metered" && pc?.recurring?.meter === (solo as any).meterId && pc?.recurring?.interval === "month" && pc?.unit_amount_decimal === "50" && pc?.metadata?.kind === "overage_metered")
    const soloRow = svc.tables.plan_limits!.find((r) => r.id === "pl_solo")
    check("...stores the link on plan_limits (meter, price, published rate)", soloRow?.stripe_meter_id === (solo as any).meterId && soloRow?.stripe_metered_price_id === (solo as any).priceId && soloRow?.stripe_metered_rate_cents_per_1k === 50000)
    check("...links the monthly subscription on the tier and reports the annual one as not linked", (solo as any).linked === 1 && (solo as any).notLinked.length === 1 && (solo as any).notLinked[0].brokerageId === "bB")
    check("...and never touches another tier's subscription", !stub.calls.some((c) => c.op.startsWith("subscriptions") && c.args.id === "sub_C"))
    const team = await publishOverageMeteredPrice(svc, stub.client, { planTier: "team", metric: "video_minutes" })
    check("a second tier REUSES the metric's meter (one meter per metric; no second meters.create)", team.ok && (team as any).meterId === (solo as any).meterId && stub.calls.filter((c) => c.op === "meters.create").length === 1)
  }

  console.log("\n[multi-location is custom-priced — derived, displayed, refused at checkout]")
  {
    check("isCustomPricedTier is DERIVED from the seat bands (custom ⇔ band null) for every canonical tier", CANONICAL_TIERS.every((t) => isCustomPricedTier(t) === (TIER_SEAT_BANDS[t] === null)))
    check("...which today is exactly multi_location", CANONICAL_TIERS.filter((t) => isCustomPricedTier(t)).join() === "multi_location" && !isCustomPricedTier("enterprise") && !isCustomPricedTier(null))
    const multi = publicTierFromRow({ tier_name: "multi_location", display_name: "Multi-Location", monthly_price_cents: 199900, annual_price_cents: 1999000, setup_fee_cents: 0 })
    check("the live $1,999 placeholder NEVER reaches a public card: amounts zeroed, customPriced true", multi.customPriced && multi.monthlyCents === 0 && multi.annualCents === 0 && multi.setupCents === 0)
    check("...headline reads \"Custom pricing\" and the CTA opens the sales door, not a trial", tierPriceLabel(multi) === "Custom pricing" && tierCallToAction(multi).label === "Contact sales" && tierCallToAction(multi).href === customPricingDoorPath("multi_location"))
    const solo = publicTierFromRow({ tier_name: "solo_agent", display_name: "Solo Agent", monthly_price_cents: 9900, annual_price_cents: 99900, setup_fee_cents: 0 })
    check("POSITIVE CONTROL — a list-priced tier keeps its configured price and trial CTA", !solo.customPriced && solo.monthlyCents === 9900 && tierPriceLabel(solo) === "$99" && tierCallToAction(solo).label === "Start free trial")
    check("customPricingCheckoutRefusal names the door for multi_location, null for team", /custom-priced/.test(customPricingCheckoutRefusal("multi_location") ?? "") && customPricingCheckoutRefusal("team") === null)
    const svc = memSupabase({ subscription_tiers: [{ id: "t_multi", tier_name: "multi_location", display_name: "Multi-Location", monthly_price_cents: 199900, annual_price_cents: 1999000, setup_fee_cents: 0, is_active: true }] })
    const co = await createActivationCheckout(svc, { brokerageId: "bX", tierId: "t_multi", billingCycle: "monthly", successUrl: "https://x/ok", cancelUrl: "https://x/no" })
    check("EXECUTED — the hosted activation checkout refuses a custom tier before any Stripe call (customPricing flag)", !co.ok && (co as any).customPricing === true && !svc.writes.length)
    const a = code(BILLING_ACT)
    const fnAt = a.indexOf("export async function startSubscriptionCheckout")
    const refuseAt = a.indexOf("customPricingCheckoutRefusal(", fnAt)
    const custAt = a.indexOf("stripe.customers.create(", fnAt)
    check("the in-app embedded checkout refuses it BEFORE creating a Stripe customer/session", fnAt !== -1 && refuseAt > fnAt && custAt > refuseAt)
    const act = code(ACTIVATION)
    check("the activation checkout asks the same predicate before getPlatformStripe", act.indexOf("customPricingCheckoutRefusal(") !== -1 && act.indexOf("customPricingCheckoutRefusal(") < act.indexOf("getPlatformStripe"))
    const pr = bare(PRICING)
    check("/pricing renders the price and CTA through tierPriceLabel / tierCallToAction (no inline trial link per card)", /tierPriceLabel\(t\)/.test(pr) && /tierCallToAction\(t\)/.test(pr) && !/formatTierPrice\(t\.monthlyCents\)/.test(pr))
    check("POSITIVE CONTROL — the inline-price scan would flag the old card", /formatTierPrice\(t\.monthlyCents\)/.test(bare('<span>{formatTierPrice(t.monthlyCents)}</span>')))
  }

  console.log("\n[source — order, no legacy API, injected client, surface]")
  {
    const o = code(OVER)
    const claimAt = o.indexOf('from("ai_overage_invoices")\n      .insert(')
    const linkAt = o.indexOf("linkMeteredPriceOnSubscription(stripe")
    const eventAt = o.indexOf("reportOverageMeterEvent(stripe")
    check("the ledger CLAIM precedes every Stripe call on the meter path (link + event)", claimAt !== -1 && linkAt > claimAt && eventAt > linkAt)
    check("billed on the meter path only WITH the provider identifier + channel", /\.update\(\{ status: "billed", billing_channel: "meter_event", stripe_meter_event_identifier: reported\.identifier/.test(o))
    check("the invoice-item path names NO m669 column (safe before the migration is applied)", !/\.update\(\{ status: "billed", stripe_invoice_item_id: invoiceItemId[^}]*billing_channel/.test(o))
    const legacy = /createUsageRecord|usageRecords\s*\.|usage_record_summaries|listUsageRecordSummaries|aggregate_usage/
    const files = [OVER, METER, ACT, read("lib/billing/stripe-subscription-ops.ts")]
    check("NO legacy usage-record API in the overage path (removed in 2025-03-31.basil)", files.every((f) => !legacy.test(bare(f))))
    check("POSITIVE CONTROL — the legacy scan recognises a usage-record call", legacy.test(bare("await stripe.subscriptionItems.createUsageRecord(si, { quantity: 3 })")))
    check("the meter module takes the Stripe client INJECTED (no platform-key import added to the roster)", !/from\s*["']@\/lib\/stripe["']|import\(["']@\/lib\/stripe["']\)/.test(code(METER)))
    const a = code(ACT)
    check("publishOverageMeteredPriceAction is superadmin-gated FIRST and audited", /export async function publishOverageMeteredPriceAction[\s\S]{0,400}?requireSuperadmin\(\)/.test(a) && /audit\(auth\.userId, "plan_limits\.overage_metered_price_published"/.test(a))
    check("...refuses when Stripe is unconfigured (nothing published)", /publishOverageMeteredPriceAction[\s\S]*?isStripeConfigured\(\)\) return \{ ok: false/.test(a))
    check("the terms upsert writes the metric it validated and audits before → after (the change log)", /\.eq\("metric", v\.value\.metric\)/.test(a) && /audit\(auth\.userId, "plan_limits\.overage_terms_updated"[\s\S]{0,300}?before:/.test(a))
    check("the change-log READER reads the audit rows those actions write", /export async function listOverageTermsChangeLogAction[\s\S]*?from\("superadmin_audit_log"\)[\s\S]*?\.eq\("target_type", "plan_limit"\)/.test(a))
    const c = code(CARD)
    check("the card administers every billed metric and publishes through the action (no raw supabase)", /OVERAGE_BILLED_METRICS\.map/.test(c) && /publishOverageMeteredPriceAction\(/.test(c) && /upsertAIOverageTermsAction\(/.test(c) && !/supabase|createServiceClient/.test(c))
    check("the plans page loads the change log through the action lane", /listOverageTermsChangeLogAction\(\)/.test(code(PLANS)))
  }

  console.log("\n[migration m669 — the rule, not the waypoint]")
  {
    const m = sqlCode(MIG)
    check("plan_limits gains the three link columns (nullable = nothing published)", /add column if not exists stripe_meter_id text/.test(m) && /add column if not exists stripe_metered_price_id text/.test(m) && /add column if not exists stripe_metered_rate_cents_per_1k integer/.test(m))
    check("a price link is complete or absent (CHECK)", /stripe_metered_price_id is null\s*or \(stripe_meter_id is not null and stripe_metered_rate_cents_per_1k is not null/.test(m))
    check("the ledger gains billing_channel (default invoice_item, CHECK two values) + the identifier", /billing_channel text not null default 'invoice_item'/.test(m) && /check \(billing_channel in \('invoice_item', 'meter_event'\)\)/.test(m) && /stripe_meter_event_identifier text/.test(m))
    check("'billed' still requires the channel's OWN provider result", /billing_channel = 'invoice_item' and stripe_invoice_item_id is not null/.test(m) && /billing_channel = 'meter_event' and stripe_meter_event_identifier is not null/.test(m))
    check("no price is set by the migration (no UPDATE of rates / ids)", !/update public\.plan_limits/.test(m))
    check("postconditions RAISE", (m.match(/raise exception/g) ?? []).length >= 4)
  }

  console.log("\n[registration]")
  {
    const guard = (JSON.parse(PKG).scripts?.guard ?? "") as string
    check("package.json test:overage-stripe-metering runs this proof", /"test:overage-stripe-metering":\s*"tsx scripts\/overage-stripe-metering-simulator\.ts"/.test(PKG))
    check("...chained exactly once in guard, AFTER test:scrapers (ordering only)", (guard.match(/npm run test:overage-stripe-metering(?![\w-])/g) ?? []).length === 1 && guard.indexOf("npm run test:scrapers") < guard.indexOf("npm run test:overage-stripe-metering"))
    check("MAINTENANCE_DOMAINS names an owner and coOwners for the proof", /proof: "test:overage-stripe-metering", coOwners: \[/.test(REG))
  }

  console.log("\n" + "─".repeat(78))
  console.log(`${pass} passed, ${fail} failed`)
  if (fail) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
  console.log(" ✅ OVERAGE_STRIPE_METERING_PASS — overage terms are one platform option per tier and metric, charged as meter events on Stripe subscriptions when published (invoice item otherwise), idempotently; multi-location is quoted, never listed")
}
main().catch((e) => { console.error(e); process.exit(1) })
