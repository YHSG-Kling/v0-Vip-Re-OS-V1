import { NextRequest, NextResponse } from "next/server"
import {
  AFFILIATE_CODE_RE,
  AFFILIATE_REF_COOKIE,
  AFFILIATE_REF_COOKIE_DAYS,
  normalizeAffiliateCode,
} from "@/lib/platform/affiliates"
import { isSafeRefReturn } from "@/lib/platform/affiliate-ref-capture"

/**
 * AFFILIATE ATTRIBUTION CAPTURE — the marketing link target.
 *
 *   GET /api/ref?code=PARTNER1  →  set a 90-day attribution cookie, redirect
 *   to /get-started (the public signup funnel).
 *
 * The funnel pages themselves are untouched: signupBrokerageAction reads the
 * cookie server-side (via cookies()) after provisioning and attributes the new
 * tenant to the affiliate best-effort. Last click wins the cookie; the DB's
 * UNIQUE(brokerage_id) on affiliate_referrals makes the actual attribution
 * first-wins per tenant.
 *
 * Deliberately no DB lookup here: an invalid/unknown code just redirects
 * without a cookie (no code-enumeration oracle on a public endpoint), and the
 * real validation happens at signup time against active affiliates only.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = normalizeAffiliateCode(url.searchParams.get("code"))
  // `to` lets the funnel pages (/pricing, /get-started — which cannot set
  // cookies as server components) bounce through here and return to
  // themselves. Allowlisted relative paths only (isSafeRefReturn) — anything
  // else falls back to the signup funnel.
  const to = url.searchParams.get("to")
  const dest = new URL(isSafeRefReturn(to) ? (to as string) : "/get-started", url.origin)

  const res = NextResponse.redirect(dest, { status: 307 })
  if (AFFILIATE_CODE_RE.test(code)) {
    res.cookies.set(AFFILIATE_REF_COOKIE, code, {
      maxAge: AFFILIATE_REF_COOKIE_DAYS * 24 * 60 * 60,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    })
  }
  return res
}
