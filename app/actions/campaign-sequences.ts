"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { revalidatePath } from "next/cache"
import {
  type CampaignSequence,
  type SequenceStep,
  type SequenceEnrollment,
  type ChannelType,
  type SequenceCategory,
  type SequenceBuilderStep,
  VALID_STEP_TYPES,
  MARKETING_SEQUENCE_TYPES,
  NURTURE_SEQUENCE_TYPES,
} from "@/lib/campaigns/sequence-constants"

// ─── List sequences ───────────────────────────────────────────────────────────

export async function listCampaignSequences(
  brokerageId: string,
  category?: SequenceCategory
): Promise<{
  sequences: CampaignSequence[]
  error?: string
}> {
  const service = createServiceClient()
  let query = service
    .from("campaign_sequences")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (category === "marketing") {
    query = query.in("sequence_type", MARKETING_SEQUENCE_TYPES as unknown as string[])
  } else if (category === "nurture") {
    query = query.in("sequence_type", NURTURE_SEQUENCE_TYPES as unknown as string[])
  }

  const { data, error } = await query

  if (error) return { sequences: [], error: error.message }
  return { sequences: (data ?? []) as CampaignSequence[] }
}

// ─── Get sequence with steps ──────────────────────────────────────────────────

export async function getCampaignSequence(
  sequenceId: string,
  options?: { includeEnrollments?: boolean }
): Promise<{
  sequence: CampaignSequence | null
  steps: SequenceStep[]
  enrollments: SequenceEnrollment[]
  error?: string
}> {
  const service = createServiceClient()
  const includeEnrollments = options?.includeEnrollments ?? true

  const [seqRes, stepsRes, enrollRes] = await Promise.all([
    service.from("campaign_sequences").select("*").eq("id", sequenceId).maybeSingle(),
    service
      .from("campaign_sequence_steps")
      .select("*")
      .eq("sequence_id", sequenceId)
      .order("step_number", { ascending: true }),
    includeEnrollments
      ? service
          .from("sequence_enrollments")
          .select(`*, contact:contacts(first_name, last_name, email)`)
          .eq("sequence_id", sequenceId)
          .order("enrolled_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: null, error: null }),
  ])

  if (seqRes.error) return { sequence: null, steps: [], enrollments: [], error: seqRes.error.message }

  const enrollments = ((enrollRes.data ?? []) as SequenceEnrollment[])

  return {
    sequence: seqRes.data as CampaignSequence,
    steps: (stepsRes.data ?? []) as SequenceStep[],
    enrollments,
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

// SequenceBuilderStep moved to @/lib/campaigns/sequence-constants

export async function getSequenceSteps(sequenceId: string): Promise<{ steps: SequenceBuilderStep[]; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { steps: [], error: "Not authenticated" }

    const service = createServiceClient()

    // Verify ownership
    const { data: seq } = await service
      .from("campaign_sequences")
      .select("brokerage_id")
      .eq("id", sequenceId)
      .maybeSingle()
    if (!seq || seq.brokerage_id !== ctx.brokerageId) return { steps: [], error: "Not found" }

    // DB stores channel (not step_type) — map on read
    const { data, error } = await service
      .from("campaign_sequence_steps")
      .select("id, step_number, step_name, channel, delay_days, delay_hours, subject, body, is_active")
      .eq("sequence_id", sequenceId)
      .order("step_number", { ascending: true })
    if (error) return { steps: [], error: error.message }
    for (const row of data ?? []) {
      if (!row.channel || !VALID_STEP_TYPES.has(row.channel)) {
        return { steps: [], error: `Invalid step channel in sequence: ${row.channel ?? "(empty)"}` }
      }
    }
    const steps: SequenceBuilderStep[] = (data ?? []).map((row: any) => ({
      id: row.id,
      step_number: row.step_number,
      step_name: row.step_name ?? row.channel ?? "Step",
      step_type: (row.channel ?? "email") as SequenceBuilderStep["step_type"],
      delay_days: row.delay_days ?? 0,
      delay_hours: row.delay_hours ?? 0,
      subject: row.subject ?? null,
      body: row.body ?? "",
      is_active: row.is_active ?? true,
      output_variable_name: row.output_variable_name ?? null,
      qr_attached: row.qr_attached ?? false,
      qr_target_url_pattern: row.qr_target_url_pattern ?? null,
      image_prompt: row.image_prompt ?? null,
      image_style: row.image_style ?? null,
      image_aspect_ratio: row.image_aspect_ratio ?? null,
      video_script: row.video_script ?? null,
      video_voice_only: row.video_voice_only ?? false,
      video_background_url: row.video_background_url ?? null,
      voice_drop_script: row.voice_drop_script ?? null,
      voice_drop_voice_id: row.voice_drop_voice_id ?? null,
      social_platform: row.social_platform ?? null,
      social_caption_prompt: row.social_caption_prompt ?? null,
      task_assignee_type: row.task_assignee_type ?? null,
      task_title: row.task_title ?? null,
      task_due_offset_days: row.task_due_offset_days ?? 0,
      document_type: row.document_type ?? null,
      document_state: row.document_state ?? null,
      avm_data_source: row.avm_data_source ?? null,
      avm_report_type: row.avm_report_type ?? null,
      avm_include_investor_adj: row.avm_include_investor_adj ?? false,
      ad_platform: row.ad_platform ?? null,
      ad_objective: row.ad_objective ?? null,
      direct_mail_piece_type: row.direct_mail_piece_type ?? null,
    }))
    return { steps }
  } catch (e: any) {
    return { steps: [], error: e.message }
  }
}

export async function saveSequenceSteps(sequenceId: string, steps: SequenceBuilderStep[]): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    // Verify ownership
    const { data: seq } = await service
      .from("campaign_sequences")
      .select("brokerage_id")
      .eq("id", sequenceId)
      .maybeSingle()
    if (!seq || seq.brokerage_id !== ctx.brokerageId) return { success: false, error: "Unauthorized" }

    // Validate all steps BEFORE any DB mutation so an invalid channel
    // cannot corrupt existing steps.
    for (const s of steps) {
      if (!s.step_type || !VALID_STEP_TYPES.has(s.step_type as any)) {
        return { success: false, error: `Invalid step channel: ${s.step_type ?? "(empty)"}` }
      }
    }

    // Fetch only the IDs of existing steps — needed to compute which rows to delete.
    const { data: existingSteps, error: fetchError } = await service
      .from("campaign_sequence_steps")
      .select("id")
      .eq("sequence_id", sequenceId)
    if (fetchError) {
      return { success: false, error: `Failed to read existing steps: ${fetchError.message}` }
    }

    const existingIds = new Set((existingSteps ?? []).map((s: any) => s.id as string))
    const newIds = new Set(steps.map((s) => s.id))
    const idsToDelete = [...existingIds].filter((id) => !newIds.has(id))

    // Split steps into verified-existing (safe to upsert by ID) and new (insert without ID).
    // Client-provided IDs that are NOT in existingIds could belong to another sequence;
    // inserting without an ID lets the DB generate a fresh UUID and prevents cross-sequence overwrite.
    if (steps.length > 0) {
      const toUpdate = steps.filter((s): s is SequenceBuilderStep & { id: string } => !!s.id && existingIds.has(s.id))
      const toInsert = steps.filter((s) => !s.id || !existingIds.has(s.id))

      const buildRow = (s: SequenceBuilderStep, overrideIdx?: number) => ({
        sequence_id: sequenceId,
        step_number: overrideIdx ?? steps.indexOf(s) + 1,
        step_name: s.step_name || s.step_type,
        channel: s.step_type,
        delay_days: s.delay_days ?? 0,
        delay_hours: s.delay_hours ?? 0,
        subject: s.subject ?? null,
        body: s.body || "",
        is_active: s.is_active ?? true,
        // Variable graph
        output_variable_name: s.output_variable_name ?? null,
        // QR modifier
        qr_attached: s.qr_attached ?? false,
        qr_target_url_pattern: s.qr_target_url_pattern ?? null,
        // AI Image
        image_prompt: s.image_prompt ?? null,
        image_style: s.image_style ?? null,
        image_aspect_ratio: s.image_aspect_ratio ?? null,
        // Video
        video_script: s.video_script ?? null,
        video_voice_only: s.video_voice_only ?? false,
        video_background_url: s.video_background_url ?? null,
        // Voice Drop
        voice_drop_script: s.voice_drop_script ?? null,
        voice_drop_voice_id: s.voice_drop_voice_id ?? null,
        // Social
        social_platform: s.social_platform ?? null,
        social_caption_prompt: s.social_caption_prompt ?? null,
        // Task
        task_assignee_type: s.task_assignee_type ?? null,
        task_title: s.task_title ?? null,
        task_due_offset_days: s.task_due_offset_days ?? 0,
        // Document
        document_type: s.document_type ?? null,
        document_state: s.document_state ?? null,
        // AVM/CMA
        avm_data_source: s.avm_data_source ?? null,
        avm_report_type: s.avm_report_type ?? null,
        avm_include_investor_adj: s.avm_include_investor_adj ?? false,
        // Ad
        ad_platform: s.ad_platform ?? null,
        ad_objective: s.ad_objective ?? null,
        // Direct mail
        direct_mail_piece_type: s.direct_mail_piece_type ?? null,
      })

      if (toUpdate.length > 0) {
        const updateRows = toUpdate.map((s) => ({ id: s.id, ...buildRow(s) }))
        const { error: upsertError } = await service
          .from("campaign_sequence_steps")
          .upsert(updateRows, { onConflict: "id" })
        if (upsertError) return { success: false, error: upsertError.message }
      }

      if (toInsert.length > 0) {
        const insertRows = toInsert.map((s) => buildRow(s))
        const { error: insertError } = await service
          .from("campaign_sequence_steps")
          .insert(insertRows)
        if (insertError) return { success: false, error: insertError.message }
      }
    }

    // Delete only rows that were removed — surgical, never touches unchanged steps.
    if (idsToDelete.length > 0) {
      const { error: deleteError } = await service
        .from("campaign_sequence_steps")
        .delete()
        .in("id", idsToDelete)
      if (deleteError) return { success: false, error: `Failed to remove deleted steps: ${deleteError.message}` }
    }
    revalidatePath("/dashboard/campaigns/sequences")
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}
