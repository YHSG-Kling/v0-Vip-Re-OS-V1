// lib/lead-pipeline/reactivation-cadence-runner.ts
//
// Live side of the REACTIVATION CADENCE (the escalating, self-limiting re-engagement ladder).
// For each dormant assigned contact it computes days-since-last-touch, reconstructs which rungs
// have already fired (from prior proposals + escalation signals), asks the pure engine for the
// next due step, and executes exactly that one:
//   STEP 1/2 → propose ONE gated client message (email, then SMS) — the consent gate AND the
//              channel-preference gate run downstream in approveClientMessage, so a contact who
//              asked for email-only never gets the SMS rung dispatched.
//   STEP 3   → escalate: notify the responsible human + raise an ai_isa bus signal, then HOLD
//              (the marker means the engine stops auto-touching this contact).
// Idempotent per (contact, step). Read-mostly; never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planReactivationStep, reactivationFallbackCopy, reactivationAudience, followupSuppresses, type ReactivationThresholds } from "./reactivation-cadence"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface ReactivationRunInput {
  brokerageId: string
  now?: string
  thresholds?: Partial<ReactivationThresholds>
  copyGenerator?: CopyGenerator
  limit?: number
}

export interface ReactivationRunResult {
  scanned: number
  emailed: number
  texted: number
  mailed: number
  escalated: number
  held: number
}

const STEP_KEY = (contactId: string, step: number) => `REACTIVATION step:${step} — contact:${contactId}`

export async function runReactivationCadence(input: ReactivationRunInput, client?: Svc): Promise<ReactivationRunResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const out: ReactivationRunResult = { scanned: 0, emailed: 0, texted: 0, mailed: 0, escalated: 0, held: 0 }
  const nowMs = new Date(now).getTime()

  // Assigned, contactable, re-engage-allowed contacts. (last_contacted_at IS a live column —
  // the legacy stale-contact cron's created_at proxy predates it; this cadence uses the real one.)
  const { data: contacts } = await svc
    .from("contacts")
    .select("id, first_name, last_name, contact_type, agent_id, status, dnc_status, isa_reengage_allowed, last_contacted_at, created_at, next_followup_at, phone, tcpa_consent, sms_opt_out, mailing_address_verified, direct_mail_opt_out")
    .eq("brokerage_id", input.brokerageId)
    .not("agent_id", "is", null)
    .eq("dnc_status", false)
    .neq("status", "archived")
    .neq("status", "inactive")
    .not("isa_reengage_allowed", "eq", false)
    .limit(input.limit ?? 200)

  // One active reactivation preset for the brokerage — enables the direct-mail rung when a
  // contact's SMS isn't viable but they have a deliverable address (channel-by-disposition).
  const { data: preset } = await svc
    .from("direct_mail_presets").select("id")
    .eq("brokerage_id", input.brokerageId).eq("is_active", true).limit(1).maybeSingle()
  const presetId = (preset as any)?.id ?? null

  for (const row of (contacts ?? []) as any[]) {
    // Honor an explicit future-intent date — if they asked to be reached later, don't nag yet.
    if (followupSuppresses(row.next_followup_at, now)) continue
    const lastTouch = row.last_contacted_at ?? row.created_at
    if (!lastTouch) continue
    const daysDormant = Math.floor((nowMs - new Date(lastTouch).getTime()) / 86_400_000)
    if (daysDormant < 7) continue // cheap pre-filter; engine re-checks against thresholds
    out.scanned++

    // Reconstruct completed rungs: steps 1/2 from prior proposals, step 3 from the escalation signal.
    const { data: priorMsgs } = await svc
      .from("agent_client_messages")
      .select("rationale")
      .eq("brokerage_id", input.brokerageId)
      .eq("entity_id", row.id)
      .ilike("rationale", "REACTIVATION step:%")
    const completedSteps: number[] = []
    for (const m of (priorMsgs ?? []) as any[]) {
      const mt = /REACTIVATION step:(\d)/.exec(m.rationale ?? "")
      if (mt) completedSteps.push(Number(mt[1]))
    }
    const { count: escCount } = await svc
      .from("manager_signals")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", row.id)
      .eq("signal_type", "reactivation_escalation")
    if ((escCount ?? 0) > 0) completedSteps.push(3)

    const plan = planReactivationStep({ daysDormant, completedSteps, thresholds: input.thresholds })
    if (!plan.due) { out.held++; continue }

    const firstName = row.first_name ?? null
    if (plan.action === "email" || plan.action === "sms") {
      const step = plan.step as 1 | 2
      // CHANNEL-BY-DISPOSITION (contacts are full-multichannel): step 1 is email; step 2 prefers
      // a direct SMS, but when SMS isn't viable (no consented/reachable line) it reaches for
      // DIRECT MAIL if there's a deliverable address + an active preset, else falls back to email.
      let channel: "email" | "sms" | "direct_mail" = plan.action
      if (plan.action === "sms") {
        const smsViable = !!row.phone && row.tcpa_consent === true && row.sms_opt_out !== true && row.dnc_status !== true
        const mailViable = !!presetId && row.mailing_address_verified === true && row.direct_mail_opt_out !== true
        channel = smsViable ? "sms" : (mailViable ? "direct_mail" : "email")
      }
      const fallback = reactivationFallbackCopy(step, firstName)
      const audience = reactivationAudience(row.contact_type)

      let subject = fallback.subject
      let body = fallback.body
      if (channel === "direct_mail") {
        // The preset carries the locked copy; the approve path reads 'preset:<id>' from subject.
        subject = `preset:${presetId}`
      } else {
        const { loadContactPersona } = await import("@/lib/kernel/ai-copy")
        const persona = await loadContactPersona(svc, row.id).catch(() => ({ audience }))
        const draft = await generatePersonaCopy(
          {
            goal: `a brief, warm, no-pressure re-engagement ${channel === "email" ? "email" : "text"} to a contact who has gone quiet for ${daysDormant} days — invite them to pick back up, make it easy to say "later"`,
            facts: [fallback.body],
            channel: channel === "email" ? "email" : "sms",
            persona: { ...persona, situation: "dormant contact reactivation" },
            words: channel === "email" ? 80 : 40,
          },
          { subject: fallback.subject, body: fallback.body },
          { generator: input.copyGenerator },
        )
        subject = draft.subject ?? fallback.subject
        body = draft.body
      }
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage(
        {
          brokerageId: input.brokerageId,
          agentKind: "ai_isa",
          entityType: "contact",
          entityId: row.id,
          recipientContactId: row.id,
          audience,
          subject,
          body,
          rationale: `${STEP_KEY(row.id, step)} — ${plan.reason} (channel:${channel})`,
          channel,
        },
        svc,
      )
      if (res.ok) { if (channel === "email") out.emailed++; else if (channel === "sms") out.texted++; else out.mailed++ }
    } else if (plan.action === "escalate") {
      // Hand to the responsible human + raise the bus signal that marks step 3 done (→ HOLD).
      try {
        const name = `${firstName ?? ""} ${row.last_name ?? ""}`.trim() || "A contact"
        if (row.agent_id) {
          await svc.from("notifications").insert({
            user_id: row.agent_id, brokerage_id: input.brokerageId, type: "reactivation_escalation",
            title: `${name} has gone quiet — your call`,
            body: `${name} hasn't responded through the ${daysDormant}-day re-engagement cadence (email + text). The system is standing down to avoid over-nagging — a personal touch from you is the next best move.`,
            entity_type: "contact", entity_id: row.id, priority: "high", is_read: false,
          })
        }
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId: input.brokerageId, fromManager: "ai_isa", toManager: "ai_isa",
          signalType: "reactivation_escalation",
          message: `${name} unresponsive through the full reactivation cadence (${daysDormant}d). Escalated to the responsible agent; auto-touching halted.`,
          entityType: "contact", entityId: row.id,
          payload: { daysDormant },
        }, svc)
        out.escalated++
      } catch { /* best-effort */ }
    }
  }

  return out
}
