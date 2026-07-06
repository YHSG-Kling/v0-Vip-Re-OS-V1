import { NextRequest, NextResponse } from "next/server"
import { stripe } from "@/lib/stripe"
import { createServiceClient } from "@/lib/supabase/service"
import { syncBrokeragePlanTier } from "@/lib/billing/sync-plan-tier"
import { setStripeOnboardingByAccount } from "@/lib/connections/vendor-stripe"
import { buildSubscriptionPatch, upsertBrokerageSubscription, type NormalizedStripeSub } from "@/lib/billing/subscription-activation"
import Stripe from "stripe"

/** Normalize a Stripe subscription into the shape buildSubscriptionPatch wants. */
function normalizeSub(s: Stripe.Subscription): NormalizedStripeSub {
  const a = s as any
  return {
    stripeSubscriptionId: s.id,
    stripeCustomerId: (s.customer as string) ?? null,
    tierId: s.metadata?.tier_id ?? null,
    status: s.status,
    currentPeriodStart: a.current_period_start ?? null,
    currentPeriodEnd: a.current_period_end ?? null,
    trialEnd: s.trial_end ?? null,
    cancelAt: s.cancel_at ?? null,
  }
}

// Stripe webhook handler
// Handles: checkout.session.completed, invoice.paid, invoice.payment_failed,
//          customer.subscription.updated, customer.subscription.deleted, account.updated
export async function POST(request: NextRequest) {
  const body = await request.text()
  const signature = request.headers.get("stripe-signature")

  if (!signature) {
    return NextResponse.json({ error: "No signature" }, { status: 400 })
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error("[Billing Webhook] STRIPE_WEBHOOK_SECRET not configured")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (err) {
    console.error("[Billing Webhook] Signature verification failed:", err)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  // Webhook is authenticated by Stripe signature verification above. There is
  // no user session in this request, so the RLS-enforced server client would
  // block every upsert (current_user_brokerage_id() returns null → the
  // billing_invoices_tenant_* and subscriptions_tenant_* policies reject the
  // row). Use the service client.
  const supabase = createServiceClient()

  try {
    switch (event.type) {
      // ─── CHECKOUT COMPLETED → ACTIVATE + LINK (no duplicate row) ──────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const brokerageId = session.metadata?.brokerage_id
          || (session.subscription ? (await stripe.subscriptions.retrieve(session.subscription as string)).metadata?.brokerage_id : null)
        if (!brokerageId) { console.error("[Billing Webhook] checkout.session.completed: no brokerage_id"); break }

        // Link the Stripe subscription to the brokerage's EXISTING (trialing) row —
        // never insert a duplicate. This is the activation that flips the account live.
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string)
          const patch = buildSubscriptionPatch(normalizeSub(sub))
          await upsertBrokerageSubscription(supabase, brokerageId, patch)
          await syncBrokeragePlanTier(brokerageId)
          // Safety: ensure the paid account is fully provisioned (idempotent no-op
          // when signup already provisioned it).
          try {
            const { data: owner } = await supabase.from("users").select("id").eq("brokerage_id", brokerageId).in("user_type", ["broker", "admin", "agent"]).limit(1).maybeSingle()
            if (owner?.id) {
              const { repairIncompleteAccountSetup } = await import("@/lib/kernel/users")
              await repairIncompleteAccountSetup(owner.id)
            }
          } catch (err) { console.warn("[Billing Webhook] provisioning safety-repair failed:", (err as any)?.message) }
        }
        break
      }

      // ─── INVOICE PAID ────────────────────────────────────────────────────────
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice
        const stripeInvoiceId = invoice.id
        const invoiceAny = invoice as any
        const subscriptionId = typeof invoiceAny.subscription === 'string' ? invoiceAny.subscription : invoiceAny.subscription?.id

        // Get brokerage_id from subscription metadata
        let brokerageId: string | null = null
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId)
          brokerageId = subscription.metadata?.brokerage_id || null
        }

        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Update or insert invoice record
        const { error } = await supabase
          .from("billing_invoices")
          .upsert({
            stripe_invoice_id: stripeInvoiceId,
            brokerage_id: brokerageId,
            amount_cents: invoice.amount_paid,
            status: "paid",
            invoice_date: new Date(invoice.created * 1000).toISOString().split("T")[0],
            paid_at: new Date().toISOString(),
            pdf_url: invoice.invoice_pdf || null,
          }, {
            onConflict: "stripe_invoice_id",
          })

        if (error) {
          console.error("[Billing Webhook] Failed to update invoice:", error)
        }
        break
      }

      // ─── INVOICE PAYMENT FAILED ──────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice
        const stripeInvoiceId = invoice.id
        const invoiceAny2 = invoice as any
        const subscriptionId = typeof invoiceAny2.subscription === 'string' ? invoiceAny2.subscription : invoiceAny2.subscription?.id

        // Get brokerage_id from subscription metadata
        let brokerageId: string | null = null
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId)
          brokerageId = subscription.metadata?.brokerage_id || null
        }

        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Update invoice status to open (unpaid)
        const { error } = await supabase
          .from("billing_invoices")
          .upsert({
            stripe_invoice_id: stripeInvoiceId,
            brokerage_id: brokerageId,
            amount_cents: invoice.amount_due,
            status: "open",
            invoice_date: new Date(invoice.created * 1000).toISOString().split("T")[0],
            pdf_url: invoice.invoice_pdf || null,
          }, {
            onConflict: "stripe_invoice_id",
          })

        if (error) {
          console.error("[Billing Webhook] Failed to update invoice:", error)
        }

        // Emit payment failed alert notification
        await supabase.from("notifications").insert({
          brokerage_id: brokerageId,
          type: "billing_alert",
          title: "Payment Failed",
          body: `Your subscription payment of $${(invoice.amount_due / 100).toFixed(2)} failed. Please update your payment method.`,
          priority: "high",
        })

        break
      }

      // ─── SUBSCRIPTION UPDATED ────────────────────────────────────────────────
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription
        const brokerageId = subscription.metadata?.brokerage_id
        const tierId = subscription.metadata?.tier_id

        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Link/update the brokerage's ONE subscription row (never a duplicate) —
        // the signup row has no stripe_subscription_id, so a raw upsert-by-that-id
        // used to insert a second row here.
        const patch = buildSubscriptionPatch(normalizeSub(subscription))
        await upsertBrokerageSubscription(supabase, brokerageId, patch)

        // Keep brokerages.plan_tier in sync with the active subscription so
        // cap-enforcement reflects upgrades/downgrades immediately. Failure
        // here is logged but doesn't fail the webhook.
        await syncBrokeragePlanTier(brokerageId)
        break
      }

      // ─── SUBSCRIPTION DELETED/CANCELLED ──────────────────────────────────────
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const brokerageId = subscription.metadata?.brokerage_id

        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Update subscription status to cancelled
        const { error } = await supabase
          .from("subscriptions")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscription.id)

        if (error) {
          console.error("[Billing Webhook] Failed to cancel subscription:", error)
        }

        // Cap-enforcement: with no active subscription the brokerage falls
        // back to the entry-level tier. Caps tighten immediately so we can't
        // burn paid features on a cancelled account.
        await syncBrokeragePlanTier(brokerageId)

        // Notify brokerage
        await supabase.from("notifications").insert({
          brokerage_id: brokerageId,
          type: "billing_alert",
          title: "Subscription Cancelled",
          body: "Your subscription has been cancelled. Your access will be limited.",
          priority: "high",
        })

        break
      }

      // ─── STRIPE CONNECT: ACCOUNT UPDATED (onboarding complete) ───────────────
      case "account.updated": {
        const account = event.data.object as Stripe.Account
        if (account.details_submitted && account.charges_enabled) {
          await setStripeOnboardingByAccount(supabase, account.id, true)
        }
        break
      }

      default:
        console.log(`[Billing Webhook] Unhandled event type: ${event.type}`)
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error("[Billing Webhook] Error processing event:", err)
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 })
  }
}
