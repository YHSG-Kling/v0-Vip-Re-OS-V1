// TypeScript strict — no any, no default export
// Routes through the consolidated per-agent calendar provider (lib/providers/calendar),
// which uses the agent's connected Google/Microsoft OAuth token. The old registry/stub
// path (providers/calendar/registry.ts + google.ts) has been removed.

import { createClient } from "@/lib/supabase/server"
import { createCalendarEvent, updateCalendarEvent } from "@/lib/providers/calendar"
import type { CalendarProviderType } from "@/lib/kernel/calendar-sync"

export async function syncCalendarEventToProvider(params: {
  brokerageId: string
  userId: string
  /** Which provider the caller believes it is syncing to. Converged (§6, 2026-08-31) onto the
   *  CHECK-backed CalendarProviderType — the deleted `CalendarProviderName` ("google"|"outlook"|
   *  "ical") was a second spelling; see lib/providers/calendar/types.ts. NOTE: the body below
   *  never reads this — the real provider is resolved from the agent's connected account — so
   *  it is documentation of intent, not routing. */
  provider: CalendarProviderType
  calendarEventId: string
}): Promise<void> {
  const { userId, calendarEventId } = params
  const supabase = await createClient()

  // ── Step 1: Load calendar_events row by id ──────────────────────────────
  const { data: row, error: fetchError } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("id", calendarEventId)
    .single()

  if (fetchError) {
    throw new Error(
      `[CalendarSyncOrchestrator] Failed to fetch calendar_event ${calendarEventId}: ${fetchError.message}`
    )
  }

  if (!row) {
    throw new Error(
      `[CalendarSyncOrchestrator] calendar_event not found: ${calendarEventId}`
    )
  }

  // ── Step 2: Build the calendar event ────────────────────────────────────
  const metadata = (row.metadata ?? {}) as Record<string, unknown>
  const existingExternalId = typeof metadata.externalId === "string" ? metadata.externalId : undefined

  const event = {
    title: typeof metadata.title === "string" ? metadata.title : (row.event_type as string),
    description: typeof metadata.description === "string" ? metadata.description : undefined,
    startTime: row.start_at as string,
    endTime: (row.end_at ? (row.end_at as string) : (row.start_at as string)),
  }

  // ── Step 3: Create/update on the agent's connected calendar ──────────────
  // The agent's connected Google/Microsoft account (resolved by agentUserId) determines
  // the real provider; when none is connected the provider returns a mock id (no crash).
  const actor = { agentUserId: userId }
  let externalId: string
  if (existingExternalId) {
    const updated = await updateCalendarEvent(existingExternalId, event, actor)
    if (!updated.success) {
      throw new Error(`[CalendarSyncOrchestrator] updateCalendarEvent failed: ${updated.error ?? "unknown"}`)
    }
    externalId = existingExternalId
  } else {
    const created = await createCalendarEvent(event, actor)
    if (!created.success || !created.eventId) {
      throw new Error(`[CalendarSyncOrchestrator] createCalendarEvent failed: ${created.error ?? "no eventId"}`)
    }
    externalId = created.eventId
  }

  // ── Step 4: Merge externalId back into calendar_events.metadata ─────────
  // Preserve all existing metadata fields, only add/update externalId
  const updatedMetadata: Record<string, unknown> = {
    ...metadata,
    externalId,
  }

  const { error: updateError } = await supabase
    .from("calendar_events")
    .update({ metadata: updatedMetadata })
    .eq("id", calendarEventId)

  if (updateError) {
    throw new Error(
      `[CalendarSyncOrchestrator] Failed to persist externalId for calendar_event ${calendarEventId}: ${updateError.message}`
    )
  }
}
