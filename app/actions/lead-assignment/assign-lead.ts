"use server"

// app/actions/lead-assignment/assign-lead.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE ASSIGNMENT VERBS, AND THE ONE THAT NO LONGER EXISTS.
//
// OWNER RULING: "agents can't claim leads when they can only see contacts.
// brokerage admins can auto assign to team leads and/or agents manually but
// agent assignment should be auto assigned when positive feedback is received
// from the brokerages agent assignment settings."
//
// A lead belongs to the BROKERAGE until assignment happens. Assignment is either
// AUTOMATIC (the tier's policy, on positive feedback or ISA qualification) or
// ADMIN-DRIVEN (a tenant admin picking an agent or a team lead by hand). It is
// never something an agent reaches out and takes: agents see CONTACTS, and a
// contact is what an assigned lead becomes.
//
// WHAT WAS RETIRED. `claimLeadAction` — the assignment-log half of an agent
// claim — is gone, and so is the surface that called it
// (app/components/leads/AvailableLeadsSheet.tsx, "Claim This Lead", deleted).
// The FLAG it wrote is not gone, because three live surfaces read it as "this
// handoff is still awaiting first touch": lib/intelligence/daily-briefing-generator.ts,
// lib/intelligence/isa-overnight.ts (handoffs_unclaimed) and
// lib/intelligence/user-type-briefs/team-lead.ts. Under automatic assignment the
// agent never accepts the handoff — it arrives — so the flag now means
// ACKNOWLEDGED, and `acknowledgeLeadHandoffAction` below is its only writer,
// gated to the agent the lead was actually assigned to (or a tenant admin).
//
// EVERY EXPORT IN THIS FILE IS A PUBLIC HTTP ENDPOINT. Each one re-reads the
// session, re-resolves the caller's brokerage from the DATABASE (never from an
// argument) and gates before it acts.

import { createClient } from "@/lib/supabase/server"
import { autoAssignLead } from "@/lib/lead-assignment/tier-routing"
import { evaluateAssignmentEligibility } from "@/lib/lead-assignment/rule-matcher"
import { handleLeadAssigned } from "@/lib/kernel/lead-acquisition-handlers"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"

type Gate =
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; reason: string }

/**
 * THE gate every verb in this file uses. NOT exported — a `"use server"` module
 * may only export async server actions, and a helper exported from one is a
 * public endpoint nobody meant to publish.
 *
 * ── WHY resolveTenantAdmin AND NOT isAdminOrBroker ──────────────────────────
 *
 * The owner's ruling ends "in team or solo agent subscription, they can have an
 * admin that sees everything since a brokerage id needs to be created for their
 * subscription" — so the admin seat must work on a ONE-AGENT tenant, not only on
 * a multi-agent brokerage.
 *
 * MEASURED on the live database, that admin is a GRANT, not a user_type: the
 * solo tenant 231f4e64-…'s administrator is agent1@yourbrokerage.com, whose
 * users.user_type is 'agent' and who holds an 'admin' grant in
 * user_role_assignments pinned to their own brokerage. public.is_brokerage_admin()
 * (m466) admits them; the pure isAdminOrBroker predicate this file used does NOT,
 * because it only reads user_type. So the tenant that most needs the admin seat
 * was the one refused it. resolveTenantAdmin is the full rule — user_type OR a
 * tenant-pinned grant — and it returns a RESULT, so a refused grant read fails
 * CLOSED instead of being reported as "not an admin".
 *
 * team_lead is already in TENANT_ADMIN_USER_TYPES, which is what makes "if team
 * lead subscription, team lead has agent assignment settings" true of these
 * verbs without a second roster.
 */
async function gateTenantAdmin(): Promise<Gate> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, reason: "Unauthorized" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  // supabase-js RESOLVES a refused query — a swallowed error here would read as
  // "no profile", which is the same shape as "denied". Both must refuse.
  if (profileError) return { ok: false, reason: "Could not verify your account" }
  if (!profile?.brokerage_id) return { ok: false, reason: "No brokerage found for user" }

  const admin = await resolveTenantAdmin(supabase, user.id, profile)
  if (!admin.ok) return { ok: false, reason: "Could not verify your permissions" }
  if (!admin.isTenantAdmin) {
    return { ok: false, reason: "Forbidden: only a brokerage admin or team lead can assign leads" }
  }

  return { ok: true, userId: user.id, brokerageId: profile.brokerage_id }
}

/**
 * ADMIN AUTO-ASSIGN — run the tenant's own assignment policy for one lead.
 *
 * Same resolver the automatic paths use (lib/lead-assignment/tier-routing.ts), so
 * pressing "Auto-Assign" in the admin panel can never pick differently from the
 * positive-feedback path that runs unattended overnight.
 */
export async function assignLead(
  leadId: string,
): Promise<{ assigned: boolean; agentId?: string; reason: string }> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) throw new Error(gate.reason)

  const out = await autoAssignLead({
    leadId,
    brokerageId: gate.brokerageId,
    trigger: "admin_auto",
  })

  return {
    assigned: out.assigned || !!out.alreadyAssigned,
    agentId: out.agentId,
    reason: out.reason,
  }
}

/**
 * MANUAL ASSIGNMENT — a brokerage admin (or team lead) hands a lead to a named
 * agent or team lead. Explicitly allowed by the ruling, and the ONLY way a
 * specific person is chosen by hand.
 *
 * It enforces the SAME gate as the automated resolver — OWNER RULING: a lead must
 * have been QUALIFIED **OR** have POSITIVE INTENT (it was an AND until this lane;
 * see lib/lead-assignment/rule-matcher.ts evaluateAssignmentEligibility for which
 * of the eight legal lifecycle_state values count as positive intent, and why).
 * Assignment converts the lead into a contact and starts that person's clock, so
 * manual must not be a side door around the gate — nor a narrower one.
 *
 * `agentId` IS AN agents.id AND IS PROVED TO BE ONE, in this tenant. It arrives
 * from the browser, and `leads.agent_id` / `assignment_log.agent_id` both FK
 * agents(id) while `users.id` is a DISJOINT space — an unvalidated id here would
 * either hand the lead to another brokerage's agent or fail the FK long after
 * the gate said yes.
 */
export async function manualAssignLead(
  leadId: string,
  agentId: string,
): Promise<{ success: boolean; reason?: string }> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) throw new Error(gate.reason)

  const supabase = await createClient()

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, brokerage_id, lead_stage, lifecycle_state, lead_score, agent_id, is_active")
    .eq("id", leadId)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()

  if (leadError) throw new Error("Could not read that lead")
  if (!lead) throw new Error("Lead not found in your brokerage")
  if (lead.agent_id) throw new Error("Lead already has an assigned agent")
  // MERGED FROM the deleted app/actions/lead-lifecycle.ts claimLead, which was the only
  // assignment path that refused a deactivated lead. Handing an agent a row that has been
  // taken out of the pipeline is work assigned against a lead nobody is working.
  if (lead.is_active === false) throw new Error("Lead is inactive and cannot be assigned")

  // THE RECIPIENT MUST BE A REAL, ACTIVE AGENT OF THIS TENANT.
  const { data: recipient, error: recipientError } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("brokerage_id", gate.brokerageId)
    .eq("is_active", true)
    .maybeSingle()
  if (recipientError) throw new Error("Could not verify that agent")
  if (!recipient) throw new Error("That agent is not an active agent of your brokerage")

  // THE GATE — the SAME pure predicate autoAssignLead runs, so pressing "Assign"
  // by hand can never admit (or refuse) a lead the automatic path would decide
  // differently about. Two copies of this expression is exactly how the manual
  // door became a side entrance the last time.
  const eligibility = evaluateAssignmentEligibility(lead.lead_stage, lead.lifecycle_state)
  if (!eligibility.ok) {
    throw new Error(eligibility.reason)
  }

  await handleLeadAssigned({
    leadId,
    brokerageId: gate.brokerageId,
    agentId,
    method: "manual",
    scoreAtAssignment: lead.lead_score ?? 0,
  })

  // The ledger's method column carries the METHOD only (m489); WHO decided goes
  // in routing_reason, which nothing wrote before this lane.
  const { error: reasonError } = await supabase
    .from("assignment_log")
    .update({
      routing_reason:
        `[admin_manual][gate:${eligibility.via}] assigned by hand by user ${gate.userId} — ${eligibility.reason}`.slice(0, 2000),
    })
    .eq("lead_id", leadId)
    .eq("brokerage_id", gate.brokerageId)
    .is("routing_reason", null)
  if (reasonError) {
    // Bookkeeping only — the lead HAS moved, so this must not read as a failure.
    console.warn("[manualAssignLead] routing_reason not recorded:", reasonError.message)
  }

  return { success: true }
}

/**
 * ACKNOWLEDGE A HANDOFF — the successor to the retired `claimLeadAction`.
 *
 * THIS IS NOT A CLAIM. The lead is ALREADY the caller's; nothing about ownership
 * changes here. It flips `assignment_log.claimed` false → true under an
 * optimistic lock and emits LEAD_CLAIMED so the acknowledgement fans out (staff
 * notification / sequence enrollment / portal update).
 *
 * WHY THE FLAG SURVIVED THE VERB. `assignment_log.claimed` is inserted false by
 * the assignment handler and READ by three live surfaces as "this handoff is
 * still awaiting first touch" — lib/intelligence/daily-briefing-generator.ts,
 * lib/intelligence/isa-overnight.ts (handoffs_unclaimed) and
 * lib/intelligence/user-type-briefs/team-lead.ts. Deleting the only writer would
 * have left those three counters able to go up and never down.
 *
 * WHO MAY CALL IT. The agent the lead was actually assigned to, or a tenant
 * admin. `agents.id` and `users.id` are DISJOINT spaces, so the caller's agents
 * row is resolved through `agents.user_id` and compared to `leads.agent_id`.
 * The previous version gated on TENANCY ALONE — any signed-in user of the
 * tenant could close out any colleague's handoff and have the LEAD_CLAIMED event
 * attributed to themselves.
 */
export async function acknowledgeLeadHandoffAction(
  leadId: string,
): Promise<{ success: boolean; reason?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { success: false, reason: "profile_check_failed" }
  if (!profile?.brokerage_id) return { success: false, reason: "no_brokerage" }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, agent_id")
    .eq("id", leadId)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  // Fails CLOSED: a refused read is a refusal, not a pass.
  if (leadError) return { success: false, reason: "lead_scope_check_failed" }
  if (!lead) return { success: false, reason: "lead_not_in_tenant" }
  if (!lead.agent_id) return { success: false, reason: "lead_not_assigned" }

  const admin = await resolveTenantAdmin(supabase, user.id, profile)
  if (!admin.ok) return { success: false, reason: "permission_check_failed" }

  if (!admin.isTenantAdmin) {
    const { data: me, error: meError } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .eq("brokerage_id", profile.brokerage_id)
      .maybeSingle()
    if (meError) return { success: false, reason: "agent_check_failed" }
    if (!me || me.id !== lead.agent_id) {
      return { success: false, reason: "not_the_assigned_agent" }
    }
  }

  const { claimLead } = await import("@/lib/lead-assignment/assignment-engine")
  return await claimLead({
    leadId,
    agentUserId: user.id,
    brokerageId: profile.brokerage_id,
  })
}
