// lib/lead-pipeline/lead-reactivation-cadence-runner.ts
//
// Live side of the STALE-LEAD REACTIVATION LADDER (AI ISA). Scans AI-ISA-owned, unconverted,
// contactable leads; honors an explicit future-intent date; reconstructs which rungs have fired;
// and executes the next due rung via the GOVERNED message loop (m231 lead-recipient support):
//   STEP 1/2 → propose ONE human-approved touch (email; step 2 prefers DIRECT MAIL, downgrading
//              to a second email when there's no active preset / no deliverable address / opt-out).
//   STEP 3   → escalate to the responsible human + raise an ai_isa bus signal, then HOLD.
// Leads use the approved pre-consent channels ONLY (email + direct mail). Idempotent per
// (lead, step). Read-mostly; never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planLeadReactivationStep, leadReactivationCopy } from "./lead-reactivation-cadence"
import { followupSuppresses, type ReactivationThresholds } from "./reactivation-cadence"
import { type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface LeadReactivationRunInput {
  brokerageId: string
  now?: string
  thresholds?: Partial<ReactivationThresholds>
  copyGenerator?: CopyGenerator
  limit?: number
}

export interface LeadReactivationRunResult {
  scanned: number
  emailed: number
  mailed: number
  escalated: number
}

const STEP_KEY = (leadId: string, step: number) => `LEAD REACTIVATION step:${step} — lead:${leadId}`

export async function runLeadReactivationCadence(input: LeadReactivationRunInput, client?: Svc): Promise<LeadReactivationRunResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const out: LeadReactivationRunResult = { scanned: 0, emailed: 0, mailed: 0, escalated: 0 }
  const nowMs = new Date(now).getTime()

  const { data: leads } = await svc
    .from("leads")
    .select("id, first_name, last_name, email, agent_id, status, lifecycle_state, email_opt_out, direct_mail_opt_out, mailing_address_verified, last_contacted_at, created_at, next_followup_at")
    .eq("brokerage_id", input.brokerageId)
    .eq("ai_isa_owner", true)
    .neq("lifecycle_state", "converted")
    .not("status", "in", '("archived","inactive","dead")')
    .limit(input.limit ?? 200)

  // One active reactivation preset for the brokerage (direct-mail rung needs a designed piece).
  const { data: preset } = await svc
    .from("direct_mail_presets")
    .select("id")
    .eq("brokerage_id", input.brokerageId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle()
  const presetId = (preset as any)?.id ?? null

  for (const row of (leads ?? []) as any[]) {
    if (followupSuppresses(row.next_followup_at, now)) continue // honor explicit "reach me later"
    const lastTouch = row.last_contacted_at ?? row.created_at
    if (!lastTouch) continue
    const daysDormant = Math.floor((nowMs - new Date(lastTouch).getTime()) / 86_400_000)
    if (daysDormant < 10) continue
    out.scanned++

    const { data: priorMsgs } = await svc
      .from("agent_client_messages")
      .select("rationale")
      .eq("brokerage_id", input.brokerageId)
      .eq("recipient_lead_id", row.id)
      .ilike("rationale", "LEAD REACTIVATION step:%")
    const completedSteps: number[] = []
    for (const m of (priorMsgs ?? []) as any[]) {
      const mt = /LEAD REACTIVATION step:(\d)/.exec(m.rationale ?? "")
      if (mt) completedSteps.push(Number(mt[1]))
    }
    const { count: escCount } = await svc
      .from("manager_signals")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", row.id)
      .eq("signal_type", "lead_reactivation_escalation")
    if ((escCount ?? 0) > 0) completedSteps.push(3)

    const plan = planLeadReactivationStep({ daysDormant, completedSteps, thresholds: input.thresholds })
    if (!plan.due) continue

    const firstName = row.first_name ?? null
    if (plan.action === "email" || plan.action === "direct_mail") {
      const step = plan.step as 1 | 2
      // Step 2 prefers direct mail, but only when it can actually be fulfilled; otherwise a second
      // email (both are approved lead channels) so the ladder still advances.
      const canMail = plan.action === "direct_mail" && !!presetId && row.direct_mail_opt_out !== true && row.mailing_address_verified === true
      const channel: "email" | "direct_mail" = canMail ? "direct_mail" : "email"
      // Email rung still needs a deliverable address-free path: skip if email not possible either.
      if (channel === "email" && (!row.email || row.email_opt_out === true)) continue

      const fallback = leadReactivationCopy(step, firstName)
      let subject = fallback.subject
      let body = fallback.body
      if (channel === "email") {
        // Persona+enrichment-grounded copy from the LEADS table (frozen once converted): the
        // intent is the goal, the lead's Fair-Housing-safe enriched facts ground the generation.
        const { generateEntityStepCopy } = await import("@/lib/campaign-sequences/persona-render-runner")
        const draft = await generateEntityStepCopy({
          svc, entity: "lead", id: row.id,
          intent: `a brief, warm, no-pressure re-engagement email to a real-estate lead who has gone quiet for ${daysDormant} days — leave the door open, make it easy to reply "later"`,
          channel: "email",
          words: 80,
          fallback: { subject: fallback.subject, body: fallback.body },
          generator: input.copyGenerator,
        })
        subject = draft.subject ?? fallback.subject
        body = draft.body
      } else {
        // direct mail carries the preset id in the subject (the approve path reads 'preset:<id>').
        subject = `preset:${presetId}`
      }

      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage(
        {
          brokerageId: input.brokerageId,
          agentKind: "ai_isa",
          entityType: "lead",
          entityId: row.id,
          recipientLeadId: row.id,
          audience: "lead",
          subject,
          body,
          rationale: `${STEP_KEY(row.id, step)} — ${plan.reason} (channel:${channel})`,
          channel,
        },
        svc,
      )
      if (res.ok) { if (channel === "direct_mail") out.mailed++; else out.emailed++ }
    } else if (plan.action === "escalate") {
      try {
        const name = `${firstName ?? ""} ${row.last_name ?? ""}`.trim() || "A lead"
        if (row.agent_id) {
          await svc.from("notifications").insert({
            user_id: row.agent_id, brokerage_id: input.brokerageId, type: "lead_reactivation_escalation",
            title: `${name} hasn't re-engaged — your call`,
            body: `${name} stayed quiet through the ${daysDormant}-day lead reactivation ladder (email + mail). The system is standing down to avoid over-nagging — a personal note from you is the next best move.`,
            entity_type: "lead", entity_id: row.id, priority: "medium", is_read: false,
          })
        }
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId: input.brokerageId, fromManager: "ai_isa", toManager: "ai_isa",
          signalType: "lead_reactivation_escalation",
          message: `${name} unresponsive through the full lead reactivation ladder (${daysDormant}d). Escalated; auto-touching halted.`,
          entityType: "lead", entityId: row.id,
          payload: { daysDormant },
        }, svc)
        out.escalated++
      } catch { /* best-effort */ }
    }
  }

  return out
}
