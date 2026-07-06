// lib/billing/stripe-portal.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE Stripe billing-portal opener, shared by the vendor billing action and the
// brokerage-tenant billing action. The vendor path already had a self-serve portal
// (manage card / invoices / cancel); tenants did not — this gives them parity
// through a single implementation so the two can't drift.

/** Create a Stripe billing-portal session URL for a customer. Throws if the customer
 *  has no billing account yet (subscribe first) or Stripe isn't configured. */
export async function createBillingPortalUrl(stripeCustomerId: string | null | undefined, returnUrl: string): Promise<string> {
  if (!stripeCustomerId) throw new Error("No billing account yet — subscribe to a plan first")
  const { stripe } = await import("@/lib/stripe")
  const portal = await stripe.billingPortal.sessions.create({ customer: stripeCustomerId, return_url: returnUrl })
  if (!portal.url) throw new Error("Stripe did not return a billing-portal URL")
  return portal.url
}
