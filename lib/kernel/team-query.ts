// lib/kernel/team-query.ts
//
// "HEY TEAM—" — the bullpen question, productized. In a great office the agent doesn't
// open six tabs to remember a client; they stand up and ask the room, and whoever knows
// something answers. Here the room is the eleven managers: ask the voice admin
// "hey team, what's happening with the Hendersons?" and every manager contributes ONLY
// what its own tables actually know —
//
//   · AI ISA              — transaction propensity + the last dial outcome
//   · Shopping Agent      — saved homes + upcoming tours
//   · Listing Concierge   — upcoming showings of our listings
//   · Deal Coordinator    — live deals, next deadline, any fire drill in the last 24h
//   · Campaign Orchestrator — what's pending in the gate + when they last heard from us
//   · Sphere Manager      — relationship state (incl. withdrawn — the team says so and
//                           recommends silence rather than fabricating a next touch)
//   · the bus             — the managers' own recent talk about this person
//
// One spoken answer, manager-attributed, nothing fabricated: a manager with nothing to
// say says nothing, and an unknown name gets an honest "the team has nothing."
// Read-only by design — the team REPORTS; acting still goes through the gate.
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export interface ManagerContribution {
  manager: ManagerKey
  line: string
}

/** Pure: pick the best contact for a spoken name (case-insensitive, first/last/full). */
export function matchContactByName<T extends { id: string; first_name: string | null; last_name: string | null }>(
  contacts: T[], spokenName: string,
): T | null {
  const q = spokenName.trim().toLowerCase().replace(/^the\s+/, "").replace(/s$/, "")
  if (!q) return null
  const scored = contacts.map((c) => {
    const first = (c.first_name ?? "").toLowerCase()
    const last = (c.last_name ?? "").toLowerCase()
    const full = `${first} ${last}`.trim()
    let score = 0
    if (full === q) score = 4
    else if (last === q || first === q) score = 3
    else if (last.startsWith(q) || first.startsWith(q)) score = 2
    else if (full.includes(q)) score = 1
    return { c, score }
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
  return scored[0]?.c ?? null
}

/** Pure: compose the spoken team answer — manager-attributed, honest when empty. */
export function composeTeamAnswer(contactName: string, contributions: ManagerContribution[]): string {
  if (contributions.length === 0) {
    return `The team has nothing on ${contactName} yet — no saved homes, no deals, no recent conversations.`
  }
  const lines = contributions.map((c) => `${MANAGERS[c.manager].label}: ${c.line}`)
  return `Here's what the team knows about ${contactName}. ${lines.join(" ")}`
}

export interface TeamQueryResult {
  found: boolean
  contactId: string | null
  contactName: string | null
  spoken: string
  contributions: ManagerContribution[]
}

/**
 * Ask the whole team about a person. Every fact from a real table; managers with
 * nothing to contribute stay silent. Read-only — reporting, never acting.
 */
export async function runTeamQuery(
  brokerageId: string,
  personQuery: string,
  opts: { now?: Date } = {},
  client?: Svc,
): Promise<TeamQueryResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()

  const { data: candidates } = await supabase.from("contacts")
    .select("id, first_name, last_name, nurture_status, intent_score, engagement_score, equity_estimate, referral_score, last_life_event_detected, updated_at")
    .eq("brokerage_id", brokerageId)
    .or(`first_name.ilike.%${personQuery.replace(/[%,()]/g, "")}%,last_name.ilike.%${personQuery.replace(/[%,()]/g, "")}%`)
    .limit(25)
  const contact = matchContactByName((candidates ?? []) as any[], personQuery)
  if (!contact) {
    return {
      found: false, contactId: null, contactName: null,
      spoken: `I checked with the whole team — nobody has a contact matching "${personQuery}". Want me to spell-check that or search leads instead?`,
      contributions: [],
    }
  }
  const name = [(contact as any).first_name, (contact as any).last_name].filter(Boolean).join(" ").trim() || "this client"
  const c: ManagerContribution[] = []

  const [saves, tours, showings, txns, gate, lastSent, talk, lastCall] = await Promise.all([
    supabase.from("saved_properties").select("property_address").eq("contact_id", contact.id).eq("dismissed", false).order("saved_at", { ascending: false }).limit(5),
    supabase.from("tours").select("id").eq("contact_id", contact.id).in("status", ["scheduled", "confirmed", "pending"]).limit(5),
    supabase.from("showings").select("id, scheduled_date").eq("contact_id", contact.id).gte("scheduled_date", now.toISOString().slice(0, 10)).limit(5),
    supabase.from("transactions").select("id, deal_name, stage, inspection_deadline, appraisal_deadline, financing_deadline")
      .or(`buyer_contact_id.eq.${contact.id},seller_contact_id.eq.${contact.id},contact_id.eq.${contact.id}`)
      .in("status", ["active", "under_contract", "closing"]).is("deleted_at", null).limit(5),
    supabase.from("agent_client_messages").select("id, subject").eq("recipient_contact_id", contact.id).eq("status", "proposed").limit(5),
    supabase.from("agent_client_messages").select("sent_at").eq("recipient_contact_id", contact.id).eq("status", "sent").not("sent_at", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("manager_signals").select("message, from_manager").eq("contact_id", contact.id).order("created_at", { ascending: false }).limit(2),
    supabase.from("ai_isa_calls").select("appointment_set, created_at").eq("contact_id", contact.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])

  // AI ISA — propensity + last dial.
  const { computeTransactionPropensity } = await import("@/lib/ai-isa/transaction-propensity")
  const daysSince = (iso: string | null) => (iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000) : null)
  const prop = computeTransactionPropensity({
    intentScore: (contact as any).intent_score, engagementScore: (contact as any).engagement_score,
    equityEstimate: (contact as any).equity_estimate, referralScore: (contact as any).referral_score,
    lifeEventDaysAgo: daysSince((contact as any).last_life_event_detected),
    lastActivityDaysAgo: daysSince((contact as any).updated_at),
  })
  if (prop.topReasons.length > 0) c.push({ manager: "ai_isa", line: `reads them as likely to transact — ${prop.topReasons.slice(0, 2).join(", ")}.` })
  if ((lastCall.data as any)?.appointment_set) c.push({ manager: "ai_isa", line: `my last dial with them booked an appointment.` })

  // Shopping Agent — saved homes + tours.
  const saveRows = (saves.data ?? []) as Array<{ property_address: string | null }>
  if (saveRows.length > 0) c.push({ manager: "shopping_agent", line: `they've saved ${saveRows.length} home${saveRows.length === 1 ? "" : "s"}, most recently ${saveRows[0].property_address ?? "one on file"}.` })
  if ((tours.data ?? []).length > 0) c.push({ manager: "shopping_agent", line: `${(tours.data ?? []).length} tour${(tours.data ?? []).length === 1 ? " is" : "s are"} on the books.` })

  // Listing Concierge — upcoming showings.
  if ((showings.data ?? []).length > 0) c.push({ manager: "listing_concierge", line: `they have ${(showings.data ?? []).length} upcoming showing${(showings.data ?? []).length === 1 ? "" : "s"} of our listings.` })

  // Deal Coordinator — live deals + next deadline + fire drill.
  const txRows = (txns.data ?? []) as any[]
  if (txRows.length > 0) {
    const t = txRows[0]
    const deadlines = [t.inspection_deadline, t.appraisal_deadline, t.financing_deadline].filter(Boolean).sort()
    c.push({ manager: "deal_coordinator", line: `${t.deal_name ?? "their deal"} is ${String(t.stage ?? "in flight").toLowerCase().replace(/_/g, " ")}${deadlines[0] ? `, next deadline ${deadlines[0]}` : ""}.` })
    const { data: drill } = await supabase.from("notifications").select("id")
      .eq("type", "fire_drill").in("entity_id", txRows.map((t2) => t2.id))
      .gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString()).limit(1).maybeSingle()
    if (drill) c.push({ manager: "deal_coordinator", line: `heads up — a fire drill ran on this deal in the last 24 hours; the save plan is in your notifications.` })
  }

  // Campaign Orchestrator — gate + last touch.
  const gateRows = (gate.data ?? []) as any[]
  if (gateRows.length > 0) c.push({ manager: "campaign_orchestrator", line: `${gateRows.length} message${gateRows.length === 1 ? " is" : "s are"} waiting on your approval for them.` })
  const sentAt = (lastSent.data as any)?.sent_at as string | null
  if (sentAt) {
    const days = Math.max(0, Math.floor((now.getTime() - new Date(sentAt).getTime()) / 86_400_000))
    c.push({ manager: "campaign_orchestrator", line: `they last heard from us ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}.` })
  }

  // Sphere — relationship state. Withdrawn = the team says so and recommends SILENCE.
  if ((contact as any).nurture_status === "withdrawn") {
    c.push({ manager: "sphere_of_influence", line: `this relationship is WITHDRAWN — every channel revoked; the team recommends no outreach unless they come to us.` })
  }

  // The bus — the managers' own recent talk.
  for (const t of ((talk.data ?? []) as any[]).slice(0, 1)) {
    const from = (t.from_manager in MANAGERS ? MANAGERS[t.from_manager as ManagerKey].label : t.from_manager)
    c.push({ manager: "campaign_orchestrator", line: `on the team bus, ${from} noted: ${t.message}` })
  }

  return { found: true, contactId: contact.id, contactName: name, spoken: composeTeamAnswer(name, c), contributions: c }
}
