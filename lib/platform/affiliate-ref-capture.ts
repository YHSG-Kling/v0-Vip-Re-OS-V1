// lib/platform/affiliate-ref-capture.ts
// ─────────────────────────────────────────────────────────────────────────────
// ?ref= CAPTURE ON PUBLIC FUNNEL PAGES (/pricing, /get-started).
//
// Affiliates share links like /pricing?ref=PARTNER1 — but only /api/ref set the
// 90-day attribution cookie, so a direct funnel link silently lost attribution.
// A Next.js SERVER COMPONENT cannot set cookies (cookies().set is restricted to
// Server Actions / Route Handlers), so the page bounces once through the ONE
// existing cookie-setter — GET /api/ref (cookie name/duration keep-one:
// AFFILIATE_REF_COOKIE / AFFILIATE_REF_COOKIE_DAYS in lib/platform/affiliates)
// — which now honors a `to` param restricted to the funnel paths below. The
// redirect target carries no ?ref, so there is no loop.

import { AFFILIATE_CODE_RE, normalizeAffiliateCode } from "./affiliates"

/** The only paths /api/ref may bounce back to (open-redirect guard). */
export const REF_RETURN_PATHS = ["/get-started", "/pricing"] as const

/** PURE: is `to` a safe same-site return target for the ref capture bounce? */
export function isSafeRefReturn(to: string | null | undefined): boolean {
  if (!to || !to.startsWith("/") || to.startsWith("//") || to.includes("\\")) return false
  const path = to.split("?")[0]
  return (REF_RETURN_PATHS as readonly string[]).includes(path)
}

/**
 * PURE: given a page's ?ref value and the page's own return path (which may
 * carry surviving query params like tier/utm — but never ref), the /api/ref
 * capture URL to redirect through — or null when there is nothing to capture.
 */
export function refCaptureRedirect(ref: string | string[] | undefined, returnTo: string): string | null {
  const code = normalizeAffiliateCode(Array.isArray(ref) ? ref[0] : ref)
  if (!AFFILIATE_CODE_RE.test(code)) return null
  if (!isSafeRefReturn(returnTo)) return null
  return `/api/ref?code=${encodeURIComponent(code)}&to=${encodeURIComponent(returnTo)}`
}
