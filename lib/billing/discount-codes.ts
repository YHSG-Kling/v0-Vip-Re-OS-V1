// lib/billing/discount-codes.ts
// ─────────────────────────────────────────────────────────────────────────────
// DISCOUNT CODES — the ONE path from a typed code to a Stripe `discounts`
// parameter (wave 141H). Owner (wave 141, COUPONS, binding): "Stripe coupons /
// promotion codes are valid on signup, direct paid, trial conversion, setup fee,
// seat packages, supported one-time charges: code → Stripe validation →
// eligibility → application → invoice/checkout → internal reconciliation. No
// independent discount math. Immediate errors for invalid/expired/ineligible
// codes. Never fabricate prices."
//
// SURVIVORS THIS RIDES (nothing rebuilt):
//   · platform_coupons + lib/platform/coupons.ts validateCouponForRedemption —
//     WHICH tier a platform code is for, its own expiry / cap / active flag;
//     stripe_coupon_id links the row to the Stripe coupon the superadmin
//     publish created (app/actions/superadmin/coupons.ts publishCouponToStripeAction).
//   · lib/billing/stripe-subscription-ops.ts stripeLookupDiscount — the Stripe
//     read (coupon by id, promotion code by its spelling), on the platform client.
//   · lib/platform/coupons.ts evaluateStripeDiscount / checkoutDiscountParams —
//     Stripe's OWN restrictions judged purely; the `discounts` param built purely.
//   · brokerages.billing_metadata.coupon — the bag app/actions/auth/signup-brokerage.ts
//     fills at signup ("applied when you add billing at checkout"). Before this
//     file NOTHING read it (writer with no reader): neither checkout builder nor
//     the trial-conversion create passed `discounts`, so a signup coupon was
//     recorded, promised, and never applied. Now every checkout asks here.
//
// WHAT A RESOLUTION MEANS:
//   none     — no code typed and no signup coupon on the account: checkout lets
//              Stripe's own page take a promotion code (allow_promotion_codes).
//   applied  — Stripe validated it and its restrictions fit: `params.discounts`
//              goes on the Checkout Session / Subscription; the tenant sees
//              `summary` (a platform code's "20% off for 3 months") or the code.
//   refused  — the code is invalid / expired / exhausted / for another tier or
//              product / not yet live on Stripe: `message` is the tenant's
//              sentence, said IMMEDIATELY and SPECIFICALLY; no checkout is
//              created with a discount the invoice would not carry.
//   skipped  — Stripe is not configured in this runtime: nothing could be
//              validated. The checkout itself cannot be created either, so the
//              caller reports the account state honestly.
//
// One blind spot, published: a Stripe-only promotion code (no platform_coupons
// row) is accepted at CHECKOUT and on a live subscription, but the public
// signup funnel (lib/platform/trial-funnel.ts) accepts platform codes only —
// its redemption ledger FKs platform_coupons. Stripe-only codes are still
// usable at the checkout that follows the signup (Stripe's own promo field).

import {
  normalizeCouponCode,
  isValidCouponCode,
  validateCouponForRedemption,
  describeCoupon,
  normalizeStripeDiscount,
  evaluateStripeDiscount,
  checkoutDiscountParams,
  isMockStripeCouponId,
  type PlatformCoupon,
  type StripeDiscountContext,
} from "@/lib/platform/coupons"
import { isStripeConfigured, stripeLookupDiscount, type StripeDiscountLookup } from "./stripe-subscription-ops"

const COUPON_COLS =
  "id, code, description, percent_off, amount_off_cents, duration, duration_months, applies_to_tier, max_redemptions, redeemed_count, expires_at, active, stripe_coupon_id"

/** The signup coupon bag app/actions/auth/signup-brokerage.ts writes into
 *  brokerages.billing_metadata.coupon — the keys this resolver reads. */
interface SignupCouponBag {
  id?: string | null
  code?: string | null
  stripe_coupon_id?: string | null
  summary?: string | null
}

type DiscountResolution =
  | { status: "none" }
  | {
      status: "applied"
      source: "platform_coupon" | "stripe_promotion_code" | "signup_coupon"
      code: string
      /** platform_coupons.id when the code is a platform coupon (null for a Stripe-only promotion code). */
      couponId: string | null
      stripeCouponId: string | null
      promotionCodeId: string | null
      summary: string
      params: { discounts: Array<{ promotion_code: string } | { coupon: string }> }
    }
  | { status: "refused"; code: string; reason: string; message: string }
  | { status: "skipped"; code: string; reason: "stripe_unconfigured" | "lookup_failed"; message: string }

interface ResolveDiscountInput {
  brokerageId: string
  /** The tier being bought (platform coupons may be tier-restricted). */
  tier: string | null
  /** A code typed at checkout. Absent → the signup coupon bag is consulted. */
  code?: string | null
  /** Stripe facts of what is being bought (see StripeDiscountContext). */
  productIds?: string[] | null
  amountCents?: number | null
  currency?: string | null
  customerId?: string | null
  isFirstTransaction?: boolean | null
}

interface ResolveDiscountDeps {
  lookup?: (q: { stripeCouponId?: string | null; promotionCode?: string | null }) => Promise<StripeDiscountLookup>
  configured?: () => boolean
  now?: Date
}

/** Read the signup coupon bag off the brokerage (merged bag, never replaced). */
async function readSignupCouponBag(svc: any, brokerageId: string): Promise<{ bag: SignupCouponBag | null; error: string | null }> {
  const { data, error } = await svc.from("brokerages").select("billing_metadata").eq("id", brokerageId).maybeSingle()
  if (error) return { bag: null, error: error.message }
  const bm = (data as { billing_metadata?: unknown } | null)?.billing_metadata
  const coupon = bm && typeof bm === "object" ? (bm as { coupon?: unknown }).coupon : null
  return { bag: coupon && typeof coupon === "object" ? (coupon as SignupCouponBag) : null, error: null }
}

/**
 * code → Stripe validation → eligibility → `discounts`. Read-only: no
 * redemption row is written here (recordCouponRedemption below is the ledger
 * writer the appliers call once Stripe accepted the discount).
 */
export async function resolveDiscountForCheckout(svc: any, input: ResolveDiscountInput, deps: ResolveDiscountDeps = {}): Promise<DiscountResolution> {
  const now = deps.now ?? new Date()
  const configured = deps.configured ?? isStripeConfigured
  const lookup = deps.lookup ?? stripeLookupDiscount

  let code = normalizeCouponCode(input.code ?? "")
  let source: "platform_coupon" | "stripe_promotion_code" | "signup_coupon" = "platform_coupon"
  let bag: SignupCouponBag | null = null
  if (!code) {
    const read = await readSignupCouponBag(svc, input.brokerageId)
    if (read.error) console.error("[discount-codes] billing_metadata read refused — signup coupon unknown:", read.error)
    bag = read.bag
    code = normalizeCouponCode(bag?.code ?? "")
    if (!code) return { status: "none" }
    source = "signup_coupon"
  }

  // 1 · The platform's own coupon row (tier restriction, platform expiry / cap / active).
  let platform: (PlatformCoupon & { id: string }) | null = null
  if (isValidCouponCode(code)) {
    const { data, error } = await svc.from("platform_coupons").select(COUPON_COLS).eq("code", code).maybeSingle()
    if (error) return { status: "skipped", code, reason: "lookup_failed", message: `Couldn't check code ${code} — try again` }
    platform = (data as unknown as (PlatformCoupon & { id: string }) | null) ?? null
  }
  if (platform) {
    // Applying an already-redeemed signup coupon at the checkout that follows IS the point
    // (existingRedemption false): the per-tenant uniqueness lives on the redemption ledger.
    const local = validateCouponForRedemption(platform, { tier: input.tier, now, existingRedemption: false })
    if (!local.ok) return { status: "refused", code, reason: local.reason, message: local.message }
  }

  // 2 · Stripe validation — the discount is only ever the one Stripe will apply.
  if (!configured()) {
    return { status: "skipped", code, reason: "stripe_unconfigured", message: "Payments are not configured in this environment — the code could not be checked" }
  }
  const stripeCouponId = platform?.stripe_coupon_id ?? bag?.stripe_coupon_id ?? null
  if (platform && (!stripeCouponId || isMockStripeCouponId(stripeCouponId))) {
    // The platform knows the code but it was never published live to Stripe (or only mock-published):
    // the invoice could not carry it. Refuse by name, and tell staff which coupon to publish.
    console.error(`[discount-codes] platform coupon ${code} (${platform.id}) has no LIVE Stripe coupon (stripe_coupon_id=${stripeCouponId ?? "null"}) — publish it from /dashboard/superadmin/coupons`)
    return { status: "refused", code, reason: "not_published", message: `${code} isn't ready to use yet — contact support` }
  }
  const looked = platform ? await lookup({ stripeCouponId }) : await lookup({ promotionCode: code })
  if (!looked.ok) {
    if (looked.skipped) return { status: "skipped", code, reason: "stripe_unconfigured", message: "Payments are not configured in this environment — the code could not be checked" }
    if (looked.notFound) return { status: "refused", code, reason: "not_found", message: `${code} isn't a current offer code` }
    return { status: "skipped", code, reason: "lookup_failed", message: `Couldn't check code ${code} right now — try again` }
  }
  if (!platform) source = "stripe_promotion_code"

  // 3 · Eligibility by Stripe's own restrictions (pure).
  const shape = normalizeStripeDiscount(looked.coupon, looked.promotionCode)
  const ctx: StripeDiscountContext = {
    now, productIds: input.productIds ?? null, amountCents: input.amountCents ?? null, currency: input.currency ?? null,
    customerId: input.customerId ?? null, isFirstTransaction: input.isFirstTransaction ?? null,
  }
  const verdict = evaluateStripeDiscount(shape, ctx, code)
  if (!verdict.ok) return { status: "refused", code, reason: verdict.reason, message: verdict.message }

  // 4 · Application params — Stripe applies, Stripe prices.
  const promotionCodeId = shape.promotionCode?.id ?? null
  const params = checkoutDiscountParams({ stripeCouponId: shape.couponId || stripeCouponId, promotionCodeId })
  if (!params) return { status: "refused", code, reason: "not_published", message: `${code} isn't ready to use yet — contact support` }
  const summary = platform ? describeCoupon(platform) : (bag?.summary ?? code)
  return { status: "applied", source, code, couponId: platform?.id ?? bag?.id ?? null, stripeCouponId: shape.couponId || stripeCouponId, promotionCodeId, summary, params }
}

// ── The redemption ledger writer (MERGED survivor) ────────────────────────────
//
// TOMBSTONE (orphan doctrine §1.1): the two-write idiom — (1) INSERT the
// platform_coupon_redemptions row FIRST, UNIQUE(coupon_id, brokerage_id) being the
// real concurrency guard, (2) redeemed_count = COUNT(ledger), derived, never a
// stale +1 — stood THREE times: app/actions/superadmin/coupons.ts
// redeemCouponForBrokerageAction (the original), app/actions/billing.ts
// acceptCancellationSaveOfferAction, app/actions/auth/signup-brokerage.ts step 4b.
// The first two now call this one; signup-brokerage.ts keeps its copy this wave
// (lane 141A is auditing that file — named in the lane notes, not touched).

interface RecordRedemptionResult {
  ok: boolean
  /** true ⇒ this tenant had already redeemed the coupon (23505) — not an error for an applier. */
  already: boolean
  /** The derived count written back, when the write happened. */
  redeemedCount: number | null
  error?: string
}

export async function recordCouponRedemption(
  svc: any,
  args: { couponId: string; brokerageId: string; redeemedBy: string | null; fallbackCount?: number | null },
): Promise<RecordRedemptionResult> {
  const { error: insErr } = await svc.from("platform_coupon_redemptions").insert({
    coupon_id: args.couponId,
    brokerage_id: args.brokerageId,
    redeemed_by: args.redeemedBy,
  })
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") return { ok: true, already: true, redeemedCount: null }
    return { ok: false, already: false, redeemedCount: null, error: insErr.message }
  }
  const { count } = await svc.from("platform_coupon_redemptions").select("id", { count: "exact", head: true }).eq("coupon_id", args.couponId)
  const redeemedCount = typeof count === "number" ? count : (args.fallbackCount ?? 0) + 1
  const { error: cntErr } = await svc.from("platform_coupons").update({ redeemed_count: redeemedCount }).eq("id", args.couponId)
  if (cntErr) console.error("[discount-codes] redeemed_count sync failed (ledger row exists):", cntErr.message)
  return { ok: true, already: false, redeemedCount }
}

// ── Reconciliation: the ledger learns what Stripe actually applied (m777) ─────
//
// app/api/billing/webhook/route.ts calls this from customer.subscription.created /
// updated when the Stripe subscription carries a discount: the tenant's redemption
// row of that coupon is stamped with Stripe's discount id + when. Until m777 is
// APPLIED the UPDATE names absent columns and is refused entirely (PGRST204) —
// logged, never thrown, and never in the same write as the subscription row.

export async function stampCouponStripeApplication(
  svc: any,
  args: { brokerageId: string; stripeCouponId: string; stripeDiscountId: string | null; appliedAt: string },
): Promise<{ ok: boolean; stamped: number; error?: string }> {
  const { data: coupon, error: cErr } = await svc.from("platform_coupons").select("id").eq("stripe_coupon_id", args.stripeCouponId).maybeSingle()
  if (cErr) return { ok: false, stamped: 0, error: cErr.message }
  const couponId = (coupon as { id?: string } | null)?.id ?? null
  if (!couponId) return { ok: true, stamped: 0 } // a Stripe-only coupon has no platform row — nothing to reconcile
  const { data: rows, error } = await svc.from("platform_coupon_redemptions")
    .update({ stripe_discount_id: args.stripeDiscountId, stripe_applied_at: args.appliedAt })
    .eq("coupon_id", couponId).eq("brokerage_id", args.brokerageId)
    .select("id")
  if (error) return { ok: false, stamped: 0, error: error.message }
  return { ok: true, stamped: ((rows ?? []) as unknown[]).length }
}

/** PURE: the discount Stripe applied, summed from an invoice's total_discount_amounts (cents). */
export function invoiceDiscountCents(invoice: { total_discount_amounts?: Array<{ amount?: number | null }> | null } | null | undefined): number {
  const list = invoice?.total_discount_amounts ?? []
  return list.reduce((sum, d) => sum + (typeof d?.amount === "number" ? d.amount : 0), 0)
}

/** PURE: the coupon id a Stripe subscription's discount names (SDK ≥ 2024: `discounts[]`;
 *  older shapes: `discount.coupon`). null when the subscription carries no discount. */
export function subscriptionDiscountCoupon(sub: any): { stripeCouponId: string; stripeDiscountId: string | null } | null {
  const list = Array.isArray(sub?.discounts) ? sub.discounts : (sub?.discount ? [sub.discount] : [])
  for (const d of list) {
    // An unexpanded discount is a bare "di_…" id: it names no coupon, so there is nothing to reconcile from it.
    if (!d || typeof d === "string") continue
    const c = d.coupon ?? d.source?.coupon
    const couponId = typeof c === "string" ? c : c?.id
    if (couponId) return { stripeCouponId: String(couponId), stripeDiscountId: typeof d.id === "string" ? d.id : null }
  }
  return null
}
