"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { auditStaffAction, gateStaffAction } from "@/lib/platform/staff-action-gate"
import { provisionTenantOwner } from "@/lib/kernel/users"
import { rollbackTenantCreation } from "@/lib/kernel/tenant-creation-rollback"
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
  // GATE PARITY (round 19). This used to demand a literal 'superadmin' read off
  // `platform_role ?? user_type ?? role` — including the RETIRED users.role
  // column. Its only caller, manualProvisionSubscriberAction, gates on the
  // 'tenants' platform capability instead, so a platform admin / support staffer
  // passed the outer door and was then refused by this inner one: the documented
  // "platform admin staff provision subscribers too" policy did not actually
  // work. Both doors now consult the SAME capability through the canonical gate.
  const gate = await gateStaffAction("tenants")
  if (!gate.ok) return { success: false, error: gate.error }
  const callerUser = { id: gate.userId }

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
      // ROLL BACK THE HALF-BUILT TENANT — children first, and READ the answer.
      // The bare `.delete()` this replaces did neither: `users.brokerage_id` is
      // ON DELETE SET NULL, so it left a live user belonging to no tenant, and
      // supabase-js RESOLVES a refused delete (CLAUDE.md §3), so a blocked
      // rollback reported only the provisioning failure. See
      // lib/kernel/tenant-creation-rollback.ts for the measured delete-rule
      // census behind this.
      const rollback = await rollbackTenantCreation(service, brokerageId)
      if (!rollback.ok) {
        console.error("[createSubscriber] tenant rollback incomplete:", rollback.error)
        return {
          success: false,
          error: `Owner provisioning failed: ${owner.error}. ${rollback.error}`,
        }
      }
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

    // PROSPECT CONVERSION STAMP — if this subscriber was a platform_prospect
    // (any capture channel: web hand-raise, /demo, phone reception, referral,
    // OS-intent sourcing), record the conversion moment: converted_brokerage_id
    // + status 'converted' (this path creates an ACTIVE subscription — a paying
    // tenant, unlike the self-serve trial). Matches by admin + brokerage email
    // and by the brokerage phone (the reception's caller-ID key). Counted +
    // idempotent (lib/platform/prospect-conversion.ts); best-effort — a
    // stamping problem must never cost the provisioning, but the loss is logged.
    try {
      const { stampProspectConversion } = await import("@/lib/platform/prospect-conversion")
      const stamp = await stampProspectConversion(service, {
        brokerageId,
        emails: [params.adminEmail, params.brokerageEmail],
        phone: params.brokeragePhone ?? null,
        outcome: "converted",
      })
      if (stamp.errors.length > 0) {
        console.warn("[createSubscriber] prospect conversion stamp incomplete:", stamp.errors.join("; "), { matched: stamp.matched, linked: stamp.linked })
      }
    } catch (err) { console.warn("[createSubscriber] prospect conversion stamp failed (non-fatal):", (err as any)?.message) }

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

/**
 * RESEND the tenant-owner magic link for a subscriber whose original invite did
 * not land (`createSubscriber` returns `inviteSent:false` + `inviteError` when
 * that happens — provisionTenantOwner tolerates an "already registered" address
 * and still finishes the tenant).
 *
 * This does NOT invent an owner. It re-sends to an address that ALREADY holds a
 * users row on that brokerage — see the target check below. Without that check
 * the endpoint was a superadmin-gated primitive for mailing an
 * `user_type:'admin'` invite for ANY brokerage_id to ANY address, which is a
 * tenant-takeover shape rather than a retry.
 */
export async function retrySubscriberInvite(params: {
  adminEmail: string
  brokerageId: string
}): Promise<{ success: boolean; error?: string }> {
  // Platform-staff gate, same capability as the provisioning door it retries for
  // ('tenants'). Previously this was wide open and let any client send Supabase
  // invite emails to any address attached to any brokerage_id; then it was hard
  // superadmin, which locked out the platform admins who provision tenants.
  const gate = await gateStaffAction("tenants")
  if (!gate.ok) return { success: false, error: gate.error }

  const email = params.adminEmail.trim().toLowerCase()
  if (!email || !params.brokerageId) {
    return { success: false, error: "adminEmail and brokerageId are both required" }
  }

  const service = createServiceClient()

  // TARGET CHECK — the address must already be a user of THIS brokerage. That is
  // exactly the state createSubscriber leaves behind (provisionTenantOwner step 3
  // upserts the users row with user_type='admin' + brokerage_id before it ever
  // reports inviteSent:false), so every legitimate retry passes, while
  // "mail an admin invite for someone else's tenant" no longer does.
  const { data: target, error: targetErr } = await service
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("email", email)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (targetErr) return { success: false, error: `Could not verify the invitee: ${targetErr.message}` }
  if (!target) {
    return {
      success: false,
      error: "No user with that email belongs to that brokerage — provision the subscriber first instead of resending an invite.",
    }
  }

  // supabase-js RESOLVES a refused invite with { error } — it does not throw, so
  // the old bare try/catch returned {success:true} for sends that never happened.
  try {
    const { error: sendErr } = await service.auth.admin.inviteUserByEmail(email, {
      data: {
        brokerage_id: params.brokerageId,
        user_type: (target.user_type as string | null) ?? "admin",
      },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
    })
    if (sendErr) return { success: false, error: sendErr.message }
    // A staff member mailing a tenant-owner magic link is a cross-tenant act;
    // it belongs in the same audit trail as the provisioning that preceded it.
    await auditStaffAction(gate, "subscriber.invite.resent", params.brokerageId, {
      admin_email: email,
      user_type: (target.user_type as string | null) ?? "admin",
    })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Unknown error" }
  }
}
