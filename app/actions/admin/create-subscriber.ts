"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { auditStaffAction, gateStaffAction } from "@/lib/platform/staff-action-gate"
import { createTenantCore } from "@/lib/kernel/tenant-creation"
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
  /** Explicit config snapshot to provision from (staff-picked — the caller gates +
   *  pre-validates the id). When OMITTED, the tier's live funnel snapshot applies
   *  (snapshotForTier — the same server-side resolution the self-serve signup
   *  uses), so EVERY provisioned tenant snapshots at creation (owner ruling:
   *  "when the platform prospect is converted, the account should also create
   *  the account with a snapshot"). Best-effort — never fails the provisioning. */
  snapshotId?: string
}

/**
 * Staff-provisioned subscriber (an ACTIVE subscription, not a trial).
 *
 * TOMBSTONE (lane 77B): the brokerages insert, provisionTenantOwner + rollback,
 * subscription row, snapshot apply and prospect conversion stamp that stood
 * here were the SECOND spelling of tenant creation (the first:
 * app/actions/auth/signup-brokerage.ts). SURVIVOR:
 * lib/kernel/tenant-creation.ts::createTenantCore. What stays here is this
 * door's own: the platform-staff gate, the Stripe customer on the PLATFORM
 * account (the platform is the merchant for a tenant's subscription —
 * lib/billing/stripe-account-scope.ts) and the audited activity line.
 * Delegating also gave this door what only the self-serve one had: the
 * duplicate-owner guard, the tenant's AI-ISA actor, the starter assistant,
 * the SUBSCRIPTION_CREATED lifecycle event and the onboarding library.
 */
export async function createSubscriber(params: CreateSubscriberParams): Promise<{
  success: boolean
  brokerageId?: string
  userId?: string
  subscriptionId?: string
  inviteSent?: boolean
  inviteError?: string
  error?: string
  /** Config-snapshot outcome — honest per-part reporting (same shape as signupBrokerageAction). */
  snapshotApplied?: string[]
  snapshotName?: string
  snapshotError?: string
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
    // THE ONE CORE — brokerage (plan_tier set so fair-use applies on day one),
    // owner (invite-first, id pinned, tier-aware, counted rollback), the ACTIVE
    // subscription row for the chosen cycle, the staff-picked snapshot or the
    // tier default, and the prospect link-back by admin + brokerage email and
    // the brokerage phone (the reception's caller-ID key) with outcome
    // 'converted' — an active subscription is a paying tenant.
    const created = await createTenantCore(service, {
      brokerageName: params.brokerageName,
      adminEmail: params.adminEmail,
      adminFirstName: params.adminFirstName,
      adminLastName: params.adminLastName,
      tier: params.tierName,
      tierId: params.tierId,
      brokerageEmail: params.brokerageEmail,
      brokeragePhone: params.brokeragePhone ?? null,
      city: params.brokerageCity ?? null,
      state: params.brokerageState ?? null,
      signupSource: "superadmin",
      billing: { mode: "active", billingCycle: params.billingCycle, stripeCustomerId: params.stripeCustomerId ?? null },
      snapshotId: params.snapshotId ?? null,
      callerUserId: callerUser.id,
    })
    if (!created.ok || !created.brokerageId || !created.userId) {
      return { success: false, error: created.error ?? "Tenant creation failed" }
    }
    const brokerageId = created.brokerageId
    const userId = created.userId
    const subscriptionId = created.subscriptionId ?? null

    // Stripe customer — the platform is the payee for a tenant's subscription
    // (lib/billing/stripe-account-scope.ts roster: platform_payee). Created
    // AFTER the tenant exists so its metadata carries the real brokerage_id,
    // then written onto the subscription row (counted — a row that did not
    // match is reported, never assumed).
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
        if (subscriptionId) {
          const { data: linked, error: linkErr } = await service
            .from("subscriptions")
            .update({ stripe_customer_id: stripeCustomerId, updated_at: new Date().toISOString() })
            .eq("id", subscriptionId)
            .select("id")
          if (linkErr) console.warn("[createSubscriber] stripe_customer_id write refused:", linkErr.message)
          else if ((linked ?? []).length !== 1) console.warn("[createSubscriber] stripe_customer_id matched no subscription row:", subscriptionId)
        }
      } catch (stripeErr: any) {
        console.warn("[createSubscriber] Stripe customer creation failed:", stripeErr.message)
      }
    }

    // Audit log — activities has no metadata column; use notes as JSON string
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
            subscription_id: subscriptionId,
            subscription_error: created.subscriptionError ?? null,
            stripe_customer_id: stripeCustomerId,
            notes: params.notes || "",
            // Config-snapshot-at-creation outcome — honest either way.
            snapshot_id: params.snapshotId ?? null,
            snapshot_name: created.snapshotName ?? null,
            snapshot_applied: created.snapshotApplied ?? null,
            snapshot_error: created.snapshotError ?? null,
            prospect_linked: created.prospectStamp?.linked ?? 0,
            extras_skipped: created.extrasSkipped,
            timestamp: new Date().toISOString(),
          }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
      if (auditErr) console.error("[create-subscriber] audit log insert failed:", auditErr.message)
    } catch {
      // Non-fatal: audit log failures don't block subscriber creation
    }

    // (The magic-link invite was sent by provisionTenantOwner inside the core.)
    return {
      success: true,
      brokerageId,
      userId,
      subscriptionId: subscriptionId ?? undefined,
      inviteSent: created.inviteSent,
      inviteError: created.inviteError,
      snapshotApplied: created.snapshotApplied,
      snapshotName: created.snapshotName ?? undefined,
      snapshotError: created.snapshotError,
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
