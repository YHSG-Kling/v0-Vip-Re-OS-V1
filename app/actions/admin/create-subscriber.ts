"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { provisionTenantOwner } from "@/lib/kernel/users"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
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

  try {
    // Step 1: Create brokerage — set plan_tier so fair-use enforcement
    // (lib/ai/fair-use.ts via brokerages.plan_tier → plan_limits) immediately
    // applies the correct monthly AI token ceiling. Without this the new
    // brokerage falls back to NULL → solo_agent default, which silently
    // under-caps team / brokerage / multi_location tiers.
    const { data: brokerage, error: bErr } = await service
      .from("brokerages")
      .insert({
        name: params.brokerageName,
        email: params.brokerageEmail,
        phone: params.brokeragePhone || null,
        city: params.brokerageCity || null,
        state: params.brokerageState || null,
        plan_tier: params.tierName,
        signup_source: "superadmin",
        onboarding_status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (bErr || !brokerage) {
      return { success: false, error: `Brokerage creation failed: ${bErr?.message}` }
    }

    const brokerageId = brokerage.id

    // Step 2: Provision the tenant OWNER through the canonical identity path —
    // creates the auth user FIRST (so public.users.id === auth.users.id, the
    // invariant every read path + RLS policy depends on), pins/enriches the users
    // row, creates the teams row for a team tenant, and — tier-aware — gives a
    // solo/team owner their agents row (+ commission + onboarding + role
    // assignment). Sends the magic-link invite. Replaces the old pre-insert that
    // collided with the on_auth_user_created trigger and orphaned the profile.
    const owner = await provisionTenantOwner({
      email:         params.adminEmail,
      firstName:     params.adminFirstName,
      lastName:      params.adminLastName,
      brokerageId,
      brokerageName: params.brokerageName,
      tier:          params.tierName,
      redirectTo:    `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
      callerUserId:  callerUser.id,
    })
    if (!owner.success || !owner.userId) {
      await service.from("brokerages").delete().eq("id", brokerageId)
      return { success: false, error: `Owner provisioning failed: ${owner.error}` }
    }
    const userId = owner.userId

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
    //
    // IDENTITY CLASS. activities.agent_id FKs agents(id); callerUser.id is a
    // users id, so this insert was rejected by the foreign key — and the catch
    // below discarded the rejection. The audit line for provisioning a new
    // subscriber was never once written. The caller here is a superadmin, who
    // legitimately may have no agents row at all, so the column (nullable) gets
    // null in that case and the actor is recorded in the notes payload instead —
    // an audit entry that names its actor beats one that does not exist.
    const callerAgentId = await resolveAgentId(service as any, callerUser.id)
    try {
      const { error: auditErr } = await service
        .from("activities")
        .insert({
          activity_type: "superadmin.subscriber.created",
          agent_id: callerAgentId,
          brokerage_id: brokerageId,
          title: `New subscriber provisioned: ${params.brokerageName}`,
          notes: JSON.stringify({
            actor_user_id: callerUser.id,
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
      if (auditErr) console.error("[create-subscriber] audit log insert failed:", auditErr.message)
    } catch {
      // Non-fatal: audit log failures don't block subscriber creation
    }

    // (The magic-link invite was sent by provisionTenantOwner in Step 2.)
    return {
      success: true,
      brokerageId,
      userId,
      subscriptionId: subscription.id,
      inviteSent: owner.inviteSent,
      inviteError: owner.inviteError,
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
  // Superadmin-only — previously this was wide open and let any client
  // send Supabase invite emails to any address attached to any brokerage_id.
  const supabase = await createClient()
  const { data: { user: callerUser } } = await supabase.auth.getUser()
  if (!callerUser) return { success: false, error: "Unauthenticated" }

  const { data: callerProfile } = await supabase
    .from("users")
    .select("user_type, role, platform_role")
    .eq("id", callerUser.id)
    .single()

  const callerType =
    callerProfile?.platform_role ?? callerProfile?.user_type ?? callerProfile?.role
  if (callerType !== "superadmin") {
    return { success: false, error: "Forbidden: superadmin only" }
  }

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
