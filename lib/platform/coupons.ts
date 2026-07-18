// lib/platform/coupons.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE coupon/discount-code logic for tier subscriptions — no "use server", no
// Supabase, no Stripe import — so every rule (code shape, create validation,
// redemption eligibility, discount math, human summary, Stripe payload) is
// unit-testable without a request. The superadmin actions in
// app/actions/superadmin/coupons.ts are thin DB/Stripe wrappers over this.
//
// Mirrors the plan-catalog split: lib/billing/plan-catalog.ts (pure) +
// app/actions/superadmin/plan-catalog.ts (action). DB tables (already
// migrated): platform_coupons + platform_coupon_redemptions.

import { CANONICAL_TIERS } from "@/lib/billing/plan-catalog"

export type CouponDuration = "once" | "repeating" | "forever"
export type CanonicalTier = (typeof CANONICAL_TIERS)[number]

/** Shape of a platform_coupons row (the columns the pure layer reasons about). */
export interface PlatformCoupon {
  id?: string
  code: string
  description?: string | null
  /** Exactly ONE of percent_off / amount_off_cents is set (DB CHECK). */
  percent_off: number | null
  amount_off_cents: number | null
  duration: CouponDuration
  /** Required when duration='repeating' (1..36). */
  duration_months: number | null
  /** null = valid for ANY tier. */
  applies_to_tier: CanonicalTier | null
  max_redemptions: number | null
  redeemed_count: number
  expires_at: string | null
  active: boolean
  stripe_coupon_id?: string | null
}

// ── Code normalization ───────────────────────────────────────────────────────

/** DB CHECK on platform_coupons.code — the single source of truth for shape. */
export const COUPON_CODE_RE = /^[A-Z0-9_-]{3,32}$/

/** Uppercase + trim + collapse interior whitespace to '-' so "summer sale"
 *  becomes "SUMMER-SALE". Does NOT guarantee validity — pair with
 *  isValidCouponCode / validateCouponInput. */
export function normalizeCouponCode(raw: string): string {
  return (raw ?? "").trim().toUpperCase().replace(/\s+/g, "-")
}

export function isValidCouponCode(code: string): boolean {
  return COUPON_CODE_RE.test(code)
}

// ── Create validation ────────────────────────────────────────────────────────

export interface CouponInput {
  code: string
  description?: string | null
  percentOff?: number | null
  amountOffCents?: number | null
  duration?: CouponDuration
  durationMonths?: number | null
  appliesToTier?: string | null
  maxRedemptions?: number | null
  expiresAt?: string | null
}

export interface NormalizedCoupon {
  code: string
  description: string | null
  percent_off: number | null
  amount_off_cents: number | null
  duration: CouponDuration
  duration_months: number | null
  applies_to_tier: CanonicalTier | null
  max_redemptions: number | null
  expires_at: string | null
}

export type CouponValidation = { ok: true; value: NormalizedCoupon } | { ok: false; error: string }

/** PURE: validate + normalize a new coupon. Mirrors every DB CHECK so a bad
 *  coupon fails with a human message, not a Postgres constraint error. */
export function validateCouponInput(input: CouponInput): CouponValidation {
  const code = normalizeCouponCode(input.code)
  if (!isValidCouponCode(code)) {
    return { ok: false, error: "Code must be 3-32 characters: A-Z, 0-9, '-' or '_' (e.g. LAUNCH20)" }
  }

  const hasPercent = input.percentOff != null
  const hasAmount = input.amountOffCents != null
  if (hasPercent === hasAmount) {
    return { ok: false, error: "Set exactly one of percent off OR amount off" }
  }

  let percent: number | null = null
  let amount: number | null = null
  if (hasPercent) {
    percent = Math.round(Number(input.percentOff))
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return { ok: false, error: "Percent off must be between 1 and 100" }
    }
  } else {
    amount = Math.round(Number(input.amountOffCents))
    if (!Number.isFinite(amount) || amount < 1) {
      return { ok: false, error: "Amount off must be a positive number of cents" }
    }
  }

  const duration: CouponDuration = input.duration ?? "once"
  if (!["once", "repeating", "forever"].includes(duration)) {
    return { ok: false, error: "Duration must be once, repeating, or forever" }
  }
  let durationMonths: number | null = null
  if (duration === "repeating") {
    durationMonths = Math.round(Number(input.durationMonths))
    if (!Number.isFinite(durationMonths) || durationMonths < 1 || durationMonths > 36) {
      return { ok: false, error: "A repeating coupon needs a duration of 1-36 months" }
    }
  }

  const tierRaw = (input.appliesToTier ?? "").trim()
  let tier: CanonicalTier | null = null
  if (tierRaw) {
    if (!(CANONICAL_TIERS as readonly string[]).includes(tierRaw)) {
      return { ok: false, error: `Tier must be one of: ${CANONICAL_TIERS.join(", ")} (or blank for any tier)` }
    }
    tier = tierRaw as CanonicalTier
  }

  let maxRedemptions: number | null = null
  if (input.maxRedemptions != null) {
    maxRedemptions = Math.round(Number(input.maxRedemptions))
    if (!Number.isFinite(maxRedemptions) || maxRedemptions < 1) {
      return { ok: false, error: "Max redemptions must be a positive whole number (or blank for unlimited)" }
    }
  }

  let expiresAt: string | null = null
  if (input.expiresAt) {
    const t = Date.parse(input.expiresAt)
    if (Number.isNaN(t)) return { ok: false, error: "Expiry date is not a valid date" }
    expiresAt = new Date(t).toISOString()
  }

  return {
    ok: true,
    value: {
      code,
      description: (input.description ?? "").trim() || null,
      percent_off: percent,
      amount_off_cents: amount,
      duration,
      duration_months: durationMonths,
      applies_to_tier: tier,
      max_redemptions: maxRedemptions,
      expires_at: expiresAt,
    },
  }
}

// ── Redemption eligibility ───────────────────────────────────────────────────

export type RedemptionFailReason =
  | "inactive"
  | "expired"
  | "max_redemptions_reached"
  | "tier_mismatch"
  | "already_redeemed"

export type RedemptionCheck = { ok: true } | { ok: false; reason: RedemptionFailReason; message: string }

/** PURE: may this coupon be redeemed for a tenant on `tier` right now?
 *  `existingRedemption` = the tenant already has a platform_coupon_redemptions
 *  row for this coupon (UNIQUE(coupon_id, brokerage_id) is the DB guard; this
 *  is the friendly pre-check). Checks run worst-first so the message names the
 *  most fundamental problem. */
export function validateCouponForRedemption(
  coupon: PlatformCoupon,
  ctx: { tier: string | null; now: Date; existingRedemption: boolean },
): RedemptionCheck {
  if (!coupon.active) {
    return { ok: false, reason: "inactive", message: `Coupon ${coupon.code} is deactivated` }
  }
  if (coupon.expires_at) {
    const exp = Date.parse(coupon.expires_at)
    if (!Number.isNaN(exp) && exp <= ctx.now.getTime()) {
      return { ok: false, reason: "expired", message: `Coupon ${coupon.code} expired ${new Date(exp).toLocaleDateString("en-US")}` }
    }
  }
  if (coupon.max_redemptions != null && coupon.redeemed_count >= coupon.max_redemptions) {
    return {
      ok: false,
      reason: "max_redemptions_reached",
      message: `Coupon ${coupon.code} has reached its ${coupon.max_redemptions}-redemption limit`,
    }
  }
  if (coupon.applies_to_tier && coupon.applies_to_tier !== ctx.tier) {
    return {
      ok: false,
      reason: "tier_mismatch",
      message: `Coupon ${coupon.code} applies to the ${coupon.applies_to_tier} tier only (tenant is on ${ctx.tier ?? "no tier"})`,
    }
  }
  if (ctx.existingRedemption) {
    return { ok: false, reason: "already_redeemed", message: `This tenant already redeemed ${coupon.code}` }
  }
  return { ok: true }
}

// ── Discount math ────────────────────────────────────────────────────────────

export interface DiscountOutcome {
  /** Monthly price in cents WHILE the discount applies (never below 0). */
  discountedCents: number
  /** Cents saved per discounted billing period. */
  savingsPerPeriodCents: number
  /** How many monthly periods the discount covers: 1 for 'once',
   *  duration_months for 'repeating', null = forever. */
  appliesForMonths: number | null
  /** Price the tenant reverts to when the discount ends (null when it never ends). */
  revertsToCents: number | null
}

/** PURE: apply a coupon to a monthly base price, with duration semantics. */
export function discountedPriceCents(baseCents: number, coupon: PlatformCoupon): DiscountOutcome {
  const base = Math.max(0, Math.round(baseCents))
  let discounted: number
  if (coupon.percent_off != null) {
    discounted = Math.max(0, Math.round(base * (100 - coupon.percent_off) / 100))
  } else {
    discounted = Math.max(0, base - Math.round(coupon.amount_off_cents ?? 0))
  }
  const months = coupon.duration === "forever" ? null : coupon.duration === "repeating" ? (coupon.duration_months ?? 1) : 1
  return {
    discountedCents: discounted,
    savingsPerPeriodCents: base - discounted,
    appliesForMonths: months,
    revertsToCents: months == null ? null : base,
  }
}

// ── Human summary ────────────────────────────────────────────────────────────

const fmtDollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`

/** PURE: "20% off for 3 months" / "$50 off once" / "15% off forever". */
export function describeCoupon(coupon: PlatformCoupon): string {
  const what = coupon.percent_off != null ? `${coupon.percent_off}% off` : `${fmtDollars(coupon.amount_off_cents ?? 0)} off`
  const when =
    coupon.duration === "forever" ? "forever"
    : coupon.duration === "repeating" ? `for ${coupon.duration_months ?? 1} month${(coupon.duration_months ?? 1) === 1 ? "" : "s"}`
    : "once"
  return `${what} ${when}`
}

// ── Stripe payload (pure — the action decides real vs mock) ─────────────────

/** PURE: the form/SDK payload a Stripe coupon publish uses. Kept here so the
 *  mapping (duration_in_months only when repeating, currency only for
 *  amount-off, redeem_by in unix seconds) is testable without creds. */
export function stripeCouponPayload(coupon: PlatformCoupon): Record<string, unknown> {
  return {
    name: coupon.code,
    ...(coupon.percent_off != null
      ? { percent_off: coupon.percent_off }
      : { amount_off: coupon.amount_off_cents ?? 0, currency: "usd" }),
    duration: coupon.duration,
    ...(coupon.duration === "repeating" ? { duration_in_months: coupon.duration_months ?? 1 } : {}),
    ...(coupon.max_redemptions != null ? { max_redemptions: coupon.max_redemptions } : {}),
    ...(coupon.expires_at ? { redeem_by: Math.floor(Date.parse(coupon.expires_at) / 1000) } : {}),
    metadata: { code: coupon.code, applies_to_tier: coupon.applies_to_tier ?? "any" },
  }
}

/** A mock-published stripe_coupon_id (Stripe unconfigured) is self-describing —
 *  it can never be mistaken for a live Stripe id. */
export function isMockStripeCouponId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("mock_")
}
