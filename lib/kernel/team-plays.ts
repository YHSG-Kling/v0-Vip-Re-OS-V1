// lib/kernel/team-plays.ts
//
// TEAM PLAYS — the huddle. What an elite human team does that no software does: when
// several people have something going on the SAME client, they don't each fire off a
// message — they huddle and walk out with ONE coordinated play. Every AI tool on the
// market (and until now, our own managers) does the opposite: isolated automations that
// spam the agent with fragments.
//
// A Team Play convenes the managers: when ≥2 DISTINCT managers have open business on one
// contact (open bus signals and/or pending gate proposals), the OS composes a single
// co-authored play — each manager's contribution as a named section, ONE client-facing
// message for the human to approve — and supersedes the fragments it absorbed (auditable:
// machine-superseded fragments carry the play's id; no human approver is forged).
//
// The agent opens their queue and instead of five disconnected pings sees:
//   "TEAM PLAY for Jordan Henderson — AI ISA: booked Tue appointment · Shopping Agent:
//    price dropped on a saved home · Sphere: closing anniversary next week → one message."
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export interface PlayFragment {
  /** Where the fragment came from. */
  kind: "signal" | "proposal"
  id: string
  manager: ManagerKey | "unknown"
  managerLabel: string
  /** The fragment's broker-readable line (signal message / proposal subject+body). */
  line: string
  /** Proposal body (when kind='proposal') — folded into the play's client message. */
  body?: string
}

export interface ConferenceCandidate {
  contactId: string
  fragments: PlayFragment[]
  /** Distinct managers with business on this contact. */
  managers: ManagerKey[]
}

/** Pure: group fragments by contact and keep only true conferences (≥2 distinct managers).
 *  One manager with two items is not a huddle — it's that manager's own queue. */
export function detectConferences(
  fragments: Array<{ contactId: string | null; fragment: PlayFragment }>,
): ConferenceCandidate[] {
  const byContact = new Map<string, PlayFragment[]>()
  for (const f of fragments) {
    if (!f.contactId) continue
    const list = byContact.get(f.contactId) ?? []
    list.push(f.fragment)
    byContact.set(f.contactId, list)
  }
  const out: ConferenceCandidate[] = []
  for (const [contactId, frags] of byContact) {
    const managers = Array.from(new Set(frags.map((f) => f.manager).filter((m): m is ManagerKey => m !== "unknown")))
    if (managers.length >= 2) out.push({ contactId, fragments: frags, managers })
  }
  return out
}

/** Pure: compose the co-authored play. The internal briefing lists each manager's
 *  contribution; the client message merges the proposal bodies into one coherent note. */
export function composeTeamPlay(
  candidate: ConferenceCandidate,
  contactName: string,
): { subject: string; body: string; briefing: string } {
  const sections = candidate.fragments.map((f) => `· ${f.managerLabel}: ${f.line}`).join("\n")
  const proposalBodies = candidate.fragments.filter((f) => f.kind === "proposal" && f.body).map((f) => f.body as string)
  const managerLabels = candidate.managers.map((m) => MANAGERS[m].label).join(" + ")

  const body = proposalBodies.length > 0
    ? `Hi — a few things came together for you this week, so here's everything in one note:\n\n${proposalBodies.map((b, i) => `${i + 1}. ${b}`).join("\n\n")}\n\nReply here and I'll line all of it up.`
    : `Hi — a few things came together for you this week. Reply here and I'll walk you through all of it at once.`

  return {
    subject: `Everything happening for you this week — one note`,
    body,
    briefing: `TEAM PLAY for ${contactName} (${managerLabels} convened):\n${sections}\nOne coordinated message replaces ${candidate.fragments.length} separate touches.`,
  }
}

export interface RunTeamPlaysResult {
  conferences: number
  playsProposed: number
  fragmentsSuperseded: number
}

/**
 * Detect conferences and compose team plays for a brokerage. For each conference:
 *   1. propose ONE play into the gate (Campaign Orchestrator coordinates the team's comms)
 *   2. supersede the absorbed PROPOSAL fragments (status='rejected', send_error carries the
 *      play id, approved_by stays NULL = machine supersede, never a forged human)
 *   3. consume the absorbed SIGNAL fragments with the play as the recorded action
 * Idempotent: a contact with an open team play is skipped.
 */
export async function runTeamPlays(
  brokerageId: string, client?: Svc,
): Promise<RunTeamPlaysResult> {
  const supabase = client ?? createServiceClient()

  // Gather open business: open bus signals + pending gate proposals, both contact-keyed.
  const [{ data: signals }, { data: proposals }] = await Promise.all([
    supabase.from("manager_signals")
      .select("id, to_manager, from_manager, message, contact_id")
      .eq("brokerage_id", brokerageId).eq("status", "open").not("contact_id", "is", null).limit(500),
    supabase.from("agent_client_messages")
      .select("id, agent_kind, subject, body, recipient_contact_id, rationale")
      .eq("brokerage_id", brokerageId).eq("status", "proposed").not("recipient_contact_id", "is", null).limit(500),
  ])

  const fragments: Array<{ contactId: string | null; fragment: PlayFragment }> = []
  for (const s of (signals ?? []) as any[]) {
    const m = (s.to_manager in MANAGERS ? s.to_manager : "unknown") as ManagerKey | "unknown"
    fragments.push({
      contactId: s.contact_id,
      fragment: { kind: "signal", id: s.id, manager: m, managerLabel: m === "unknown" ? s.to_manager : MANAGERS[m].label, line: s.message },
    })
  }
  for (const p of (proposals ?? []) as any[]) {
    // Team plays themselves are proposals — never re-absorb one (idempotency).
    if ((p.rationale ?? "").startsWith("TEAM PLAY")) continue
    const m = (p.agent_kind in MANAGERS ? p.agent_kind : "unknown") as ManagerKey | "unknown"
    fragments.push({
      contactId: p.recipient_contact_id,
      fragment: { kind: "proposal", id: p.id, manager: m, managerLabel: m === "unknown" ? p.agent_kind : MANAGERS[m].label, line: p.subject ?? "(no subject)", body: p.body },
    })
  }

  const conferences = detectConferences(fragments)
  let playsProposed = 0
  let fragmentsSuperseded = 0

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

  for (const conf of conferences) {
    // Idempotency: skip a contact that already has an open team play.
    const { data: existing } = await supabase.from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).eq("recipient_contact_id", conf.contactId)
      .in("status", ["proposed", "approved"]).ilike("rationale", "TEAM PLAY%").limit(1).maybeSingle()
    if (existing) continue

    const { data: c } = await supabase.from("contacts").select("first_name, last_name").eq("id", conf.contactId).maybeSingle()
    const contactName = c ? [(c as any).first_name, (c as any).last_name].filter(Boolean).join(" ").trim() || "this client" : "this client"
    const play = composeTeamPlay(conf, contactName)

    const res = await proposeClientMessage({
      brokerageId, agentKind: "campaign_orchestrator", entityType: "contact",
      entityId: conf.contactId, recipientContactId: conf.contactId, audience: "buyer",
      subject: play.subject, body: play.body,
      rationale: play.briefing,
      channel: "portal",
    }, supabase)
    if (!res.ok || !res.id) continue
    playsProposed += 1

    // Supersede the absorbed fragments — auditable, never a forged human approval.
    for (const f of conf.fragments) {
      if (f.kind === "proposal") {
        const { data: sup } = await supabase.from("agent_client_messages")
          .update({ status: "rejected", send_error: `superseded by team play ${res.id}` })
          .eq("id", f.id).eq("status", "proposed").select("id").maybeSingle()
        if (sup) fragmentsSuperseded += 1
      } else {
        const { data: sup } = await supabase.from("manager_signals")
          .update({ status: "consumed", consumed_at: new Date().toISOString(), consumed_action: `folded into team play ${res.id}` })
          .eq("id", f.id).eq("status", "open").select("id").maybeSingle()
        if (sup) fragmentsSuperseded += 1
      }
    }
  }

  return { conferences: conferences.length, playsProposed, fragmentsSuperseded }
}
