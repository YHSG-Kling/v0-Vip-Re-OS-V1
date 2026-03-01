// TypeScript strict — no any, no default export
// Must not import Google/Outlook SDKs
// Must not contain provider-specific logic — only calls via resolveCalendarProvider

import { createClient } from "@/lib/supabase/server"
import { resolveCalendarProvider } from "@/lib/providers/calendar/registry"
import type { CalendarProviderName } from "@/lib/providers/calendar/types"

export async function syncCalendarEventToProvider(params: {
  brokerageId: string
  userId: string
  provider: CalendarProviderName
  calendarEventId: string
}): Promise<void> {
  const { brokerageId, userId, provider, calendarEventId } = params
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

  // ── Step 2: Build provider input ────────────────────────────────────────
  const metadata = (row.metadata ?? {}) as Record<string, unknown>

  const providerInput = {
    externalId: typeof metadata.externalId === "string" ? metadata.externalId : undefined,
    title: typeof metadata.title === "string" ? metadata.title : (row.event_type as string),
    description: typeof metadata.description === "string" ? metadata.description : undefined,
    startAtUtcISO: row.start_at as string,
    endAtUtcISO: row.end_at ? (row.end_at as string) : undefined,
    timezoneName: row.timezone_name as string,
    metadata,
  }

  // ── Step 3: Call provider.upsertEvent ────────────────────────────────────
  const calendarProvider = resolveCalendarProvider(provider)
  const { externalId } = await calendarProvider.upsertEvent({
    brokerageId,
    userId,
    event: providerInput,
  })

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
