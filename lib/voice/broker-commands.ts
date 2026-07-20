// lib/voice/broker-commands.ts
//
// BROKER-LANE VOICE BACKENDS (round 36) — the spoken forms of three
// principal/manager-gated actions. Each one:
//
//   • re-checks its role guard HERE (the run_team_command free-text lane has
//     no per-tool registry gate), resolving the speaking user's role from the
//     DB — never trusting the transcript;
//   • then calls the CANONICAL action with the sessionless-caller overload
//     ({ client, actorUserId }), so the action's OWN guard runs a second time
//     against the same DB rows (equivalent-or-stricter, never bypassed);
//   • surfaces a voice_action receipt on the manager bus (the webhook already
//     writes the agent_assistant_tool_calls row for every call).
//
// Policies enforced:
//   • LEADS ARE NOT AGENT-SPEAKABLE (round-33 owner policy: RAW LEADS =
//     PLATFORM ONLY / LEADS = BROKERAGE + PLATFORM). voicePromoteLead admits
//     only the broker/admin role set the canonical action admits, and NEVER
//     speaks raw-record content back — only counts and the promotion result.
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

/** Same role set the canonical promoteLead action admits (PROMOTE_ROLES). */
const LEAD_PROMOTE_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "super_admin", "superadmin"])

/** Same manager set contact-reassignment's requireReassignAuthority admits. */
const REASSIGN_MANAGER_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "superadmin"])

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
  tool: "promote_lead" | "reassign_contact" | "broadcast_announcement"
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
// PROMOTE LEAD — "promote the lead for John Smith"
// ─────────────────────────────────────────────────────────────────────────────

export interface VoicePromoteLeadInput extends BrokerCtx {
  /** Explicit raw_scraped_leads.id when the caller already has it. */
  rawRecordId?: string | null
  /** Spoken name hint — matched against un-promoted raw records in-tenancy. */
  nameQuery?: string | null
}

export async function voicePromoteLead(input: VoicePromoteLeadInput, client?: Svc): Promise<BrokerVoiceResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  // ── Guard 1 (this lane): broker/admin roles only — leads are NOT agent-speakable ──
  const actor = await loadActor(svc, input)
  if (!actor) return { ok: false, spoken: "Acting user not found." }
  if (!LEAD_PROMOTE_ROLES.has(actor.userType)) {
    return { ok: false, spoken: "Lead promotion is a broker call — it isn't available for your role by voice." }
  }
  if (actor.brokerageId !== input.brokerageId) {
    return { ok: false, spoken: "Your account isn't in this brokerage, so I can't promote leads here." }
  }

  // ── Resolve the raw record (explicit id, else unique name match, in-tenancy,
  //    un-promoted only). Raw-record CONTENT is never spoken back — counts only. ──
  let rawRecordId = (input.rawRecordId ?? "").trim() || null
  if (!rawRecordId) {
    const name = (input.nameQuery ?? "").trim()
    if (name.length < 2) {
      return { ok: false, spoken: "Whose lead should I promote? Give me the name on the raw record." }
    }
    const tokens = name.split(/\s+/)
    let q = svc
      .from("raw_scraped_leads")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .is("lead_id", null)
      .limit(5)
    q = tokens.length >= 2
      ? q.ilike("first_name", `%${tokens[0]}%`).ilike("last_name", `%${tokens[tokens.length - 1]}%`)
      : q.or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%`)
    const { data: matches } = await q
    const rows = (matches ?? []) as Array<{ id: string }>
    if (rows.length === 0) {
      return { ok: false, spoken: `I don't see an un-promoted raw record matching "${name}" in your brokerage.` }
    }
    if (rows.length > 1) {
      return { ok: false, spoken: `There are ${rows.length} un-promoted raw records matching "${name}" — use the Raw Leads bench to pick the exact one, or give me the full name.` }
    }
    rawRecordId = rows[0].id
  }

  // ── Guard 2 (the canonical action's own gate, re-run through our client) ──
  const { promoteLead } = await import("@/app/actions/lead-promotion/promote-lead")
  const res = await promoteLead(rawRecordId, undefined, { client: svc, actorUserId: input.actorUserId })

  if (!res.success) {
    return {
      ok: false,
      spoken: `The promotion didn't go through at the ${res.stage} step: ${res.message}`,
      data: { raw_record_id: rawRecordId, stage: res.stage },
    }
  }

  await busReceipt(svc, {
    brokerageId: input.brokerageId,
    tool: "promote_lead",
    message: `Voice admin promoted raw record ${rawRecordId} to lead ${res.leadId ?? "(id pending)"} — canonical promoteLead pipeline`,
    entityType: "lead",
    entityId: res.leadId ?? null,
    payload: { raw_record_id: rawRecordId },
  })

  return {
    ok: true,
    spoken: "Done — the lead is promoted. Scoring is running, and if it's a platform lead, distribution takes it from here. It'll show in the Leads list momentarily.",
    data: { lead_id: res.leadId ?? null, raw_record_id: rawRecordId },
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
