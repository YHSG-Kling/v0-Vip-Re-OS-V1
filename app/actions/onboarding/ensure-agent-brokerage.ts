"use server"

/**
 * Self-heal: give a brokerage-LESS agent a personal "brokerage-of-one".
 *
 * The whole OS anchors on a brokerage — connections, transactions, ISA calling,
 * onboarding, financials all gate on brokerage_id (see lib/connections/
 * field-spec.isConnectSupported "Requires a brokerage…"). A self-serve solo
 * signup already gets one (signupBrokerageAction provisions a solo_agent
 * brokerage), but an agent who arrived through a path that skipped it — a legacy
 * seed, an aborted invite, a hand-created row — is permanently walled out of
 * every gated surface. This heals that: the agent gets their own solo brokerage
 * the same shape a fresh solo signup produces, so no legitimate agent is ever
 * left brokerage-less.
 *
 * TOMBSTONE (wave 140, lane 140C — subscriber convergence): the brokerages
 * insert, the hand-built slug (never checked for uniqueness), the subscriptions
 * row (written WITHOUT trial_end, which lib/billing/billing-access.ts reads as a
 * trial that never ends), the snapshot apply and the domain-record call that
 * stood here were the FOURTH spelling of tenant creation — and the only one
 * with no AI-ISA actor, no starter assistant, no SUBSCRIPTION_CREATED, no
 * onboarding library, no evidence and no provisioning record. SURVIVOR:
 * lib/kernel/tenant-creation.ts::createTenantCore, entered through
 * `adoptExistingOwner` (the signed-in user is anchored to the minted tenant and
 * gets tier-aware domain records with their REAL user_type — never re-typed
 * admin, never re-invited). What stays here is this door's own: the session
 * identity, the owner-role check, the pending-invite guard and the
 * anchored-but-incomplete repair.
 *
 * SAFETY:
 *   - Only agent / team_lead owners self-provision. Staff / vendor / contact get
 *     their brokerage from their org or an invite — never a solo tenant here.
 *   - Pending-invite guard: an agent invited to an existing brokerage must JOIN
 *     it; we never create a solo brokerage while an invitation is open (that
 *     would split them off their intended tenant).
 *   - Idempotent: an already-anchored user is a no-op (and a half-provisioned
 *     tenant of theirs is RESUMED by the core, never duplicated).
 *   - Reuses createOrRepairUserDomainRecords for the agents/commission/
 *     onboarding/RBAC rows, so there is zero drift from the signup path.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { createOrRepairUserDomainRecords } from "@/lib/kernel/users"
import { createTenantCore } from "@/lib/kernel/tenant-creation"

const SOLO_TRIAL_DAYS = 14

export interface EnsureAgentBrokerageResult {
  ok: boolean
  brokerageId?: string
  created?: boolean
  error?: string
}

export async function ensureAgentBrokerage(): Promise<EnsureAgentBrokerageResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const svc = createServiceClient()
  const { data: u } = await svc
    .from("users")
    .select("id, email, first_name, last_name, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u) return { ok: false, error: "User not found" }

  // Already anchored to a brokerage — but "anchored" is not the same as "complete".
  // A user can carry a brokerage_id and still be MISSING their agents row (a legacy seed, a
  // partially-applied invite, a hand-created row). That is the account state behind the
  // "agent profile not found" / "no agent record found for your account" bounces in the live
  // walkthrough, and returning early here left it permanently unhealed. Repair the domain
  // records in place instead — createOrRepairUserDomainRecords is idempotent and is the SAME
  // path signup and login-time repair use, so there is no drift.
  if (u.brokerage_id) {
    const brokerageId = u.brokerage_id as string
    if (["agent", "team_lead"].includes(String(u.user_type))) {
      const { data: existingAgent } = await svc
        .from("agents")
        .select("id")
        .eq("user_id", u.id)
        .maybeSingle()
      if (!existingAgent) {
        const { data: brk } = await svc
          .from("brokerages")
          .select("plan_tier")
          .eq("id", brokerageId)
          .maybeSingle()
        await createOrRepairUserDomainRecords({
          userId: u.id,
          userType: u.user_type,
          brokerageId,
          teamId: null,
          tier: (brk?.plan_tier as string) ?? "solo_agent",
          callerUserId: u.id,
        } as any)
      }
    }
    return { ok: true, brokerageId, created: false }
  }

  // Only agent / team_lead OWNERS get a personal brokerage-of-one.
  if (!["agent", "team_lead"].includes(String(u.user_type))) {
    return { ok: false, error: "Only agents can self-provision a personal brokerage." }
  }

  // Pending-invite guard — an invited agent must accept + join, not fork off.
  const email = String(u.email ?? "").toLowerCase()
  if (email) {
    // NOTE: use limit(1)+array, not maybeSingle(). maybeSingle() ERRORS (data=null)
    // when a user has MORE than one pending invitation — which would silently bypass
    // this guard and fork them off their intended tenant. Any pending row blocks.
    const { data: pending } = await svc
      .from("user_invitations")
      .select("id")
      .eq("email", email)
      .eq("status", "pending")
      .limit(1)
    if (pending && pending.length > 0) return { ok: false, error: "A brokerage invitation is pending — accept it to join, instead of creating a solo account." }
  }

  // THE ONE CORE — the same sequence a solo self-serve signup gets (unique
  // slug'd website, trialing subscription WITH trial_end, the solo_agent
  // funnel snapshot, ISA actor, starter assistant, SUBSCRIPTION_CREATED,
  // onboarding library, operating baseline, ledger evidence, provisioning
  // record), with THIS signed-in user adopted as the owner. The tenant comes
  // from the session's own users row — nothing here arrives in a request body.
  const displayName = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || (email ? email.split("@")[0] : "Agent")
  const created = await createTenantCore(svc, {
    brokerageName: `${displayName}'s Brokerage`,
    adminEmail: email,
    adminFirstName: String(u.first_name ?? "") || displayName,
    adminLastName: String(u.last_name ?? ""),
    tier: "solo_agent",
    brokerageOnPlatform: false,
    teamOnPlatform: false,
    // signup_source is CHECK-constrained to self_serve/superadmin/partner/import;
    // this is a self-serve provision (auto-triggered), so 'self_serve' is correct.
    signupSource: "self_serve",
    billing: { mode: "trial", trialDays: SOLO_TRIAL_DAYS },
    callerUserId: u.id,
    adoptExistingOwner: { userId: u.id as string, userType: String(u.user_type) },
  })
  if (!created.ok || !created.brokerageId) return { ok: false, error: created.error ?? "Brokerage creation failed" }
  return { ok: true, brokerageId: created.brokerageId, created: !created.resumed }
}
