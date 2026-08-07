"use server"

// ─────────────────────────────────────────────────────────────────────────────
// SIX SEQUENCE ACTIONS REMOVED (burn-down), not deprecated — deleted.
//
// pauseCampaignSequence / duplicateCampaignSequence / archiveCampaignSequence and
// batchPauseSequences / batchLaunchSequences / batchArchiveSequences were ONLY
// reachable from app/dashboard/campaigns/components/os/ — an eight-panel
// directory that app/dashboard/campaigns/page.tsx never imported, because that
// page is a pure redirect to the marketing studio. The panels had no host and
// had never rendered, so these six were unreachable from the running product.
//
// The live sequence surface (app/dashboard/campaigns/sequences/SequencesListClient)
// already covers every one of them through updateCampaignSequence /
// createCampaignSequence / deleteCampaignSequence — and unlike batchLaunchSequences
// it runs the brand-voice compliance precheck before activating anything.
//
// batchArchiveSequences also hard-DELETEd rows while calling itself "archive",
// which is not behaviour worth carrying forward.
// ─────────────────────────────────────────────────────────────────────────────

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
import { STEP_PALETTE, storableValue, type StepFieldSpec } from "@/lib/workflow/step-palette"

/** Every per-channel column the step palette declares — the save allow-list.
 *  scripts/step-palette-consolidation-simulator.ts proves each is a real column
 *  on campaign_sequence_steps, so this can never name one that does not exist. */
const PALETTE_FIELD_SPECS: ReadonlyMap<string, StepFieldSpec> = new Map(
  STEP_PALETTE.flatMap((s) => s.fields).map((f) => [f.name, f]),
)
const PALETTE_STEP_FIELDS: readonly string[] = Array.from(PALETTE_FIELD_SPECS.keys())

/** The value to write for a palette field: "" becomes null, EXCEPT where the
 *  column is NOT NULL (showing_duration_minutes, task_due_offset_days,
 *  tour_date_offset_days), which take the spec's fallback instead. */
function fieldValueForWrite(name: string, raw: unknown): unknown {
  const spec = PALETTE_FIELD_SPECS.get(name)
  return spec ? storableValue(spec, raw) : (raw === undefined || raw === "" ? null : raw)
}

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

/**
 * The sequence, its steps and (optionally) its enrollments — the read behind the
 * sequence detail + builder pages.
 *
 * TENANT GATE. This is the widest read in the file: it returns the sequence, every
 * step INCLUDING subject + body message copy, and up to 200 enrollments joined to
 * `contacts(first_name, last_name, email)` — contact PII. It ran on the
 * RLS-bypassing service client with no auth gate and no brokerage predicate, and
 * as a "use server" export it is a public HTTP endpoint, so one sequence uuid
 * returned another brokerage's campaign copy and its contacts' names and email
 * addresses.
 *
 * The gate below is the same one `getSequenceSteps` in this file already applies
 * to the narrower steps-only read; this brings the wider read up to it. Callers
 * are server components that pass only an id, so the signature is unchanged.
 */
export async function getCampaignSequence(
  sequenceId: string,
  options?: { includeEnrollments?: boolean }
): Promise<{
  sequence: CampaignSequence | null
  steps: SequenceStep[]
  enrollments: SequenceEnrollment[]
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { sequence: null, steps: [], enrollments: [], error: "Not authenticated" }
  }

  const service = createServiceClient()
  const includeEnrollments = options?.includeEnrollments ?? true

  const [seqRes, stepsRes, enrollRes] = await Promise.all([
    service
      .from("campaign_sequences")
      .select("*")
      .eq("id", sequenceId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle(),
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
          .eq("brokerage_id", ctx.brokerageId)
          .order("enrolled_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: null, error: null }),
  ])

  if (seqRes.error) return { sequence: null, steps: [], enrollments: [], error: seqRes.error.message }

  // The three reads run in parallel, so the steps and enrollments queries fire
  // before the brokerage predicate on the sequence has been evaluated. If the
  // sequence is not this caller's, refuse HERE — returning `sequence: null`
  // alongside populated steps and enrollments would leak exactly the message
  // copy and contact PII the gate above exists to protect.
  if (!seqRes.data) return { sequence: null, steps: [], enrollments: [], error: "Sequence not found" }

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
  // Tenant gate: service client bypasses RLS, so we must verify the sequence
  // belongs to the caller's brokerage before mutating.
  const ctx = await getAgentContext()
  if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const service = createServiceClient()
  const { data: existing } = await service
    .from("campaign_sequences")
    .select("brokerage_id")
    .eq("id", sequenceId)
    .maybeSingle()
  if (!existing) return { success: false, error: "Sequence not found" }
  if (existing.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden: sequence in another brokerage" }
  }

  const { error } = await service
    .from("campaign_sequences")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", sequenceId)
    .eq("brokerage_id", ctx.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
  return { success: true }
}

// ─── Delete sequence ──────────────────────────────────────────────────────────

export async function deleteCampaignSequence(sequenceId: string): Promise<{ success: boolean; error?: string }> {
  // Tenant gate: service client bypasses RLS, so we must verify the sequence
  // belongs to the caller's brokerage before deleting.
  const ctx = await getAgentContext()
  if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const service = createServiceClient()
  const { data: existing } = await service
    .from("campaign_sequences")
    .select("brokerage_id")
    .eq("id", sequenceId)
    .maybeSingle()
  if (!existing) return { success: false, error: "Sequence not found" }
  if (existing.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden: sequence in another brokerage" }
  }

  const { error } = await service
    .from("campaign_sequences")
    .delete()
    .eq("id", sequenceId)
    .eq("brokerage_id", ctx.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  return { success: true }
}

// ─── Create step ──────────────────────────────────────────────────────────────

/**
 * Three surfaces write steps through here (both campaign builders and the
 * marketing studio). It used to take the service client straight to an INSERT
 * with NO ownership check — a signed-in user of any brokerage could add a step
 * to any sequence they knew the id of — and it accepted only subject/body, so
 * every per-channel field its callers collected was dropped. Both are fixed
 * below: the sequence must belong to the caller's brokerage, the channel must be
 * one the column admits, and the palette's fields ride through.
 */
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
  [field: string]: unknown
}): Promise<{ step: SequenceStep | null; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { step: null, error: "Not authenticated" }

  const service = createServiceClient()

  const { data: owner } = await service
    .from("campaign_sequences")
    .select("brokerage_id")
    .eq("id", params.sequence_id)
    .maybeSingle()
  if (!owner || owner.brokerage_id !== ctx.brokerageId) {
    return { step: null, error: "Unauthorized" }
  }

  if (!params.channel || !VALID_STEP_TYPES.has(params.channel as any)) {
    return { step: null, error: `Invalid step channel: ${params.channel || "(empty)"}` }
  }

  const row: Record<string, unknown> = {
    sequence_id: params.sequence_id,
    step_number: params.step_number,
    step_name: params.step_name,
    channel: params.channel,
    delay_days: params.delay_days,
    delay_hours: params.delay_hours,
    subject: params.subject ?? null,
    // body is NOT NULL. This wrote `?? null`, and the sequence builder's "Add
    // step" passes no body — so the INSERT was rejected every time, the action
    // returned { step: null }, and the caller's `if (result.step)` swallowed it.
    // The button appeared to do nothing at all. saveSequenceSteps had it right
    // with `|| ""`; this now matches.
    body: params.body ?? "",
    send_time: params.send_time ?? null,
    is_active: true,
    sent_count: 0,
    open_count: 0,
    click_count: 0,
    reply_count: 0,
  }
  for (const name of PALETTE_STEP_FIELDS) {
    if (name in row) continue
    if (!(name in params)) continue
    row[name] = fieldValueForWrite(name, params[name])
  }

  const { data, error } = await service
    .from("campaign_sequence_steps")
    .insert(row)
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
  updates: Partial<Pick<SequenceStep, "step_name" | "channel" | "delay_days" | "delay_hours" | "subject" | "body" | "send_time" | "is_active">> & Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const service = createServiceClient()

  // The step must live in a sequence this brokerage owns. Checking the SEQUENCE
  // is not enough on its own — a caller could pass a step id from elsewhere with
  // a sequence id of their own — so the step's own sequence_id is what is read.
  const { data: step } = await service
    .from("campaign_sequence_steps")
    .select("sequence_id, campaign_sequences!inner(brokerage_id)")
    .eq("id", stepId)
    .maybeSingle()
  const ownerBrokerage = (step as any)?.campaign_sequences?.brokerage_id
  if (!step || ownerBrokerage !== ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  if (updates.channel !== undefined && !VALID_STEP_TYPES.has(updates.channel as any)) {
    return { success: false, error: `Invalid step channel: ${updates.channel || "(empty)"}` }
  }

  // The common columns, plus whatever palette fields the caller sent. A key the
  // palette does not declare is never written, so the Record<string, unknown>
  // above cannot be used to reach an arbitrary column.
  const ALLOWED_COMMON = [
    "step_name", "channel", "delay_days", "delay_hours",
    "subject", "body", "send_time", "is_active",
  ]
  const patch: Record<string, unknown> = {}
  for (const k of ALLOWED_COMMON) {
    if (k in updates) patch[k] = (updates as Record<string, unknown>)[k]
  }
  for (const name of PALETTE_STEP_FIELDS) {
    if (name in patch) continue
    if (!(name in updates)) continue
    patch[name] = fieldValueForWrite(name, (updates as Record<string, unknown>)[name])
  }
  if (Object.keys(patch).length === 0) return { success: true }

  const { error } = await service
    .from("campaign_sequence_steps")
    .update(patch)
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

/**
 * Launch (or re-launch) a sequence: verify it has steps, then flip is_active.
 *
 * This is also the survivor of the former `resumeCampaignSequence`, whose entire
 * body was `return launchCampaignSequence(sequenceId)` — resuming a paused
 * sequence and launching one are the same write, so there was nothing to merge.
 * Removed rather than kept as a second public endpoint onto the same mutation.
 */
export async function launchCampaignSequence(sequenceId: string): Promise<{ success: boolean; error?: string }> {
  // Tenant gate: service client bypasses RLS, so we must verify the sequence
  // belongs to the caller's brokerage before mutating. This gate was missing —
  // it activates a sequence, i.e. it starts sending real messages to real
  // contacts, and a bare sequence uuid was enough to start any brokerage's.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const service = createServiceClient()

  const { data: existing, error: readError } = await service
    .from("campaign_sequences")
    .select("brokerage_id")
    .eq("id", sequenceId)
    .maybeSingle()
  if (readError) return { success: false, error: readError.message }
  if (!existing) return { success: false, error: "Sequence not found" }
  if (existing.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden: sequence in another brokerage" }
  }

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
    .eq("brokerage_id", ctx.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/campaigns/sequences")
  revalidatePath(`/dashboard/campaigns/sequences/${sequenceId}`)
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
  // Tenant gate: service client bypasses RLS, so we must verify the enrollment
  // belongs to the caller's brokerage before mutating.
  //
  // This function had NO gate at all while every other service-client mutation
  // in this file (deleteCampaignSequence, updateCampaignSequence, …) carries the
  // comment above. As a "use server" export it is a public endpoint, so an
  // enrollment uuid was enough to cancel any brokerage's enrollment — pulling a
  // contact out of a nurture sequence with no trace of who did it.
  //
  // It also took `sequenceId` purely for revalidatePath and never checked the
  // enrollment was IN that sequence; the row's own sequence_id is authoritative
  // and is what gets confirmed below.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const service = createServiceClient()
  const { data: existing, error: readError } = await service
    .from("sequence_enrollments")
    .select("id, brokerage_id, sequence_id")
    .eq("id", enrollmentId)
    .maybeSingle()

  // A refused read is not "no rows" — fail closed rather than reporting a
  // cancellation that never happened.
  if (readError) return { success: false, error: readError.message }
  if (!existing) return { success: false, error: "Enrollment not found" }
  if (existing.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden: enrollment in another brokerage" }
  }

  const { data: updated, error } = await service
    .from("sequence_enrollments")
    .update({ status: "cancelled" })
    .eq("id", enrollmentId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!updated?.length) return { success: false, error: "Enrollment not cancelled" }

  revalidatePath(`/dashboard/campaigns/sequences/${existing.sequence_id ?? sequenceId}`)
  return { success: true }
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

      // The per-channel columns are taken from the STEP PALETTE, not from a
      // hand-kept list. The old list covered about half of what the palette
      // declares — a broker could set an ad budget, a gift occasion, an e-sign
      // recipient or a tour's properties and the save would drop them without
      // a word, then the adapter would fail at dispatch days later with "No ad
      // platform configured". The palette is also the ALLOW-LIST: a key the
      // palette does not declare is never written, so the index signature on
      // SequenceBuilderStep cannot be used to reach an arbitrary column.
      const buildRow = (s: SequenceBuilderStep, overrideIdx?: number) => {
        const row: Record<string, unknown> = {
          sequence_id: sequenceId,
          step_number: overrideIdx ?? steps.indexOf(s) + 1,
          step_name: s.step_name || s.step_type,
          channel: s.step_type,
          delay_days: s.delay_days ?? 0,
          delay_hours: s.delay_hours ?? 0,
          subject: s.subject ?? null,
          body: s.body || "",
          is_active: s.is_active ?? true,
        }
        for (const name of PALETTE_STEP_FIELDS) {
          if (name in row) continue          // the common fields above win
          if (!(name in s)) continue         // absent = leave the column alone
          row[name] = fieldValueForWrite(name, (s as Record<string, unknown>)[name])
        }
        return row
      }

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
