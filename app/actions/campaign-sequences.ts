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
    service.from("campaign_sequences").select("*").eq("id", sequenceId).single(),
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
      compliance_gated: false,
      enrollments_total: 0,
      completions_total: 0,
      conversions_total: 0,
      created_by: user.id,
    })
    .select()
    .single()

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
    .single()

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
