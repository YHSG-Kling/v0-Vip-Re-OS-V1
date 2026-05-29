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
  contactId: string
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

  // Validate sequence exists, is active, and compliance_gated=true
  const { data: sequence, error: seqErr } = await supabase
    .from("campaign_sequences")
    .select("id, is_active, compliance_gated, brokerage_id")
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
    .eq("contact_id", params.contactId)
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
      contact_id: params.contactId,
      brokerage_id: params.brokerageId,
      status: "active",
      current_step: 0,
      enrolled_at: new Date().toISOString(),
      next_step_at: nextStepAt,
      ab_variant: params.abVariant ?? null,
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
    entityType: "contact",
    entityId: params.contactId,
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
