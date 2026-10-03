/**
 * lib/kernel/portal-template-render.ts
 *
 * Pure render helper for client portal transparency templates. Kept out of the server-only
 * event-fanout module so it can be unit-tested directly. Transparency notices are proactive and
 * SPECIFIC, not generic: template strings may contain {key} tokens filled from the event metadata
 * (e.g. real contract dates — earnest money due, inspection deadline, closing). A missing/blank key
 * renders as "TBD" so a partially-known milestone still posts something useful rather than a raw
 * token.
 */
import { priceOrPendingReview, PRICE_PENDING_REVIEW } from "@/lib/format/money"

/**
 * A PRICE token ({contract_price_fmt}, {purchase_price}, {offer_price}, …). A price we do not
 * have — missing, blank, zero, "$0" — renders the ONE wording for it (wave 94,
 * lib/format/money.ts PRICE_PENDING_REVIEW), never "TBD" and never "$0". A pre-formatted
 * value (`*_fmt`) passes through unless it says zero.
 */
const PRICE_KEY_RE = /(^|_)price(_|$)/i

function renderPriceToken(key: string, v: unknown): string {
  if (typeof v === "string" && /_fmt$/i.test(key)) {
    const digits = Number(v.replace(/[^0-9.]/g, ""))
    return v.trim() && Number.isFinite(digits) && digits > 0 ? v : PRICE_PENDING_REVIEW
  }
  return priceOrPendingReview(typeof v === "number" || typeof v === "string" ? v : null)
}

export function renderTemplateText(
  text:     string | undefined,
  metadata: Record<string, any> | undefined,
): string | undefined {
  if (!text || !text.includes("{")) return text
  return text.replace(/\{([a-z0-9_]+)\}/gi, (_m, key: string) => {
    const v = metadata?.[key]
    if (PRICE_KEY_RE.test(key)) return renderPriceToken(key, v)
    // Only interpolate primitives — an object/array value would stringify to "[object Object]" in a
    // client-facing card; treat those (and missing/blank) as "TBD".
    const t = typeof v
    if (v === undefined || v === null || v === "" || (t !== "string" && t !== "number" && t !== "boolean")) return "TBD"
    return String(v)
  })
}
