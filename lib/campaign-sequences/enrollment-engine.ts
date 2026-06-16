/**
 * lib/campaign-sequences/enrollment-engine.ts
 *
 * Handles enrolling a contact into a campaign sequence.
 * - Validates the sequence is active and compliance_gated=true
 * - Prevents duplicate active enrollments
 * - Calculates first step's next_step_at based on step 1 delay
 * - Inserts sequence_enrollments row
 * - Emits ISA_QUALIFICATION_STARTED kernel event
 */

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EnrollContactParams {
  sequenceId: string
  /** Provide exactly ONE of contactId / leadId. Leads enroll too (the table supports lead_id). */
  contactId?: string
  leadId?: string
  brokerageId: string
  enrolledBy?: string
  abVariant?: "A" | "B"
}

export interface EnrollResult {
  success: boolean
  enrollmentId?: string
  error?: string
  alreadyEnrolled?: boolean
}

// ─── Main enrollment function ─────────────────────────────────────────────────

export async function enrollContact(params: EnrollContactParams): Promise<EnrollResult> {
  const supabase = createServiceClient()

  // Exactly one recipient kind. (Leads enroll into the approved pre-consent channels only — the
  // step-executor already enforces lead-channel gating; this just lets the loop address them.)
  const isLead = !!params.leadId && !params.contactId
  const recipientCol = isLead ? "lead_id" : "contact_id"
  const recipientId = isLead ? params.leadId! : params.contactId
  if (!recipientId) {
    return { success: false, error: "enrollContact requires exactly one of contactId / leadId" }
  }

  // Validate sequence exists, is active, and compliance_gated=true
  const { data: sequence, error: seqErr } = await supabase
    .from("campaign_sequences")
    .select("id, is_active, compliance_gated, brokerage_id, is_ab_test")
    .eq("id", params.sequenceId)
    .eq("brokerage_id", params.brokerageId)
    .single()

  if (seqErr || !sequence) {
    return { success: false, error: "Sequence not found or not in this brokerage" }
  }

  if (!sequence.is_active) {
    return { success: false, error: "Sequence is not active" }
  }

  // compliance_gated must always be true — reject if somehow false
  if (!sequence.compliance_gated) {
    return { success: false, error: "Sequence compliance gate is not active — cannot enroll" }
  }

  // Prevent duplicate active enrollment
  const { data: existing } = await supabase
    .from("sequence_enrollments")
    .select("id, status")
    .eq("sequence_id", params.sequenceId)
    .eq(recipientCol, recipientId)
    .in("status", ["active", "paused"])
    .maybeSingle()

  if (existing) {
    return {
      success: false,
      alreadyEnrolled: true,
      enrollmentId: existing.id,
      error: "Contact is already actively enrolled in this sequence",
    }
  }

  // Calculate next_step_at from step 1 delay
  const { data: firstStep } = await supabase
    .from("campaign_sequence_steps")
    .select("delay_days, delay_hours")
    .eq("sequence_id", params.sequenceId)
    .eq("step_number", 1)
    .eq("is_active", true)
    .maybeSingle()

  let nextStepAt: string
  if (firstStep) {
    const delayMs =
      (firstStep.delay_days ?? 0) * 24 * 60 * 60 * 1000 +
      (firstStep.delay_hours ?? 0) * 60 * 60 * 1000
    nextStepAt = new Date(Date.now() + delayMs).toISOString()
  } else {
    // No steps yet — set next_step_at to now (cron will process immediately)
    nextStepAt = new Date().toISOString()
  }

  // Insert enrollment
  const { data: enrollment, error: insertErr } = await supabase
    .from("sequence_enrollments")
    .insert({
      sequence_id: params.sequenceId,
      [recipientCol]: recipientId,
      brokerage_id: params.brokerageId,
      status: "active",
      current_step: 0,
      enrolled_at: new Date().toISOString(),
      next_step_at: nextStepAt,
      // A/B: honor an explicit variant, else split 50/50 when the sequence is_ab_test, else null.
      ab_variant: (await import("./ab-variant")).assignAbVariant({ isAbTest: (sequence as any).is_ab_test, provided: params.abVariant ?? null }),
    })
    .select("id")
    .single()

  if (insertErr || !enrollment) {
    return { success: false, error: `Enrollment insert failed: ${insertErr?.message}` }
  }

  // Update total enrollments count on sequence (fire-and-forget)
  supabase
    .rpc("increment_sequence_enrollments", { seq_id: params.sequenceId })

  // Emit ISA_QUALIFICATION_STARTED kernel event (non-blocking)
  await processKernelEvent({
    event: KernelEvent.ISA_QUALIFICATION_STARTED,
    brokerageId: params.brokerageId,
    entityType: isLead ? "lead" : "contact",
    entityId: recipientId,
    suppressEnrollment: true,
  }).catch(() => {})

  return { success: true, enrollmentId: enrollment.id }
}

// ─── Pause / resume enrollment ────────────────────────────────────────────────

export async function pauseEnrollment(enrollmentId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({ status: "paused" })
    .eq("id", enrollmentId)
    .eq("status", "active")

  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function resumeEnrollment(enrollmentId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({ status: "active" })
    .eq("id", enrollmentId)
    .eq("status", "paused")

  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * RESPONSE-DRIVEN STOP — the "keep trying UNTIL they respond" terminator.
 *
 * The whole point of the multi-channel cadence is to keep reaching out until the person answers
 * (positive OR negative). When a contact/lead REPLIES on any channel (an inbound message lands),
 * every active/paused sequence they're enrolled in must stop immediately — continuing to drip at
 * someone who already engaged is exactly the over-touch the system is built to avoid. Wired into
 * the communication spine's inbound path so ANY channel's reply terminates the cadence. Idempotent,
 * never throws.
 */
export async function stopSequencesOnResponse(
  params: { brokerageId: string; contactId?: string; leadId?: string },
  client?: ReturnType<typeof createServiceClient>,
): Promise<{ unenrolled: number }> {
  if (!params.contactId && !params.leadId) return { unenrolled: 0 }
  const supabase = client ?? createServiceClient()
  let q = supabase
    .from("sequence_enrollments")
    .update({ status: "unenrolled", completed_at: new Date().toISOString() })
    .eq("brokerage_id", params.brokerageId)
    .in("status", ["active", "paused"])
  q = params.contactId ? q.eq("contact_id", params.contactId) : q.eq("lead_id", params.leadId!)
  const { data, error } = await q.select("id")
  if (error) return { unenrolled: 0 }
  return { unenrolled: data?.length ?? 0 }
}

export async function unenrollContact(
  sequenceId: string,
  contactId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({
      status: "unenrolled",
      completed_at: new Date().toISOString(),
    })
    .eq("sequence_id", sequenceId)
    .eq("contact_id", contactId)
    .in("status", ["active", "paused"])

  if (error) return { success: false, error: error.message }
  return { success: true }
}
