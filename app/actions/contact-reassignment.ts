"use server"

// app/actions/contact-reassignment.ts
// ─────────────────────────────────────────────────────────────────────────────
// PER-CONTACT REASSIGNMENT — the single-contact sibling of the bulk successor
// flow (app/actions/agent-deactivation.ts → lib/agents/agent-deactivation.ts).
// The bulk flow moves a departing agent's WHOLE book; this moves ONE contact
// between two active agents, reusing the same per-entity move set the bulk
// flow established, filtered to this contact:
//   · the contact row               (contacts.agent_id)
//   · their leads                   (leads.agent_id where leads.contact_id = X)
//   · their IN-FLIGHT deal roles    (transactions agent/buyer_agent/seller_agent
//                                    on ACTIVE_DEAL_STATUSES — closed deals keep
//                                    historical attribution, same rule as bulk)
//   · their OPEN tasks              (tasks assigned to the old agent — closed
//                                    tasks stay as history, same rule as bulk)
//   · their active property alerts  (property_alerts.agent_user_id)
// Portal linkage (invites/access/messages) is CONTACT-scoped, not agent-scoped,
// so it follows the contact automatically — nothing to move, and we say so.
//
// Gated to the tenancy principal (broker/admin; solo agent on solo tier; team
// lead on team tier) or a brokerage manager role — a regular agent can never
// take another agent's contact. Audited in lifecycle_events; counters honest.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { ACTIVE_DEAL_STATUSES } from "@/lib/agents/agent-deactivation"
import { revalidatePath } from "next/cache"

/** Same manager set the bulk deactivation flow admits.
 *  SCOPE LADDER (kept inline — team leads come through the tenancy-principal
 *  branch, not this set): 'superadmin' removed — dead as users.user_type
 *  (0 live rows store it). */
const MANAGER_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

type Svc = ReturnType<typeof createServiceClient>

/** Sessionless-caller overload shape (voice webhook): the caller supplies its
 *  own verified client + acting users.id; the SAME role/principal guard runs
 *  against the DB through that client. A browser cannot spoof this — a forged
 *  plain-object client has no working .from and fails closed at the guard. */
export interface ReassignCaller {
  client: Svc
  actorUserId: string
}

async function requireReassignAuthority(caller?: ReassignCaller): Promise<
  { ok: true; brokerageId: string; actorUserId: string } | { ok: false; error: string }
> {
  let userId: string
  let brokerageId: string
  let role: string
  if (caller) {
    if (typeof caller.client?.from !== "function" || typeof caller.actorUserId !== "string" || !caller.actorUserId) {
      return { ok: false, error: "Not authenticated" }
    }
    const { data: userRow } = await caller.client
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", caller.actorUserId)
      .maybeSingle()
    if (!(userRow as { brokerage_id?: string | null } | null)?.brokerage_id) return { ok: false, error: "Not authenticated" }
    userId = caller.actorUserId
    brokerageId = (userRow as { brokerage_id: string }).brokerage_id
    role = String((userRow as { user_type?: string | null }).user_type ?? "agent")
  } else {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Not authenticated" }
    userId = ctx.userId
    brokerageId = ctx.brokerageId
    role = ctx.role
  }
  if (MANAGER_ROLES.has(role)) return { ok: true, brokerageId, actorUserId: userId }
  const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
  const svc = createServiceClient()
  const principal = await isTenancyPrincipal(svc, {
    userId,
    brokerageId,
    role,
  })
  if (!principal) return { ok: false, error: "Forbidden — only a broker/manager or tenancy principal can reassign contacts" }
  return { ok: true, brokerageId, actorUserId: userId }
}

export interface ReassignTarget {
  agentId: string
  userId: string | null
  name: string
}

/** Active agents in the caller's brokerage the picker can reassign TO. */
export async function listReassignTargetsAction(): Promise<
  { ok: true; targets: ReassignTarget[] } | { ok: false; error: string }
> {
  const auth = await requireReassignAuthority()
  if (!auth.ok) return { ok: false, error: auth.error }
  const svc = createServiceClient()
  const { data: agents } = await svc
    .from("agents")
    .select("id, user_id")
    .eq("brokerage_id", auth.brokerageId)
    .eq("is_active", true)
    .limit(300)
  const rows = (agents ?? []) as Array<{ id: string; user_id: string | null }>
  const userIds = rows.map((a) => a.user_id).filter(Boolean) as string[]
  const { data: users } = userIds.length > 0
    ? await svc.from("users").select("id, first_name, last_name, email").in("id", userIds)
    : { data: [] }
  const nameById = new Map(
    ((users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>).map(
      (u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || "Agent"],
    ),
  )
  return {
    ok: true,
    targets: rows.map((a) => ({
      agentId: a.id,
      userId: a.user_id,
      name: (a.user_id && nameById.get(a.user_id)) || "Agent",
    })),
  }
}

export interface ReassignContactResult {
  ok: boolean
  error?: string
  contactMoved: boolean
  leadsMoved: number
  dealRolesMoved: number
  openTasksMoved: number
  alertsMoved: number
  /** Portal invites/messages are contact-scoped — they follow the contact with
   *  no row moves; surfaced so the UI can say so honestly. */
  portalFollowsContact: boolean
}

/**
 * reassignContactAction — move ONE contact (and their open work) from the
 * current agent to another active agent in the same brokerage.
 */
export async function reassignContactAction(input: {
  contactId: string
  toAgentId: string
}, caller?: ReassignCaller): Promise<ReassignContactResult> {
  const empty: ReassignContactResult = {
    ok: false, contactMoved: false, leadsMoved: 0, dealRolesMoved: 0,
    openTasksMoved: 0, alertsMoved: 0, portalFollowsContact: true,
  }
  const auth = await requireReassignAuthority(caller)
  if (!auth.ok) return { ...empty, error: auth.error }
  if (!input.contactId || !input.toAgentId) return { ...empty, error: "contactId and toAgentId are required" }

  const svc: Svc = createServiceClient()
  const nowIso = new Date().toISOString()

  // ── Load + tenancy-check the contact ──
  const { data: contact } = await svc
    .from("contacts")
    .select("id, agent_id, brokerage_id, first_name, last_name")
    .eq("id", input.contactId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!contact) return { ...empty, error: "Contact not found in your brokerage" }
  const fromAgentId: string | null = (contact as any).agent_id ?? null
  if (fromAgentId === input.toAgentId) return { ...empty, error: "Contact is already assigned to that agent" }

  // ── Validate the target agent (same rule as the bulk successor check) ──
  const { data: target } = await svc
    .from("agents")
    .select("id, user_id, is_active")
    .eq("id", input.toAgentId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!target) return { ...empty, error: "Target agent not found in this brokerage" }
  if ((target as any).is_active === false) return { ...empty, error: "Target agent is not active" }
  const targetUserId: string | null = (target as any).user_id ?? null

  const result: ReassignContactResult = { ...empty, ok: false }

  // ── 1. The contact row ──
  {
    const { error } = await svc
      .from("contacts")
      .update({ agent_id: input.toAgentId, updated_at: nowIso })
      .eq("id", input.contactId)
      .eq("brokerage_id", auth.brokerageId)
    if (error) return { ...empty, error: `Contact move failed: ${error.message}` }
    result.contactMoved = true
  }

  // ── 2. Their leads (ownership follows the client — same as the bulk flow,
  //       filtered to this contact's lead rows) ──
  {
    const { count } = await svc
      .from("leads")
      .update({ agent_id: input.toAgentId, updated_at: nowIso }, { count: "exact" })
      .eq("brokerage_id", auth.brokerageId)
      .eq("contact_id", input.contactId)
    result.leadsMoved = count ?? 0
  }

  // ── 3. In-flight deal roles for THIS contact (closed deals keep historical
  //       attribution — identical rule to the bulk flow) ──
  if (fromAgentId) {
    for (const roleCol of ["agent_id", "buyer_agent_id", "seller_agent_id"] as const) {
      const { count } = await svc
        .from("transactions")
        .update({ [roleCol]: input.toAgentId, updated_at: nowIso }, { count: "exact" })
        .eq("brokerage_id", auth.brokerageId)
        .eq(roleCol, fromAgentId)
        .or(`contact_id.eq.${input.contactId},buyer_contact_id.eq.${input.contactId},seller_contact_id.eq.${input.contactId}`)
        .in("status", ACTIVE_DEAL_STATUSES as unknown as string[])
      result.dealRolesMoved += count ?? 0
    }
  }

  // ── 4. This contact's OPEN tasks owed by the old agent (closed/cancelled
  //       stay as history — same exclusion set as the bulk flow) ──
  if (fromAgentId) {
    const OPEN_TASK_EXCLUDE = "(completed,cancelled,done,closed)"
    const { count } = await svc
      .from("tasks")
      .update({ assigned_to_agent_id: input.toAgentId }, { count: "exact" })
      .eq("brokerage_id", auth.brokerageId)
      .eq("contact_id", input.contactId)
      .eq("assigned_to_agent_id", fromAgentId)
      .not("status", "in", OPEN_TASK_EXCLUDE)
    result.openTasksMoved = count ?? 0
  }

  // ── 5. Their ACTIVE property alerts (property_alerts.agent_user_id is a
  //       users.id) — re-pointed to the new agent so alert delivery follows ──
  if (targetUserId) {
    const { count } = await svc
      .from("property_alerts")
      .update({ agent_user_id: targetUserId, updated_at: nowIso }, { count: "exact" })
      .eq("brokerage_id", auth.brokerageId)
      .eq("contact_id", input.contactId)
      .eq("is_active", true)
    result.alertsMoved = count ?? 0
  }

  // ── Audit (same lifecycle_events idiom as the bulk flow) — best-effort ──
  await svc
    .from("lifecycle_events")
    .insert({
      brokerage_id: auth.brokerageId,
      entity_type: "contact",
      entity_id: input.contactId,
      event_type: "CONTACT_REASSIGNED",
      actor_user_id: auth.actorUserId,
      metadata: {
        from_agent: fromAgentId,
        to_agent: input.toAgentId,
        by: auth.actorUserId,
        leads_moved: result.leadsMoved,
        deal_roles_moved: result.dealRolesMoved,
        open_tasks_moved: result.openTasksMoved,
        alerts_moved: result.alertsMoved,
      },
      created_at: nowIso,
    })
    .then(() => {}, (e: unknown) => console.error("[reassignContact] audit failed:", e))

  // ── Tell the receiving agent (in-app notification, mirrors the bulk flow) ──
  if (targetUserId) {
    const contactName =
      [(contact as any).first_name, (contact as any).last_name].filter(Boolean).join(" ").trim() || "A contact"
    await svc
      .from("notifications")
      .insert({
        user_id: targetUserId,
        brokerage_id: auth.brokerageId,
        type: "contact_reassigned",
        title: "A contact was reassigned to you",
        body: `${contactName} is now yours${result.dealRolesMoved > 0 ? ` — including ${result.dealRolesMoved} in-flight deal role(s), review those first` : ""}.`,
        entity_type: "contact",
        entity_id: input.contactId,
        priority: result.dealRolesMoved > 0 ? "high" : "medium",
        channel: "in_app",
        is_read: false,
      })
      .then(() => {}, () => {})
  }

  // ── GAMIFICATION AWARD, PORTED ONTO THE SURVIVOR (§1 merge, wave 26) ───────
  // The ONE thing app/actions/agents.ts:assignAgentToContact did that this
  // action did not. That function is the never-surfaced duplicate of this one
  // (it only re-pointed contacts.agent_id and left every downstream row with the
  // previous agent); this action is strictly more complete on every other axis,
  // so the award moves HERE rather than the duplicate staying alive to carry it.
  //
  // The receiving agent is credited — `input.toAgentId` is an agents.id, which is
  // the id class awardPoints keys on (agents.id and users.id are DISJOINT).
  //
  // A REFUSED AWARD MUST NOT ROLL BACK THE REASSIGNMENT. The contact and all its
  // downstream work have already moved and are already audited above; points are
  // a motivational ledger, not the record of the move. So this is best-effort —
  // but it is LOGGED, never swallowed: a silently missing award is how a
  // gamification ledger drifts out of agreement with the events it scores.
  // Goes straight to the canonical awarder (the atomic award_agent_points RPC),
  // not through app/actions/agents.ts's module-private wrapper: that wrapper's
  // one extra job is proving the target agent is in the caller's tenant, and
  // this action already proved exactly that above ("Target agent not found in
  // this brokerage" / "Target agent is not active") before moving anything.
  try {
    const { awardAgentPoints, POINT_VALUES } = await import("@/lib/gamification/award-points")
    const awarded = await awardAgentPoints(svc, {
      agentId:       input.toAgentId,
      points:        POINT_VALUES.CONTACT_ASSIGNED,
      reason:        "CONTACT_ASSIGNED",
      referenceType: "contact",
      referenceId:   input.contactId,
    })
    if (!awarded.ok) {
      console.error("[reassignContact] CONTACT_ASSIGNED points award refused — the contact DID move; only the award is missing:", awarded.error)
    } else {
      // Badges are threshold-awarded against the total the database now holds,
      // never against locally-recomputed arithmetic.
      try {
        const { checkAndAwardBadges } = await import("@/app/actions/gamification")
        await checkAndAwardBadges(input.toAgentId, awarded.newTotal)
      } catch (badgeError) {
        console.error(
          "[reassignContact] points landed but the badge check failed:",
          badgeError instanceof Error ? badgeError.message : badgeError,
        )
      }
    }
  } catch (awardError) {
    console.error(
      "[reassignContact] CONTACT_ASSIGNED points award failed — the contact DID move; only the award is missing:",
      awardError instanceof Error ? awardError.message : awardError,
    )
  }

  revalidatePath("/crm")
  revalidatePath(`/crm/contacts/${input.contactId}`)

  result.ok = true
  return result
}
