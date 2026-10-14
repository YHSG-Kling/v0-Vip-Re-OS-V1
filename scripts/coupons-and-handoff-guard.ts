#!/usr/bin/env tsx
/**
 * scripts/coupons-and-handoff-guard.ts   (npm run test:coupons-and-handoff)
 * ─────────────────────────────────────────────────────────────────────────────
 * COUPONS ON EVERY CHARGE + THE SUBSCRIBER → BROKERAGE BILLING HANDOFF (wave 141H).
 * In memory, Stripe stubbed, no network, no model.
 *
 *   A · ELIGIBILITY IS STRIPE'S OWN RULES, JUDGED PURELY (lib/platform/coupons.ts):
 *       valid / redeem_by / caps / applies_to.products / promotion-code active, expiry,
 *       cap, first purchase, minimum amount, customer pin — each refused by name, each
 *       with a passing control; the `discounts` param prefers the promotion code and
 *       never carries a mock id.
 *   B · THE ONE RESOLVER (lib/billing/discount-codes.ts resolveDiscountForCheckout):
 *       a valid platform code is applied; an unknown code is refused AT ONCE; an
 *       expired code and a wrong-tier code are refused BEFORE any Stripe call; an
 *       unpublished (mock) platform coupon is refused by name; a Stripe-only promotion
 *       code is applied; a Stripe-exhausted coupon is refused; the signup bag applies
 *       with no code typed; nothing + nothing = none; unconfigured Stripe = skipped.
 *   C · THE APPLIERS (stripped source, finder control): both checkouts resolve BEFORE
 *       any Stripe customer / session and spread the params (allow_promotion_codes when
 *       none); the trial conversion carries `discounts`; the funnel check validates on
 *       Stripe; applyDiscountCodeAction rides withActionLedger + stripeApplyCoupon; the
 *       hosted checkout refuses an expired code in memory with discountRefused.
 *   D · RECONCILIATION: invoiceDiscountCents sums Stripe's amounts; the subscription's
 *       coupon is read from discounts[] / discount; the stamp lands on THIS tenant's
 *       redemption only; the webhook writes discount_cents SEPARATELY after the invoice
 *       upsert; recordCouponRedemption (the merged survivor) — first / already / derived
 *       count — and its three callers.
 *   E · THE HANDOFF (lib/billing/subscriber-handoff.ts): scheduled with
 *       create_prorations; a second run is a replay that acts on nothing; immediate with
 *       prorate + invoice_now and the final invoice; wrong tenant / same tenant /
 *       unsubscribed target / unknown target refused with NO Stripe call and NO ledger
 *       row; a local (never Stripe-linked) source is cancelled now or swept at cancel_at;
 *       the target row is untouched (no double billing); evidence rows.
 *   F · REGISTRATION (membership, never a chain position).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"
import {
  normalizeStripeDiscount, evaluateStripeDiscount, checkoutDiscountParams, type StripeDiscountShape,
} from "../lib/platform/coupons"
import {
  resolveDiscountForCheckout, recordCouponRedemption, stampCouponStripeApplication, invoiceDiscountCents, subscriptionDiscountCoupon,
} from "../lib/billing/discount-codes"
import { handoffSubscriberBillingToBrokerage, handoffCycle } from "../lib/billing/subscriber-handoff"
import { runSubscriptionLifecycleSweep } from "../lib/billing/stripe-subscription-ops"
import { createActivationCheckout } from "../lib/billing/subscription-activation"
import { validateFunnelCoupon } from "../lib/platform/trial-funnel"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const control = (name: string, cond: boolean, detail?: string) => check(`CONTROL: ${name}`, cond, detail)
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Coupons + billing handoff verified — Stripe validates, Stripe prices, the ledger reconciles; the handoff prorates once and never crosses a tenant")
  console.log(" COUPONS_AND_HANDOFF_PASS")
}
const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => blankComments(src(p), { jsx: true })

// ─── in-memory supabase — the billing-convergence proof's fake (writers COUNT rows; the ledger's
//     UNIQUE idempotency_key + attempts DEFAULT are modelled, which the handoff's replay rides) ───
type Row = Record<string, any>
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  let seq = 0
  const t = (name: string) => (tables[name] ??= [])
  const like = (pat: string) => new RegExp("^" + pat.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i")
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select"
    let payload: any = null, onConflict: string | null = null
    let order: { col: string; asc: boolean } | null = null, lim: number | null = null
    let mode: "many" | "single" | "maybe" = "many", count = false, head = false, wantRows = false
    const matched = () => t(table).filter((r) => filters.every((f) => f(r)))
    const shape = (rows: Row[]) => {
      if (mode === "single") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: `${rows.length} rows` } }
      if (mode === "maybe") return { data: rows[0] ?? null, error: null }
      return { data: rows, error: null }
    }
    function exec() {
      if (op === "select") {
        let rows = matched()
        if (order) { const { col, asc } = order; rows = [...rows].sort((a, b2) => (a[col] < b2[col] ? -1 : a[col] > b2[col] ? 1 : 0) * (asc ? 1 : -1)) }
        if (lim != null) rows = rows.slice(0, lim)
        const snap = rows.map((r) => ({ ...r }))
        if (count) return { data: head ? null : snap, error: null, count: snap.length }
        return shape(snap)
      }
      if (op === "insert") {
        const defaults: Row = table === "agent_action_ledger" ? { attempts: 1 } : {}
        const list: Row[] = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: `${table}_${++seq}`, created_at: new Date().toISOString(), ...defaults, ...p }))
        if (table === "agent_action_ledger") {
          for (const p of list) if (p.idempotency_key && t(table).some((r) => r.idempotency_key === p.idempotency_key)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint agent_action_ledger_idempotency_key_key" } }
        }
        if (table === "platform_coupon_redemptions") {
          for (const p of list) if (t(table).some((r) => r.coupon_id === p.coupon_id && r.brokerage_id === p.brokerage_id)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint platform_coupon_redemptions_coupon_id_brokerage_id_key" } }
        }
        t(table).push(...list)
        return wantRows ? shape(list) : { data: null, error: null }
      }
      if (op === "update") { const rows = matched(); for (const r of rows) Object.assign(r, payload); return wantRows ? shape(rows) : { data: null, error: null } }
      if (op === "upsert") {
        const out: Row[] = []
        for (const p of (Array.isArray(payload) ? payload : [payload])) {
          const ex = onConflict ? t(table).find((r) => r[onConflict!] === p[onConflict!]) : null
          if (ex) { Object.assign(ex, p); out.push(ex) } else { const n = { id: `${table}_${++seq}`, ...p }; t(table).push(n); out.push(n) }
        }
        return wantRows ? shape(out) : { data: null, error: null }
      }
      const rows = matched(); tables[table] = t(table).filter((r) => !rows.includes(r))
      return wantRows ? shape(rows) : { data: null, error: null }
    }
    const b: any = {
      select(_c?: string, o?: any) { if (op === "select") { count = !!o?.count; head = !!o?.head } else wantRows = true; return b },
      insert(p: any) { op = "insert"; payload = p; return b },
      update(p: any) { op = "update"; payload = p; return b },
      upsert(p: any, o?: any) { op = "upsert"; payload = p; onConflict = o?.onConflict ?? null; return b },
      delete() { op = "delete"; return b },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      not(c: string, o: string, v: any) { filters.push((r) => (o === "is" && v === null ? r[c] != null : o === "like" ? !like(String(v)).test(String(r[c] ?? "")) : r[c] !== v)); return b },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] >= v); return b },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] > v); return b },
      lte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] <= v); return b },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return b },
      ilike(c: string, p: string) { filters.push((r) => like(p).test(String(r[c] ?? ""))); return b },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return b },
      limit(n: number) { lim = n; return b },
      maybeSingle() { mode = "maybe"; return b },
      single() { mode = "single"; return b },
      then(res: any, rej: any) { return Promise.resolve().then(exec).then(res, rej) },
    }
    return b
  }
  return { from, tables }
}

const NOW = new Date("2026-10-14T12:00:00.000Z")
const unix = (d: Date) => Math.floor(d.getTime() / 1000)

// Stripe objects as the SDK returns them (coupon with applies_to expanded; promotion code row).
const stripeCoupon = (over: Row = {}): Row => ({ id: "cpn_live", valid: true, redeem_by: null, max_redemptions: null, times_redeemed: 0, percent_off: 20, duration: "repeating", duration_in_months: 3, ...over })
const stripePromo = (over: Row = {}): Row => ({ id: "promo_1", code: "FALL25", active: true, expires_at: null, max_redemptions: null, times_redeemed: 0, customer: null, restrictions: { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null }, coupon: stripeCoupon({ id: "cpn_promo" }), ...over })

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Coupons + subscriber→brokerage billing handoff")
  console.log("══════════════════════════════════════════════════")

  // ─── A · eligibility ────────────────────────────────────────────────────────
  console.log("\n[A · Stripe's own restrictions, judged purely]")
  const ok = (shape: StripeDiscountShape, ctx: Row = {}) => evaluateStripeDiscount(shape, { now: NOW, ...ctx }, "CODE")
  const base = normalizeStripeDiscount(stripeCoupon())
  check("a valid, unrestricted coupon is eligible", ok(base).ok)
  check("coupon.valid=false → stripe_invalid", (ok(normalizeStripeDiscount(stripeCoupon({ valid: false }))) as any).reason === "stripe_invalid")
  check("redeem_by in the past → stripe_expired (a future redeem_by passes)",
    (ok(normalizeStripeDiscount(stripeCoupon({ redeem_by: unix(NOW) - 60 }))) as any).reason === "stripe_expired" && ok(normalizeStripeDiscount(stripeCoupon({ redeem_by: unix(NOW) + 3600 }))).ok)
  check("times_redeemed ≥ max_redemptions → stripe_exhausted (one left passes)",
    (ok(normalizeStripeDiscount(stripeCoupon({ max_redemptions: 5, times_redeemed: 5 }))) as any).reason === "stripe_exhausted" && ok(normalizeStripeDiscount(stripeCoupon({ max_redemptions: 5, times_redeemed: 4 }))).ok)
  const restricted = normalizeStripeDiscount(stripeCoupon({ applies_to: { products: ["prod_team"] } }))
  check("applies_to.products with no matching product (ad-hoc price_data lines) → product_restricted; a matching product passes",
    (ok(restricted, { productIds: [] }) as any).reason === "product_restricted" && ok(restricted, { productIds: ["prod_team"] }).ok)
  const promoOf = (over: Row = {}, couponOver: Row = {}) => normalizeStripeDiscount(stripeCoupon(couponOver), stripePromo(over))
  check("promotion code: inactive → promo_inactive; expired → promo_expired; exhausted → promo_exhausted",
    (ok(promoOf({ active: false })) as any).reason === "promo_inactive" && (ok(promoOf({ expires_at: unix(NOW) - 1 })) as any).reason === "promo_expired" && (ok(promoOf({ max_redemptions: 1, times_redeemed: 1 })) as any).reason === "promo_exhausted")
  check("promotion code: first_time_transaction refused for a returning customer, allowed for a first purchase / unknown",
    (ok(promoOf({ restrictions: { first_time_transaction: true } }), { isFirstTransaction: false }) as any).reason === "promo_first_purchase_only"
    && ok(promoOf({ restrictions: { first_time_transaction: true } }), { isFirstTransaction: true }).ok && ok(promoOf({ restrictions: { first_time_transaction: true } }), {}).ok)
  check("promotion code: minimum_amount refused under the amount (same currency), passes at the amount and when the currency differs",
    (ok(promoOf({ restrictions: { minimum_amount: 10000, minimum_amount_currency: "usd" } }), { amountCents: 9900, currency: "usd" }) as any).reason === "promo_minimum_amount"
    && ok(promoOf({ restrictions: { minimum_amount: 10000, minimum_amount_currency: "usd" } }), { amountCents: 10000, currency: "usd" }).ok
    && ok(promoOf({ restrictions: { minimum_amount: 10000, minimum_amount_currency: "eur" } }), { amountCents: 9900, currency: "usd" }).ok)
  check("promotion code pinned to another customer → promo_customer_pinned; the pinned customer passes",
    (ok(promoOf({ customer: "cus_other" }), { customerId: "cus_me" }) as any).reason === "promo_customer_pinned" && ok(promoOf({ customer: "cus_me" }), { customerId: "cus_me" }).ok)
  check("worst-first: an invalid coupon behind an inactive promo names the coupon", (ok(promoOf({ active: false }, { valid: false })) as any).reason === "stripe_invalid")
  check("every refusal carries a tenant sentence naming the code (no Stripe id, no 'platform-covered')",
    [{ valid: false }, { redeem_by: 1 }, { max_redemptions: 1, times_redeemed: 1 }].every((o) => { const r = ok(normalizeStripeDiscount(stripeCoupon(o))) as any; return !r.ok && /CODE/.test(r.message) && !/cpn_|platform-covered/.test(r.message) }))
  check("checkoutDiscountParams: promotion code preferred, else the coupon, never a mock id",
    JSON.stringify(checkoutDiscountParams({ stripeCouponId: "cpn_live", promotionCodeId: "promo_1" })) === JSON.stringify({ discounts: [{ promotion_code: "promo_1" }] })
    && JSON.stringify(checkoutDiscountParams({ stripeCouponId: "cpn_live", promotionCodeId: null })) === JSON.stringify({ discounts: [{ coupon: "cpn_live" }] })
    && checkoutDiscountParams({ stripeCouponId: "mock_LAUNCH_1", promotionCodeId: null }) === null && checkoutDiscountParams({ stripeCouponId: null, promotionCodeId: null }) === null)
  check("normalizeStripeDiscount tolerates id-only / unexpanded shapes", normalizeStripeDiscount({ id: "cpn_x" }).appliesToProducts === null && normalizeStripeDiscount({ id: "cpn_x" }).couponValid === false)

  // ─── B · the resolver ───────────────────────────────────────────────────────
  console.log("\n[B · resolveDiscountForCheckout — code → Stripe validation → eligibility → params]")
  const coupons = [
    { id: "c_live", code: "LAUNCH20", percent_off: 20, amount_off_cents: null, duration: "repeating", duration_months: 3, applies_to_tier: null, max_redemptions: null, redeemed_count: 0, expires_at: null, active: true, stripe_coupon_id: "cpn_live" },
    { id: "c_expired", code: "OLD10", percent_off: 10, amount_off_cents: null, duration: "once", duration_months: null, applies_to_tier: null, max_redemptions: null, redeemed_count: 0, expires_at: "2026-01-01T00:00:00.000Z", active: true, stripe_coupon_id: "cpn_old" },
    { id: "c_team", code: "TEAM50", percent_off: 50, amount_off_cents: null, duration: "once", duration_months: null, applies_to_tier: "team", max_redemptions: null, redeemed_count: 0, expires_at: null, active: true, stripe_coupon_id: "cpn_team" },
    { id: "c_mock", code: "MOCKY", percent_off: 5, amount_off_cents: null, duration: "once", duration_months: null, applies_to_tier: null, max_redemptions: null, redeemed_count: 0, expires_at: null, active: true, stripe_coupon_id: "mock_MOCKY_1" },
    { id: "c_gone", code: "GONE15", percent_off: 15, amount_off_cents: null, duration: "once", duration_months: null, applies_to_tier: null, max_redemptions: null, redeemed_count: 0, expires_at: null, active: true, stripe_coupon_id: "cpn_gone" },
  ]
  const db = fakeDb({
    platform_coupons: coupons,
    platform_coupon_redemptions: [],
    brokerages: [
      { id: "brk_bag", name: "Bag Co", plan_tier: "solo_agent", billing_metadata: { coupon: { id: "c_live", code: "LAUNCH20", stripe_coupon_id: "cpn_live", summary: "20% off for 3 months" } } },
      { id: "brk_plain", name: "Plain Co", plan_tier: "solo_agent", billing_metadata: {} },
    ],
  })
  const lookupCalls: Row[] = []
  const lookup = async (q: Row) => {
    lookupCalls.push(q)
    if (q.stripeCouponId === "cpn_live") return { ok: true as const, coupon: stripeCoupon({ id: "cpn_live" }), promotionCode: null }
    if (q.stripeCouponId === "cpn_gone") return { ok: true as const, coupon: stripeCoupon({ id: "cpn_gone", max_redemptions: 2, times_redeemed: 2 }), promotionCode: null }
    if (q.promotionCode === "FALL25") return { ok: true as const, coupon: stripeCoupon({ id: "cpn_promo" }), promotionCode: stripePromo() }
    return { ok: false as const, notFound: true as const, skipped: false as const }
  }
  const deps = { lookup, configured: () => true, now: NOW }
  const applied = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "launch20", productIds: [] }, deps)
  check("a valid platform code → applied (normalized, Stripe-validated, discounts:[{coupon}], the platform summary)",
    applied.status === "applied" && applied.code === "LAUNCH20" && applied.source === "platform_coupon" && applied.couponId === "c_live"
    && JSON.stringify(applied.params) === JSON.stringify({ discounts: [{ coupon: "cpn_live" }] }) && applied.summary === "20% off for 3 months", JSON.stringify(applied))
  lookupCalls.length = 0
  const unknown = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "NOPE99" }, deps)
  check("an unknown code (no platform row, no Stripe promotion code) → refused not_found, immediately and specifically",
    unknown.status === "refused" && unknown.reason === "not_found" && /NOPE99/.test(unknown.message) && lookupCalls.length === 1 && lookupCalls[0].promotionCode === "NOPE99", JSON.stringify(unknown))
  lookupCalls.length = 0
  const expired = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "OLD10" }, deps)
  const wrongTier = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "TEAM50" }, deps)
  check("an expired platform code and a wrong-tier code are refused BEFORE any Stripe call (platform rules first)",
    expired.status === "refused" && expired.reason === "expired" && wrongTier.status === "refused" && wrongTier.reason === "tier_mismatch" && lookupCalls.length === 0, `${JSON.stringify(expired)} ${JSON.stringify(wrongTier)} lookups=${lookupCalls.length}`)
  const teamOk = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "team", code: "TEAM50" }, { ...deps, lookup: async (q: Row) => ({ ok: true as const, coupon: stripeCoupon({ id: String(q.stripeCouponId) }), promotionCode: null }) })
  control("the tier-restricted code on its own tier is applied", teamOk.status === "applied")
  lookupCalls.length = 0
  const mock = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "MOCKY" }, deps)
  check("a platform coupon never published live to Stripe (mock_ id) → refused not_published, tenant wording, no Stripe call",
    mock.status === "refused" && mock.reason === "not_published" && /contact support/.test(mock.message) && !/mock_/.test(mock.message) && lookupCalls.length === 0, JSON.stringify(mock))
  const promo = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "fall25" }, deps)
  check("a Stripe-only promotion code → applied with discounts:[{promotion_code}] and no platform coupon id",
    promo.status === "applied" && promo.source === "stripe_promotion_code" && promo.couponId === null && JSON.stringify(promo.params) === JSON.stringify({ discounts: [{ promotion_code: "promo_1" }] }), JSON.stringify(promo))
  const gone = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "GONE15" }, deps)
  check("a platform code whose Stripe coupon is exhausted → refused stripe_exhausted (Stripe's rule wins)", gone.status === "refused" && gone.reason === "stripe_exhausted", JSON.stringify(gone))
  const bag = await resolveDiscountForCheckout(db, { brokerageId: "brk_bag", tier: "solo_agent" }, deps)
  check("no code typed + the signup coupon on the account → applied from the bag (source signup_coupon)", bag.status === "applied" && bag.source === "signup_coupon" && bag.code === "LAUNCH20", JSON.stringify(bag))
  const none = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent" }, deps)
  check("no code + no bag → none (the checkout lets Stripe's page take a promotion code)", none.status === "none")
  const unconf = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "LAUNCH20" }, { ...deps, configured: () => false })
  check("Stripe unconfigured → skipped (said, never applied, never a price)", unconf.status === "skipped" && unconf.reason === "stripe_unconfigured")
  const strict = await resolveDiscountForCheckout(db, { brokerageId: "brk_plain", tier: "solo_agent", code: "LAUNCH20", productIds: [] }, { ...deps, lookup: async () => ({ ok: true as const, coupon: stripeCoupon({ id: "cpn_live", applies_to: { products: ["prod_x"] } }), promotionCode: null }) })
  check("a product-restricted Stripe coupon against ad-hoc line items → refused product_restricted", strict.status === "refused" && strict.reason === "product_restricted")

  // ─── C · the appliers ───────────────────────────────────────────────────────
  console.log("\n[C · every charge asks the one resolver, before Stripe]")
  const billing = code("app/actions/billing.ts")
  const activation = code("lib/billing/subscription-activation.ts")
  const ops = code("lib/billing/stripe-subscription-ops.ts")
  const funnel = code("lib/platform/trial-funnel.ts")
  const resolveBefore = (s: string, stripeCall: string) => s.includes("resolveDiscountForCheckout(") && s.indexOf("resolveDiscountForCheckout(") < s.indexOf(stripeCall)
  check("embedded checkout (startSubscriptionCheckout): resolves BEFORE stripe.customers.create, throws the refusal, spreads discountParams, allow_promotion_codes when none, takes discountCode",
    resolveBefore(billing, "stripe.customers.create") && /if \(discount\.status === "refused"\) throw new Error\(discount\.message\)/.test(billing)
    && /\.\.\.\(discountParams as any\)/.test(billing) && /allow_promotion_codes: true/.test(billing) && /discountCode\?: string \| null/.test(billing))
  check("hosted checkout (createActivationCheckout): resolves BEFORE checkout.sessions.create, returns discountRefused, spreads the params, keeps the setup-fee line shape",
    resolveBefore(activation, "stripe.checkout.sessions.create") && /discountRefused: true/.test(activation) && /\.\.\.\(discountParams as unknown as Record<string, never>\)/.test(activation)
    && /line_items: \[\.\.\.lineItems, \.\.\.addInvoiceItems\]/.test(activation) && /allow_promotion_codes: true/.test(activation))
  check("trial conversion (stripeConvertTrial) carries `discounts` from the resolver; the sweep resolves the signup bag through the seam",
    /discounts\?: Array<\{ promotion_code: string \} \| \{ coupon: string \}> \| null/.test(ops) && /\{ discounts: args\.discounts \}/.test(ops) && /resolveDiscount\(svc, \{ brokerageId: row\.brokerage_id/.test(ops))
  check("stripeLookupDiscount lives on the ops survivor (coupons.retrieve with applies_to expanded; promotionCodes.list by code) and stripeApplyCoupon takes a promotion code",
    /stripe\.coupons\.retrieve\(q\.stripeCouponId, \{ expand: \["applies_to"\] \}\)/.test(ops) && /stripe\.promotionCodes\.list\(\{ code: q\.promotionCode, active: true/.test(ops) && /\[\{ promotion_code: opts\.promotionCodeId \}\]/.test(ops))
  check("the public funnel check validates on Stripe when configured (unpublished refused by name; evaluateStripeDiscount on the live coupon)",
    /if \(configured\(\)\)/.test(funnel) && /reason: "not_published"/.test(funnel) && /evaluateStripeDiscount\(normalizeStripeDiscount\(looked\.coupon, null\)/.test(funnel))
  check("applyDiscountCodeAction: session tenant + COMMERCE roster, the subscription's real product ids, withActionLedger FINANCIAL around stripeApplyCoupon, the merged redemption writer, audited",
    /export async function applyDiscountCodeAction/.test(billing) && /requireTenantCommerceAdmin\(\)[\s\S]{0,400}applyDiscountCodeAction|applyDiscountCodeAction[\s\S]{0,400}requireTenantCommerceAdmin\(\)/.test(billing)
    && /billing\.subscription\.apply_discount_code/.test(billing) && /riskClass: "FINANCIAL"[\s\S]{0,600}stripeApplyCoupon\(stripeSubId, discount\.stripeCouponId, \{ promotionCodeId: discount\.promotionCodeId \}\)/.test(billing)
    && /recordCouponRedemption\(svc, \{ couponId: discount\.couponId/.test(billing) && /subscription\.discount_code_applied/.test(billing))
  control("the before-Stripe finder sees a checkout that creates the session first", !resolveBefore('await stripe.checkout.sessions.create({})\nconst d = await resolveDiscountForCheckout(svc, {})', "stripe.checkout.sessions.create"))
  check("the upgrade modal passes the typed code and shows the server's refusal; the plan card applies a code to the live plan; the invoice table shows Stripe's discount beside the paid amount",
    /startSubscriptionCheckout\([\s\S]{0,200}discountCodeInput\.trim\(\) \|\| null/.test(code("app/settings/billing/upgrade-modal.tsx")) && /setDiscountCodeError\(/.test(code("app/settings/billing/upgrade-modal.tsx"))
    && /applyDiscountCodeAction\(discountCodeInput\)/.test(code("app/settings/billing/current-plan-card.tsx")) && /invoice\.discount_cents/.test(code("app/settings/billing/invoice-history-table.tsx")))
  // In memory: the hosted checkout refuses an expired code BEFORE any Stripe call (Stripe is unconfigured here, so a
  // created session would have failed at the credential — the refusal comes first and is typed).
  const coDb = fakeDb({
    subscription_tiers: [{ id: "t1", tier_name: "solo_agent", display_name: "Solo", monthly_price_cents: 9900, annual_price_cents: 99000, setup_fee_cents: 0, is_active: true }],
    brokerages: [{ id: "brk_co", name: "Co", email: "co@x.test", plan_tier: "solo_agent", billing_metadata: {} }],
    subscriptions: [], platform_settings: [{ collect_tax: false }], platform_coupons: coupons, notifications: [],
  })
  const refusedCo = await createActivationCheckout(coDb, { brokerageId: "brk_co", tierId: "t1", billingCycle: "monthly", successUrl: "https://x/s", cancelUrl: "https://x/c", discountCode: "OLD10" })
  const wrongTierCo = await createActivationCheckout(coDb, { brokerageId: "brk_co", tierId: "t1", billingCycle: "monthly", successUrl: "https://x/s", cancelUrl: "https://x/c", discountCode: "TEAM50" })
  check("hosted checkout in memory: an expired code and a wrong-tier code are refused as discountRefused with the tenant sentence (no session attempted)",
    !refusedCo.ok && (refusedCo as any).discountRefused === true && /OLD10/.test(refusedCo.error) && !wrongTierCo.ok && (wrongTierCo as any).discountRefused === true && /team tier only/.test(wrongTierCo.error), `${JSON.stringify(refusedCo)} ${JSON.stringify(wrongTierCo)}`)
  const fun = await validateFunnelCoupon("launch20", "solo_agent", db as any, { lookup: lookup as any, configured: () => true, now: NOW })
  const funMock = await validateFunnelCoupon("MOCKY", "solo_agent", db as any, { lookup: lookup as any, configured: () => true, now: NOW })
  const funGone = await validateFunnelCoupon("GONE15", "solo_agent", db as any, { lookup: lookup as any, configured: () => true, now: NOW })
  check("funnel check: a live code passes Stripe validation; an unpublished code and a Stripe-exhausted code are refused by name",
    fun.ok && fun.code === "LAUNCH20" && !funMock.ok && (funMock as any).reason === "not_published" && !funGone.ok && (funGone as any).reason === "stripe_exhausted", `${JSON.stringify(funMock)} ${JSON.stringify(funGone)}`)

  // ─── D · reconciliation ─────────────────────────────────────────────────────
  console.log("\n[D · the ledger reconciles to Stripe]")
  check("invoiceDiscountCents sums Stripe's total_discount_amounts (null → 0)", invoiceDiscountCents({ total_discount_amounts: [{ amount: 1980 }, { amount: 20 }] }) === 2000 && invoiceDiscountCents({ total_discount_amounts: null }) === 0 && invoiceDiscountCents(null) === 0)
  check("subscriptionDiscountCoupon reads discounts[] (expanded or coupon-by-id) and the legacy discount, skips bare ids, null when none",
    JSON.stringify(subscriptionDiscountCoupon({ discounts: [{ id: "di_1", coupon: { id: "cpn_live" } }] })) === JSON.stringify({ stripeCouponId: "cpn_live", stripeDiscountId: "di_1" })
    && subscriptionDiscountCoupon({ discounts: [{ id: "di_2", coupon: "cpn_x" }] })?.stripeCouponId === "cpn_x"
    && subscriptionDiscountCoupon({ discount: { id: "di_3", coupon: { id: "cpn_old" } } })?.stripeCouponId === "cpn_old"
    && subscriptionDiscountCoupon({ discounts: ["di_4"] }) === null && subscriptionDiscountCoupon({ discounts: [] }) === null)
  const recDb = fakeDb({
    platform_coupons: [{ id: "c_live", code: "LAUNCH20", redeemed_count: 0, stripe_coupon_id: "cpn_live" }],
    platform_coupon_redemptions: [{ id: "r_a", coupon_id: "c_live", brokerage_id: "brk_a", redeemed_at: "2026-10-01" }, { id: "r_b", coupon_id: "c_live", brokerage_id: "brk_b", redeemed_at: "2026-10-02" }],
  })
  const stamp = await stampCouponStripeApplication(recDb, { brokerageId: "brk_a", stripeCouponId: "cpn_live", stripeDiscountId: "di_1", appliedAt: NOW.toISOString() })
  const rA = recDb.tables.platform_coupon_redemptions.find((r) => r.id === "r_a")!, rB = recDb.tables.platform_coupon_redemptions.find((r) => r.id === "r_b")!
  check("the Stripe stamp lands on THIS tenant's redemption of that coupon only (counted 1); the other tenant's row is untouched",
    stamp.ok && stamp.stamped === 1 && rA.stripe_discount_id === "di_1" && rA.stripe_applied_at === NOW.toISOString() && rB.stripe_discount_id === undefined, JSON.stringify(stamp))
  const stampNone = await stampCouponStripeApplication(recDb, { brokerageId: "brk_a", stripeCouponId: "cpn_stripe_only", stripeDiscountId: "di_9", appliedAt: NOW.toISOString() })
  check("a Stripe-only coupon (no platform row) stamps nothing and is not an error", stampNone.ok && stampNone.stamped === 0)
  const r1 = await recordCouponRedemption(recDb, { couponId: "c_live", brokerageId: "brk_c", redeemedBy: "usr_c" })
  const r2 = await recordCouponRedemption(recDb, { couponId: "c_live", brokerageId: "brk_c", redeemedBy: "usr_c" })
  check("recordCouponRedemption (the merged survivor): first → ok with the DERIVED count (3 = the ledger), second → already (UNIQUE), count unchanged",
    r1.ok && !r1.already && r1.redeemedCount === 3 && recDb.tables.platform_coupons[0].redeemed_count === 3 && r2.ok && r2.already && recDb.tables.platform_coupon_redemptions.length === 3, `${JSON.stringify(r1)} ${JSON.stringify(r2)}`)
  const superadmin = code("app/actions/superadmin/coupons.ts")
  check("the superadmin redeem and the tenant save-offer call recordCouponRedemption; neither keeps an inline redemption insert",
    /recordCouponRedemption\(svc, \{ couponId, brokerageId, redeemedBy: gate\.userId/.test(superadmin) && !/from\("platform_coupon_redemptions"\)\.insert/.test(superadmin)
    && /recordCouponRedemption\(svc, \{ couponId: coupon\.id, brokerageId: gate\.brokerageId/.test(billing) && !/from\("platform_coupon_redemptions"\)\.insert/.test(billing))
  const hook = code("app/api/billing/webhook/route.ts")
  check("webhook: invoice.paid writes discount_cents in a SEPARATE update AFTER the invoice upsert (counted; refused-and-logged until m777); subscription.* stamps the carried coupon",
    hook.indexOf("invoiceDiscountCents(") > hook.indexOf('onConflict: "stripe_invoice_id"') && /update\(\{ discount_cents: discountCents \}\)\.eq\("stripe_invoice_id", stripeInvoiceId\)\.eq\("brokerage_id", brokerageId\)\.select\("id"\)/.test(hook)
    && /subscriptionDiscountCoupon\(subscription\)/.test(hook) && /stampCouponStripeApplication\(supabase, \{ brokerageId/.test(hook))
  check("the superadmin list reads stripe_applied_at through a SECOND select (the list survives an unapplied m777) and renders 'Stripe applied n/m'",
    /select\("coupon_id, stripe_applied_at, stripe_discount_id"\)\.not\("stripe_applied_at", "is", null\)/.test(superadmin) && /stripe_applied_redemptions: stripeAppliedRes\.error \? null/.test(superadmin)
    && /Stripe applied \{c\.stripe_applied_redemptions\}\/\{c\.ledger_redemptions\}/.test(code("app/dashboard/superadmin/coupons/coupons-manager.tsx")))
  const m777 = src("supabase/migrations/m777-coupon-reconciliation-columns.sql")
  check("m777 adds exactly the three reconciliation columns (nullable, IF NOT EXISTS) and carries a status header",
    /ADD COLUMN IF NOT EXISTS discount_cents integer/.test(m777) && /ADD COLUMN IF NOT EXISTS stripe_discount_id text/.test(m777) && /ADD COLUMN IF NOT EXISTS stripe_applied_at timestamptz/.test(m777) && /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(m777))

  // ─── E · the handoff ────────────────────────────────────────────────────────
  console.log("\n[E · subscriber → brokerage billing handoff — prorated once, never across a tenant]")
  const seedHandoff = () => fakeDb({
    users: [
      { id: "u_tgt_admin", brokerage_id: "brk_tgt", user_type: "broker_owner", platform_role: null },
      { id: "u_src_admin", brokerage_id: "brk_src", user_type: "admin", platform_role: null },
      { id: "u_other", brokerage_id: "brk_other", user_type: "broker", platform_role: null },
      { id: "u_tgt_agent", brokerage_id: "brk_tgt", user_type: "agent", platform_role: null },
      { id: "u_staff", brokerage_id: null, user_type: "admin", platform_role: "superadmin" },
      { id: "u_src_agent", brokerage_id: "brk_tgt", user_type: "agent", platform_role: null, status: "active" },
    ],
    brokerages: [
      { id: "brk_src", name: "Solo Agent LLC", plan_tier: "solo_agent", billing_metadata: {} },
      { id: "brk_tgt", name: "Big Brokerage", plan_tier: "team", billing_metadata: {} },
      { id: "brk_other", name: "Unrelated", plan_tier: "team", billing_metadata: {} },
      { id: "brk_nosub", name: "No Plan Co", plan_tier: "team", billing_metadata: {} },
    ],
    subscriptions: [
      { id: "sub_src", brokerage_id: "brk_src", status: "active", stripe_subscription_id: "sub_stripe_src", stripe_customer_id: "cus_src", cancel_at: null, current_period_end: "2026-11-01T00:00:00.000Z", updated_at: "2026-10-01" },
      { id: "sub_tgt", brokerage_id: "brk_tgt", status: "active", stripe_subscription_id: "sub_stripe_tgt", stripe_customer_id: "cus_tgt", cancel_at: null, current_period_end: "2026-11-01T00:00:00.000Z", updated_at: "2026-10-01", seat_packages: 0, extra_seats: 0 },
      { id: "sub_other", brokerage_id: "brk_other", status: "active", stripe_subscription_id: "sub_stripe_other", stripe_customer_id: "cus_o", cancel_at: null, current_period_end: "2026-11-01T00:00:00.000Z", updated_at: "2026-10-01" },
    ],
    subscription_tiers: [{ id: "tier_team", tier_name: "team", is_active: true, max_agents: 10, seat_package_size: 5, seat_package_price_cents: null, stripe_seat_price_id: null }, { id: "tier_solo", tier_name: "solo_agent", is_active: true, max_agents: 2, seat_package_size: 2, seat_package_price_cents: null, stripe_seat_price_id: null }],
    user_role_assignments: [], agents: [{ user_id: "u_src_agent", brokerage_id: "brk_tgt", is_active: true }, { user_id: "u_tgt_agent", brokerage_id: "brk_tgt", is_active: true }], locations: [],
    brokerage_fee_types: [{ id: "fee_tech", brokerage_id: "brk_tgt", name: "Tech Fee", is_active: true }],
    agent_action_ledger: [], lifecycle_events: [],
  })
  const stripeCalls: Row[] = []
  const endSubscription = async (id: string | null | undefined, effUnix: number, nowUnix: number, key: string) => {
    stripeCalls.push({ id, effUnix, nowUnix, key })
    return effUnix <= nowUnix
      ? { applied: true, skipped: false, mode: "cancelled_now" as const, finalInvoiceId: "in_final_1", cancelAtUnix: nowUnix }
      : { applied: true, skipped: false, mode: "scheduled_cancel" as const, finalInvoiceId: null, cancelAtUnix: effUnix }
  }
  const events: Row[] = []
  const emit = async (e: Row) => { events.push(e); return { inserted: true } }
  const hd = seedHandoff()
  const hdeps = { endSubscription, ledgerClient: hd, emit, now: NOW }
  const future = "2026-11-01T00:00:00.000Z"
  const h1 = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_tgt_admin" }, hdeps)
  const srcRow = () => hd.tables.subscriptions.find((r) => r.id === "sub_src")!
  const tgtRowJson = JSON.stringify(hd.tables.subscriptions.find((r) => r.id === "sub_tgt"))
  check("scheduled handoff: Stripe asked ONCE to cancel the SOURCE subscription at effectiveAt with create_prorations, idempotency key = the cycle",
    h1.ok && h1.source.mode === "stripe_scheduled_cancel" && h1.source.proration === "create_prorations" && stripeCalls.length === 1 && stripeCalls[0].id === "sub_stripe_src"
    && stripeCalls[0].effUnix === unix(new Date(future)) && stripeCalls[0].key === handoffCycle("brk_src", "brk_tgt", future), JSON.stringify(h1))
  check("no lost paid period: the source row stays 'active' with cancel_at = effectiveAt (Stripe's webhook writes the status when it cancels)",
    srcRow().status === "active" && srcRow().cancel_at === future)
  check("no double billing: the TARGET subscription row is byte-identical and Stripe was never asked about the target",
    JSON.stringify(hd.tables.subscriptions.find((r) => r.id === "sub_tgt")) === tgtRowJson && stripeCalls.every((c) => c.id !== "sub_stripe_tgt"))
  check("evidence: one FINANCIAL ledger row on the source tenant (executed, provider stripe, ref = the Stripe subscription) + one SUBSCRIPTION_CANCELLED event with reason brokerage_handoff naming the target",
    hd.tables.agent_action_ledger.length === 1 && hd.tables.agent_action_ledger[0].action === "billing.subscription.handoff_to_brokerage" && hd.tables.agent_action_ledger[0].brokerage_id === "brk_src"
    && hd.tables.agent_action_ledger[0].status === "executed" && hd.tables.agent_action_ledger[0].risk_class === "FINANCIAL" && hd.tables.agent_action_ledger[0].provider_ref === "sub_stripe_src"
    && events.length === 1 && events[0].event === "subscription_cancelled" && events[0].brokerageId === "brk_src" && (events[0].metadata as Row).reason === "brokerage_handoff" && (events[0].metadata as Row).target_brokerage_id === "brk_tgt" && h1.ok && h1.evidence.eventEmitted,
    JSON.stringify(hd.tables.agent_action_ledger[0]))
  check("the verdict reports the target's seat posture through the one seat facts and its configured agent fee types WITHOUT charging (chargedCents 0, no Stripe call)",
    // 3 producers on the target: the broker_owner (a licensed seat by type), its own agent, and the adopted agent.
    h1.ok && h1.target.seat.tier === "team" && h1.target.seat.seatCount === 3 && h1.target.seat.limit === 10 && h1.target.seat.fits === true
    && h1.target.techFee.status === "configured_waterfall" && h1.target.techFee.feeTypeIds.join() === "fee_tech" && h1.target.techFee.chargedCents === 0, JSON.stringify(h1.ok ? h1.target : h1))
  const h2 = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_tgt_admin" }, hdeps)
  check("IDEMPOTENT: a second run is a replay — ok, replay:true, same mode, NO second Stripe call, NO second ledger row, NO second event, rows unchanged",
    h2.ok && h2.replay === true && h2.source.mode === "stripe_scheduled_cancel" && stripeCalls.length === 1 && hd.tables.agent_action_ledger.length === 1 && events.length === 1 && srcRow().cancel_at === future, JSON.stringify(h2))
  // Refusals: nothing moves, nothing is written.
  const before = { calls: stripeCalls.length, ledger: hd.tables.agent_action_ledger.length, events: events.length, rows: JSON.stringify(hd.tables.subscriptions) }
  const wrongActor = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_other" }, hdeps)
  const srcActor = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_src_admin" }, hdeps)
  const agentActor = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_tgt_agent" }, hdeps)
  const same = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_src", effectiveAt: future, actorUserId: "u_staff" }, hdeps)
  const noSub = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_nosub", effectiveAt: future, actorUserId: "u_staff" }, hdeps)
  const unknownTgt = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_missing", effectiveAt: future, actorUserId: "u_staff" }, hdeps)
  const badDate = await handoffSubscriberBillingToBrokerage(hd, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: "not-a-date", actorUserId: "u_staff" }, hdeps)
  check("WRONG TENANT refused: an unrelated brokerage's admin, the SOURCE's own admin and a target AGENT (not on the admin roster) are all actor_not_authorized",
    !wrongActor.ok && wrongActor.refused === "actor_not_authorized" && !srcActor.ok && srcActor.refused === "actor_not_authorized" && !agentActor.ok && agentActor.refused === "actor_not_authorized")
  check("same tenant / target without a live subscription / unknown target / invalid date are refused by name",
    !same.ok && same.refused === "same_tenant" && !noSub.ok && noSub.refused === "target_not_subscribed" && !unknownTgt.ok && unknownTgt.refused === "target_tenant_unknown" && !badDate.ok && badDate.refused === "invalid_effective_at")
  check("every refusal acted on NOTHING: no Stripe call, no ledger row, no event, no row changed",
    stripeCalls.length === before.calls && hd.tables.agent_action_ledger.length === before.ledger && events.length === before.events && JSON.stringify(hd.tables.subscriptions) === before.rows)
  // Platform staff may act; an immediate handoff cancels now with prorate + invoice_now (a different cycle).
  const hdNow = seedHandoff()
  const past = "2026-10-10T00:00:00.000Z"
  const h3 = await handoffSubscriberBillingToBrokerage(hdNow, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: past, actorUserId: "u_staff" }, { ...hdeps, ledgerClient: hdNow })
  check("platform staff (platform_role) may hand off; an effective date already reached cancels NOW with prorate + invoice_now and reports Stripe's final invoice — no refund call exists",
    h3.ok && h3.source.mode === "stripe_cancelled_now" && h3.source.proration === "prorate_invoice_now" && h3.source.finalInvoiceId === "in_final_1" && !/refunds/.test(code("lib/billing/subscriber-handoff.ts")), JSON.stringify(h3))
  // A never-Stripe-linked source (a local trial): cancelled now, or scheduled and swept.
  const hdLocal = seedHandoff()
  hdLocal.tables.subscriptions.find((r) => r.id === "sub_src")!.stripe_subscription_id = null
  hdLocal.tables.subscriptions.find((r) => r.id === "sub_src")!.status = "trialing"
  const callsBeforeLocal = stripeCalls.length
  const h4 = await handoffSubscriberBillingToBrokerage(hdLocal, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: past, actorUserId: "u_tgt_admin" }, { ...hdeps, ledgerClient: hdLocal })
  const localRow = hdLocal.tables.subscriptions.find((r) => r.id === "sub_src")!
  check("a local (never Stripe-linked) trial with the date reached is cancelled NOW locally (counted), no Stripe call, no proration",
    h4.ok && h4.source.mode === "local_cancelled_now" && h4.source.proration === "none" && localRow.status === "cancelled" && !!localRow.cancelled_at && stripeCalls.length === callsBeforeLocal, JSON.stringify(h4))
  const hdSched = seedHandoff()
  hdSched.tables.subscriptions.find((r) => r.id === "sub_src")!.stripe_subscription_id = null
  hdSched.tables.subscriptions.find((r) => r.id === "sub_src")!.status = "trialing"
  const h5 = await handoffSubscriberBillingToBrokerage(hdSched, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_tgt_admin" }, { ...hdeps, ledgerClient: hdSched })
  const schedRow = () => hdSched.tables.subscriptions.find((r) => r.id === "sub_src")!
  check("a local trial with a future date is SCHEDULED (cancel_at written, still trialing)", h5.ok && h5.source.mode === "local_scheduled" && schedRow().status === "trialing" && schedRow().cancel_at === future)
  const sweepDeps = { hasPaymentMethod: async () => ({ ok: true, has: false }), send: async () => ({ success: true }), ledgerClient: hdSched, resolveDiscount: async () => ({ status: "none" }) }
  const sBefore = await runSubscriptionLifecycleSweep(hdSched, NOW, sweepDeps)
  const statusBefore = schedRow().status
  const sAt = await runSubscriptionLifecycleSweep(hdSched, new Date("2026-11-01T00:00:01.000Z"), sweepDeps)
  const statusAt = schedRow().status
  const sAgain = await runSubscriptionLifecycleSweep(hdSched, new Date("2026-11-02T00:00:00.000Z"), sweepDeps)
  // The transition EVENT needs the service client (no env in this proof): it lands in `errors` as
  // "transition event not recorded" — the row move and its ledger row are what is asserted here.
  check("the daily lifecycle sweep leaves it alone before cancel_at, moves it to 'cancelled' ONCE when the date arrives (cancelAtReached 1, ledgered), and 0 on the next run",
    sBefore.cancelAtReached === 0 && statusBefore === "trialing" && sAt.cancelAtReached === 1 && statusAt === "cancelled" && sAgain.cancelAtReached === 0
    && hdSched.tables.agent_action_ledger.some((r) => r.action === "billing.subscription.cancel_at_reached" && r.status === "executed"), `before=${JSON.stringify(sBefore)} at=${JSON.stringify(sAt)} again=${JSON.stringify(sAgain)}`)
  const hdNone = seedHandoff()
  hdNone.tables.subscriptions = hdNone.tables.subscriptions.filter((r) => r.id !== "sub_src")
  const h6 = await handoffSubscriberBillingToBrokerage(hdNone, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_tgt_admin" }, { ...hdeps, ledgerClient: hdNone })
  check("a source with no live subscription hands off with mode no_subscription (nothing to stop; the target verdict still reported)", h6.ok && h6.source.mode === "no_subscription" && h6.target.subscriptionId === "sub_tgt")
  const hdRefuse = seedHandoff()
  const h7 = await handoffSubscriberBillingToBrokerage(hdRefuse, { sourceBrokerageId: "brk_src", targetBrokerageId: "brk_tgt", effectiveAt: future, actorUserId: "u_tgt_admin" }, { ...hdeps, ledgerClient: hdRefuse, endSubscription: async () => ({ applied: false, skipped: false, error: "card_declined" }) })
  const h7row = hdRefuse.tables.subscriptions.find((r) => r.id === "sub_src")!
  check("a Stripe refusal fails closed: ok:false stripe_refused, the ledger row settles 'failed', the local row is untouched, no event",
    !h7.ok && h7.refused === "stripe_refused" && hdRefuse.tables.agent_action_ledger[0]?.status === "failed" && h7row.cancel_at === null && h7row.status === "active", JSON.stringify(h7))
  const handoffSrc = code("lib/billing/subscriber-handoff.ts")
  check("source: the handoff ends the subscription through the ops survivor (cancel_at + create_prorations / cancel prorate + invoice_now), under withActionLedger FINANCIAL, emits SUBSCRIPTION_CANCELLED, imports no Stripe client",
    /stripeEndSubscriptionForHandoff/.test(handoffSrc) && /riskClass: "FINANCIAL"/.test(handoffSrc) && /KernelEvent\.SUBSCRIPTION_CANCELLED/.test(handoffSrc) && !/@\/lib\/stripe["']/.test(handoffSrc)
    && /cancel_at: effectiveAtUnix, proration_behavior: "create_prorations"/.test(ops) && /\{ prorate: true, invoice_now: true/.test(ops))

  // ─── F · registration ───────────────────────────────────────────────────────
  console.log("\n[F · registration]")
  const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> }
  check("package.json registers test:coupons-and-handoff and the guard chain runs it (membership, never a position)",
    /coupons-and-handoff-guard\.ts/.test(pkg.scripts["test:coupons-and-handoff"] ?? "") && new RegExp("npm run test:coupons-and-handoff(\\s|&|$)").test(pkg.scripts.guard ?? ""))
  const entry = Object.values(MAINTENANCE_DOMAINS).find((d) => d.proof === "test:coupons-and-handoff")
  check("MAINTENANCE_DOMAINS owns the proof: finance_manager accountable, data_steward + compliance_officer co-own, both named in the prose",
    !!entry && entry.manager === "finance_manager" && (entry.coOwners ?? []).includes("data_steward") && (entry.coOwners ?? []).includes("compliance_officer") && /data_steward co-owns/.test(entry.what) && /compliance_officer co-owns/.test(entry.what))

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
