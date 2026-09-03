"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import {
  linkCalendarProvider,
  pushCalendarEventToProvider,
  pullCalendarEventsFromProvider,
  listProviderAccounts,
  listSyncLogs,
  listSyncMappings,
  type CalendarProviderType,
  type CalendarProviderAccountRow,
  type CalendarSyncLogRow,
} from "@/lib/kernel"

/**
 * calendar_provider_accounts.provider_type CHECK, read live from project
 * hrvaqgvukzxfskkcrwbt: google_calendar | outlook. Nothing else. A "use server"
 * action receives whatever the network sends it, so the TypeScript union above
 * is a compile-time comment as far as runtime is concerned — this array is the
 * runtime gate, and it is the reason an unsupported provider comes back as a
 * refusal instead of as SQLSTATE 23514 from a stack trace.
 *
 * Kept as a module-local const rather than an export: a `"use server"` module
 * may only export async functions, and a non-function export breaks Next's
 * page-data collection.
 */
const LIVE_PROVIDER_TYPES: readonly CalendarProviderType[] = ["google_calendar", "outlook"]

const CALENDAR_SETTINGS_PATH = "/dashboard/settings/calendar"

/**
 * Link a calendar account to the signed-in user.
 *
 * Returns a verdict rather than throwing, because the caller is a form on the
 * calendar settings page and an unhandled throw there replaces the whole page
 * with an error boundary — which tells the agent nothing about WHICH field the
 * database refused.
 *
 * HONESTY NOTE, carried into the UI: lib/kernel/calendar-sync.ts:linkCalendarProvider
 * stores no OAuth tokens (token_expires_at is written as null) and no provider
 * adapter is enabled, so "linked" here means the account is registered and sync
 * attempts will be LOGGED, not that events are flowing. The settings page states
 * that in those words and the sync log shows the provider-adapter refusal
 * verbatim.
 */
export async function connectCalendarProvider(input: {
  providerType: string
  providerAccountId: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, error: "Unauthorized" }

  const providerType = input.providerType?.trim() as CalendarProviderType
  if (!LIVE_PROVIDER_TYPES.includes(providerType)) {
    return {
      ok: false,
      error: `Unsupported calendar provider "${input.providerType}". This database accepts: ${LIVE_PROVIDER_TYPES.join(", ")}.`,
    }
  }

  const providerAccountId = input.providerAccountId?.trim()
  if (!providerAccountId) {
    return { ok: false, error: "The provider account (the calendar's email address or id) is required" }
  }

  try {
    const linked = await linkCalendarProvider({
      userId: user.id,
      providerType,
      providerAccountId,
    })
    revalidatePath(CALENDAR_SETTINGS_PATH)
    return { ok: true, id: linked.id }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The calendar account could not be linked",
    }
  }
}

/**
 * Push one VIP OS calendar event at a linked provider account.
 *
 * The kernel writes a calendar_sync_logs row for every attempt and this returns that
 * outcome instead of swallowing it, so the UI can never report a delivery that did not
 * happen. As of w26 a google_calendar account genuinely pushes (status 'success', with a
 * calendar_sync_mappings row carrying the provider's event id); an outlook account still
 * has no adapter and logs 'partial' with the reason.
 */
export async function syncEventToProvider(
  calendarEventId: string,
  providerAccountId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, error: "Unauthorized" }

  try {
    await pushCalendarEventToProvider({
      userId: user.id,
      calendarEventId,
      providerAccountId,
    })
    revalidatePath(CALENDAR_SETTINGS_PATH)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The event could not be queued for this calendar",
    }
  }
}

export async function syncFromProvider(providerAccountId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  await pullCalendarEventsFromProvider({
    userId: user.id,
    providerAccountId,
  })
}

export async function fetchMyProviderAccounts(): Promise<CalendarProviderAccountRow[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  return await listProviderAccounts({ userId: user.id })
}

/**
 * Every push and pull attempt against one linked account, newest first.
 *
 * listSyncLogs asserts account access before reading and throws on a refused
 * query; this converts that into a verdict the page can print, because an empty
 * log and a refused log must not look the same on screen.
 */
export async function fetchSyncLogs(
  providerAccountId: string,
): Promise<{ ok: true; logs: CalendarSyncLogRow[] } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, error: "Unauthorized" }

  try {
    const logs = await listSyncLogs({ userId: user.id, providerAccountId })
    return { ok: true, logs }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The sync history could not be read",
    }
  }
}

/**
 * WHICH EVENTS ARE ACTUALLY ON THE PROVIDER'S CALENDAR — the calendar_sync_mappings
 * reader (w26, lane C8). A log line says an attempt happened; a mapping row says the
 * provider holds this event under this id. Same verdict shape as fetchSyncLogs, for the
 * same reason: an empty mapping list and a refused read must not look the same on screen.
 */
export async function fetchSyncMappings(
  providerAccountId: string,
): Promise<
  | { ok: true; mappings: Awaited<ReturnType<typeof listSyncMappings>> }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, error: "Unauthorized" }

  try {
    const mappings = await listSyncMappings({ userId: user.id, providerAccountId })
    return { ok: true, mappings }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The synced-event list could not be read",
    }
  }
}
