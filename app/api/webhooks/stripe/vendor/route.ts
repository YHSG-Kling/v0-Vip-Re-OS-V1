import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyStripeWebhook } from "@/lib/billing/stripe-webhook-secrets"
import { applyVendorSubscriptionEvent } from "@/app/actions/vendor-billing"
import {
  applyVendorPayoutProviderEvent,
  VENDOR_PAYOUT_COMPLETION_EVENTS,
} from "@/lib/vendors/vendor-payout-events"

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
 * A tenant-signed delivery is refused ON THE SUBSCRIPTION LANE:
 * `vendor_marketplace_profiles` is the platform's record of what a vendor owes
 * the PLATFORM, and a tenant's Stripe account has no authority over it. Without
 * that check any tenant with a Stripe account could suspend or reinstate any
 * vendor by emitting a subscription event carrying that vendor's profile id in
 * metadata.
 *
 * ── PAYOUT COMPLETION LANE (added 2026-08-27) ───────────────────────────────
 * The same endpoint also closes the vendor PAYOUT ledger: transfer.created /
 * transfer.reversed (the Transfer initiateVendorPayout creates on the
 * BROKERAGE's account) and payout.paid / payout.failed (the po_… ids
 * vendor_payouts.stripe_payout_id can carry) land on vendor_payouts.status +
 * completed_at via lib/vendors/vendor-payout-events.ts. That money is the
 * BROKERAGE's, so tenant-signed deliveries are legitimate there — scoped to the
 * signing tenant's own rows inside the applier, never widened by metadata.
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

  // ── PAYOUT COMPLETION (owner ruling 2026-08-27: "the vendor payout completed
  // at should come from the providers event completion") ─────────────────────
  //
  // initiateVendorPayout creates a TRANSFER on the BROKERAGE's Stripe account
  // ({ side: "tenant" }), so these deliveries are legitimately signed by a
  // TENANT (direct-mode brokerage) or by the PLATFORM (connect-mode brokerages
  // bank under the platform's account). This lane therefore runs BEFORE the
  // platform-only refusal below, which exists to protect the SUBSCRIPTION
  // ledger (money the vendor owes the PLATFORM) — a different authority
  // question from a brokerage's own payout ledger. Cross-tenant honesty lives
  // inside the applier: the row is found by the stripe id STORED ON IT, and a
  // tenant-signed delivery is refused unless the row's brokerage_id IS the
  // signing tenant (never trusted from event metadata).
  if (VENDOR_PAYOUT_COMPLETION_EVENTS[String(event.type)]) {
    const svc = createServiceClient()
    const obj = event.data.object as { id?: string } | null
    // VendorPayoutDbClient is the STRUCTURAL slice of the supabase client the
    // applier touches (so the simulator can stub it); the real client's chained
    // builders are thenables rather than Promises, hence the seam cast here.
    const result = await applyVendorPayoutProviderEvent(
      svc as unknown as import("@/lib/vendors/vendor-payout-events").VendorPayoutDbClient,
      {
      eventType: String(event.type),
      stripeObjectId: obj?.id ?? null,
      // The PROVIDER's event time — the ruling says completion comes from the
      // provider's event, so completed_at records Stripe's clock, not ours.
      eventCreatedAtIso: new Date(event.created * 1000).toISOString(),
      signer: { ownerType: verification.ownerType, ownerId: verification.ownerId },
    })
    switch (result.outcome) {
      case "applied":
        return NextResponse.json({ ok: true, applied: true, payoutId: result.payoutId, status: result.status, completedAt: result.completedAt })
      case "replay":
        return NextResponse.json({ ok: true, applied: false, replay: true, payoutId: result.payoutId, status: result.status })
      case "stale_transition":
        console.warn("[Vendor Webhook] payout event out of order —", result.message)
        return NextResponse.json({ ok: true, applied: false, reason: result.message })
      case "unmatched":
        // A FINDING, not a success (§3): logged loudly, acknowledged with
        // applied:false. 200 on purpose — transfers that are not vendor payouts
        // (agent commission disbursements ride the same v1/transfers) land here
        // by design, and a 5xx would make Stripe redeliver them forever.
        console.warn("[Vendor Webhook] FINDING — payout event matched no ledger row:", result.message)
        return NextResponse.json({ ok: true, applied: false, reason: result.message })
      case "refused_cross_tenant":
        console.error("[Vendor Webhook] REFUSED —", result.message, "event:", event.type)
        return NextResponse.json({ ok: true, applied: false, reason: result.message })
      case "error":
        // Fail closed + retryable: a refused read/update, or an update that
        // matched 0 rows, is answered 500 so Stripe redelivers.
        console.error("[Vendor Webhook] payout event NOT recorded —", result.message)
        return NextResponse.json({ ok: false, error: result.message }, { status: 500 })
    }
  }

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
