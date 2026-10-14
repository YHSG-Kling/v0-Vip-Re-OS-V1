/**
 * scripts/canaries/coupon.ts — COUPON canary (wave 141, lane 141J):
 *   valid → correct charge path; invalid → immediate refusal
 * through lib/platform/coupons.ts (PURE: validateCouponForRedemption — inactive / expired / limit / tier /
 * already-redeemed, worst-first with a tenant-readable message; isMockStripeCouponId — a mock-published id
 * can never reach Stripe) and the Stripe application survivor (lib/billing/stripe-subscription-ops.ts:
 * the discount is applied by STRIPE on the subscription — `discounts: [{ coupon }]` — never computed here).
 * Owner (wave 141): "code → Stripe validation → eligibility → application → invoice/checkout → internal
 * reconciliation. No independent discount math. Immediate errors for invalid/expired/ineligible codes. Never
 * fabricate prices." Stripe-SDK promotion-code validation on every charge door (lane 141H) is a WAVE141 HOOK.
 */
import { canary } from "./_harness"
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
  // The RULE (not a spelling): the ops module refuses a mock-published id before any SDK call. At HEAD it is
  // spelled `.startsWith("mock_")` inline while lib/platform/coupons.ts spells it isMockStripeCouponId — the
  // same rule twice (CLAUDE.md §6; lane 141H's file, reported in the 141J notes), accepted either way here.
  const ops = strippedRepo("lib/billing/stripe-subscription-ops.ts") ?? ""
  c.step("correct charge path: the discount is applied BY STRIPE on the subscription (`discounts: [{ coupon }]`) only for a LIVE Stripe coupon id — a mock-published id is refused before any SDK call", (/isMockStripeCouponId\s*\(/.test(ops) || /\.startsWith\(\s*["']mock_["']\s*\)/.test(ops)) && /discounts:\s*\[\s*\{\s*coupon:/.test(ops) && isMockStripeCouponId("mock_LAUNCH20") && !isMockStripeCouponId("coupon_live_abc"), "")
  const payload = stripeCouponPayload(base)
  c.step("no fabricated prices: the Stripe coupon payload carries percent/amount, duration and redeem_by — never a tier price", payload.percent_off === 20 && payload.duration === "repeating" && payload.duration_in_months === 3 && typeof payload.redeem_by === "number" && !("unit_amount" in payload) && !("price" in payload), Object.keys(payload).join(","))
  const billingImportsMath = listFiles("lib/billing", (f) => /\.tsx?$/.test(f)).filter((f) => /\bdiscountedPriceCents\b/.test(strippedRepo(f) ?? ""))
  c.step("no independent discount math on a charge: nothing under lib/billing imports the preview math (discountedPriceCents) — Stripe computes the amount", billingImportsMath.length === 0, billingImportsMath.join(",") || "0 files")
  c.step("signup door reconciles: the self-serve door records the redemption ledger row (platform_coupon_redemptions) and reports couponError honestly", /["']platform_coupon_redemptions["']/.test(strippedRepo("app/actions/auth/signup-brokerage.ts") ?? "") && /couponError/.test(strippedRepo("app/actions/auth/signup-brokerage.ts") ?? ""), "")
  // WAVE141 HOOK (integrator): 141H — Stripe-SDK validation on every charge door.
  for (const h of hooksFor("coupon")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "at HEAD eligibility is the platform_coupons row's own rules; Stripe is reached only with a published coupon id"); continue }
    c.step(`${h.lane} landed (${at}) — wire the SDK-validated door (valid applied / invalid refused / ineligible refused, discount visible in reconciliation) into this canary with the SDK stubbed (WAVE141 HOOK (integrator): 141H)`, false, "")
  }
  c.blind("Pure + source: no Stripe call; the SDK's own promotion-code restrictions (first-time customers, minimum amount, product applicability) are Stripe's and are lane 141H's test:coupons-and-handoff.")
  return c.report([], 0)
}
