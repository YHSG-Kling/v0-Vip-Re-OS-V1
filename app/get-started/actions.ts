"use server"

// app/get-started/actions.ts
// ─────────────────────────────────────────────────────────────────────────────
// Public (unauthenticated) server actions for the self-serve trial funnel on
// /get-started. Read-only: coupon *validation* only — the redemption itself is
// recorded inside signupBrokerageAction after the tenant exists. All rules live
// in lib/platform/trial-funnel (which reuses the pure lib/platform/coupons
// layer), so the public funnel can never accept a code the superadmin
// redemption rail would refuse.

import { validateFunnelCoupon } from "@/lib/platform/trial-funnel"

export interface FunnelCouponFeedback {
  ok: boolean
  /** Normalized code (what the signup submits) when valid. */
  code?: string
  /** "20% off for 3 months" when valid. */
  summary?: string
  /** Human reason when invalid. */
  message?: string
}

/** Live coupon-field feedback for the public funnel — validation only, nothing is redeemed. */
export async function checkFunnelCouponAction(code: string, tier: string): Promise<FunnelCouponFeedback> {
  if (!code?.trim()) return { ok: false, message: "Enter a code to check it" }
  // Public-surface throttle — stops coupon-code enumeration from one client.
  // Per-instance (honest limitation documented in lib/security/public-rate-limit.ts).
  {
    const { checkPublicRateLimit, publicCallerIp } = await import("@/lib/security/public-rate-limit")
    const verdict = checkPublicRateLimit("coupon-check", await publicCallerIp(), { limit: 20, windowMs: 60_000 })
    if (!verdict.allowed) return { ok: false, message: "Too many code checks — wait a moment and try again." }
  }
  try {
    const check = await validateFunnelCoupon(code, tier)
    if (!check.ok) return { ok: false, message: check.message }
    return { ok: true, code: check.code, summary: check.summary }
  } catch (err) {
    console.error("[get-started] coupon check failed:", err)
    return { ok: false, message: "Couldn't check that code right now — you can still sign up without it." }
  }
}
