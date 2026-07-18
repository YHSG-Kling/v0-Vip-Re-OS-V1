// lib/platform/save-offer.ts
// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION SAVE-OFFER — the retention step the cancel flow was missing.
// A tenant admin clicking "Cancel subscription" previously went straight to a
// confirm dialog; standard SaaS practice (and the whole point of having a
// coupon engine) is to counter with a configured discount first.
//
// PURE layer — no "use server", no Supabase, no Stripe — mirroring
// lib/platform/coupons.ts. The offer is DRIVEN BY EXISTING RAILS:
//   · which coupon is the save-offer lives in platform_settings.retention_offer
//     (jsonb on the singleton — see scripts/l61-s01-retention-offer-status-notice.sql),
//     configured on the superadmin coupons page;
//   · eligibility reuses validateCouponForRedemption (tier match, expiry,
//     redemption cap, one-per-tenant) — the SAME rules a manual redemption obeys;
//   · the discount math reuses discountedPriceCents.
// No offer configured, or the tenant is ineligible → NO offer (never invented).

import {
  validateCouponForRedemption,
  discountedPriceCents,
  describeCoupon,
  normalizeCouponCode,
  type PlatformCoupon,
} from "@/lib/platform/coupons"

// ── Config (platform_settings.retention_offer jsonb) ─────────────────────────

export interface RetentionOfferConfig {
  /** platform_coupons.code presented at cancellation; null = feature off. */
  couponCode: string | null
  /** Headline shown above the offer. */
  headline: string
}

export const DEFAULT_SAVE_OFFER_HEADLINE = "Before you go — here's an offer to stay"

/** PURE: merge a stored retention_offer jsonb over defaults; bad values fall back. */
export function resolveRetentionOfferConfig(raw: any): RetentionOfferConfig {
  const r = raw ?? {}
  const code = typeof r.couponCode === "string" && r.couponCode.trim() ? normalizeCouponCode(r.couponCode) : null
  const headline =
    typeof r.headline === "string" && r.headline.trim() ? r.headline.trim().slice(0, 160) : DEFAULT_SAVE_OFFER_HEADLINE
  return { couponCode: code, headline }
}

// ── Offer resolution ─────────────────────────────────────────────────────────

export interface SaveOffer {
  couponId: string
  couponCode: string
  headline: string
  /** "20% off for 3 months" — from describeCoupon. */
  summary: string
  /** Current monthly price in cents (the tier's list price). */
  currentMonthlyCents: number
  /** Monthly price in cents while the discount applies. */
  discountedMonthlyCents: number
  /** Cents saved per discounted month. */
  savingsPerMonthCents: number
  /** How many monthly periods the discount covers; null = forever. */
  appliesForMonths: number | null
}

export type SaveOfferResolution =
  | { offer: SaveOffer }
  | { offer: null; reason: "not_configured" | "coupon_missing" | "ineligible"; detail: string }

/**
 * PURE: resolve the save-offer for a tenant about to cancel. `coupon` is the
 * platform_coupons row matching the configured code (null when the lookup found
 * nothing). Eligibility is the SAME check a manual superadmin redemption runs —
 * an offer this tenant could not actually redeem is never shown.
 */
export function resolveSaveOffer(input: {
  config: RetentionOfferConfig
  coupon: (PlatformCoupon & { id: string }) | null
  tier: string | null
  monthlyPriceCents: number
  existingRedemption: boolean
  now: Date
}): SaveOfferResolution {
  const { config, coupon } = input
  if (!config.couponCode) {
    return { offer: null, reason: "not_configured", detail: "No cancellation save-offer is configured" }
  }
  if (!coupon) {
    return { offer: null, reason: "coupon_missing", detail: `Configured save-offer coupon ${config.couponCode} was not found` }
  }
  const check = validateCouponForRedemption(coupon, {
    tier: input.tier,
    now: input.now,
    existingRedemption: input.existingRedemption,
  })
  if (!check.ok) return { offer: null, reason: "ineligible", detail: check.message }

  const outcome = discountedPriceCents(input.monthlyPriceCents, coupon)
  return {
    offer: {
      couponId: coupon.id,
      couponCode: coupon.code,
      headline: config.headline,
      summary: describeCoupon(coupon),
      currentMonthlyCents: Math.max(0, Math.round(input.monthlyPriceCents)),
      discountedMonthlyCents: outcome.discountedCents,
      savingsPerMonthCents: outcome.savingsPerPeriodCents,
      appliesForMonths: outcome.appliesForMonths,
    },
  }
}
