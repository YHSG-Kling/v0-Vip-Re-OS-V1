/**
 * scripts/canaries/coupon.ts — COUPON canary (wave 141, lane 141J; wired by lane 141K):
 *   valid → correct charge path; invalid → immediate refusal
 * through lib/platform/coupons.ts (PURE: validateCouponForRedemption — inactive / expired / limit / tier /
 * already-redeemed, worst-first with a tenant-readable message; isMockStripeCouponId — a mock-published id
 * can never reach Stripe; evaluateStripeDiscount / checkoutDiscountParams — Stripe's OWN restrictions judged
 * purely, the `discounts` param built purely) and, LANDED AT 81fcd1f14 (lane 141H), the ONE door every charge
 * asks — lib/billing/discount-codes.ts resolveDiscountForCheckout (typed code or the signup bag → platform
 * rules → STRIPE validation → eligibility → `discounts`), recordCouponRedemption (the MERGED ledger writer) and
 * the reconciliation readers (stampCouponStripeApplication, invoiceDiscountCents, subscriptionDiscountCoupon).
 * The Stripe lookup is the ONE thing stubbed (the resolver's `lookup` seam answers like the SDK would).
 * Owner (wave 141): "code → Stripe validation → eligibility → application → invoice/checkout → internal
 * reconciliation. No independent discount math. Immediate errors for invalid/expired/ineligible codes. Never
 * fabricate prices."
 */
import type { StripeDiscountLookup } from "../../lib/billing/stripe-subscription-ops"
import { CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, listFiles, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Coupon: valid → correct charge path; invalid → immediate refusal (no independent discount math)")
  const { validateCouponForRedemption, validateCouponInput, isMockStripeCouponId, stripeCouponPayload } = await import("../../lib/platform/coupons")
  const now = new Date("2026-10-14T12:00:00Z")
  const base = { id: "c1", code: "LAUNCH20", description: null, percent_off: 20, amount_off_cents: null, duration: "repeating" as const, duration_months: 3, applies_to_tier: null, max_redemptions: 100, redeemed_count: 5, expires_at: "2027-01-01T00:00:00Z", active: true, stripe_coupon_id: "coupon_live_abc" }
  c.step("valid: an active, unexpired, under-limit, any-tier code is eligible for this tenant", validateCouponForRedemption(base, { tier: "brokerage", now, existingRedemption: false }).ok === true, "")
  const expired = validateCouponForRedemption({ ...base, expires_at: "2026-01-01T00:00:00Z" }, { tier: "brokerage", now, existingRedemption: false })
  c.step("invalid → IMMEDIATE, specific: an expired code is refused with reason 'expired' and a tenant-readable message naming the code", !expired.ok && expired.reason === "expired" && /LAUNCH20/.test(expired.message), expired.ok ? "" : expired.message)
  const inactive = validateCouponForRedemption({ ...base, active: false }, { tier: "brokerage", now, existingRedemption: false })
  const limit = validateCouponForRedemption({ ...base, redeemed_count: 100 }, { tier: "brokerage", now, existingRedemption: false })
  const tier = validateCouponForRedemption({ ...base, applies_to_tier: "solo_agent" }, { tier: "brokerage", now, existingRedemption: false })
  const twice = validateCouponForRedemption(base, { tier: "brokerage", now, existingRedemption: true })
  c.step("invalid → IMMEDIATE, specific: deactivated / limit reached / wrong tier / already redeemed each name their own reason", !inactive.ok && inactive.reason === "inactive" && !limit.ok && limit.reason === "max_redemptions_reached" && !tier.ok && tier.reason === "tier_mismatch" && !twice.ok && twice.reason === "already_redeemed", "")
  c.step("worst-first: a deactivated AND expired code reports 'inactive' (the most fundamental problem), never a misleading second reason", (() => { const r = validateCouponForRedemption({ ...base, active: false, expires_at: "2026-01-01T00:00:00Z" }, { tier: "brokerage", now, existingRedemption: false }); return !r.ok && r.reason === "inactive" })(), "")
  c.step("shape: a malformed code is refused at creation with a human message (no Postgres constraint error reaches a human)", !validateCouponInput({ code: "bad code!", percentOff: 10 }).ok && !validateCouponInput({ code: "BOTH", percentOff: 10, amountOffCents: 500 }).ok, "")
  // The RULE (not a spelling): the ops module refuses a mock-published id before any SDK call, and the discount
  // it sends is a Stripe `discounts` entry (a coupon or, since 141H, a promotion code) — never an amount.
  const ops = strippedRepo("lib/billing/stripe-subscription-ops.ts") ?? ""
  c.step("correct charge path: the discount is applied BY STRIPE on the subscription (`discounts: [{ coupon | promotion_code }]`) only for a LIVE Stripe id — a mock-published id is refused before any SDK call", (/isMockStripeCouponId\s*\(/.test(ops) || /\.startsWith\(\s*["']mock_["']\s*\)/.test(ops)) && /discounts:[^\n]*\{\s*(coupon|promotion_code):/.test(ops) && isMockStripeCouponId("mock_LAUNCH20") && !isMockStripeCouponId("coupon_live_abc"), "")
  const payload = stripeCouponPayload(base)
  c.step("no fabricated prices: the Stripe coupon payload carries percent/amount, duration and redeem_by — never a tier price", payload.percent_off === 20 && payload.duration === "repeating" && payload.duration_in_months === 3 && typeof payload.redeem_by === "number" && !("unit_amount" in payload) && !("price" in payload), Object.keys(payload).join(","))
  const billingImportsMath = listFiles("lib/billing", (f) => /\.tsx?$/.test(f)).filter((f) => /\bdiscountedPriceCents\b/.test(strippedRepo(f) ?? ""))
  c.step("no independent discount math on a charge: nothing under lib/billing imports the preview math (discountedPriceCents) — Stripe computes the amount", billingImportsMath.length === 0, billingImportsMath.join(",") || "0 files")
  c.step("signup door reconciles: the self-serve door records the redemption ledger row (platform_coupon_redemptions) and reports couponError honestly", /["']platform_coupon_redemptions["']/.test(strippedRepo("app/actions/auth/signup-brokerage.ts") ?? "") && /couponError/.test(strippedRepo("app/actions/auth/signup-brokerage.ts") ?? ""), "")

  // WAVE141 HOOK (integrator): 141H — Stripe-SDK validation on every charge door; wired 141K with the lookup stubbed.
  const landed = hooksFor("coupon").map((h) => ({ h, at: h.probe() }))
  for (const { h, at } of landed) if (!at) c.hook(h.lane, h.contract, "at HEAD eligibility is the platform_coupons row's own rules; Stripe is reached only with a published coupon id")
  const wired = landed.find((x) => x.at)
  if (!wired || LIVE) {
    c.blind(LIVE ? "CANARY_LIVE: the discount door is driven in memory only (a redemption row is a billing fact) — pure + source steps ran." : "Pure + source: no Stripe call; the SDK's own promotion-code restrictions are Stripe's and lane 141H's test:coupons-and-handoff.")
    return c.report([], 0)
  }
  const { resolveDiscountForCheckout, recordCouponRedemption, stampCouponStripeApplication, invoiceDiscountCents, subscriptionDiscountCoupon } = await import("../../lib/billing/discount-codes")
  const B = uuid(), C1 = uuid(), C2 = uuid(), C3 = uuid(), C4 = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-coupon`, billing_metadata: { coupon: { id: C1, code: "LAUNCH20", stripe_coupon_id: "coupon_live_abc", summary: "20% off for 3 months" } } }],
    platform_coupons: [
      { ...base, id: C1, description: `${CANARY_TAG} launch` },
      { ...base, id: C2, code: "MOCKONLY", stripe_coupon_id: "mock_MOCKONLY", description: CANARY_TAG },
      { ...base, id: C3, code: "OLDCODE", expires_at: "2026-01-01T00:00:00Z", description: CANARY_TAG },
      { ...base, id: C4, code: "TEAMONLY", applies_to_tier: "team", description: CANARY_TAG },
    ],
  })
  setSvc(svc)
  const lookups: Array<{ stripeCouponId?: string | null; promotionCode?: string | null }> = []
  const unix = (d: string) => Math.floor(Date.parse(d) / 1000)
  // THE STRIPE LOOKUP, recorded: answers in the SDK's shapes (coupons.retrieve with applies_to; promotionCodes.list row).
  const lookup = async (q: { stripeCouponId?: string | null; promotionCode?: string | null }): Promise<StripeDiscountLookup> => {
    lookups.push(q)
    if (q.stripeCouponId === "coupon_live_abc") return { ok: true, coupon: { id: "coupon_live_abc", valid: true, redeem_by: unix("2027-01-01T00:00:00Z"), max_redemptions: 100, times_redeemed: 5 }, promotionCode: null }
    if (q.promotionCode === "SPRING") return { ok: true, coupon: { id: "coupon_spring", valid: true }, promotionCode: { id: "promo_spring_1", code: "SPRING", active: true, restrictions: { first_time_transaction: true } } }
    if (q.promotionCode === "MINIMUM") return { ok: true, coupon: { id: "coupon_min", valid: true }, promotionCode: { id: "promo_min_1", code: "MINIMUM", active: true, restrictions: { minimum_amount: 10000, minimum_amount_currency: "usd" } } }
    if (q.promotionCode === "DEADPROMO") return { ok: true, coupon: { id: "coupon_dead", valid: false }, promotionCode: { id: "promo_dead_1", code: "DEADPROMO", active: true } }
    return { ok: false, notFound: true, skipped: false }
  }
  const deps = { lookup, configured: () => true, now }
  const typed = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "launch20" }, deps)
  c.step(`${wired.h.lane} landed (${wired.at}): a typed platform code → platform rules → STRIPE validation (ONE lookup, by the published coupon id) → eligibility → \`discounts: [{ coupon }]\` for Stripe to apply AND price; the tenant sees the summary, never an amount this code computed`, typed.status === "applied" && typed.source === "platform_coupon" && typed.couponId === C1 && typed.stripeCouponId === "coupon_live_abc" && JSON.stringify(typed.params) === JSON.stringify({ discounts: [{ coupon: "coupon_live_abc" }] }) && /20%/.test(typed.summary) && lookups.length === 1 && lookups[0].stripeCouponId === "coupon_live_abc", JSON.stringify(typed).slice(0, 200))
  const bag = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage" }, deps)
  c.step("141H the signup coupon (brokerages.billing_metadata.coupon — a writer that had NO reader) is now READ at every checkout: no typed code → the bag → the same Stripe validation → applied", bag.status === "applied" && bag.source === "signup_coupon" && JSON.stringify(bag.params) === JSON.stringify({ discounts: [{ coupon: "coupon_live_abc" }] }), JSON.stringify(bag).slice(0, 160))
  const before = lookups.length
  const mock = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "MOCKONLY" }, deps)
  const old = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "OLDCODE" }, deps)
  const wrongTier = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "TEAMONLY" }, deps)
  c.step("141H IMMEDIATE, SPECIFIC refusals before Stripe is even asked: an unpublished (mock-published) platform coupon → not_published ('not ready to use yet'); an expired platform code → expired; a code for another tier → tier_mismatch — no lookup, and no checkout is created with a discount the invoice would not carry", mock.status === "refused" && mock.reason === "not_published" && /ready to use yet/.test(mock.message) && old.status === "refused" && old.reason === "expired" && wrongTier.status === "refused" && wrongTier.reason === "tier_mismatch" && lookups.length === before, [mock, old, wrongTier].map((r) => (r.status === "refused" ? r.reason : r.status)).join(","))
  const nope = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "NOPE" }, deps)
  const dead = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "DEADPROMO" }, deps)
  c.step("141H Stripe-side refusals, immediate and specific: an unknown promotion code → not_found ('isn't a current offer code'); a promotion code whose coupon Stripe reads as invalid → stripe_invalid", nope.status === "refused" && nope.reason === "not_found" && /NOPE/.test(nope.message) && dead.status === "refused" && dead.reason === "stripe_invalid", [nope, dead].map((r) => (r.status === "refused" ? `${r.reason}: ${r.message}` : r.status)).join(" | "))
  const firstOnly = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "SPRING", isFirstTransaction: false }, deps)
  const firstOk = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "SPRING", isFirstTransaction: true }, deps)
  const tooSmall = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "MINIMUM", amountCents: 5000, currency: "usd" }, deps)
  c.step("141H eligibility by STRIPE's OWN restrictions (pure): a first-purchase-only promotion is refused for a returning customer and applied as `discounts: [{ promotion_code }]` (Stripe counts its redemption) for a first one; a minimum-amount promotion refuses a smaller order", firstOnly.status === "refused" && firstOnly.reason === "promo_first_purchase_only" && firstOk.status === "applied" && firstOk.source === "stripe_promotion_code" && firstOk.promotionCodeId === "promo_spring_1" && JSON.stringify(firstOk.params) === JSON.stringify({ discounts: [{ promotion_code: "promo_spring_1" }] }) && tooSmall.status === "refused" && tooSmall.reason === "promo_minimum_amount", [firstOnly, firstOk, tooSmall].map((r) => (r.status === "refused" ? r.reason : r.status)).join(","))
  const dark = await resolveDiscountForCheckout(svc, { brokerageId: B, tier: "brokerage", code: "LAUNCH20" }, { ...deps, configured: () => false })
  c.step("141H honest when Stripe is absent: nothing is validated, nothing is applied — skipped stripe_unconfigured (never a fabricated discount, never a silent pass)", dark.status === "skipped" && dark.reason === "stripe_unconfigured", dark.status)
  const red = await recordCouponRedemption(svc, { couponId: C1, brokerageId: B, redeemedBy: null, fallbackCount: 5 })
  const again = await recordCouponRedemption(svc, { couponId: C1, brokerageId: B, redeemedBy: null, fallbackCount: 5 })
  const stamped = await stampCouponStripeApplication(svc, { brokerageId: B, stripeCouponId: "coupon_live_abc", stripeDiscountId: "di_canary_1", appliedAt: nowIso() })
  const ledger = (svc.tables.platform_coupon_redemptions ?? []).filter((r) => r.coupon_id === C1 && r.brokerage_id === B)
  c.step("141H reconciliation: the redemption ledger row (the MERGED one-writer; UNIQUE(coupon_id, brokerage_id) makes a second redemption 'already', never a second row; redeemed_count derived) is stamped with what Stripe ACTUALLY applied (stripe_discount_id / stripe_applied_at, m777) — the discount is visible in reconciliation; an invoice's discount is summed from Stripe's total_discount_amounts and a subscription's coupon read off its discounts[] (a bare id names nothing)", red.ok && !red.already && red.redeemedCount === 6 && again.ok && again.already === true && ledger.length === 1 && stamped.ok && stamped.stamped === 1 && ledger[0].stripe_discount_id === "di_canary_1" && !!ledger[0].stripe_applied_at && (svc.tables.platform_coupons ?? []).find((r) => r.id === C1)?.redeemed_count === 6 && invoiceDiscountCents({ total_discount_amounts: [{ amount: 2000 }, { amount: 500 }] }) === 2500 && subscriptionDiscountCoupon({ discounts: [{ id: "di_canary_1", coupon: { id: "coupon_live_abc" } }] })?.stripeCouponId === "coupon_live_abc" && subscriptionDiscountCoupon({ discounts: ["di_bare"] }) === null, `stamped ${stamped.stamped}`)
  const act = strippedRepo("lib/billing/subscription-activation.ts") ?? "", bill = strippedRepo("app/actions/billing.ts") ?? ""
  c.step("141H every charge door asks the ONE resolver BEFORE creating the Stripe object: the activation checkout (before checkout.sessions.create), the in-app checkout (before customers.create), the trial conversion (the sweep's resolveDiscount seam) — a refusal returns immediately", act.search(/resolveDiscountForCheckout\(/) >= 0 && act.search(/resolveDiscountForCheckout\(/) < act.search(/checkout\.sessions\.create/) && bill.search(/resolveDiscountForCheckout\(/) >= 0 && bill.search(/resolveDiscountForCheckout\(/) < bill.search(/customers\.create/) && /resolveDiscount\b/.test(ops) && /discounts/.test(ops), "")
  c.blind("Stripe is a recorder (the resolver's lookup seam): the live coupons.retrieve / promotionCodes.list shapes, allow_promotion_codes on the hosted page and the invoice's total_discount_amounts are lane 141H's test:coupons-and-handoff and its live-verification owner item. The redemption ledger's UNIQUE(coupon_id, brokerage_id) is modelled by the canary client (scripts/canaries/_harness.ts CANARY_UNIQUE).")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
