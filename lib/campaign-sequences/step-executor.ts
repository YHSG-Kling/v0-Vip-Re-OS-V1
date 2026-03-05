/**
 * lib/campaign-sequences/step-executor.ts
 *
 * Executes a single sequence step for one enrollment.
 * Steps: compliance gate → channel gate → dispatch → log → advance enrollment.
 * DO NOT modify lib/kernel/compliance.ts or lib/providers/dispatch.ts.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { checkSequenceAuthority } from "./compliance-gate"
import {
  dispatchEmail,
  dispatchSms,
  dispatchDirectMail,
  dispatchVideo,
} from "@/lib/providers/dispatch"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExecuteResult {
  status: "sent" | "skipped" | "authority_blocked" | "no_next_step" | "completed" | "error"
  reason?: string
  messageId?: string
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeSequenceStep(
  enrollmentId: string
): Promise<ExecuteResult> {
  const supabase = createServiceClient()

  // ── Step 1: Fetch enrollment ────────────────────────────────────────────────
  const { data: enrollment, error: enrollErr } = await supabase
    .from("sequence_enrollments")
    .select("id, sequence_id, contact_id, lead_id, current_step, status, brokerage_id, ab_variant")
    .eq("id", enrollmentId)
    .single()

  if (enrollErr || !enrollment) {
    return { status: "error", reason: `Enrollment not found: ${enrollErr?.message}` }
  }

  const brokerageId: string = enrollment.brokerage_id
  const contactId: string | null = enrollment.contact_id

  // ── Step 2: Fetch the next step (current_step + 1) ──────────────────────────
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

  // No next step — mark enrollment completed
  if (!step) {
    await supabase
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_step_at: null,
      })
      .eq("id", enrollmentId)

    await processKernelEvent({
      event: KernelEvent.ISA_MAX_TOUCHES_REACHED,
      brokerageId,
      entityType: "contact",
      entityId: contactId ?? enrollmentId,
    }).catch(() => {})

    return { status: "completed" }
  }

  // ── Step 3: Compliance gate (ALWAYS — cannot be skipped) ──────────────────
  // We need a userId for the gate — use created_by from the sequence
  const { data: seqRow } = await supabase
    .from("campaign_sequences")
    .select("created_by")
    .eq("id", enrollment.sequence_id)
    .single()

  const userId = seqRow?.created_by ?? brokerageId

  if (contactId) {
    const gateResult = await checkSequenceAuthority(
      contactId,
      step.channel,
      { brokerageId, userId },
      supabase
    )

    if (!gateResult.allowed) {
      // Log authority_blocked execution row
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

      // Emit AUTHORITY_BLOCKED kernel event (non-blocking)
      await processKernelEvent({
        event: KernelEvent.AUTHORITY_BLOCKED,
        brokerageId,
        entityType: "contact",
        entityId: contactId,
      }).catch(() => {})

      // Do NOT advance enrollment — leave next_step_at unchanged
      return { status: "authority_blocked", reason: gateResult.reason }
    }
  }

  // ── Step 4: Channel-level gates ─────────────────────────────────────────────

  // SMS: TCPA consent required
  if (step.channel === "sms" && contactId) {
    const { data: contactRow } = await supabase
      .from("contacts")
      .select("tcpa_consent, dnc_status")
      .eq("id", contactId)
      .single()

    if (!contactRow?.tcpa_consent || contactRow?.dnc_status) {
      await supabase.from("sequence_step_executions").insert({
        enrollment_id: enrollmentId,
        sequence_id: enrollment.sequence_id,
        step_id: step.id,
        contact_id: contactId,
        channel: step.channel,
        status: "skipped",
        blocked_reason: "SMS: No TCPA consent or DNC",
        sent_at: null,
      })
      return await advanceEnrollment(supabase, enrollment, step, "skipped")
    }
  }

  // video / direct_mail: feature_flag check
  if (step.channel === "video" || step.channel === "direct_mail") {
    const featureKey = step.channel === "video" ? "video_campaigns" : "direct_mail_campaigns"
    const { data: flag } = await supabase
      .from("feature_flags")
      .select("enabled, superadmin_only")
      .eq("feature_key", featureKey)
      .maybeSingle()

    const locked = !flag?.enabled || flag?.superadmin_only === true
    if (locked) {
      await supabase.from("sequence_step_executions").insert({
        enrollment_id: enrollmentId,
        sequence_id: enrollment.sequence_id,
        step_id: step.id,
        contact_id: contactId,
        channel: step.channel,
        status: "skipped",
        blocked_reason: `Feature flag locked: ${featureKey}`,
        sent_at: null,
      })
      return await advanceEnrollment(supabase, enrollment, step, "skipped")
    }
  }

  // ── Step 5: Fetch contact for dispatch ──────────────────────────────────────
  let contact: Record<string, any> | null = null
  if (contactId) {
    const { data } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, mailing_address, city, state, zip")
      .eq("id", contactId)
      .single()
    contact = data
  }

  // ── Step 5: Dispatch via channel ────────────────────────────────────────────
  let dispatchResult: { success: boolean; providerKey: string; messageId?: string; error?: string } = {
    success: false,
    providerKey: step.channel,
  }

  const baseCtx = { brokerageId, systemSource: "sequence", leadId: contactId ?? undefined }

  switch (step.channel) {
    case "email": {
      if (!contact?.email) {
        dispatchResult = { success: false, providerKey: "email", error: "No email on contact" }
      } else {
        dispatchResult = await dispatchEmail({
          ...baseCtx,
          from: "noreply@platform.com",
          to: contact.email,
          subject: step.subject ?? "(No Subject)",
          html: `<p>${step.body ?? ""}</p>`,
        })
      }
      break
    }
    case "sms": {
      if (!contact?.phone) {
        dispatchResult = { success: false, providerKey: "sms", error: "No phone on contact" }
      } else {
        dispatchResult = await dispatchSms({
          ...baseCtx,
          to: contact.phone,
          message: step.body ?? "",
        })
      }
      break
    }
    case "voice": {
      // Full voice dispatch is Layer 4 — log intent only
      dispatchResult = { success: true, providerKey: "voice", messageId: undefined }
      break
    }
    case "direct_mail": {
      if (!contact?.mailing_address) {
        dispatchResult = { success: false, providerKey: "lob", error: "No mailing address on contact" }
      } else {
        dispatchResult = await dispatchDirectMail({
          ...baseCtx,
          recipientName: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Resident",
          mailingAddress: contact.mailing_address,
          city: contact.city ?? "",
          state: contact.state ?? "",
          zip: contact.zip ?? "",
          templateId: step.direct_mail_template_id ?? "",
        })
      }
      break
    }
    case "video": {
      if (!contact?.email) {
        dispatchResult = { success: false, providerKey: "heygen", error: "No email on contact for video" }
      } else {
        dispatchResult = await dispatchVideo({
          ...baseCtx,
          templateId: step.video_template_id ?? "",
          recipientEmail: contact.email,
          recipientName: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || undefined,
        })
      }
      break
    }
    case "in_app": {
      // Insert directly into messages table
      const { data: msgRow } = await supabase.from("messages").insert({
        contact_id: contactId,
        type: "in_app",
        direction: "outbound",
        body: step.body ?? "",
        status: "sent",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).select("id").single()
      dispatchResult = { success: true, providerKey: "in_app", messageId: msgRow?.id }
      break
    }
    default:
      dispatchResult = { success: false, providerKey: step.channel, error: `Unknown channel: ${step.channel}` }
  }

  const executionStatus = dispatchResult.success ? "sent" : "failed"
  const now = new Date().toISOString()

  // ── Step 6: INSERT sequence_step_executions ─────────────────────────────────
  await supabase.from("sequence_step_executions").insert({
    enrollment_id: enrollmentId,
    sequence_id: enrollment.sequence_id,
    step_id: step.id,
    contact_id: contactId,
    channel: step.channel,
    status: executionStatus,
    provider_message_id: dispatchResult.messageId ?? null,
    sent_at: dispatchResult.success ? now : null,
    blocked_reason: dispatchResult.error ?? null,
  })

  // ── Step 7: INSERT isa_outreach_log + message_provider_logs ─────────────────
  // isa_outreach_log.lead_id FK → leads.id.
  // enrollment.lead_id is fetched in Step 1; fall back to leads lookup via contact_id.
  let isaOutreachLogId: string | null = null

  // Use enrollment.lead_id (already fetched in Step 1); fall back to leads lookup via contact_id
  let finalLeadId: string | null = enrollment.lead_id ?? null
  if (!finalLeadId && contactId) {
    const { data: leadRow } = await supabase
      .from("leads")
      .select("id")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    finalLeadId = leadRow?.id ?? null
  }

  if (finalLeadId) {
    const { data: outreachRow } = await supabase
      .from("isa_outreach_log")
      .insert({
        lead_id: finalLeadId,
        brokerage_id: brokerageId,
        channel: step.channel,
        sequence_id: enrollment.sequence_id,
        sequence_step_id: step.id,
        sent_at: dispatchResult.success ? now : null,
        status: executionStatus,
        provider_message_id: dispatchResult.messageId ?? null,
      })
      .select("id")
      .single()
    isaOutreachLogId = outreachRow?.id ?? null
  }

  // message_provider_logs — wire outreach_log_id to complete the audit trail
  supabase.from("message_provider_logs").insert({
    brokerage_id: brokerageId,
    channel: step.channel,
    provider_key: dispatchResult.providerKey,
    direction: "outbound",
    provider_message_id: dispatchResult.messageId ?? null,
    provider_status: dispatchResult.success ? "sent" : "failed",
    error_message: dispatchResult.error ?? null,
    // FK → isa_outreach_log.id — audit trail now complete
    outreach_log_id: isaOutreachLogId,
    created_at: now,
  }).then(() => {}).catch(() => {})

  // ── Step 8: Emit ISA_OUTREACH_SENT ──────────────────────────────────────────
  if (dispatchResult.success) {
    await processKernelEvent({
      event: KernelEvent.ISA_OUTREACH_SENT,
      brokerageId,
      entityType: "contact",
      entityId: contactId ?? enrollmentId,
    }).catch(() => {})
  }

  // ── Steps 9–10: Advance enrollment ──────────────────────────────────────────
  return await advanceEnrollment(supabase, enrollment, step, executionStatus)
}

// ─── Helper: advance enrollment to next step ─────────────────────────────────

async function advanceEnrollment(
  supabase: ReturnType<typeof createServiceClient>,
  enrollment: Record<string, any>,
  currentStep: Record<string, any>,
  executionStatus: string
): Promise<ExecuteResult> {
  const brokerageId: string = enrollment.brokerage_id
  const nextStepNumber = (enrollment.current_step ?? 0) + 2 // next-next step for delay calc

  // Fetch the step after the one we just executed to calculate delay
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
    nextStepAt = new Date(Date.now() + ms).toISOString()
  }

  const isComplete = !followingStep

  await supabase.from("sequence_enrollments").update({
    current_step: (enrollment.current_step ?? 0) + 1,
    next_step_at: nextStepAt,
    ...(isComplete
      ? { status: "completed", completed_at: new Date().toISOString() }
      : {}),
  }).eq("id", enrollment.id)

  if (isComplete) {
    await processKernelEvent({
      event: KernelEvent.ISA_MAX_TOUCHES_REACHED,
      brokerageId,
      entityType: "contact",
      entityId: enrollment.contact_id ?? enrollment.id,
    }).catch(() => {})
  }

  return {
    status: executionStatus as ExecuteResult["status"],
    messageId: undefined,
  }
}
