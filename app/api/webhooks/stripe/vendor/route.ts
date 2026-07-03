import { NextRequest, NextResponse } from "next/server"
import { stripe } from "@/lib/stripe"
import { createServiceClient } from "@/lib/supabase/service"
import { applyVendorSubscriptionEvent } from "@/app/actions/vendor-billing"

/**
 * VENDOR SUBSCRIPTION WEBHOOK — the vendor-pays-platform billing lifecycle. Handles subscription
 * created/updated/deleted + invoice payment_succeeded/failed, resolves the vendor's marketplace profile
 * (by subscription metadata or Stripe customer id), and applies the status via applyVendorSubscriptionEvent
 * (payment_failed → past_due; cancellation → canceled + account suspended). Signature-verified with
 * STRIPE_VENDOR_WEBHOOK_SECRET. This is the vendor-side sibling of /api/billing/webhook (brokerage billing).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_VENDOR_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: "vendor webhook secret not configured" }, { status: 500 })

  const sig = req.headers.get("stripe-signature")
  if (!sig) return NextResponse.json({ error: "missing signature" }, { status: 400 })

  let event: import("stripe").Stripe.Event
  try {
    const body = await req.text()
    event = stripe.webhooks.constructEvent(body, sig, secret) as import("stripe").Stripe.Event
  } catch (err: any) {
    return NextResponse.json({ error: `signature verification failed: ${err?.message ?? String(err)}` }, { status: 400 })
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
