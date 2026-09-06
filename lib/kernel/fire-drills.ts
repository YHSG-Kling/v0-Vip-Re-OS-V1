// lib/kernel/fire-drills.ts
//
// FIRE DRILLS — the 9pm save. Deadline watchers everywhere (ours included) ping
// "inspection due in 24h" and call it a day. A FIRE DRILL is what a great human team
// does instead: it notices the deadline is UNCOVERED — financing due with no
// clear-to-close, inspection due with nobody booked, appraisal due and never ordered —
// convenes the managers, and walks out with a SAVE PLAN:
//
//   · Deal Coordinator detects the gap (contingency live + prerequisite missing)
//   · Asset Manager brings the bench (the inspector who can still be booked)
//   · the lender's loan officer is named with the exact nudge to send
//   · Campaign Orchestrator drafts the client-calming note INTO THE GATE (human approves)
//   · the agent gets a CRITICAL briefing — in their CONFIGURED assistant voice on
//     EVERY tier (voice_assistant_config) — text only as the no-voice fallback
//
// Nothing autonomous touches the client; the drill's output is a plan + a draft. The
// drill publishes its audit line onto the manager bus (consumed inline — the work is
// done in the same pass) so the Command Center talk feed shows the team convening.
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { VENDOR_CATEGORY_INSPECTOR } from "@/lib/kernel/vendor-categories"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import {
  whisperTierCapability,
  resolveAssistantVoiceId,
  type WhisperSynthesizer,
} from "@/lib/intelligence/appointment-whisper"

type Svc = ReturnType<typeof createServiceClient>

/** How far ahead a live, uncovered contingency counts as a fire (48h). */
export const FIRE_DRILL_WINDOW_HOURS = 48

export type FireThreatKind = "inspection" | "appraisal" | "financing"

export interface FireThreat {
  kind: FireThreatKind
  deadline: string // ISO date
  hoursLeft: number
  /** What's missing — the reason this is a fire and not a reminder. */
  gap: string
  /** The save — the concrete move the team recommends. */
  save: string
}

export interface DealCoverage {
  inspectionDeadline: string | null
  appraisalDeadline: string | null
  financingDeadline: string | null
  inspectionContingencyRemoved: boolean
  appraisalContingencyRemoved: boolean
  financingContingencyRemoved: boolean
  /** A transaction_inspections row with a scheduled_date (not cancelled). */
  inspectionScheduled: boolean
  /** transaction_lenders.appraisal_ordered_date set. */
  appraisalOrdered: boolean
  /** Appraisal value/completion recorded (transactions or transaction_lenders). */
  appraisalCompleted: boolean
  /** transaction_lenders.clear_to_close_date set. */
  clearToClose: boolean
}

/** Pure: an uncovered deadline = contingency still live + deadline inside the window
 *  + the prerequisite work simply not done. A covered deadline is NOT a fire. */
export function detectUncoveredDeadlines(c: DealCoverage, now: Date): FireThreat[] {
  const threats: FireThreat[] = []
  const windowMs = FIRE_DRILL_WINDOW_HOURS * 3_600_000
  const hoursLeft = (deadline: string): number | null => {
    // DATE column → the fire burns until the END of the deadline day.
    const end = new Date(`${deadline}T23:59:59Z`).getTime() - now.getTime()
    if (end < 0 || end > windowMs) return null
    return Math.max(1, Math.round(end / 3_600_000))
  }

  if (c.inspectionDeadline && !c.inspectionContingencyRemoved && !c.inspectionScheduled) {
    const h = hoursLeft(c.inspectionDeadline)
    if (h !== null) threats.push({
      kind: "inspection", deadline: c.inspectionDeadline, hoursLeft: h,
      gap: "inspection contingency is live and NO inspection is on the books",
      save: "book an inspector now and (if needed) request a contingency extension today",
    })
  }
  if (c.appraisalDeadline && !c.appraisalContingencyRemoved && !c.appraisalOrdered && !c.appraisalCompleted) {
    const h = hoursLeft(c.appraisalDeadline)
    if (h !== null) threats.push({
      kind: "appraisal", deadline: c.appraisalDeadline, hoursLeft: h,
      gap: "appraisal contingency is live and the appraisal was never ordered",
      save: "call the lender to order the appraisal first thing and paper an extension",
    })
  }
  if (c.financingDeadline && !c.financingContingencyRemoved && !c.clearToClose) {
    const h = hoursLeft(c.financingDeadline)
    if (h !== null) threats.push({
      kind: "financing", deadline: c.financingDeadline, hoursLeft: h,
      gap: "financing contingency is live with no clear-to-close from the lender",
      save: "nudge the loan officer for status + get the extension request in writing",
    })
  }
  return threats
}

export interface FireDrillKnowledge {
  /** Asset Manager's bench: the inspector who can still be booked. */
  inspectorCandidate: string | null
  /** The lender's human, by name — who exactly to nudge. */
  loanOfficer: string | null
}

/** Pure: compose the agent briefing (the save plan) + the client-calming draft.
 *  Sections appear only for real facts — no fabricated vendors or people. */
export function composeFireDrill(input: {
  dealName: string
  clientName: string | null
  threats: FireThreat[]
  knowledge: FireDrillKnowledge
}): { title: string; agentBrief: string; clientSubject: string; clientBody: string } {
  const { dealName, clientName, threats, knowledge } = input
  const kinds = threats.map((t) => t.kind).join(" + ")

  const lines: string[] = []
  lines.push(`FIRE DRILL — ${dealName}: ${threats.length} uncovered deadline${threats.length === 1 ? "" : "s"} (${kinds}).`)
  for (const t of threats) {
    lines.push(`· ${t.kind.toUpperCase()} due ${t.deadline} (~${t.hoursLeft}h): ${t.gap}. The save: ${t.save}.`)
    if (t.kind === "inspection" && knowledge.inspectorCandidate) {
      lines.push(`  Asset Manager: ${knowledge.inspectorCandidate} is on the bench and can be booked.`)
    }
    if ((t.kind === "financing" || t.kind === "appraisal") && knowledge.loanOfficer) {
      lines.push(`  Deal Coordinator: your lender contact is ${knowledge.loanOfficer} — nudge them by name.`)
    }
  }
  lines.push(`A calming note${clientName ? ` to ${clientName}` : ""} is drafted in your approval queue — nothing sends until you approve.`)

  const clientBody = [
    `Hi${clientName ? ` ${clientName}` : ""} — a quick heads-up so you always know where things stand on ${dealName}.`,
    `We're working the upcoming ${kinds} deadline${threats.length === 1 ? "" : "s"} right now and have a plan in motion for each one.`,
    `Nothing is needed from you at this moment — I'll confirm as each piece lands, and you can reply here with any questions.`,
  ].join(" ")

  return {
    title: `🔥 Fire drill: ${dealName} — ${kinds} uncovered`,
    agentBrief: lines.join("\n"),
    clientSubject: `Where things stand on ${dealName} — we're on it`,
    clientBody,
  }
}

export interface FireDrillRunResult {
  drills: number
  threats: number
  clientDraftsProposed: number
  audio: number
  text: number
}

const defaultSynthesizer: WhisperSynthesizer = async (script, voiceId) => {
  try {
    const { synthesizeSpeechStream } = await import("@/lib/voice/elevenlabs-tts")
    const res = await synthesizeSpeechStream({ text: script, voiceId })
    return (res as { audioUrl?: string | null })?.audioUrl ?? null
  } catch { return null }
}

/**
 * Run fire drills for a brokerage: scan live deals for uncovered deadlines inside the
 * window, and for each, brief the agent (CRITICAL, assistant-voice audio on every tier) +
 * draft the client-calming note into the gate + leave the audit line on the bus.
 * Idempotent: one drill per transaction per 24h (notification-keyed).
 */
export async function runFireDrills(
  brokerageId: string,
  opts: { now?: Date; synthesizer?: WhisperSynthesizer } = {},
  client?: Svc,
): Promise<FireDrillRunResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const synthesizer = opts.synthesizer ?? defaultSynthesizer

  const { data: txns } = await supabase
    .from("transactions")
    .select("id, deal_name, client_name, status, agent_id, buyer_agent_id, seller_agent_id, contact_id, buyer_contact_id, seller_contact_id, deal_type, inspection_deadline, appraisal_deadline, financing_deadline, inspection_contingency_removed_at, appraisal_contingency_removed_at, financing_contingency_removed_at, appraisal_value, appraisal_completed_date")
    .eq("brokerage_id", brokerageId)
    .in("status", [...TRANSACTION_STATUSES_OPEN])
    .is("deleted_at", null)
    .or("inspection_deadline.not.is.null,appraisal_deadline.not.is.null,financing_deadline.not.is.null")
    .limit(200)

  let drills = 0, threatsTotal = 0, clientDraftsProposed = 0, audio = 0, text = 0

  for (const txn of (txns ?? []) as any[]) {
    // Coverage — every fact from a real table.
    const [{ data: inspections }, { data: lender }] = await Promise.all([
      supabase.from("transaction_inspections").select("scheduled_date, status")
        .eq("transaction_id", txn.id).not("scheduled_date", "is", null).neq("status", "cancelled").limit(1),
      supabase.from("transaction_lenders")
        .select("clear_to_close_date, appraisal_ordered_date, appraisal_completed_date, loan_officer_name, lender_name")
        .eq("transaction_id", txn.id).limit(1).maybeSingle(),
    ])
    const threats = detectUncoveredDeadlines({
      inspectionDeadline: txn.inspection_deadline,
      appraisalDeadline: txn.appraisal_deadline,
      financingDeadline: txn.financing_deadline,
      inspectionContingencyRemoved: !!txn.inspection_contingency_removed_at,
      appraisalContingencyRemoved: !!txn.appraisal_contingency_removed_at,
      financingContingencyRemoved: !!txn.financing_contingency_removed_at,
      inspectionScheduled: ((inspections ?? []) as any[]).length > 0,
      appraisalOrdered: !!(lender as any)?.appraisal_ordered_date,
      appraisalCompleted: !!txn.appraisal_completed_date || !!txn.appraisal_value || !!(lender as any)?.appraisal_completed_date,
      clearToClose: !!(lender as any)?.clear_to_close_date,
    }, now)
    if (threats.length === 0) continue

    // The agent to brief — transactions key agents.id; the notification needs the USER.
    const agentRowId = txn.agent_id ?? txn.buyer_agent_id ?? txn.seller_agent_id
    if (!agentRowId) continue
    const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", agentRowId).maybeSingle()
    const agentUserId = (agentRow as { user_id: string | null } | null)?.user_id
    if (!agentUserId) continue

    // Idempotency — one drill per transaction per 24h.
    const { data: already } = await supabase.from("notifications").select("id")
      .eq("type", "fire_drill").eq("entity_id", txn.id)
      .gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString())
      .limit(1).maybeSingle()
    if (already) continue

    // Asset Manager's bench: the best inspector we actually have (only for inspection fires).
    let inspectorCandidate: string | null = null
    if (threats.some((t) => t.kind === "inspection")) {
      const { data: vend } = await supabase.from("vendors").select("name")
        .eq("brokerage_id", brokerageId).eq("category", VENDOR_CATEGORY_INSPECTOR)
        .order("rating", { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      inspectorCandidate = (vend as { name: string } | null)?.name ?? null
    }
    const loanOfficer = (lender as any)?.loan_officer_name ?? (lender as any)?.lender_name ?? null

    const composed = composeFireDrill({
      dealName: txn.deal_name ?? "your deal",
      clientName: txn.client_name ?? null,
      threats,
      knowledge: { inspectorCandidate, loanOfficer },
    })

    // The client-calming draft → THE GATE (human approves; nothing autonomous).
    const recipientContactId = txn.buyer_contact_id ?? txn.seller_contact_id ?? txn.contact_id
    if (recipientContactId) {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId, agentKind: "deal_coordinator", entityType: "transaction",
        entityId: txn.id, recipientContactId,
        audience: txn.buyer_contact_id ? "buyer" : "seller",
        subject: composed.clientSubject, body: composed.clientBody,
        rationale: `FIRE DRILL — uncovered ${threats.map((t) => t.kind).join("+")} deadline(s) on ${txn.deal_name}; client kept calm + informed while the team executes the save.`,
        channel: "portal",
      }, supabase)
      if (res.ok) clientDraftsProposed += 1
    }

    // Briefing in the user's CONFIGURED assistant voice — audio on EVERY tier.
    const { data: usr } = await supabase.from("users").select("user_type, brokerage_id, team_id").eq("id", agentUserId).maybeSingle()
    const { mapUserTypeToTier } = await import("@/lib/kernel/0.1-feature-access")
    const tier = mapUserTypeToTier((usr as any)?.user_type ?? "agent", (usr as any)?.brokerage_id ?? undefined, (usr as any)?.team_id ?? undefined)
    let audioUrl: string | null = null
    if (whisperTierCapability(tier) === "audio") {
      const voiceId = await resolveAssistantVoiceId(supabase, agentUserId)
      if (voiceId) audioUrl = await synthesizer(composed.agentBrief, voiceId)
    }

    const { error: notifErr } = await supabase.from("notifications").insert({
      user_id: agentUserId, brokerage_id: brokerageId, type: "fire_drill",
      title: composed.title,
      body: audioUrl ? `${composed.agentBrief}\n\n▶ Listen: ${audioUrl}` : composed.agentBrief,
      entity_type: "transaction", entity_id: txn.id, priority: "critical", is_read: false,
    })
    if (notifErr) continue
    drills += 1
    threatsTotal += threats.length
    if (audioUrl) audio += 1; else text += 1

    // Audit line on the bus — the talk feed shows the team convening. The work is done
    // in this same pass, so the signal is consumed inline (no dangling open business).
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const pub = await publishManagerSignal({
      brokerageId, fromManager: "deal_coordinator", toManager: "campaign_orchestrator",
      signalType: "fire_drill_opened",
      message: `Fire drill on ${txn.deal_name}: ${threats.map((t) => `${t.kind} uncovered (due ${t.deadline})`).join(", ")} — agent briefed, save plan issued, calming draft in the gate.`,
      entityType: "transaction", entityId: txn.id,
    }, supabase)
    if (pub.ok && pub.signalId && !pub.reason) {
      await supabase.from("manager_signals")
        .update({ status: "consumed", consumed_at: now.toISOString(), consumed_action: "fire drill executed: agent briefed (critical) + client-calming draft proposed into the gate" })
        .eq("id", pub.signalId)
    }
  }

  return { drills, threats: threatsTotal, clientDraftsProposed, audio, text }
}
