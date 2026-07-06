"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { stripe } from "@/lib/stripe"
import {
  VENDOR_TIERS,
  normalizeTier,
  mapStripeEventToStatus,
  type VendorTier,
} from "@/lib/kernel/vendor-subscription"

/** Resolve the acting user's vendor marketplace profile (the vendor's platform account). */
async function requireVendorProfile(): Promise<{ userId: string; profile: any }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const svc = createServiceClient()
  const { data: profile } = await svc.from("vendor_marketplace_profiles").select("*").eq("user_id", user.id).maybeSingle()
  if (!profile) throw new Error("No vendor marketplace profile for this account")
  return { userId: user.id, profile }
}

/**
 * Start a vendor platform-subscription checkout for the chosen tier (vendor PAYS the platform). Reuses the
 * canonical lib/stripe proxy — mirrors the brokerage billing path. Creates/attaches the Stripe customer,
 * then a subscription Checkout session for the tier price (inline price_data off the tier catalog so it
 * works before per-tier Price IDs are configured in Stripe).
 */
export async function createVendorSubscriptionCheckout(tier: VendorTier, opts?: { returnUrl?: string }): Promise<{ url: string }> {
  const { profile } = await requireVendorProfile()
  const svc = createServiceClient()
  const t = normalizeTier(tier)
  const cap = VENDOR_TIERS[t]

  let customerId: string | null = profile.stripe_customer_id ?? null
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile.support_email ?? undefined,
      name: profile.company_name ?? undefined,
      metadata: { vendor_profile_id: profile.id, kind: "vendor_platform_subscription" },
    })
    customerId = customer.id
    await svc.from("vendor_marketplace_profiles").update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() }).eq("id", profile.id)
  }

  const base = opts?.returnUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://app.example.com"
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{
      price_data: {
        currency: "usd",
        recurring: { interval: "month" },
        unit_amount: cap.monthlyPriceUsd * 100,
        product_data: { name: `VIP Agents Vendor — ${t} tier` },
      },
      quantity: 1,
    }],
    metadata: { vendor_profile_id: profile.id, vendor_tier: t },
    subscription_data: { metadata: { vendor_profile_id: profile.id, vendor_tier: t } },
    success_url: `${base}/vendor/billing?status=success`,
    cancel_url: `${base}/vendor/billing?status=cancelled`,
  })
  if (!session.url) throw new Error("Stripe did not return a checkout URL")
  // Record the intended tier immediately; the webhook confirms it active on payment.
  await svc.from("vendor_marketplace_profiles").update({ subscription_tier: t, updated_at: new Date().toISOString() }).eq("id", profile.id)
  return { url: session.url }
}

/** Open the Stripe billing portal so the vendor can manage card / invoices / cancellation. */
export async function createVendorBillingPortalSession(returnUrl?: string): Promise<{ url: string }> {
  const { profile } = await requireVendorProfile()
  const base = returnUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://app.example.com"
  const { createBillingPortalUrl } = await import("@/lib/billing/stripe-portal")
  return { url: await createBillingPortalUrl(profile.stripe_customer_id, `${base}/vendor/billing`) }
}

/**
 * Apply a Stripe subscription lifecycle event to a vendor profile — the shared updater the webhook calls.
 * mapStripeEventToStatus decides the new subscription_status; a cancellation also suspends the platform
 * account (status → suspended). Best-effort, service-scoped. Exported for the webhook route.
 */
export async function applyVendorSubscriptionEvent(input: {
  vendorProfileId: string
  eventType: string
  stripeStatus?: string | null
  stripeSubscriptionId?: string | null
  tier?: string | null
}): Promise<{ status: string; suspended: boolean }> {
  const svc = createServiceClient()
  const mapped = mapStripeEventToStatus(input.eventType, input.stripeStatus)
  const update: Record<string, unknown> = { subscription_status: mapped.status, updated_at: new Date().toISOString() }
  if (input.stripeSubscriptionId) update.stripe_subscription_id = input.stripeSubscriptionId
  if (input.tier) update.subscription_tier = normalizeTier(input.tier)
  if (mapped.suspendAccount) update.status = "suspended"
  else if (mapped.status === "active") update.status = "approved"
  await svc.from("vendor_marketplace_profiles").update(update).eq("id", input.vendorProfileId)
  return { status: mapped.status, suspended: mapped.suspendAccount }
}
