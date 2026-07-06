"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"

const BILLING_ADMIN_ROLES = new Set(["admin", "broker", "broker_owner", "superadmin", "super_admin"])

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
export async function getCurrentSubscription(_brokerageId?: string) {
  // AUTH GATE — was returning any brokerage's subscription by id.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return null
  }

  const supabase = await createClient()

  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select(`
      *,
      subscription_tiers:tier_id(*)
    `)
    .eq("brokerage_id", ctx.brokerageId)
    .in("status", ["active", "trialing", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return subscription
}

// ─── GET BILLING USAGE ───────────────────────────────────────────────────────
export async function getBillingUsage(_brokerageId?: string) {
  // AUTH GATE — was returning any brokerage's billing usage.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return null
  const supabase = await createClient()

  const { data: usage, error } = await supabase
    .from("billing_usage")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return usage
}

// ─── GET INVOICE HISTORY ─────────────────────────────────────────────────────
export async function getInvoiceHistory(_brokerageId?: string, year?: number) {
  // AUTH GATE — was returning any brokerage's invoice history (PII +
  // financial data).
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []
  const supabase = await createClient()

  let query = supabase
    .from("billing_invoices")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
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
  _brokerageId: string, // ignored — derived from session
  tierId: string,
  billingCycle: "monthly" | "annual"
) {
  // AUTH GATE — was creating Stripe checkout sessions on any brokerage id,
  // letting a caller initiate paid subscription changes for tenants they
  // don't belong to. Now scoped to caller's brokerage + admin role only.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    throw new Error("Unauthorized")
  }

  const supabase = await createClient()

  const { data: u } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", ctx.userId)
    .maybeSingle()
  const userType = u?.user_type ?? ctx.userType
  if (!BILLING_ADMIN_ROLES.has(userType)) {
    throw new Error("Forbidden: admin only")
  }

  const brokerageId = ctx.brokerageId

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

  const { stripe } = await import("@/lib/stripe")

  // Collect the recurring plan + a one-time SETUP FEE on the first invoice.
  const { buildCheckoutConfig } = await import("@/lib/billing/subscription-activation")
  const { lineItems, addInvoiceItems } = buildCheckoutConfig(tier as any, billingCycle)

  // Create checkout session for subscription
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    ui_mode: "embedded",
    mode: "subscription",
    line_items: lineItems as any,
    subscription_data: {
      // add_invoice_items charges the one-time setup fee on the first invoice only.
      ...(addInvoiceItems.length > 0 ? { add_invoice_items: addInvoiceItems as any } : {}),
      metadata: {
        brokerage_id: brokerageId,
        tier_id: tierId,
        tier_name: tier.tier_name,
      },
    },
    // Also stamp the session so checkout.session.completed can resolve the tenant.
    metadata: { brokerage_id: brokerageId, tier_id: tierId, tier_name: tier.tier_name },
    redirect_on_completion: "never",
  })

  return session.client_secret
}

// ─── CANCEL SUBSCRIPTION ─────────────────────────────────────────────────────
export async function cancelSubscription(subscriptionId: string) {
  // CRITICAL: was previously open — any caller could cancel any
  // brokerage's Stripe subscription by passing its id. Require admin
  // role + verify the subscription belongs to caller's brokerage.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) throw new Error("Unauthorized")
  const supabase = await createClient()
  const { data: u } = await supabase
    .from("users").select("user_type").eq("id", ctx.userId).maybeSingle()
  if (!BILLING_ADMIN_ROLES.has(u?.user_type ?? ctx.userType)) {
    throw new Error("Forbidden: billing admin only")
  }

  // Get the subscription — scoped to caller's brokerage
  const { data: subscription, error } = await supabase
    .from("subscriptions")
    .select("stripe_subscription_id, brokerage_id")
    .eq("id", subscriptionId)
    .eq("brokerage_id", ctx.brokerageId)
    .single()

  if (error || !subscription?.stripe_subscription_id) {
    throw new Error("Subscription not found")
  }

  // Cancel at period end in Stripe
  const { stripe } = await import("@/lib/stripe")
  await stripe.subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true,
  })

  // Update local record — scoped
  const { error: updateError } = await supabase
    .from("subscriptions")
    .update({
      cancel_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId)
    .eq("brokerage_id", ctx.brokerageId)

  if (updateError) throw updateError

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/settings/billing")

  return { success: true }
}

// ─── GET ALL BROKERAGES BILLING (SUPERADMIN) ─────────────────────────────────
export async function getAllBrokeragesBilling() {
  // SUPERADMIN gate — cross-tenant aggregate. Previously open.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return []
  const supabase = await createClient()
  const { data: u } = await supabase
    .from("users").select("user_type, role").eq("id", ctx.userId).maybeSingle()
  if (!["superadmin", "super_admin"].includes(u?.user_type ?? u?.role ?? "")) {
    return []
  }

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

// ─── GET DELINQUENT ACCOUNTS (SUPERADMIN) ────────────────────────────────────
export async function getDelinquentAccounts() {
  // SUPERADMIN gate — cross-tenant financial data.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return []
  const supabase = await createClient()
  const { data: u } = await supabase
    .from("users").select("user_type, role").eq("id", ctx.userId).maybeSingle()
  if (!["superadmin", "super_admin"].includes(u?.user_type ?? u?.role ?? "")) {
    return []
  }

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
    .select("user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()

  if (profile?.user_type !== "superadmin" && profile?.platform_role !== "superadmin") {
    throw new Error("Unauthorized: superadmin only")
  }

  // Look up the brokerage_id BEFORE updating so we can sync plan_tier after.
  const { data: subRow } = await supabase
    .from("subscriptions")
    .select("brokerage_id")
    .eq("id", subscriptionId)
    .maybeSingle()

  // Update subscription tier
  const { error } = await supabase
    .from("subscriptions")
    .update({
      tier_id: newTierId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId)

  if (error) throw error

  // Sync brokerages.plan_tier so cap-enforcement reflects the new tier
  // immediately. Without this, checkUsageCap would still gate on the old
  // tier's limits until the next Stripe webhook fires.
  if (subRow?.brokerage_id) {
    const { syncBrokeragePlanTier } = await import("@/lib/billing/sync-plan-tier")
    await syncBrokeragePlanTier(subRow.brokerage_id)
  }

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
