"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { stripe } from "@/lib/stripe"
import {
  VENDOR_TIERS,
  normalizeTier,
  mapStripeEventToStatus,
  resolveTierPrice,
  type TierPriceOverrides,
  type VendorTier,
} from "@/lib/kernel/vendor-subscription"
import { priceNotConfiguredRefusal } from "@/lib/billing/plan-catalog"

/** The surface name every vendor-tier price_not_configured refusal and incident carries. */
const VENDOR_TIER_PRICE_SURFACE = "vendor_tier_checkout"

/** Resolve the acting user's vendor marketplace profile (the vendor's platform account) and the
 *  tenant their seat belongs to (users.brokerage_id — the SESSION's, never a body field). */
async function requireVendorProfile(): Promise<{ userId: string; brokerageId: string | null; profile: any }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const svc = createServiceClient()
  const { data: profile } = await svc.from("vendor_marketplace_profiles").select("*").eq("user_id", user.id).maybeSingle()
  if (!profile) throw new Error("No vendor marketplace profile for this account")
  const { data: seat, error: seatErr } = await svc.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (seatErr) console.error(`[vendor-billing] vendor seat tenant read refused — no price override can be resolved: ${seatErr.message}`)
  return { userId: user.id, brokerageId: (seat as { brokerage_id?: string | null } | null)?.brokerage_id ?? null, profile }
}

/**
 * The ADMINISTERED vendor tier price for this vendor's tenant: brokerage_settings.settings.vendor_tier_pricing
 * (written by app/actions/vendor-verification.ts setVendorTierPricing, shown in the admin approval queue),
 * folded through resolveTierPrice. The catalog itself carries no price (wave 140J), so a tenant that has
 * published none resolves to `null` = price_not_configured. A REFUSED read also resolves to null — a
 * refusal must never be read as "free".
 */
async function resolveVendorTierPriceUsd(svc: ReturnType<typeof createServiceClient>, brokerageId: string | null, tier: VendorTier): Promise<number | null> {
  if (!brokerageId) return null
  const { data: row, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) {
    console.error(`[vendor-billing] brokerage_settings read refused — vendor tier price treated as not configured: ${error.message}`)
    return null
  }
  const overrides = (((row as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as { vendor_tier_pricing?: TierPriceOverrides }).vendor_tier_pricing ?? null
  return resolveTierPrice(tier, overrides)
}

export type VendorCheckoutResult =
  | { url: string }
  /** price_not_configured (wave 140J): no administered price for this tier — no Stripe session was
   *  created, nothing was charged, and the platform incident was raised. `error` is the vendor's sentence. */
  | { url: null; priceNotConfigured: true; error: string }

/**
 * Start a vendor platform-subscription checkout for the chosen tier (vendor PAYS the platform). Reuses the
 * canonical lib/stripe proxy — mirrors the brokerage billing path. Creates/attaches the Stripe customer,
 * then a subscription Checkout session for the tier price (inline price_data off the ADMINISTERED price so
 * it works before per-tier Price IDs are configured in Stripe). The price is resolved BEFORE any Stripe
 * call: an unset price refuses the checkout — the owner's ruling is that no tier price is ever invented.
 */
export async function createVendorSubscriptionCheckout(tier: VendorTier, opts?: { returnUrl?: string }): Promise<VendorCheckoutResult> {
  const { profile, brokerageId } = await requireVendorProfile()
  const svc = createServiceClient()
  const t = normalizeTier(tier)
  const cap = VENDOR_TIERS[t]

  const monthlyPriceUsd = await resolveVendorTierPriceUsd(svc, brokerageId, t)
  if (monthlyPriceUsd === null) {
    const refusal = priceNotConfiguredRefusal({
      surface: VENDOR_TIER_PRICE_SURFACE,
      what: `vendor tier '${t}' monthly price (brokerage_settings.settings.vendor_tier_pricing${brokerageId ? ` for tenant ${brokerageId}` : " — vendor seat has no tenant"})`,
      whatIsBlocked: `no checkout was started for the ${t.replace("_", " ")} plan`,
    })
    const { raisePriceNotConfiguredIncident } = await import("@/lib/billing/price-not-configured")
    await raisePriceNotConfiguredIncident(svc, refusal, { brokerageId })
    return { url: null, priceNotConfigured: true, error: refusal.tenantMessage }
  }

  let customerId: string | null = profile.stripe_customer_id ?? null
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile.support_email ?? undefined,
      name: profile.company_name ?? undefined,
      metadata: { vendor_profile_id: profile.id, kind: "vendor_platform_subscription" },
    })
    customerId = customer.id
    const { error: stripeCustomerErr } = await svc.from("vendor_marketplace_profiles").update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() }).eq("id", profile.id)
    if (stripeCustomerErr) console.error(`[vendor-billing] Stripe customer created but NOT saved on the profile (a second customer may be created next time): ${stripeCustomerErr.message}`)
  }

  const base = opts?.returnUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://app.example.com"
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{
      price_data: {
        currency: "usd",
        recurring: { interval: "month" },
        unit_amount: monthlyPriceUsd * 100,
        product_data: { name: `VIP Agents Vendor — ${cap.tier} tier` },
      },
      quantity: 1,
    }],
    metadata: { vendor_profile_id: profile.id, vendor_tier: t, priced_by: "brokerage_settings.vendor_tier_pricing" },
    subscription_data: { metadata: { vendor_profile_id: profile.id, vendor_tier: t } },
    success_url: `${base}/vendor/billing?status=success`,
    cancel_url: `${base}/vendor/billing?status=cancelled`,
  })
  if (!session.url) throw new Error("Stripe did not return a checkout URL")
  // Record the intended tier immediately; the webhook confirms it active on payment.
  const { error: intendedTierErr } = await svc.from("vendor_marketplace_profiles").update({ subscription_tier: t, updated_at: new Date().toISOString() }).eq("id", profile.id)
  if (intendedTierErr) console.error(`[vendor-billing] intended tier NOT recorded: ${intendedTierErr.message}`)
  return { url: session.url }
}

/** The administered monthly prices the vendor billing page shows (null = not yet published for this tenant). */
export async function getVendorTierPricesAction(): Promise<Record<VendorTier, number | null>> {
  const { brokerageId } = await requireVendorProfile()
  const svc = createServiceClient()
  const out = {} as Record<VendorTier, number | null>
  for (const t of Object.keys(VENDOR_TIERS) as VendorTier[]) out[t] = await resolveVendorTierPriceUsd(svc, brokerageId, t)
  return out
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
  const { error: subStatusErr } = await svc.from("vendor_marketplace_profiles").update(update).eq("id", input.vendorProfileId)
  if (subStatusErr) console.error(`[vendor-billing] vendor subscription status NOT saved: ${subStatusErr.message}`)
  return { status: mapped.status, suspended: mapped.suspendAccount }
}
