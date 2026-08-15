"use server"

/**
 * Listing Appointment Co-Pilot — agent-facing reads + actions for the
 * `listing-appt-prep` workflow chain.
 *
 * The chain auto-fires when an agent schedules a listing consultation
 * (event 'listing.appointment_set' emitted from ai-calendar-management).
 * It produces:
 *   - CMA       (cma_reports row)
 *   - Presentation (listing_presentations row)
 *   - Chapter videos (ai_video_projects rows — canonical kernel table)
 *   - Drip touchpoints scheduled (activities rows with scheduled_for)
 *
 * Today there's no single agent surface to review what was produced.
 * This module provides the unified read + the agent acceptance action.
 *
 * Reuses canonical infrastructure end-to-end:
 *   - workflow_runs / workflow_run_steps (migration 1001)
 *   - cma_reports, listing_presentations, ai_video_projects, activities
 *   - users.user_type (kernel canonical, not .role)
 *
 * No new tables. No parallel actions.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ListingApptStep {
  key:         string
  label:       string
  status:      "pending" | "running" | "done" | "failed" | "skipped" | "needs_approval"
  startedAt:   string | null
  completedAt: string | null
  attempts:    number
  errorMessage: string | null
  output:      Record<string, unknown> | null
}

export interface ListingApptCmaSummary {
  cmaId:               string | null
  recommendedPrice:    number | null
  priceRangeLow:       number | null
  priceRangeHigh:      number | null
  comparableCount:     number | null
  pricingStrategySummary: string | null
  status:              string | null
}

export interface ListingApptPresentationSummary {
  presentationId: string | null
  presentationType: string | null
  status:           string | null
  chapterCount:     number | null
}

export interface ListingApptVideoSummary {
  videoIds:      string[]
  chapterTitles: string[]
  videos: Array<{
    id:            string
    chapter_title: string | null
    status:        string | null
    video_url:     string | null
    thumbnail_url: string | null
  }>
}

export interface ListingApptDripSummary {
  touchpointsScheduled: number
  firstTouchAt:         string | null
  lastTouchAt:          string | null
}

export interface ListingApptPrepDetail {
  runId:           string
  contactId:       string | null
  contactName:     string | null
  agentUserId:     string | null
  status:          "running" | "paused" | "completed" | "failed" | "cancelled"
  appointmentDate: string | null
  daysUntil:       number | null
  propertyAddress: string | null
  startedAt:       string
  completedAt:     string | null
  steps:           ListingApptStep[]
  cma:             ListingApptCmaSummary | null
  presentation:    ListingApptPresentationSummary | null
  videos:          ListingApptVideoSummary | null
  drip:            ListingApptDripSummary | null
  /** Overall readiness — every step .done counts toward 4/4. */
  readyPercent:    number
}

export interface ListingApptPrepRow {
  runId:           string
  contactId:       string | null
  contactName:     string | null
  appointmentDate: string | null
  daysUntil:       number | null
  propertyAddress: string | null
  readyPercent:    number
  status:          string
  /** Top blocker step label, if any */
  blockedOn:       string | null
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Upcoming listing-appt-prep runs for the agent's dashboard widget.
 * Returns runs whose appointment_date is in the future (or null when running).
 */
export async function getAgentUpcomingListingApptPreps(params: {
  agentId: string
  limit?:  number
}): Promise<ListingApptPrepRow[]> {
  const supabase = await createClient()
  const limit = params.limit ?? 5

  // Pull the agent's recent listing-appt-prep runs (running OR completed
  // in the last 7 days so the agent still sees the post-appointment view).
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: rows } = await supabase
    .from("workflow_runs")
    .select(
      "id, contact_id, listing_id, status, metadata, started_at, completed_at, step_outputs"
    )
    .eq("chain_key", "listing-appt-prep")
    .eq("agent_user_id", params.agentId)
    .or(`status.eq.running,started_at.gte.${sevenDaysAgo}`)
    .order("started_at", { ascending: false })
    .limit(20)

  if (!rows) return []

  // Hydrate contact names + appointment metadata, compute readiness
  const result: ListingApptPrepRow[] = []
  const contactIds = Array.from(
    new Set(
      (rows as Array<{ contact_id: string | null }>)
        .map((r) => r.contact_id)
        .filter((id): id is string => !!id),
    ),
  )

  const contactMap = new Map<string, { first_name: string | null; last_name: string | null }>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds)
    for (const c of (contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      contactMap.set(c.id, c)
    }
  }

  // Pull per-run step status to derive readyPercent + blockedOn
  const runIds = (rows as Array<{ id: string }>).map((r) => r.id)
  const stepsByRun = new Map<string, Array<{ step_index: number; step_label: string | null; status: string }>>()
  if (runIds.length > 0) {
    const { data: steps } = await supabase
      .from("workflow_run_steps")
      .select("run_id, step_index, step_label, status")
      .in("run_id", runIds)
      .order("step_index", { ascending: true })
    for (const s of (steps ?? []) as Array<{ run_id: string; step_index: number; step_label: string | null; status: string }>) {
      if (!stepsByRun.has(s.run_id)) stepsByRun.set(s.run_id, [])
      stepsByRun.get(s.run_id)!.push(s)
    }
  }

  for (const row of rows as Array<{
    id: string
    contact_id: string | null
    listing_id: string | null
    status: string
    metadata: Record<string, unknown> | null
    started_at: string
    completed_at: string | null
    step_outputs: Record<string, unknown> | null
  }>) {
    const contact = row.contact_id ? contactMap.get(row.contact_id) ?? null : null
    const contactName = contact
      ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || null
      : null

    const apptDate = (row.metadata?.appointment_date as string | undefined) ?? null
    const propData = (row.metadata?.property_data as { address?: string } | undefined) ?? null
    const daysUntil = apptDate
      ? Math.ceil((new Date(apptDate).getTime() - Date.now()) / 86_400_000)
      : null

    // Filter out runs whose appointment is already past 1 day (clutter)
    if (daysUntil != null && daysUntil < -1) continue

    const steps = stepsByRun.get(row.id) ?? []
    const total = Math.max(steps.length, 1)
    const done  = steps.filter((s) => s.status === "done").length
    const readyPercent = Math.round((done / total) * 100)
    const firstBlocker = steps.find(
      (s) => s.status === "pending" || s.status === "running" || s.status === "needs_approval" || s.status === "failed",
    )

    result.push({
      runId:           row.id,
      contactId:       row.contact_id,
      contactName,
      appointmentDate: apptDate,
      daysUntil,
      propertyAddress: propData?.address ?? null,
      readyPercent,
      status:          row.status,
      blockedOn:       firstBlocker?.step_label ?? null,
    })

    if (result.length >= limit) break
  }

  // Sort: soonest appointment first, then by lowest readyPercent (more
  // attention-needed first).
  result.sort((a, b) => {
    const da = a.daysUntil ?? Number.POSITIVE_INFINITY
    const db = b.daysUntil ?? Number.POSITIVE_INFINITY
    if (da !== db) return da - db
    return a.readyPercent - b.readyPercent
  })

  return result
}

/**
 * Full per-run prep detail — used by the comprehensive Co-Pilot panel.
 * Aggregates workflow_run_steps + dereferences cma_reports / presentation /
 * videos so the panel has everything in one round-trip.
 */
export async function getListingAppointmentPrepDetail(params: {
  runId: string
}): Promise<{ success: boolean; error?: string; data?: ListingApptPrepDetail }> {
  if (!isValidUUID(params.runId)) {
    return { success: false, error: "Invalid run id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: run } = await supabase
    .from("workflow_runs")
    .select("id, chain_key, contact_id, listing_id, agent_user_id, status, metadata, step_outputs, started_at, completed_at")
    .eq("id", params.runId)
    .maybeSingle()
  if (!run) return { success: false, error: "Run not found" }
  if (run.chain_key !== "listing-appt-prep") {
    return { success: false, error: "Run is not a listing-appt-prep chain" }
  }

  const { data: stepsRaw } = await supabase
    .from("workflow_run_steps")
    .select("step_index, step_key, step_label, status, started_at, completed_at, attempt_count, error_message, output")
    .eq("run_id", params.runId)
    .order("step_index", { ascending: true })

  const steps: ListingApptStep[] = ((stepsRaw ?? []) as Array<{
    step_index: number
    step_key: string
    step_label: string | null
    status: ListingApptStep["status"]
    started_at: string | null
    completed_at: string | null
    attempt_count: number
    error_message: string | null
    output: Record<string, unknown> | null
  }>).map((s) => ({
    key:          s.step_key,
    label:        s.step_label ?? s.step_key,
    status:       s.status,
    startedAt:    s.started_at,
    completedAt:  s.completed_at,
    attempts:     s.attempt_count,
    errorMessage: s.error_message,
    output:       s.output,
  }))

  // Contact name
  let contactName: string | null = null
  if (run.contact_id) {
    const { data: c } = await supabase
      .from("contacts")
      .select("first_name, last_name")
      .eq("id", run.contact_id)
      .maybeSingle()
    if (c) contactName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null
  }

  // Appointment date + property
  const apptDate = (run.metadata?.appointment_date as string | undefined) ?? null
  const propertyData = run.metadata?.property_data as { address?: string } | undefined
  const daysUntil = apptDate
    ? Math.ceil((new Date(apptDate).getTime() - Date.now()) / 86_400_000)
    : null

  // Dereference step outputs to richer data
  const stepOutputs = (run.step_outputs ?? {}) as Record<string, Record<string, unknown> | undefined>

  // CMA — live cma_reports schema uses FLAT numeric columns (not jsonb).
  // Fields: recommended_price, price_range_low, price_range_high,
  // comparable_count, market_conditions, status.
  let cma: ListingApptCmaSummary | null = null
  const cmaId = stepOutputs.generate_cma?.cmaId as string | undefined
  if (cmaId) {
    const { data: cmaRow } = await supabase
      .from("cma_reports")
      .select("id, recommended_price, price_range_low, price_range_high, comparable_count, market_conditions, status")
      .eq("id", cmaId)
      .maybeSingle()
    if (cmaRow) {
      cma = {
        cmaId:                  cmaRow.id as string,
        recommendedPrice:       (cmaRow.recommended_price as number | null | undefined) ?? null,
        priceRangeLow:          (cmaRow.price_range_low as number | null | undefined) ?? null,
        priceRangeHigh:         (cmaRow.price_range_high as number | null | undefined) ?? null,
        comparableCount:        (cmaRow.comparable_count as number | null | undefined) ?? null,
        pricingStrategySummary: (cmaRow.market_conditions as string | null | undefined) ?? null,
        status:                 (cmaRow.status as string | undefined) ?? null,
      }
    }
  }

  // Presentation — live listing_presentations schema has structured columns:
  // slide_deck (jsonb), marketing_plan (jsonb), cma_low/mid/high_value,
  // cma_narrative, presentation (text legacy), presentation_type (text),
  // appointment_at, status. Chapters are stored as items in slide_deck.
  let presentation: ListingApptPresentationSummary | null = null
  const presentationId = stepOutputs.generate_presentation?.presentationId as string | undefined
  if (presentationId) {
    const { data: p } = await supabase
      .from("listing_presentations")
      .select("id, presentation_type, status, slide_deck, marketing_plan")
      .eq("id", presentationId)
      .maybeSingle()
    if (p) {
      const slideDeck = p.slide_deck as { chapters?: unknown[]; sections?: unknown[]; slides?: unknown[] } | null
      const chapterCount = Array.isArray(slideDeck?.chapters)
        ? slideDeck.chapters.length
        : Array.isArray(slideDeck?.sections)
        ? slideDeck.sections.length
        : Array.isArray(slideDeck?.slides)
        ? slideDeck.slides.length
        : null
      presentation = {
        presentationId:   p.id as string,
        presentationType: (p.presentation_type as string | undefined) ?? null,
        status:           (p.status as string | undefined) ?? null,
        chapterCount,
      }
    }
  }

  // Videos
  let videos: ListingApptVideoSummary | null = null
  const videoIds = (stepOutputs.generate_chapter_videos?.videoIds as string[] | undefined) ?? []
  const chapterTitles = (stepOutputs.generate_chapter_videos?.chapterTitles as string[] | undefined) ?? []
  if (videoIds.length > 0) {
    const { data: vids } = await supabase
      .from("ai_video_projects")
      .select("id, status, video_url, thumbnail_url")
      .in("id", videoIds)
    const vidArr = (vids ?? []) as Array<{ id: string; status: string | null; video_url: string | null; thumbnail_url: string | null }>
    videos = {
      videoIds,
      chapterTitles,
      videos: vidArr.map((v) => {
        const idx = videoIds.indexOf(v.id)
        return {
          id:            v.id,
          chapter_title: chapterTitles[idx] ?? null,
          status:        v.status,
          video_url:     v.video_url,
          thumbnail_url: v.thumbnail_url,
        }
      }),
    }
  }

  // Drip
  let drip: ListingApptDripSummary | null = null
  const dripOutput = stepOutputs.enroll_drip
  if (dripOutput) {
    drip = {
      touchpointsScheduled: (dripOutput.touchpointsScheduled as number | undefined) ?? 0,
      firstTouchAt:         (dripOutput.firstTouchAt as string | undefined) ?? null,
      lastTouchAt:          (dripOutput.lastTouchAt as string | undefined) ?? null,
    }
  }

  // Readiness — done steps / total steps (skipped counts toward done)
  const completedish = steps.filter((s) => s.status === "done" || s.status === "skipped").length
  const total = Math.max(steps.length, 1)
  const readyPercent = Math.round((completedish / total) * 100)

  return {
    success: true,
    data: {
      runId:           run.id as string,
      contactId:       run.contact_id as string | null,
      contactName,
      agentUserId:     run.agent_user_id as string | null,
      status:          run.status as ListingApptPrepDetail["status"],
      appointmentDate: apptDate,
      daysUntil,
      propertyAddress: propertyData?.address ?? null,
      startedAt:       run.started_at as string,
      completedAt:     run.completed_at as string | null,
      steps,
      cma,
      presentation,
      videos,
      drip,
      readyPercent,
    },
  }
}

// ─── Action: mark prep ready ────────────────────────────────────────────────
// When all steps are done the agent flips the workflow_run to 'completed'
// (acknowledging they've reviewed everything). Status update is the agent's
// "I'm ready to present" signal — useful for analytics + the dashboard
// widget's "completed in last 7 days" filter.

export async function markListingApptPrepReady(params: {
  runId: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.runId)) {
    return { success: false, error: "Invalid run id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: run } = await supabase
    .from("workflow_runs")
    .select("id, chain_key, status, agent_user_id, contact_id")
    .eq("id", params.runId)
    .maybeSingle()
  if (!run) return { success: false, error: "Run not found" }
  if (run.chain_key !== "listing-appt-prep") {
    return { success: false, error: "Not a listing-appt-prep run" }
  }

  if (run.status === "completed") return { success: true }   // idempotent

  const { error } = await supabase
    .from("workflow_runs")
    .update({
      status:       "completed",
      completed_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq("id", params.runId)

  if (error) return { success: false, error: error.message }

  if (run.contact_id) {
    revalidatePath(`/dashboard/agent`)
  }
  return { success: true }
}
