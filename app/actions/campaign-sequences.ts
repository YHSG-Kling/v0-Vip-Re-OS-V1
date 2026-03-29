"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CampaignSequence {
  id: string
  name: string
  description: string | null
  sequence_type: string
  trigger_event: string | null
  trigger_conditions: Record<string, unknown> | null
  is_active: boolean
  is_ab_test: boolean
  ab_test_split_pct: number | null
  compliance_gated: boolean
  enrollments_total: number
  completions_total: number
  conversions_total: number
  created_at: string
  updated_at: string
  brokerage_id: string
  created_by: string | null
  steps?: SequenceStep[]
}

export interface SequenceStep {
  id: string
  sequence_id: string
  step_number: number
  step_name: string
  channel: string
  delay_days: number
  delay_hours: number
  subject: string | null
  body: string | null
  send_time: string | null
  is_active: boolean
  ab_variant: string | null
  condition_field: string | null
  condition_operator: string | null
  condition_value: string | null
  video_template_id: string | null
  direct_mail_template_id: string | null
  personalization_tokens: Record<string, unknown> | null
  sent_count: number
  open_count: number
  click_count: number
  reply_count: number
  created_at: string
}

export interface SequenceEnrollment {
  id: string
  sequence_id: string
  contact_id: string | null
  lead_id: string | null
  status: string
  current_step: number
  enrolled_at: string
  completed_at: string | null
  converted_at: string | null
  next_step_at: string | null
  ab_variant: string | null
  contact?: { first_name: string | null; last_name: string | null; email: string | null }
}

// ─── List sequences ───────────────────────────────────────────────────────────

export async function listCampaignSequences(brokerageId: string): Promise<{
  sequences: CampaignSequence[]
  error?: string
}> {
  const service = createServiceClient()
  const { data, error } = await service
    .from("campaign_sequences")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) return { sequences: [], error: error.message }
  return { sequences: (data ?? []) as CampaignSequence[] }
}

// ─── Get sequence with steps ──────────────────────────────────────────────────

export async function getCampaignSequence(sequenceId: string): Promise<{
  sequence: CampaignSequence | null
  steps: SequenceStep[]
  enrollments: SequenceEnrollment[]
  error?: string
}> {
  const service = createServiceClient()
  const [seqRes, stepsRes, enrollRes] = await Promise.all([
    service.from("campaign_sequences").select("*").eq("id", sequenceId).maybeSingle(),
    service
      .from("campaign_sequence_steps")
      .select("*")
      .eq("sequence_id", sequenceId)
      .order("step_number", { ascending: true }),
    service
      .from("sequence_enrollments")
      .select(`
        *,
        contact:contacts(first_name, last_name, email)
      `)
      .eq("sequence_id", sequenceId)
      .order("enrolled_at", { ascending: false })
      .limit(200),
  ])

  if (seqRes.error) return { sequence: null, steps: [], enrollments: [], error: seqRes.error.message }

  return {
    sequence: seqRes.data as CampaignSequence,
    steps: (stepsRes.data ?? []) as SequenceStep[],
    enrollments: (enrollRes.data ?? []) as SequenceEnrollment[],
  }
}

// ─── Create sequence ──────────────────────────────────────────────────────────

export async function createCampaignSequence(params: {
  brokerageId: string
  name: string
  description?: string
  sequence_type: string
  trigger_event?: string
}): Promise<{ sequence: CampaignSequence | null; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { sequence: null, error: "Not authenticated" }

  const service = createServiceClient()
  const { data, error } = await service
    .from("campaign_sequences")
    .insert({
      brokerage_id: params.brokerageId,
      name: params.name,
      description: params.description ?? null,
      sequence_type: params.sequence_type,
      trigger_event: params.trigger_event ?? null,
      is_active: false,
      is_ab_test: false,
      // compliance_gated is ALWAYS true — the gate cannot be disabled
      compliance_gated: true,
      enrollments_total: 0,
      completions_total: 0,
      conversions_total: 0,
      created_by: user.id,
    })
    .select()
    .maybeSingle()

  if (error) return { sequence: null, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  return { sequence: data as CampaignSequence }
}

// ─── Update sequence ──────────────────────────────────────────────────────────

export async function updateCampaignSequence(
  sequenceId: string,
  updates: Partial<Pick<CampaignSequence, "name" | "description" | "is_active" | "trigger_event" | "compliance_gated" | "is_ab_test" | "ab_test_split_pct">>
): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("campaign_sequences")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", sequenceId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

// ─── Delete sequence ──────────────────────────────────────────────────────────

export async function deleteCampaignSequence(sequenceId: string): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("campaign_sequences")
    .delete()
    .eq("id", sequenceId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  return { success: true }
}

// ─── Create step ──────────────────────────────────────────────────────────────

export async function createSequenceStep(params: {
  sequence_id: string
  step_number: number
  step_name: string
  channel: string
  delay_days: number
  delay_hours: number
  subject?: string
  body?: string
  send_time?: string
}): Promise<{ step: SequenceStep | null; error?: string }> {
  const service = createServiceClient()
  const { data, error } = await service
    .from("campaign_sequence_steps")
    .insert({
      sequence_id: params.sequence_id,
      step_number: params.step_number,
      step_name: params.step_name,
      channel: params.channel,
      delay_days: params.delay_days,
      delay_hours: params.delay_hours,
      subject: params.subject ?? null,
      body: params.body ?? null,
      send_time: params.send_time ?? null,
      is_active: true,
      sent_count: 0,
      open_count: 0,
      click_count: 0,
      reply_count: 0,
    })
    .select()
    .maybeSingle()

  if (error) return { step: null, error: error.message }
  revalidatePath(`/dashboard/campaigns/sequences/${params.sequence_id}`)
  return { step: data as SequenceStep }
}

// ─── Update step ──────────────────────────────────────────────────────────────

export async function updateSequenceStep(
  stepId: string,
  sequenceId: string,
  updates: Partial<Pick<SequenceStep, "step_name" | "channel" | "delay_days" | "delay_hours" | "subject" | "body" | "send_time" | "is_active" | "condition_field" | "condition_operator" | "condition_value">>
): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("campaign_sequence_steps")
    .update(updates)
    .eq("id", stepId)

  if (error) return { success: false, error: error.message }
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

// ─── Delete step ──────────────────────────────────────────────────────────────

export async function deleteSequenceStep(stepId: string, sequenceId: string): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("campaign_sequence_steps")
    .delete()
    .eq("id", stepId)

  if (error) return { success: false, error: error.message }
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

// ─── Reorder steps ────────────────────────────────────────────────────────────

export async function reorderSequenceSteps(
  steps: { id: string; step_number: number }[],
  sequenceId: string
): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const results = await Promise.all(
    steps.map(s =>
      service.from("campaign_sequence_steps").update({ step_number: s.step_number }).eq("id", s.id)
    )
  )
  const failed = results.find(r => r.error)
  if (failed?.error) return { success: false, error: failed.error.message }
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

// ─── Campaign Operations ──────────────────────────────────────────────────────

export async function launchCampaignSequence(sequenceId: string): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  
  // Check if sequence has at least one step
  const { data: steps } = await service
    .from("campaign_sequence_steps")
    .select("id")
    .eq("sequence_id", sequenceId)
    .limit(1)
  
  if (!steps || steps.length === 0) {
    return { success: false, error: "Cannot launch sequence without steps" }
  }
  
  const { error } = await service
    .from("campaign_sequences")
    .update({ 
      is_active: true, 
      updated_at: new Date().toISOString() 
    })
    .eq("id", sequenceId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

export async function pauseCampaignSequence(sequenceId: string): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("campaign_sequences")
    .update({ 
      is_active: false, 
      updated_at: new Date().toISOString() 
    })
    .eq("id", sequenceId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

export async function resumeCampaignSequence(sequenceId: string): Promise<{ success: boolean; error?: string }> {
  return launchCampaignSequence(sequenceId)
}

export async function duplicateCampaignSequence(sequenceId: string, brokerageId: string): Promise<{ 
  sequence: CampaignSequence | null
  error?: string 
}> {
  const service = createServiceClient()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { sequence: null, error: "Not authenticated" }
  
  // Get original sequence
  const { data: original, error: fetchError } = await service
    .from("campaign_sequences")
    .select("*")
    .eq("id", sequenceId)
    .maybeSingle()
  
  if (fetchError || !original) return { sequence: null, error: "Sequence not found" }
  
  // Create duplicate
  const { data: duplicate, error: createError } = await service
    .from("campaign_sequences")
    .insert({
      brokerage_id: brokerageId,
      name: `${original.name} (Copy)`,
      description: original.description,
      sequence_type: original.sequence_type,
      trigger_event: original.trigger_event,
      trigger_conditions: original.trigger_conditions,
      is_active: false,
      is_ab_test: original.is_ab_test,
      ab_test_split_pct: original.ab_test_split_pct,
      compliance_gated: true,
      enrollments_total: 0,
      completions_total: 0,
      conversions_total: 0,
      created_by: user.id,
    })
    .select()
    .maybeSingle()
  
  if (createError) return { sequence: null, error: createError.message }
  
  // Duplicate steps
  const { data: originalSteps } = await service
    .from("campaign_sequence_steps")
    .select("*")
    .eq("sequence_id", sequenceId)
    .order("step_number", { ascending: true })
  
  if (originalSteps && originalSteps.length > 0) {
    const stepsToInsert = originalSteps.map(step => ({
      sequence_id: duplicate.id,
      step_number: step.step_number,
      step_name: step.step_name,
      channel: step.channel,
      delay_days: step.delay_days,
      delay_hours: step.delay_hours,
      subject: step.subject,
      body: step.body,
      send_time: step.send_time,
      is_active: step.is_active,
      ab_variant: step.ab_variant,
      condition_field: step.condition_field,
      condition_operator: step.condition_operator,
      condition_value: step.condition_value,
      video_template_id: step.video_template_id,
      direct_mail_template_id: step.direct_mail_template_id,
      personalization_tokens: step.personalization_tokens,
      sent_count: 0,
      open_count: 0,
      click_count: 0,
      reply_count: 0,
    }))
    
    await service.from("campaign_sequence_steps").insert(stepsToInsert)
  }
  
  revalidatePath("/dashboard/campaigns/sequences")
  return { sequence: duplicate as CampaignSequence }
}

export async function archiveCampaignSequence(sequenceId: string): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  
  // First pause the sequence
  await service
    .from("campaign_sequences")
    .update({ is_active: false })
    .eq("id", sequenceId)
  
  // Update any active enrollments to "cancelled"
  await service
    .from("sequence_enrollments")
    .update({ status: "cancelled" })
    .eq("sequence_id", sequenceId)
    .eq("status", "active")
  
  // Soft delete by adding archived flag (or we could hard delete)
  const { error } = await service
    .from("campaign_sequences")
    .delete()
    .eq("id", sequenceId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  return { success: true }
}

// ─── Enrollment Operations ────────────────────────────────────────────────────

export async function enrollContactInSequence(params: {
  sequenceId: string
  contactId?: string
  leadId?: string
}): Promise<{ enrollment: SequenceEnrollment | null; error?: string }> {
  if (!params.contactId && !params.leadId) {
    return { enrollment: null, error: "Must provide contact or lead ID" }
  }
  
  const service = createServiceClient()
  const { data, error } = await service
    .from("sequence_enrollments")
    .insert({
      sequence_id: params.sequenceId,
      contact_id: params.contactId ?? null,
      lead_id: params.leadId ?? null,
      status: "active",
      current_step: 1,
      enrolled_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (error) return { enrollment: null, error: error.message }
  
  // Increment enrollment count
  await service.rpc("increment_sequence_enrollments", { seq_id: params.sequenceId })
  
  revalidatePath(`/dashboard/campaigns/sequences/${params.sequenceId}`)
  return { enrollment: data as SequenceEnrollment }
}

export async function cancelEnrollment(enrollmentId: string, sequenceId: string): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("sequence_enrollments")
    .update({ status: "cancelled" })
    .eq("id", enrollmentId)

  if (error) return { success: false, error: error.message }
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

// ─── Batch Operations ─────────────────────────────────────────────────────────

export async function batchPauseSequences(sequenceIds: string[]): Promise<{ success: boolean; count: number; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("campaign_sequences")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .in("id", sequenceIds)

  if (error) return { success: false, count: 0, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  return { success: true, count: sequenceIds.length }
}

export async function batchLaunchSequences(sequenceIds: string[]): Promise<{ success: boolean; count: number; error?: string }> {
  const service = createServiceClient()
  const { error } = await service
    .from("campaign_sequences")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .in("id", sequenceIds)

  if (error) return { success: false, count: 0, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  return { success: true, count: sequenceIds.length }
}

export async function batchArchiveSequences(sequenceIds: string[]): Promise<{ success: boolean; count: number; error?: string }> {
  const service = createServiceClient()
  
  // Pause all first
  await service
    .from("campaign_sequences")
    .update({ is_active: false })
    .in("id", sequenceIds)
  
  // Cancel active enrollments
  await service
    .from("sequence_enrollments")
    .update({ status: "cancelled" })
    .in("sequence_id", sequenceIds)
    .eq("status", "active")
  
  // Delete sequences
  const { error } = await service
    .from("campaign_sequences")
    .delete()
    .in("id", sequenceIds)

  if (error) return { success: false, count: 0, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  return { success: true, count: sequenceIds.length }
}
