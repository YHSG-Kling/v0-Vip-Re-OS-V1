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
 * SAFETY:
 *   - Only agent / team_lead owners self-provision. Staff / vendor / contact get
 *     their brokerage from their org or an invite — never a solo tenant here.
 *   - Pending-invite guard: an agent invited to an existing brokerage must JOIN
 *     it; we never create a solo brokerage while an invitation is open (that
 *     would split them off their intended tenant).
 *   - Idempotent: an already-anchored user is a no-op.
 *   - Reuses createOrRepairUserDomainRecords for the agents/commission/
 *     onboarding/RBAC rows, so there is zero drift from the signup path.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { createOrRepairUserDomainRecords } from "@/lib/kernel/users"

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

  // Already anchored — nothing to heal.
  if (u.brokerage_id) return { ok: true, brokerageId: u.brokerage_id as string, created: false }

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

  // 1. Personal brokerage-of-one — same shape a solo self-serve signup produces.
  const displayName = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || (email ? email.split("@")[0] : "Agent")
  const name = `${displayName}'s Brokerage`
  const slug = `${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "brokerage"}-${Math.random().toString(36).slice(2, 6)}`
  const trialEndsAt = new Date(Date.now() + SOLO_TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: brokerage, error: bErr } = await svc
    .from("brokerages")
    .insert({
      name,
      slug,
      email: email || null,
      plan_tier: "solo_agent",
      brokerage_on_platform: false,
      team_on_platform: false,
      trial_ends_at: trialEndsAt,
      // signup_source is CHECK-constrained to self_serve/superadmin/partner/import;
      // this is a self-serve provision (auto-triggered), so 'self_serve' is correct.
      signup_source: "self_serve",
      onboarding_status: "pending",
    })
    .select("id")
    .single()
  if (bErr || !brokerage) return { ok: false, error: `Brokerage creation failed: ${bErr?.message ?? "unknown"}` }

  // 2. Anchor the user to it.
  await svc.from("users").update({ brokerage_id: brokerage.id }).eq("id", u.id)

  // 3. Canonical domain records (agents + commission + onboarding + RBAC),
  //    tier-aware — the SAME repair path signup + login-time repair use.
  // Use the user's ACTUAL role (agent OR team_lead) — both are AGENT_ROLES so the
  // agents row is still provisioned, and the RBAC row matches users.user_type.
  // Hardcoding "agent" for a team_lead would write a divergent role="agent" row, and
  // the login-time repairIncompleteAccountSetup (which reads the real user_type) would
  // then upsert a SECOND role="team_lead" row on (user_id, role).
  await createOrRepairUserDomainRecords({
    userId: u.id,
    userType: u.user_type,
    brokerageId: brokerage.id,
    teamId: null,
    tier: "solo_agent",
    callerUserId: u.id,
  } as any)

  // 4. Trialing subscription so fair-use is correct on day one (best-effort).
  try {
    const { data: tierRow } = await svc
      .from("subscription_tiers")
      .select("id")
      .eq("tier_name", "solo_agent")
      .eq("is_active", true)
      .maybeSingle()
    if (tierRow) {
      await svc.from("subscriptions").insert({
        brokerage_id: brokerage.id,
        tier_id: tierRow.id,
        status: "trialing",
        current_period_start: new Date().toISOString(),
        current_period_end: trialEndsAt,
      })
    }
  } catch { /* non-fatal */ }

  return { ok: true, brokerageId: brokerage.id as string, created: true }
}
