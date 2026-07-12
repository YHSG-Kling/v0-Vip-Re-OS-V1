/**
 * lib/gifting/shoppable-links.ts
 *
 * SHOPPABLE GIFT LINKS — the owner's call: real-estate gifting is
 * BUSINESS-TO-CUSTOMER and personal; it doesn't need a fulfillment
 * provider in the middle (a B2B gifting API was the wrong fit). The AI
 * already recommends the RIGHT gift by persona + occasion; what the
 * agent needs is to buy it in one click, in their own name, on their own
 * card — the personal touch intact, zero provider dependency, zero new
 * platform setup.
 *
 * PURE: compose direct marketplace search links (Etsy first — handmade /
 * personalized fits closing gifts; Amazon as the fast fallback) from the
 * recommended gift's name, riding on the gift TASK the send_gift adapter
 * already creates. No API keys, no egress, nothing to configure — and
 * nothing simulated: the links are searches for the exact recommended
 * item, the human makes the purchase.
 */

export interface ShoppableLinks {
  etsy: string
  amazon: string
  /** the line appended to the gift task description. */
  taskLine: string
}

export function composeShoppableLinks(giftName: string, opts: { budgetMax?: number | null } = {}): ShoppableLinks {
  const q = encodeURIComponent(giftName.trim())
  const etsy = `https://www.etsy.com/search?q=${q}${opts.budgetMax ? `&max=${Math.round(opts.budgetMax)}` : ""}`
  const amazon = `https://www.amazon.com/s?k=${q}${opts.budgetMax ? `&rh=p_36%3A-${Math.round(opts.budgetMax * 100)}` : ""}`
  return {
    etsy,
    amazon,
    taskLine: `One-click shop: Etsy ${etsy} · Amazon ${amazon}`,
  }
}
