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
  inviteSent?: boolean
  inviteError?: string
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user: callerUser },
  } = await supabase.auth.getUser()
  if (!callerUser) return { success: false, error: "Unauthenticated" }

  const { data: callerProfile } = await supabase
    .from("users")
    .select("user_type, role, platform_role")
    .eq("id", callerUser.id)
    .single()

  // Accept superadmin via any of the three role columns
  const callerType =
    callerProfile?.platform_role ?? callerProfile?.user_type ?? callerProfile?.role
  if (callerType !== "superadmin") {
    return { success: false, error: "Forbidden: superadmin only" }
  }

  const service = createServiceClient()

  // The provisioned user is always the billing admin for the new brokerage.
  // Tier-specific roles (agent, team_lead) are assigned after onboarding.
  const adminUserType = "admin"

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

    // Step 2b: Seed agent_onboarding row so first-login lands in onboarding flow
    await service
      .from("agent_onboarding")
      .insert({
        agent_id: userId,
        user_id: userId,
        brokerage_id: brokerageId,
        status: "not_started",
        current_day: 1,
        start_date: new Date().toISOString().split("T")[0],
        completion_percentage: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .catch(() => {
        // Non-fatal: onboarding record will be created on first login if missing
      })

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

    // Step 6: Send invite email via Supabase auth — non-fatal, but result is surfaced
    let inviteSucceeded = false
    let inviteErrorMessage: string | null = null

    try {
      await service.auth.admin.inviteUserByEmail(params.adminEmail, {
        data: {
          first_name: params.adminFirstName,
          last_name: params.adminLastName,
          brokerage_id: brokerageId,
          user_type: adminUserType,
        },
        // /auth/callback handles PKCE exchange; `next` tells it where to land
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
      })
      inviteSucceeded = true
    } catch (inviteErr: any) {
      console.warn("[createSubscriber] Invite email failed:", inviteErr.message)
      inviteErrorMessage = inviteErr.message ?? "Unknown invite error"
    }

    return {
      success: true,
      brokerageId,
      userId,
      subscriptionId: subscription.id,
      inviteSent: inviteSucceeded,
      inviteError: inviteErrorMessage ?? undefined,
    }
  } catch (err: any) {
    console.error("[createSubscriber] Error:", err)
    return { success: false, error: err.message || "Unexpected error" }
  }
}

export async function retrySubscriberInvite(params: {
  adminEmail: string
  brokerageId: string
}): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  try {
    await service.auth.admin.inviteUserByEmail(params.adminEmail, {
      data: {
        brokerage_id: params.brokerageId,
        user_type: "admin",
      },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
    })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Unknown error" }
  }
}
