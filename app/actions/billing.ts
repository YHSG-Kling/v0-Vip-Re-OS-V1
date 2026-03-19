"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

// ─── GET SUBSCRIPTION TIERS ──────────────────────────────────────────────────
export async function getSubscriptionTiers() {
  const supabase = await createClient()

  const { data: tiers, error } = await supabase
    .from("subscription_tiers")
    .select("*")
    .eq("is_active", true)
    .order("monthly_price_cents", { ascending: true })

  if (error) throw error
  return tiers || []
}

// ─── GET CURRENT SUBSCRIPTION ────────────────────────────────────────────────
export async function getCurrentSubscription(brokerageId: string) {
  const supabase = await createClient()

  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select(`
      *,
      subscription_tiers:tier_id(*)
    `)
    .eq("brokerage_id", brokerageId)
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return subscription
}

// ─── GET BILLING USAGE ───────────────────────────────────────────────────────
export async function getBillingUsage(brokerageId: string) {
  const supabase = await createClient()

  const { data: usage, error } = await supabase
    .from("billing_usage")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return usage
}

// ─── GET INVOICE HISTORY ─────────────────────────────────────────────────────
export async function getInvoiceHistory(brokerageId: string, year?: number) {
  const supabase = await createClient()

  let query = supabase
    .from("billing_invoices")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("invoice_date", { ascending: false })

  if (year) {
    const startOfYear = `${year}-01-01`
    const endOfYear = `${year}-12-31`
    query = query.gte("invoice_date", startOfYear).lte("invoice_date", endOfYear)
  }

  const { data: invoices, error } = await query

  if (error) throw error
  return invoices || []
}

// ─── START SUBSCRIPTION CHECKOUT ─────────────────────────────────────────────
export async function startSubscriptionCheckout(
  brokerageId: string,
  tierId: string,
  billingCycle: "monthly" | "annual"
) {
  const supabase = await createClient()

  // Get the tier
  const { data: tier, error: tierError } = await supabase
    .from("subscription_tiers")
    .select("*")
    .eq("id", tierId)
    .single()

  if (tierError || !tier) throw new Error("Tier not found")

  // Get brokerage info for customer
  const { data: brokerage, error: brokerageError } = await supabase
    .from("brokerages")
    .select("name, email")
    .eq("id", brokerageId)
    .single()

  if (brokerageError || !brokerage) throw new Error("Brokerage not found")

  // Check if brokerage already has a Stripe customer
  const { data: existingSub } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("brokerage_id", brokerageId)
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle()

  let customerId = existingSub?.stripe_customer_id

  // Create customer if not exists
  if (!customerId) {
    const { stripe } = await import("@/lib/stripe")
    const customer = await stripe.customers.create({
      email: brokerage.email || undefined,
      name: brokerage.name,
      metadata: {
        brokerage_id: brokerageId,
      },
    })
    customerId = customer.id
  }

  const priceInCents = billingCycle === "annual" 
    ? tier.annual_price_cents 
    : tier.monthly_price_cents

  const { stripe } = await import("@/lib/stripe")
  const { headers } = await import("next/headers")
  const headersList = await headers()
  const origin = headersList.get("origin") || "http://localhost:3000"

  // Create checkout session for subscription
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    ui_mode: "embedded",
    mode: "subscription",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: tier.display_name,
            description: `${tier.tier_name} plan - ${billingCycle} billing`,
          },
          unit_amount: priceInCents,
          recurring: {
            interval: billingCycle === "annual" ? "year" : "month",
          },
        },
        quantity: 1,
      },
    ],
    subscription_data: {
      metadata: {
        brokerage_id: brokerageId,
        tier_id: tierId,
        tier_name: tier.tier_name,
      },
    },
    redirect_on_completion: "never",
  })

  return session.client_secret
}

// ─── CANCEL SUBSCRIPTION ─────────────────────────────────────────────────────
export async function cancelSubscription(subscriptionId: string) {
  const supabase = await createClient()

  // Get the subscription
  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select("stripe_subscription_id")
    .eq("id", subscriptionId)
    .single()

  if (error || !subscription?.stripe_subscription_id) {
    throw new Error("Subscription not found")
  }

  // Cancel at period end in Stripe
  const { stripe } = await import("@/lib/stripe")
  await stripe.subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true,
  })

  // Update local record
  const { error: updateError } = await supabase
    .from("subscriptions")
    .update({
      cancel_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId)

  if (updateError) throw updateError

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/billing")

  return { success: true }
}

// ─── GET ALL BROKERAGES BILLING (ADMIN) ──────────────────────────────────────
export async function getAllBrokeragesBilling() {
  const supabase = await createClient()

  const { data: brokerages, error } = await supabase
    .from("brokerages")
    .select(`
      id,
      name,
      subscriptions:subscriptions(
        id,
        status,
        current_period_end,
        stripe_subscription_id,
        subscription_tiers:tier_id(tier_name, display_name, monthly_price_cents)
      )
    `)
    .order("name", { ascending: true })

  if (error) throw error
  return brokerages || []
}

// ─── GET DELINQUENT ACCOUNTS (ADMIN) ─────────────────────────────────────────
export async function getDelinquentAccounts() {
  const supabase = await createClient()

  const { data: delinquent, error } = await supabase
    .from("subscriptions")
    .select(`
      id,
      brokerage_id,
      status,
      current_period_end,
      brokerages:brokerage_id(id, name, email),
      subscription_tiers:tier_id(tier_name, display_name)
    `)
    .eq("status", "past_due")
    .order("current_period_end", { ascending: true })

  if (error) throw error
  return delinquent || []
}

// ─── MANUAL TIER OVERRIDE (SUPERADMIN) ───────────────────────────────────────
export async function manualTierOverride(
  subscriptionId: string,
  newTierId: string,
  reason: string
) {
  const supabase = await createClient()

  // Verify user is superadmin
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (profile?.role !== "superadmin") {
    throw new Error("Unauthorized: superadmin only")
  }

  // Update subscription tier
  const { error } = await supabase
    .from("subscriptions")
    .update({
      tier_id: newTierId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId)

  if (error) throw error

  // Log the override in audit_log
  await supabase.from("audit_log").insert({
    user_id: user.id,
    action: "manual_tier_override",
    entity_type: "subscription",
    entity_id: subscriptionId,
    after: { tier_id: newTierId, reason },
  })

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/admin/billing")

  return { success: true }
}
