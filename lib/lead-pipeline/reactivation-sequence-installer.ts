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
// sms rung (lead-only gate) and reach the email rungs; sequence completion fires the kernel's
// ISA_MAX_TOUCHES_REACHED escalation for BOTH. Richer rungs (direct mail, voice drop, video-email,
// FB retarget) extend this same sequence once their per-brokerage assets are configured.
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
  if (existing) return { sequenceId: (existing as any).id, created: false }

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
