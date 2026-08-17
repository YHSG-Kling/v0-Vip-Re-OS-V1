// lib/voice/broker-commands.ts
//
// BROKER-LANE VOICE BACKENDS (round 36, corrected round 37) — the spoken forms
// of three principal/manager-gated actions. Each one:
//
//   • re-checks its role guard HERE (the run_team_command free-text lane has
//     no per-tool registry gate), resolving the speaking user's role from the
//     DB — never trusting the transcript;
//   • then calls the CANONICAL function, so the canonical gate runs a second
//     time against the same DB rows (equivalent-or-stricter, never bypassed);
//   • surfaces a voice_action receipt on the manager bus (the webhook already
//     writes the agent_assistant_tool_calls row for every call).
//
// Policies enforced:
//   • RAW LEADS CAN'T BE MANUALLY MOVED (round-37 owner policy): the round-36
//     voice promote_lead lane (raw→lead by voice) is REMOVED — raw records
//     reach `leads` only through the automatic pipeline. The broker lead verb
//     that remains is voiceConvertLead: converting an already-QUALIFIED lead
//     to a contact through Engine 2 (evaluateAndAssignLead), whose server-side
//     gate REFUSES unqualified leads — the owner's "converted once qualified"
//     rule, enforced in the engine, matched by this lane.
//   • LEADS ARE NOT AGENT-SPEAKABLE (round-33 owner policy: RAW LEADS =
//     PLATFORM ONLY / LEADS = BROKERAGE + PLATFORM). voiceConvertLead admits
//     only the broker/admin lead-desk role set.
//   • BROADCAST IS IN-APP ONLY — the canonical action writes notifications
//     rows (channel "in_app") and never touches email/SMS; this backend adds
//     no egress of its own.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface BrokerVoiceResult {
  ok: boolean
  spoken: string
  data?: Record<string, unknown>
}

interface BrokerCtx {
  brokerageId: string
  actorUserId: string
}

/** Same lead-desk role set the lead lifecycle actions admit (LEAD_DESK_ROLES).
 *  SCOPE LADDER (kept inline to mirror lead-management, which deliberately
 *  excludes team_lead): 'superadmin'/'super_admin' removed — tested against
 *  users.user_type where both are dead (0 live rows / not storable). */
const LEAD_DESK_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

/** Same manager set contact-reassignment's requireReassignAuthority admits.
 *  'superadmin' removed there and here — dead as users.user_type (0 live rows). */
const REASSIGN_MANAGER_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

async function loadActor(svc: Svc, ctx: BrokerCtx): Promise<{ userType: string; brokerageId: string | null } | null> {
  const { data } = await svc
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", ctx.actorUserId)
    .maybeSingle()
  if (!data) return null
  const row = data as { user_type?: string | null; brokerage_id?: string | null }
  return { userType: String(row.user_type ?? "agent"), brokerageId: row.brokerage_id ?? null }
}

async function busReceipt(svc: Svc, input: {
  brokerageId: string
  tool: "convert_lead" | "reassign_contact" | "broadcast_announcement"
  message: string
  entityType: string
  entityId: string | null
  contactId?: string | null
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    const { surfaceVoiceActionOnBus } = await import("@/lib/voice/voice-bus")
    await surfaceVoiceActionOnBus(input, svc)
  } catch { /* visibility best-effort — the action already landed */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERT LEAD — "convert the lead for John Smith"
//
// The ONLY manual lead verb the corrected business process allows by voice:
// converting an already-QUALIFIED lead to a contact. It rides Engine 2
// (evaluateAndAssignLead), the SAME canonical lane the AI ISA's qualification
// hook uses — its server-side gate refuses any lead that isn't
// lead_stage='qualified' + consented, so an unqualified lead can never be
// converted by voice. Assignment follows the admin-set assignment_rules policy
// and conversion lands through handleLeadAssigned → createContactFromLead.
// There is NO raw→lead voice verb: raw records move only via the automatic
// pipeline (owner, round 37).
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceConvertLeadInput extends BrokerCtx {
  /** Explicit leads.id when the caller already has it. */
  leadId?: string | null
  /** Spoken name hint — matched against un-converted leads in-tenancy. */
  nameQuery?: string | null
}

export async function voiceConvertLead(input: VoiceConvertLeadInput, client?: Svc): Promise<BrokerVoiceResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  // ── Guard 1 (this lane): broker/admin roles only — leads are NOT agent-speakable ──
  const actor = await loadActor(svc, input)
  if (!actor) return { ok: false, spoken: "Acting user not found." }
  if (!LEAD_DESK_ROLES.has(actor.userType)) {
    return { ok: false, spoken: "Converting a lead is a broker call — it isn't available for your role by voice." }
  }
  if (actor.brokerageId !== input.brokerageId) {
    return { ok: false, spoken: "Your account isn't in this brokerage, so I can't convert leads here." }
  }

  // ── Resolve the lead (explicit id, else unique name match, in-tenancy,
  //    not-yet-converted only). ──
  let leadId = (input.leadId ?? "").trim() || null
  let leadRow: { id: string; lead_stage: string | null; contact_id: string | null } | null = null
  if (leadId) {
    const { data } = await svc
      .from("leads")
      .select("id, lead_stage, contact_id")
      .eq("id", leadId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (!data) return { ok: false, spoken: "I couldn't find that lead in your brokerage." }
    leadRow = data as any
  } else {
    const name = (input.nameQuery ?? "").trim()
    if (name.length < 2) {
      return { ok: false, spoken: "Whose lead should I convert? Give me the name on the lead." }
    }
    const tokens = name.split(/\s+/)
    let q = svc
      .from("leads")
      .select("id, lead_stage, contact_id")
      .eq("brokerage_id", input.brokerageId)
      .is("contact_id", null)
      .eq("is_active", true)
      .limit(5)
    q = tokens.length >= 2
      ? q.ilike("first_name", `%${tokens[0]}%`).ilike("last_name", `%${tokens[tokens.length - 1]}%`)
      : q.or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%`)
    const { data: matches } = await q
    const rows = (matches ?? []) as Array<{ id: string; lead_stage: string | null; contact_id: string | null }>
    if (rows.length === 0) {
      return { ok: false, spoken: `I don't see an un-converted lead matching "${name}" in your brokerage.` }
    }
    if (rows.length > 1) {
      return { ok: false, spoken: `There are ${rows.length} un-converted leads matching "${name}" — use the Leads list to pick the exact one, or give me the full name.` }
    }
    leadRow = rows[0]
    leadId = rows[0].id
  }

  if (leadRow?.contact_id) {
    return { ok: true, spoken: "That lead is already a contact — nothing to convert.", data: { lead_id: leadId, contact_id: leadRow.contact_id } }
  }

  // ── Guard 2 (canonical, server-side): Engine 2's gate REFUSES unqualified
  //    leads (lead_stage='qualified' + consent required) and routes per the
  //    admin's assignment_rules policy; handleLeadAssigned converts + notifies. ──
  const { evaluateAndAssignLead } = await import("@/lib/lead-assignment/assignment-engine")
  const res = await evaluateAndAssignLead({ leadId: leadId!, brokerageId: input.brokerageId })

  if (!res.assigned) {
    const unqualified = leadRow?.lead_stage !== "qualified"
    const unconsented = /lifecycle_state/.test(res.reason) && !unqualified
    return {
      ok: false,
      spoken: unqualified
        ? "That lead hasn't been qualified by the AI ISA yet, so I can't convert it — conversion only happens once qualified. The ISA is still working it."
        : unconsented
        ? "That lead is qualified but hasn't consented yet — the canonical process converts once consent lands. The ISA keeps working it."
        : `The conversion didn't go through: ${res.reason}`,
      data: { lead_id: leadId, reason: res.reason },
    }
  }

  await busReceipt(svc, {
    brokerageId: input.brokerageId,
    tool: "convert_lead",
    message: `Voice admin converted qualified lead ${leadId} to a contact via Engine 2 (${res.reason}) — canonical assignment policy + createContactFromLead`,
    entityType: "lead",
    entityId: leadId,
    payload: { agent_id: res.agentId ?? null, method: res.reason },
  })

  return {
    ok: true,
    spoken: "Done — the qualified lead is now a contact, assigned per your assignment rules, and the receiving agent got an in-app heads-up.",
    data: { lead_id: leadId, agent_id: res.agentId ?? null },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REASSIGN CONTACT — "reassign Maria Lopez to Bob Chen"
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceReassignContactInput extends BrokerCtx {
  contactId?: string | null
  personQuery?: string | null
  toAgentId?: string | null
  toAgentQuery?: string | null
}

export async function voiceReassignContact(input: VoiceReassignContactInput, client?: Svc): Promise<BrokerVoiceResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  // ── Guard 1 (this lane): manager roles or the tenancy principal ──
  const actor = await loadActor(svc, input)
  if (!actor) return { ok: false, spoken: "Acting user not found." }
  if (actor.brokerageId !== input.brokerageId) {
    return { ok: false, spoken: "Your account isn't in this brokerage, so I can't reassign contacts here." }
  }
  if (!REASSIGN_MANAGER_ROLES.has(actor.userType)) {
    const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
    const principal = await isTenancyPrincipal(svc, {
      userId: input.actorUserId,
      brokerageId: input.brokerageId,
      role: actor.userType,
    })
    if (!principal) {
      return { ok: false, spoken: "Reassigning a contact is a broker or manager call — it isn't available for your role." }
    }
  }

  // ── Resolve the contact (explicit id, else unique in-tenancy name match) ──
  let contactId = (input.contactId ?? "").trim() || null
  let contactName = "the contact"
  if (contactId) {
    const { data: c } = await svc
      .from("contacts")
      .select("id, first_name, last_name")
      .eq("id", contactId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (!c) return { ok: false, spoken: "I couldn't find that contact in your brokerage." }
    contactName = `${(c as any).first_name ?? ""} ${(c as any).last_name ?? ""}`.trim() || contactName
  } else {
    const name = (input.personQuery ?? "").trim()
    if (name.length < 2) return { ok: false, spoken: "Which contact should I move? Give me their name." }
    const { data: matches } = await svc
      .from("contacts")
      .select("id, first_name, last_name")
      .eq("brokerage_id", input.brokerageId)
      .or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%,first_name.ilike.%${name.split(/\s+/)[0]}%`)
      .limit(5)
    const rows = (matches ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>
    const scored = rows.filter((r) => {
      const full = `${r.first_name ?? ""} ${r.last_name ?? ""}`.toLowerCase()
      return name.toLowerCase().split(/\s+/).every((tok) => full.includes(tok))
    })
    const pick = scored.length > 0 ? scored : rows
    if (pick.length === 0) return { ok: false, spoken: `I don't see a contact matching "${name}" in your brokerage.` }
    if (pick.length > 1) {
      return { ok: false, spoken: `There are ${pick.length} contacts matching "${name}" — give me the full name, or do it from the CRM where you can see the list.` }
    }
    contactId = pick[0].id
    contactName = `${pick[0].first_name ?? ""} ${pick[0].last_name ?? ""}`.trim() || contactName
  }

  // ── Resolve the target agent (explicit id, else unique active-agent name match) ──
  let toAgentId = (input.toAgentId ?? "").trim() || null
  let toAgentName = "the new agent"
  if (!toAgentId) {
    const name = (input.toAgentQuery ?? "").trim()
    if (name.length < 2) return { ok: false, spoken: "Who should take them over? Give me the receiving agent's name." }
    const { data: agents } = await svc
      .from("agents")
      .select("id, user_id, is_active")
      .eq("brokerage_id", input.brokerageId)
      .eq("is_active", true)
      .limit(300)
    const agentRows = (agents ?? []) as Array<{ id: string; user_id: string | null }>
    const userIds = agentRows.map((a) => a.user_id).filter(Boolean) as string[]
    const { data: users } = userIds.length > 0
      ? await svc.from("users").select("id, first_name, last_name, email").in("id", userIds)
      : { data: [] }
    const nameById = new Map(
      ((users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>).map(
        (u) => [u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.email || ""],
      ),
    )
    const toks = name.toLowerCase().split(/\s+/)
    const hits = agentRows.filter((a) => {
      const n = (a.user_id ? nameById.get(a.user_id) ?? "" : "").toLowerCase()
      return n && toks.every((t) => n.includes(t))
    })
    if (hits.length === 0) return { ok: false, spoken: `I don't see an active agent matching "${name}" in your brokerage.` }
    if (hits.length > 1) return { ok: false, spoken: `There are ${hits.length} agents matching "${name}" — give me the full name.` }
    toAgentId = hits[0].id
    toAgentName = (hits[0].user_id ? nameById.get(hits[0].user_id) : null) || toAgentName
  }

  // ── Guard 2 + the move: the canonical action with the sessionless-caller
  //    overload — its requireReassignAuthority re-runs against the DB. ──
  const { reassignContactAction } = await import("@/app/actions/contact-reassignment")
  const res = await reassignContactAction(
    { contactId: contactId!, toAgentId: toAgentId! },
    { client: svc, actorUserId: input.actorUserId },
  )

  if (!res.ok) return { ok: false, spoken: `The reassignment didn't go through: ${res.error ?? "unknown error"}.` }

  await busReceipt(svc, {
    brokerageId: input.brokerageId,
    tool: "reassign_contact",
    message: `Voice admin reassigned ${contactName} to ${toAgentName} — canonical reassignContactAction (${res.dealRolesMoved} deal role(s), ${res.openTasksMoved} open task(s) moved)`,
    entityType: "contact",
    entityId: contactId,
    contactId,
    payload: { to_agent_id: toAgentId, leads_moved: res.leadsMoved, deal_roles_moved: res.dealRolesMoved },
  })

  const moved: string[] = []
  if (res.leadsMoved > 0) moved.push(`${res.leadsMoved} lead${res.leadsMoved === 1 ? "" : "s"}`)
  if (res.dealRolesMoved > 0) moved.push(`${res.dealRolesMoved} in-flight deal role${res.dealRolesMoved === 1 ? "" : "s"}`)
  if (res.openTasksMoved > 0) moved.push(`${res.openTasksMoved} open task${res.openTasksMoved === 1 ? "" : "s"}`)
  if (res.alertsMoved > 0) moved.push(`${res.alertsMoved} property alert${res.alertsMoved === 1 ? "" : "s"}`)
  return {
    ok: true,
    spoken: `Done — ${contactName} now belongs to ${toAgentName}${moved.length ? `, along with ${moved.join(", ")}` : ""}. Their portal follows them automatically, and ${toAgentName.split(" ")[0]} got an in-app heads-up.`,
    data: { contact_id: contactId, to_agent_id: toAgentId, ...res },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST — "announce to the team: the office closes at noon Friday"
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceBroadcastInput extends BrokerCtx {
  message?: string | null
  subject?: string | null
  priority?: "low" | "medium" | "high" | null
}

export async function voiceBroadcastAnnouncement(input: VoiceBroadcastInput, client?: Svc): Promise<BrokerVoiceResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  const body = (input.message ?? "").trim()
  if (body.length < 5) return { ok: false, spoken: "What should the announcement say? Give me the message and I'll post it to the team's in-app feed." }

  // ── Guard 1 (this lane): the tenancy principal only — same rule the action enforces ──
  const actor = await loadActor(svc, input)
  if (!actor) return { ok: false, spoken: "Acting user not found." }
  if (actor.brokerageId !== input.brokerageId) {
    return { ok: false, spoken: "Your account isn't in this brokerage, so I can't post announcements here." }
  }
  {
    const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
    const principal = await isTenancyPrincipal(svc, {
      userId: input.actorUserId,
      brokerageId: input.brokerageId,
      role: actor.userType,
    })
    if (!principal) {
      return { ok: false, spoken: "Team announcements are for the account principal — ask your broker or team lead to post it." }
    }
  }

  // Subject: spoken lane derives a short one from the message when not given.
  const subject = (input.subject ?? "").trim() || (body.length > 60 ? `${body.slice(0, 57)}…` : body)

  // ── Guard 2 + the fan-out: the canonical IN-APP-ONLY action (its principal
  //    gate re-runs; it writes notifications rows only — never email/SMS). ──
  const { notifyBrokerageAgentsAction } = await import("@/app/actions/communications")
  const res = await notifyBrokerageAgentsAction(
    { subject, body, priority: input.priority ?? "medium" },
    { client: svc, actorUserId: input.actorUserId },
  )

  if (!res.ok) return { ok: false, spoken: `The announcement didn't go out: ${res.error ?? "unknown error"}.` }

  await busReceipt(svc, {
    brokerageId: input.brokerageId,
    tool: "broadcast_announcement",
    message: `Voice admin posted a ${res.scope ?? "brokerage"} announcement in-app to ${res.notified ?? 0} teammate(s): "${subject.slice(0, 60)}"`,
    entityType: "brokerage",
    entityId: input.brokerageId,
    payload: { notified: res.notified ?? 0, scope: res.scope ?? "brokerage" },
  })

  return {
    ok: true,
    spoken: `Posted — ${res.notified ?? 0} teammate${(res.notified ?? 0) === 1 ? "" : "s"} got the announcement on their in-app feed${res.scope === "team" ? " (your team)" : ""}. In-app only, as always — nothing was emailed or texted.`,
    data: { notified: res.notified ?? 0, scope: res.scope ?? "brokerage", subject },
  }
}
