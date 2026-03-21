"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { stripe } from "@/lib/stripe"

export interface CreateSubscriberParams {
  brokerageName: string
  brokerageCity?: string
  brokerageState?: string
  brokerageEmail: string
  brokeragePhone?: string
  adminFirstName: string
  adminLastName: string
  adminEmail: string
  tierId: string
  tierName: "solo_agent" | "team" | "brokerage" | "multi_location"
  billingCycle: "monthly" | "annual"
  notes?: string
  stripeCustomerId?: string
}

export async function createSubscriber(params: CreateSubscriberParams): Promise<{
  success: boolean
  brokerageId?: string
  userId?: string
  subscriptionId?: string
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user: callerUser },
  } = await supabase.auth.getUser()
  if (!callerUser) return { success: false, error: "Unauthenticated" }

  const { data: callerProfile } = await supabase
    .from("users")
    .select("user_type, role")
    .eq("id", callerUser.id)
    .single()

  const callerType = callerProfile?.user_type ?? callerProfile?.role
  if (callerType !== "superadmin") {
    return { success: false, error: "Forbidden: superadmin only" }
  }

  const service = createServiceClient()

  const TIER_USER_TYPE: Record<string, string> = {
    solo_agent: "agent",
    team: "team_lead",
    brokerage: "admin",
    multi_location: "admin",
  }
  const adminUserType = TIER_USER_TYPE[params.tierName] || "admin"

  try {
    // Step 1: Create brokerage — only insert columns that exist in schema
    const { data: brokerage, error: bErr } = await service
      .from("brokerages")
      .insert({
        name: params.brokerageName,
        email: params.brokerageEmail,
        phone: params.brokeragePhone || null,
        city: params.brokerageCity || null,
        state: params.brokerageState || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (bErr || !brokerage) {
      return { success: false, error: `Brokerage creation failed: ${bErr?.message}` }
    }

    const brokerageId = brokerage.id

    // Step 2: Create admin user record
    const { data: newUser, error: uErr } = await service
      .from("users")
      .insert({
        email: params.adminEmail,
        first_name: params.adminFirstName,
        last_name: params.adminLastName,
        user_type: adminUserType,
        role: adminUserType,
        brokerage_id: brokerageId,
        is_contact: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (uErr || !newUser) {
      await service.from("brokerages").delete().eq("id", brokerageId)
      return { success: false, error: `User creation failed: ${uErr?.message}` }
    }

    const userId = newUser.id

    // Step 3: Create Stripe customer
    let stripeCustomerId = params.stripeCustomerId || null
    if (!stripeCustomerId) {
      try {
        const customer = await stripe.customers.create({
          name: `${params.adminFirstName} ${params.adminLastName}`,
          email: params.adminEmail,
          metadata: {
            brokerage_id: brokerageId,
            brokerage_name: params.brokerageName,
            tier: params.tierName,
            created_by: callerUser.id,
          },
        })
        stripeCustomerId = customer.id
      } catch (stripeErr: any) {
        console.warn("[createSubscriber] Stripe customer creation failed:", stripeErr.message)
      }
    }

    // Step 4: Create subscription record — no billing_cycle column in schema
    const periodEnd =
      params.billingCycle === "annual"
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: subscription, error: sErr } = await service
      .from("subscriptions")
      .insert({
        brokerage_id: brokerageId,
        tier_id: params.tierId,
        status: "active",
        stripe_customer_id: stripeCustomerId,
        current_period_start: new Date().toISOString(),
        current_period_end: periodEnd,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (sErr || !subscription) {
      return { success: false, error: `Subscription creation failed: ${sErr?.message}` }
    }

    // Step 5: Audit log — activities has no metadata column; use notes as JSON string
    await service
      .from("activities")
      .insert({
        activity_type: "superadmin.subscriber.created",
        agent_id: callerUser.id,
        brokerage_id: brokerageId,
        title: `New subscriber provisioned: ${params.brokerageName}`,
        notes: JSON.stringify({
          admin_email: params.adminEmail,
          tier: params.tierName,
          billing_cycle: params.billingCycle,
          subscription_id: subscription.id,
          notes: params.notes || "",
          timestamp: new Date().toISOString(),
        }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .catch(() => {})

    // Step 6: Send invite email via Supabase auth — non-fatal
    try {
      await service.auth.admin.inviteUserByEmail(params.adminEmail, {
        data: {
          first_name: params.adminFirstName,
          last_name: params.adminLastName,
          brokerage_id: brokerageId,
          user_type: adminUserType,
        },
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/onboarding`,
      })
    } catch (inviteErr: any) {
      console.warn("[createSubscriber] Invite email failed:", inviteErr.message)
    }

    return {
      success: true,
      brokerageId,
      userId,
      subscriptionId: subscription.id,
    }
  } catch (err: any) {
    console.error("[createSubscriber] Error:", err)
    return { success: false, error: err.message || "Unexpected error" }
  }
}
