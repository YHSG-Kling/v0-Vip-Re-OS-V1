/**
 * lib/campaign-sequences/step-executor.ts
 *
 * Executes a single sequence step for one enrollment.
 *
 * Pipeline:
 *   1. Fetch enrollment + step
 *   2. Compliance gate (authority check)
 *   3. Channel-level gates (TCPA, feature flags)
 *   4. Load context (contact, agent, previous step outputs)
 *   5. Resolve variables ({{contact.x}}, {{step_1.image_url}}, etc.)
 *   6. Dispatch via channel registry (ChannelAdapter.execute)
 *   7. Write step_output to enrollment.step_outputs[output_variable_name]
 *   8. Audit log (workflow_step_runs + sequence_step_executions + isa_outreach_log)
 *   9. Emit kernel events
 *  10. Advance enrollment to next step
 *
 * All channels are dispatched through the registry — no switch statements.
 */

// Bootstrap registry (side-effect import registers all adapters)
import "@/lib/workflow/adapters/index"

import { createServiceClient } from "@/lib/supabase/service"
import { registry }            from "@/lib/workflow/channel-registry"
import type { StepContext, StepResult } from "@/lib/workflow/channel-registry"
import { buildVariableContext, resolveVariables } from "@/lib/workflow/variables"
import { checkSequenceAuthority }  from "./compliance-gate"
import { KernelEvent }             from "@/lib/kernel/events"
import { processKernelEvent }      from "@/lib/kernel/notification-engine"

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExecuteResult {
  status: "sent" | "skipped" | "authority_blocked" | "no_next_step" | "completed" | "error"
  reason?: string
  messageId?: string
}

// ─── Channels that need TCPA consent ─────────────────────────────────────────

const TCPA_CHANNELS = new Set(["sms", "voice_drop", "ai_call"])

// ─── Channels that need a feature flag ───────────────────────────────────────

const FEATURE_FLAGGED_CHANNELS: Record<string, string> = {
  video:               "video_campaigns",
  direct_mail:         "direct_mail_campaigns",
  ad_campaign:         "ad_campaigns",
  listing_landing_page:"listing_landing_pages",
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeSequenceStep(
  enrollmentId: string
): Promise<ExecuteResult> {
  const supabase = createServiceClient()
  const startedAt = Date.now()

  // ── Step 1: Fetch enrollment ───────────────────────────────────────────────
  const { data: enrollment, error: enrollErr } = await supabase
    .from("sequence_enrollments")
    .select("id, sequence_id, contact_id, lead_id, current_step, status, brokerage_id, ab_variant, step_outputs")
    .eq("id", enrollmentId)
    .single()

  if (enrollErr || !enrollment) {
    return { status: "error", reason: `Enrollment not found: ${enrollErr?.message}` }
  }

  const brokerageId: string = enrollment.brokerage_id
  const contactId: string | null = enrollment.contact_id
  const previousOutputs: Record<string, Record<string, unknown>> = enrollment.step_outputs ?? {}

  // ── Step 2: Fetch next step ────────────────────────────────────────────────
  const nextStepNumber = (enrollment.current_step ?? 0) + 1

  const { data: step, error: stepErr } = await supabase
    .from("campaign_sequence_steps")
    .select("*")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_number", nextStepNumber)
    .eq("is_active", true)
    .maybeSingle()

  if (stepErr) {
    return { status: "error", reason: `Step fetch error: ${stepErr.message}` }
  }

  if (!step) {
    await supabase
      .from("sequence_enrollments")
      .update({ status: "completed", completed_at: new Date().toISOString(), next_step_at: null })
      .eq("id", enrollmentId)

    await processKernelEvent({
      event: KernelEvent.ISA_MAX_TOUCHES_REACHED,
      brokerageId,
      entityType: "contact",
      entityId: contactId ?? enrollmentId,
      suppressEnrollment: true,
    }).catch(() => {})

    return { status: "completed" }
  }

  // ── Step 3: Sequence creator user id ──────────────────────────────────────
  const { data: seqRow } = await supabase
    .from("campaign_sequences")
    .select("created_by")
    .eq("id", enrollment.sequence_id)
    .single()
  const userId = seqRow?.created_by ?? brokerageId

  // ── Step 4: Compliance gate ────────────────────────────────────────────────
  if (contactId) {
    const gateResult = await checkSequenceAuthority(
      contactId,
      step.channel,
      { brokerageId, userId },
      supabase
    )

    if (!gateResult.allowed) {
      await supabase.from("sequence_step_executions").insert({
        enrollment_id: enrollmentId,
        sequence_id: enrollment.sequence_id,
        step_id: step.id,
        contact_id: contactId,
        channel: step.channel,
        status: "authority_blocked",
        blocked_reason: gateResult.reason ?? "Authority gate blocked",
        sent_at: null,
      })

      await processKernelEvent({
        event: KernelEvent.AUTHORITY_BLOCKED,
        brokerageId,
        entityType: "contact",
        entityId: contactId,
        suppressEnrollment: true,
      }).catch(() => {})

      return { status: "authority_blocked", reason: gateResult.reason }
    }
  }

  // ── Step 5: Channel-level gates ────────────────────────────────────────────

  // TCPA consent for SMS/voice_drop/ai_call
  if (TCPA_CHANNELS.has(step.channel) && contactId) {
    const { data: contactRow } = await supabase
      .from("contacts")
      .select("tcpa_consent, dnc_status")
      .eq("id", contactId)
      .single()

    if (!contactRow?.tcpa_consent || contactRow?.dnc_status) {
      await logAndSkip(supabase, { enrollmentId, enrollment, step, contactId, reason: "SMS/voice: No TCPA consent or DNC" })
      return await advanceEnrollment(supabase, enrollment, step, "skipped")
    }
  }

  // Feature flag gate
  const featureKey = FEATURE_FLAGGED_CHANNELS[step.channel]
  if (featureKey) {
    const { data: flag } = await supabase
      .from("feature_flags")
      .select("enabled, superadmin_only")
      .eq("feature_key", featureKey)
      .maybeSingle()

    if (!flag?.enabled || flag?.superadmin_only) {
      await logAndSkip(supabase, { enrollmentId, enrollment, step, contactId, reason: `Feature flag locked: ${featureKey}` })
      return await advanceEnrollment(supabase, enrollment, step, "skipped")
    }
  }

  // ── Step 6: Load contact + agent ───────────────────────────────────────────
  let contact: Record<string, any> | null = null
  let agentUserId: string | null = null
  let agentId: string | null = null

  if (contactId) {
    const { data } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, mailing_address, city, state, zip, agent_id")
      .eq("id", contactId)
      .single()
    contact = data

    if (data?.agent_id) {
      agentId = data.agent_id
      const { data: a } = await supabase
        .from("agents").select("user_id").eq("id", data.agent_id).maybeSingle()
      agentUserId = a?.user_id ?? null
    }
  }

  // ── Step 7: Build variable context + resolve template strings ──────────────
  const varCtx = buildVariableContext({
    contact: contact ?? undefined,
    enrollment: {
      id: enrollmentId,
      sequence_id: enrollment.sequence_id,
      brokerage_id: brokerageId,
    },
    stepOutputs: previousOutputs,
  })

  // Pre-resolve commonly used fields from the step that may contain {{variables}}
  const resolvedVars: Record<string, string> = {}
  const templateFields = [
    "subject", "body", "image_prompt", "social_caption_prompt",
    "qr_target_url_pattern", "listing_page_slug", "voice_drop_script",
    "video_script", "task_title", "task_notes_prompt", "ad_audience_prompt",
    "showing_notes", "tour_start_address",
  ]
  for (const field of templateFields) {
    const raw = step[field]
    if (typeof raw === "string" && raw.includes("{{")) {
      resolvedVars[field] = resolveVariables(raw, varCtx)
    }
  }

  // ── Step 8: Build StepContext and dispatch via registry ────────────────────
  const stepRunId = crypto.randomUUID()
  const stepCtx: StepContext = {
    enrollmentId,
    step,
    contact: contact as any,
    brokerageId,
    agentUserId,
    agentId,
    resolvedVars,
    previousOutputs,
    supabase,
  }

  // Write running row to workflow_step_runs
  void Promise.resolve(supabase.from("workflow_step_runs").insert({
    id: stepRunId,
    enrollment_id: enrollmentId,
    step_id: step.id,
    channel: step.channel,
    status: "running",
    output_variable_name: step.output_variable_name ?? null,
    started_at: new Date().toISOString(),
  })).catch(() => {})

  const dispatchResult: StepResult = await registry.dispatch(step.channel, stepCtx)

  const now = new Date().toISOString()
  const durationMs = Date.now() - startedAt
  const executionStatus = dispatchResult.status === "sent" ? "sent" : "failed"

  // ── Step 9: Write step output to enrollment.step_outputs ───────────────────
  if (dispatchResult.output && step.output_variable_name) {
    const stepKey = `step_${nextStepNumber}` // "step_1", "step_2"
    const namedKey = step.output_variable_name  // e.g. "hero_image"

    const updatedOutputs = {
      ...previousOutputs,
      [stepKey]:  dispatchResult.output,
      [namedKey]: dispatchResult.output,
    }

    void Promise.resolve(
      supabase.from("sequence_enrollments")
        .update({ step_outputs: updatedOutputs })
        .eq("id", enrollmentId)
    ).catch(() => {})
  }

  // ── Step 10: Update workflow_step_runs ─────────────────────────────────────
  void Promise.resolve(
    supabase.from("workflow_step_runs").update({
      status: dispatchResult.status === "sent" ? "sent" : "failed",
      step_output: dispatchResult.output ?? null,
      provider_key: dispatchResult.providerKey,
      provider_message_id: dispatchResult.messageId ?? null,
      blocked_reason: dispatchResult.error ?? null,
      finished_at: now,
      duration_ms: durationMs,
    }).eq("id", stepRunId)
  ).catch(() => {})

  // ── Step 11: sequence_step_executions audit row ────────────────────────────
  await supabase.from("sequence_step_executions").insert({
    enrollment_id: enrollmentId,
    sequence_id: enrollment.sequence_id,
    step_id: step.id,
    contact_id: contactId,
    channel: step.channel,
    status: executionStatus,
    provider_message_id: dispatchResult.messageId ?? null,
    sent_at: dispatchResult.status === "sent" ? now : null,
    blocked_reason: dispatchResult.error ?? null,
  })

  // ── Step 12: isa_outreach_log + message_provider_logs ─────────────────────
  let isaOutreachLogId: string | null = null
  let finalLeadId: string | null = enrollment.lead_id ?? null
  if (!finalLeadId && contactId) {
    const { data: leadRow } = await supabase
      .from("leads").select("id").eq("contact_id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
    finalLeadId = leadRow?.id ?? null
  }

  if (finalLeadId) {
    const { data: outreachRow } = await supabase.from("isa_outreach_log").insert({
      lead_id: finalLeadId,
      brokerage_id: brokerageId,
      channel: step.channel,
      status: executionStatus,
      sent_at: dispatchResult.status === "sent" ? now : null,
      compliance_passed: true,
    }).select("id").single()
    isaOutreachLogId = outreachRow?.id ?? null
  }

  supabase.from("message_provider_logs").insert({
    brokerage_id: brokerageId,
    channel: step.channel,
    provider_key: dispatchResult.providerKey,
    direction: "outbound",
    provider_message_id: dispatchResult.messageId ?? null,
    provider_status: dispatchResult.status === "sent" ? "sent" : "failed",
    error_message: dispatchResult.error ?? null,
    outreach_log_id: isaOutreachLogId,
    created_at: now,
  })

  // ── Step 13: Kernel events ─────────────────────────────────────────────────
  if (dispatchResult.status === "sent") {
    await processKernelEvent({
      event: KernelEvent.ISA_OUTREACH_SENT,
      brokerageId,
      entityType: "contact",
      entityId: contactId ?? enrollmentId,
      suppressEnrollment: true,
    })
  }

  // ── Step 14: Advance enrollment ────────────────────────────────────────────
  return await advanceEnrollment(supabase, enrollment, step, executionStatus)
}

// ─── Helper: log and skip ─────────────────────────────────────────────────────

async function logAndSkip(
  supabase: ReturnType<typeof createServiceClient>,
  opts: { enrollmentId: string; enrollment: any; step: any; contactId: string | null; reason: string }
) {
  await supabase.from("sequence_step_executions").insert({
    enrollment_id: opts.enrollmentId,
    sequence_id: opts.enrollment.sequence_id,
    step_id: opts.step.id,
    contact_id: opts.contactId,
    channel: opts.step.channel,
    status: "skipped",
    blocked_reason: opts.reason,
    sent_at: null,
  })
}

// ─── Helper: advance enrollment ───────────────────────────────────────────────

async function advanceEnrollment(
  supabase: ReturnType<typeof createServiceClient>,
  enrollment: Record<string, any>,
  currentStep: Record<string, any>,
  executionStatus: string
): Promise<ExecuteResult> {
  const nextStepNumber = (enrollment.current_step ?? 0) + 2

  const { data: followingStep } = await supabase
    .from("campaign_sequence_steps")
    .select("delay_days, delay_hours")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_number", nextStepNumber)
    .eq("is_active", true)
    .maybeSingle()

  let nextStepAt: string | null = null
  if (followingStep) {
    const ms =
      (followingStep.delay_days ?? 0) * 24 * 60 * 60 * 1000 +
      (followingStep.delay_hours ?? 0) * 60 * 60 * 1000
    nextStepAt = new Date(Date.now() + Math.max(ms, 0)).toISOString()
  }

  const isComplete = !followingStep

  await supabase.from("sequence_enrollments").update({
    current_step: (enrollment.current_step ?? 0) + 1,
    next_step_at: nextStepAt,
    ...(isComplete ? { status: "completed", completed_at: new Date().toISOString() } : {}),
  }).eq("id", enrollment.id)

  if (isComplete) {
    await processKernelEvent({
      event: KernelEvent.ISA_MAX_TOUCHES_REACHED,
      brokerageId: enrollment.brokerage_id,
      entityType: "contact",
      entityId: enrollment.contact_id ?? enrollment.id,
      suppressEnrollment: true,
    }).catch(() => {})
  }

  return { status: executionStatus as ExecuteResult["status"] }
}
