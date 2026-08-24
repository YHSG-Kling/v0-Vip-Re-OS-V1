import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyStripeWebhook } from "@/lib/billing/stripe-webhook-secrets"
import { applyVendorSubscriptionEvent } from "@/app/actions/vendor-billing"

/**
 * VENDOR SUBSCRIPTION WEBHOOK — the vendor-pays-platform billing lifecycle. Handles subscription
 * created/updated/deleted + invoice payment_succeeded/failed, resolves the vendor's marketplace profile
 * (by subscription metadata or Stripe customer id), and applies the status via applyVendorSubscriptionEvent
 * (payment_failed → past_due; cancellation → canceled + account suspended). This is the vendor-side
 * sibling of /api/billing/webhook (brokerage billing).
 *
 * ── WHOSE STRIPE ACCOUNT SIGNS THIS ENDPOINT ────────────────────────────────
 *
 * VENDOR_PLATFORM_TIER (lib/vendors/vendor-money-directions.ts): the vendor pays
 * the PLATFORM for its own marketplace tier. The platform is the payee, so the
 * platform is the merchant and the platform's account signs — see
 * lib/billing/stripe-account-scope.ts, which states that rule once for every path.
 *
 * The secret is no longer the single hardcoded STRIPE_VENDOR_WEBHOOK_SECRET read
 * inline. `verifyStripeWebhook` resolves the platform's signing secret for THIS
 * endpoint (the platform credential's config.vendor_webhook_secret, else
 * STRIPE_VENDOR_WEBHOOK_SECRET) and then every tenant's, and names who signed —
 * so a tenant's own-account delivery landing here is refused BY NAME rather than
 * dismissed as a bad signature.
 *
 * A tenant-signed delivery is refused: `vendor_marketplace_profiles` is the
 * platform's record of what a vendor owes the PLATFORM, and a tenant's Stripe
 * account has no authority over it. Without that check any tenant with a Stripe
 * account could suspend or reinstate any vendor by emitting a subscription event
 * carrying that vendor's profile id in metadata.
 */
export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature")
  if (!sig) return NextResponse.json({ error: "missing signature" }, { status: 400 })

  const body = await req.text()
  const verification = await verifyStripeWebhook({ endpoint: "vendor_marketplace", body, signature: sig })

  if (verification.status === "no_candidates") {
    console.error("[Vendor Webhook] REFUSED —", verification.message)
    return NextResponse.json({ error: verification.message }, { status: 500 })
  }
  if (verification.status === "unreadable") {
    // Fail CLOSED: we could not check, so we do not claim the sender is wrong.
    // 503 invites Stripe's retry once the credential store is readable again.
    console.error("[Vendor Webhook] REFUSED —", verification.message)
    return NextResponse.json({ error: verification.message }, { status: 503 })
  }
  if (verification.status === "unverified") {
    console.error("[Vendor Webhook] REFUSED —", verification.message)
    return NextResponse.json({ error: `signature verification failed: ${verification.message}` }, { status: 400 })
  }

  const event: import("stripe").Stripe.Event = verification.event

  if (verification.ownerType !== "platform") {
    const reason =
      `Delivery to /api/webhooks/stripe/vendor was signed by ${verification.ownerType} ${verification.ownerId}'s own Stripe account. ` +
      `The vendor marketplace tier is money the vendor pays the PLATFORM (VENDOR_PLATFORM_TIER), so only platform-signed events may ` +
      `move a vendor's subscription status. Refusing.`
    console.error("[Vendor Webhook] REFUSED —", reason, "event:", event.type)
    return NextResponse.json({ ok: true, applied: false, reason }, { status: 200 })
  }

  try {
    const obj = event.data.object as any
    const metaProfileId: string | null = obj?.metadata?.vendor_profile_id ?? obj?.subscription_details?.metadata?.vendor_profile_id ?? null
    const customerId: string | null = typeof obj?.customer === "string" ? obj.customer : null
    const subscriptionId: string | null = obj?.id && String(event.type).startsWith("customer.subscription") ? obj.id : (typeof obj?.subscription === "string" ? obj.subscription : null)

    // Resolve the vendor profile: by metadata first, else by Stripe customer id.
    const svc = createServiceClient()
    let profileId: string | null = metaProfileId
    if (!profileId && customerId) {
      const { data } = await svc.from("vendor_marketplace_profiles").select("id").eq("stripe_customer_id", customerId).maybeSingle()
      profileId = (data as { id?: string } | null)?.id ?? null
    }
    if (!profileId) {
      // Not a vendor-subscription event we own (e.g. a brokerage customer) — acknowledge and ignore.
      return NextResponse.json({ ok: true, ignored: true })
    }

    const result = await applyVendorSubscriptionEvent({
      vendorProfileId: profileId,
      eventType: event.type,
      stripeStatus: obj?.status ?? null,
      stripeSubscriptionId: subscriptionId,
      tier: obj?.metadata?.vendor_tier ?? null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 })
  }
}
