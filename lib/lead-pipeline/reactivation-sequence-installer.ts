// lib/lead-pipeline/reactivation-sequence-installer.ts
//
// Installs (idempotently) the AI-ISA REACTIVATION sequence into the REAL multi-channel sequencer
// — replacing the hand-built ladder runners. Reactivation is now a campaign_sequence the existing
// step-executor drives across channels, with de-confliction, the shared touch ledger, and
// response-driven stop all for free. Each step carries an ai_intent, so the copy is GENERATED from
// the person's persona + Fair-Housing-safe enrichment (renderSequenceStep) — never a hardcoded
// template. The executor's lead-only gate restricts a LEAD enrollment to email/direct-mail
// automatically, so ONE sequence serves both contacts (full palette) and leads (email-only rungs).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Stable marker so the installer is idempotent per brokerage. */
export const REACTIVATION_TRIGGER = "ai_isa_reactivation"

interface StepSeed {
  step_number: number
  step_name: string
  channel: string
  delay_days: number
  /** The INTENT only — the copy itself is GENERATED per-person from persona + Fair-Housing-safe
   *  enrichment at send time (renderSequenceStep). No hardcoded subject/body lives on the step;
   *  if generation ever fails, the adapter skips rather than sending filler. */
  ai_intent: string
}

// Multi-channel, persona-driven. delay_days is relative to the PREVIOUS step. Leads auto-skip the
// sms + voice_drop rungs (lead-only gate + the executor's TCPA gate, enforced per step) and reach
// the email rungs; sequence completion fires the kernel's ISA_MAX_TOUCHES_REACHED escalation for
// BOTH. The VOICE DROP rung (2026-07 omnichannel directive) rides the canonical voicedrop rail —
// the brokerage's active preset with the step's situational script; no preset = an honest per-step
// error and the sequence advances. Remaining richer rungs (direct mail, video-email, FB retarget)
// extend this SAME sequence as their per-brokerage assets land.
const STEPS: StepSeed[] = [
  {
    step_number: 1, step_name: "Warm re-intro email", channel: "email", delay_days: 0,
    ai_intent: "a warm, no-pressure check-in re-engaging someone who's gone quiet — leave the door open, make it easy to reply 'later'",
  },
  {
    step_number: 2, step_name: "Friendly text nudge", channel: "sms", delay_days: 7,
    ai_intent: "a brief, friendly text nudge to reconnect — one line, no pressure",
  },
  {
    step_number: 3, step_name: "Value-forward email", channel: "email", delay_days: 7,
    ai_intent: "a short, value-forward second email — offer something genuinely helpful (a quick market read, or a simple question) while staying low-pressure",
  },
  {
    step_number: 4, step_name: "Ringless voicemail — a human voice", channel: "voice_drop", delay_days: 7,
    ai_intent: "a warm, 20-second ringless voicemail in the agent's voice for someone who hasn't answered email or text — acknowledge life gets busy, offer one genuinely helpful thing, no pressure, easy callback",
  },
  {
    step_number: 5, step_name: "AI ISA reconnect call — a real conversation", channel: "ai_call", delay_days: 12,
    ai_intent: "a warm, unhurried reconnect call: acknowledge it's been a while, ask what changed in their plans, listen more than pitch, and offer ONE concrete next step (fresh listings matched to what they wanted, or a quick market read for their area). If voicemail, leave a 15-second human-sounding message. Never pressure — the goal is a conversation, not a booking.",
  },
]

/**
 * Ensure the brokerage has the AI-ISA reactivation sequence (+ its steps). Idempotent — returns the
 * existing sequence id when already installed. Never throws into the caller.
 */
export async function ensureReactivationSequence(brokerageId: string, client?: Svc): Promise<{ sequenceId: string | null; created: boolean; error?: string }> {
  const svc = client ?? createServiceClient()

  const { data: existing } = await svc
    .from("campaign_sequences")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("trigger_event", REACTIVATION_TRIGGER)
    .eq("sequence_type", "reactivation")
    .maybeSingle()
  if (existing) {
    // UPGRADE PATH: a previously-installed sequence gains any NEW rungs
    // (idempotent per step_number) — live tenants get the voice-drop rung
    // without a reinstall; enrolled contacts pick it up as they advance.
    const existingId = (existing as any).id as string
    try {
      const { data: haveSteps } = await svc
        .from("campaign_sequence_steps")
        .select("step_number")
        .eq("sequence_id", existingId)
      const have = new Set(((haveSteps ?? []) as Array<{ step_number: number }>).map((s) => s.step_number))
      const missing = STEPS.filter((s) => !have.has(s.step_number))
      if (missing.length > 0) {
        await svc.from("campaign_sequence_steps").insert(
          missing.map((s) => ({ sequence_id: existingId, is_active: true, delay_hours: 0, ...s })),
        )
      }
    } catch { /* upgrade is best-effort — the sequence keeps running as-is */ }
    return { sequenceId: existingId, created: false }
  }

  const { data: seq, error: seqErr } = await svc
    .from("campaign_sequences")
    .insert({
      brokerage_id: brokerageId,
      name: "AI ISA Reactivation",
      description: "Multi-channel, persona-driven re-engagement for quiet contacts & leads. Stops the moment they reply.",
      trigger_event: REACTIVATION_TRIGGER,
      sequence_type: "reactivation",
      is_active: true,
      compliance_gated: true,
    })
    .select("id")
    .single()
  if (seqErr || !seq) return { sequenceId: null, created: false, error: seqErr?.message ?? "sequence insert failed" }
  const sequenceId = (seq as any).id

  const rows = STEPS.map((s) => ({ sequence_id: sequenceId, is_active: true, delay_hours: 0, ...s }))
  const { error: stepErr } = await svc.from("campaign_sequence_steps").insert(rows)
  if (stepErr) {
    // Roll back the orphan sequence so a retry re-installs cleanly.
    await svc.from("campaign_sequences").delete().eq("id", sequenceId).then(() => {}, () => {})
    return { sequenceId: null, created: false, error: `steps insert failed: ${stepErr.message}` }
  }

  return { sequenceId, created: true }
}
