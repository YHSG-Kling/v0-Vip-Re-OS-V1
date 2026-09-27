import { createServerClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import type { EventInput, Event } from "./types"

/**
 * The orchestration hook registered by lib/orchestrator/internal.ts. The slot
 * moved to ./dispatcher-registry (lane 86F) so the server-only core can reach it
 * without importing this cookie-client module; the name is re-exported unchanged.
 */
export { registerEventDispatcher } from "./dispatcher-registry"

// =====================================================
// MAIN HELPER - Log event and trigger orchestration — THE SESSION DOOR
// =====================================================

/**
 * THE SESSION DOOR onto lib/events/lifecycle-event-core.ts::recordLifecycleEvent
 * (lane 86F). The body — dedupe, entity derivation, the insert, the dispatch and
 * the kernel fan-out — moved to that server-only core, which runs on the SERVICE
 * client with a verified tenant. It used to run HERE on the cookie client, so
 * every sessionless caller (the zapier + dotloop webhooks, the e-sign finalize
 * and execution loops) was refused by RLS and threw before dispatching; those
 * callers now call the core with the brokerage of the row they verified.
 *
 * What stays here is the SESSION half, for the in-request callers
 * (submit-for-signature, logCreditStatusUpdated, logMilestoneOverdue,
 * logScriptGenerated): the tenant is the SESSION user's users.brokerage_id, and a
 * caller naming a DIFFERENT brokerage is refused (§4 — a body can never pick the
 * tenant). No session → refused (fail closed); a sessionless path must call the
 * core with its verified row's tenant instead.
 *
 * Contract kept for the callers: throws MISSING_BROKERAGE_ID / DUPLICATE_EVENT,
 * returns the dispatched Event.
 */
export async function logEventAndTrigger(eventInput: EventInput): Promise<Event> {
  if (!eventInput.brokerage_id) {
    console.error("[v0] logEventAndTrigger: brokerage_id is required but missing", eventInput.event_type)
    throw new Error("MISSING_BROKERAGE_ID")
  }

  const supabase = await createServerClient()
  const { data: auth } = await supabase.auth.getUser()
  const sessionUserId = auth?.user?.id ?? null
  if (!sessionUserId) {
    throw new Error("lifecycle event refused: no session — a sessionless caller must use recordLifecycleEvent with its verified row's brokerage")
  }
  const { data: me, error: meErr } = await supabase.from("users").select("brokerage_id").eq("id", sessionUserId).maybeSingle()
  if (meErr) throw new Error(`lifecycle event refused: session brokerage lookup refused: ${meErr.message}`)
  const sessionBrokerageId = (me?.brokerage_id as string | null) ?? null
  if (!sessionBrokerageId || sessionBrokerageId !== eventInput.brokerage_id) {
    throw new Error("lifecycle event refused: the named brokerage is not the session's")
  }

  const { brokerage_id: _named, ...rest } = eventInput
  void _named
  // Loaded at call time: the core is `server-only`, and this module sits behind the
  // lib/events barrel, which plain-tsx simulators reach transitively.
  const { recordLifecycleEvent } = await import("./lifecycle-event-core")
  const r = await recordLifecycleEvent(createServiceClient(), sessionBrokerageId, {
    ...rest,
    user_id: eventInput.user_id ?? sessionUserId,
  })
  if (!r.ok) {
    console.error("[v0] Error inserting event:", r.error)
    throw new Error(r.error)
  }
  if (r.deduped) {
    console.log(`[v0] Duplicate event detected: ${eventInput.dedupe_key}`)
    throw new Error("DUPLICATE_EVENT")
  }
  return r.event
}

// =====================================================
// CONVENIENCE FUNCTIONS - Typed event creators
// =====================================================

// logListingSigned + logListingLive RETIRED with the mark*Service callers — they emitted underscore
// events (LISTING_AGREEMENT_SIGNED / LISTING_PUBLISHED) the dotted dispatcher switch never matched.

export async function logMilestoneOverdue(params: {
  brokerage_id: string
  user_id: string
  milestone_id: string
  milestone_title: string
  days_overdue: number
  listing_id?: string | null
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.MILESTONE_OVERDUE,
    payload: {
      milestone_id: params.milestone_id,
      milestone_title: params.milestone_title,
      days_overdue: params.days_overdue,
      listing_id: params.listing_id,
    },
    source: "system",
  })
}

export async function logCreditStatusUpdated(params: {
  brokerage_id: string
  user_id: string
  contact_id: string
  old_status: string
  new_status: string
  score_band?: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.CREDIT_STATUS_UPDATED,
    payload: {
      contact_id: params.contact_id,
      old_status: params.old_status,
      new_status: params.new_status,
      score_band: params.score_band,
    },
    source: "ui",
  })
}

// RENAMED from logVideoGenerated (D-quindecies, kernel-event census tranche 7,
// 2026-09-10). The ONLY caller (app/actions/video-content.ts generateVideoScript)
// inserts into video_scripts_library — an AI SCRIPT, not a rendered video — and the
// old name emitted KernelEvent.VIDEO_GENERATION_COMPLETED with entityId a
// video_scripts_library.id. That id space belongs to ai_video_projects
// (lib/kernel/video-coordination.ts publishVideoCoordinationSignals, called by
// event-reactor.ts D-block #18 as `publishVideoCoordinationSignals(params.entityId,
// svc)`), so the coordinator's `.from("ai_video_projects").eq("id", scriptId)` lookup
// matched nothing and silently no-opped every time — a real capability (script-ready
// notification) that never fired, dressed as a working one. FIXED by emitting the
// event this moment actually is: KernelEvent.SCRIPT_GENERATED, entityType
// "video_script", entityId the video_scripts_library row — the EXACT vocabulary
// app/api/video-scripts/route.ts already uses for the same table (§6), which
// SIGNAL_HANDLERS["campaign_orchestrator:script_generated"] (lib/kernel/
// manager-signals.ts) already reads by that id via video_scripts_library.created_by.
// No new registry/handler work needed — the SCRIPT_GENERATED pipeline already exists
// end to end; this caller was simply plugged into the wrong one.
export async function logScriptGenerated(params: {
  brokerage_id: string
  user_id: string
  script_id: string
  video_type: string
  listing_id?: string
}): Promise<Event> {
  return logEventAndTrigger({
    brokerage_id: params.brokerage_id,
    user_id: params.user_id,
    event_type: KernelEvent.SCRIPT_GENERATED,
    entity_type: "video_script",
    entity_id: params.script_id,
    payload: {
      video_id: params.script_id,
      video_type: params.video_type,
      listing_id: params.listing_id,
    },
    source: "system",
    dedupe_key: `script_generated_${params.script_id}`,
  })
}

// =====================================================
// WEBHOOK HANDLER - For external events
// =====================================================

export async function handleWebhookEvent(webhookPayload: any): Promise<Event> {
  // Parse webhook and convert to internal event format
  // This is a placeholder - adjust based on your webhook provider

  const eventInput: EventInput = {
    brokerage_id: webhookPayload.brokerage_id,
    user_id: webhookPayload.user_id,
    event_type: webhookPayload.event_type,
    payload: webhookPayload.data,
    source: "webhook",
    dedupe_key: webhookPayload.id, // Use webhook ID as dedupe key
  }

  return logEventAndTrigger(eventInput)
}
