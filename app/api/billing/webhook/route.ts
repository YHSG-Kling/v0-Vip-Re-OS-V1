import { NextRequest, NextResponse } from "next/server"
import { stripe } from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import Stripe from "stripe"

// Stripe webhook handler
// Handles: invoice.paid, invoice.payment_failed, customer.subscription.updated, customer.subscription.deleted
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

  const supabase = await createClient()

  try {
    switch (event.type) {
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

        // Update subscription record
        const subscriptionAny = subscription as any
        const { error } = await supabase
          .from("subscriptions")
          .upsert({
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer as string,
            brokerage_id: brokerageId,
            tier_id: tierId || null,
            status: subscription.status,
            current_period_start: new Date(subscriptionAny.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscriptionAny.current_period_end * 1000).toISOString(),
            trial_end: subscription.trial_end 
              ? new Date(subscription.trial_end * 1000).toISOString() 
              : null,
            cancel_at: subscription.cancel_at 
              ? new Date(subscription.cancel_at * 1000).toISOString() 
              : null,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: "stripe_subscription_id",
          })

        if (error) {
          console.error("[Billing Webhook] Failed to update subscription:", error)
        }
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
        const svc = createServiceClient()
        const account = event.data.object as Stripe.Account
        if (account.details_submitted && account.charges_enabled) {
          await svc
            .from("vendor_marketplace_profiles")
            .update({ stripe_onboarding_complete: true })
            .eq("stripe_account_id", account.id)
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
