import { createClient } from "@/lib/supabase/server"
import { createHash } from "crypto"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import type { CalendarProvider } from "@/lib/providers/calendar/types"
import { googleCalendarSyncAdapter } from "@/lib/providers/calendar/google-calendar-sync-adapter"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type CalendarProviderType = "google_calendar" | "outlook"

export type CalendarProviderAccountRow = {
  id: string
  brokerage_id: string
  user_id: string
  provider_type: CalendarProviderType
  provider_account_id: string
  token_expires_at: string | null
  is_active: boolean
  last_sync_at: string | null
  sync_direction: "inbound" | "outbound" | "bidirectional"
  created_at: string
  updated_at: string
}

export type CalendarSyncMappingRow = {
  id: string
  brokerage_id: string
  calendar_event_id: string
  provider_account_id: string
  provider_event_id: string
  provider_type: CalendarProviderType
  last_synced_at: string
  is_synced: boolean
  sync_hash: string | null
}

export type CalendarSyncLogRow = {
  id: string
  brokerage_id: string
  provider_account_id: string
  direction: "push" | "pull"
  event_count: number | null
  status: "success" | "partial" | "failed"
  error_message: string | null
  started_at: string
  completed_at: string | null
}

type CalendarEventForHash = {
  id: string
  brokerage_id: string
  entity_type: string
  entity_id: string
  event_type: string
  start_at: string
  end_at: string | null
  timezone_name: string
  metadata: Record<string, unknown> | null
}

// ─── HASH HELPER ──────────────────────────────────────────────────────────────

function computeSyncHash(event: CalendarEventForHash): string {
  const key = JSON.stringify({
    event_type: event.event_type,
    start_at: event.start_at,
    end_at: event.end_at,
    timezone_name: event.timezone_name,
    entity: `${event.entity_type}:${event.entity_id}`,
  })
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

// ─── INTERNAL HELPERS ─────────────────────────────────────────────────────────

async function requireUserContext(
  userId: string
): Promise<{ brokerageId: string; userType: string }> {
  const supabase = await createClient()
  const { data: user, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", userId)
    .single()
  if (error || !user) throw new Error("User not found")
  return { brokerageId: user.brokerage_id, userType: user.user_type }
}

async function assertCanAccessAccount(params: {
  supabase: Awaited<ReturnType<typeof createClient>>
  userType: string
  userId: string
  accountId: string
}): Promise<void> {
  if (params.userType === "agent") {
    const { data: account } = await params.supabase
      .from("calendar_provider_accounts")
      .select("user_id")
      .eq("id", params.accountId)
      .single()
    if (!account || account.user_id !== params.userId) {
      throw new Error("Forbidden: cannot access other agents' accounts")
    }
    return
  }
  if (!isAdminOrBroker({ user_type: params.userType })) {
    throw new Error("Forbidden: insufficient permissions")
  }
}

// ─── THE ADAPTER SEAM ─────────────────────────────────────────────────────────
//
// The push path's outcome is decided here: an implementer of the CalendarProvider port
// (lib/providers/calendar/types.ts) registers per provider, and `upsertEvent` returning the
// PROVIDER'S event id is the one fact a calendar_sync_mappings row cannot exist without.
//
// GOOGLE IS NOW BUILT (w26, lane C8) — see lib/providers/calendar/google-calendar-sync-adapter.ts.
// The long-standing do-not-fix note further down recorded that the missing half was the
// ADAPTER, not a row; that half now exists for google_calendar, so pushCalendarEventToProvider
// really pushes and really writes the mapping.
//
// OUTLOOK IS STILL ABSENT, AND DELIBERATELY SO: the same reasoning that made a placeholder
// mapping row forbidden makes a placeholder adapter forbidden. An outlook account therefore
// still falls through to the 'partial' log below, which is the honest report — "nobody checked"
// must never render as "checked and fine" (CLAUDE.md §4).
const CALENDAR_SYNC_ADAPTERS: Partial<Record<CalendarProviderType, CalendarProvider>> = {
  google_calendar: googleCalendarSyncAdapter,
  // outlook: not built. Microsoft Graph is reachable the same way (see
  // lib/providers/calendar/personal-calendar.ts), but an adapter nobody has exercised
  // end to end must not be registered — registration is what turns the push path on.
}

/** Resolve the sync adapter for a provider, or null while none is built/registered. */
export function resolveCalendarSyncAdapter(providerType: CalendarProviderType): CalendarProvider | null {
  return CALENDAR_SYNC_ADAPTERS[providerType] ?? null
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export async function linkCalendarProvider(params: {
  userId: string
  providerType: CalendarProviderType
  providerAccountId: string
}): Promise<{ id: string }> {
  const supabase = await createClient()
  const { brokerageId } = await requireUserContext(params.userId)

  const { data: upserted, error } = await supabase
    .from("calendar_provider_accounts")
    .upsert(
      {
        brokerage_id: brokerageId,
        user_id: params.userId,
        provider_type: params.providerType,
        provider_account_id: params.providerAccountId,
        is_active: true,
        sync_direction: "bidirectional",
        token_expires_at: null,
      },
      {
        onConflict: "brokerage_id,provider_type,provider_account_id,user_id",
        ignoreDuplicates: false,
      }
    )
    .select("id")
    .single()

  if (error || !upserted) {
    throw new Error(`Failed to link calendar provider: ${error?.message ?? "no row returned"}`)
  }

  return { id: upserted.id }
}

export async function pushCalendarEventToProvider(params: {
  userId: string
  calendarEventId: string
  providerAccountId: string
}): Promise<void> {
  const supabase = await createClient()
  const { brokerageId, userType } = await requireUserContext(params.userId)

  await assertCanAccessAccount({
    supabase,
    userType,
    userId: params.userId,
    accountId: params.providerAccountId,
  })

  // Load calendar event — brokerage-scoped
  const { data: calendarEvent, error: eventError } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("id", params.calendarEventId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (eventError || !calendarEvent) {
    throw new Error(`Calendar event not found: ${eventError?.message ?? "no data"}`)
  }

  const syncHash = computeSyncHash(calendarEvent as CalendarEventForHash)
  const startedAt = new Date().toISOString()

  // THE MAPPING ROW'S WRITER, AT LAST (w26, lane C8).
  //
  // For four waves this lookup was read-only and the table had no writer, and that was
  // CORRECT while it lasted: `provider_event_id` is `text NOT NULL` and holds the
  // PROVIDER'S id for the event — a fact this module could not know, because no adapter
  // existed. A placeholder would have asserted that a local event is synced to a
  // Google/Outlook event that does not exist, and `is_synced` would have stopped meaning
  // anything. The standing ruling was therefore "the missing half is the ADAPTER, not a
  // row", and it is discharged the only way it could be: an adapter now returns that id
  // (lib/providers/calendar/google-calendar-sync-adapter.ts) and the row is written at the
  // moment it comes back — never before, never without one.
  const { data: existingMapping, error: mappingError } = await supabase
    .from("calendar_sync_mappings")
    .select("id, provider_event_id, sync_hash, is_synced")
    .eq("calendar_event_id", params.calendarEventId)
    .eq("provider_account_id", params.providerAccountId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // A refused read resolves as data:null, which is indistinguishable from "no
  // mapping yet" — and for an event that has never synced, "no mapping yet" is this
  // path's normal state, so the refusal would be invisible forever (CLAUDE.md §3).
  if (mappingError) {
    throw new Error(`Failed to read sync mapping: ${mappingError.message}`)
  }

  // THE ADAPTER SEAM, consulted (see resolveCalendarSyncAdapter above). The error on the
  // account read is CHECKED (§3): a refused read must not be reported as a completed push.
  // `user_id` is loaded because the credential belongs to the ACCOUNT'S OWNER, not to
  // whoever triggered the push — a broker pushing to an agent's calendar must use the
  // agent's own Google connection, never their own.
  const { data: accountRow, error: accountReadError } = await supabase
    .from("calendar_provider_accounts")
    .select("provider_type, user_id, is_active, sync_direction")
    .eq("id", params.providerAccountId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (accountReadError) {
    throw new Error(`Failed to read provider account: ${accountReadError.message}`)
  }
  const adapter = accountRow
    ? resolveCalendarSyncAdapter(accountRow.provider_type as CalendarProviderType)
    : null

  if (adapter && accountRow) {
    // An account the tenant has switched off, or one set to pull only, must not be
    // written to. Fail closed rather than pushing to a calendar nobody asked for.
    if (accountRow.is_active === false) {
      throw new Error("This calendar connection is inactive — nothing was pushed.")
    }
    if (accountRow.sync_direction === "inbound") {
      throw new Error("This calendar connection is inbound-only — nothing was pushed.")
    }

    const ownerUserId = accountRow.user_id as string | null
    if (!ownerUserId) {
      throw new Error("This calendar connection has no owner recorded — no credential can be resolved for it.")
    }

    // NOTHING CHANGED → NOTHING SENT. The hash is over the fields the provider event is
    // built from, so an unchanged event costs no API call and no write.
    if (existingMapping && existingMapping.is_synced === true && existingMapping.sync_hash === syncHash) {
      return
    }

    const ev = calendarEvent as CalendarEventForHash & { title?: string | null; location?: string | null }
    const { externalId } = await adapter.upsertEvent({
      brokerageId,
      userId: ownerUserId,
      event: {
        // Present ONLY when we already hold one: this is what makes a re-push an update
        // instead of a duplicate event on the agent's calendar.
        externalId: (existingMapping?.provider_event_id as string | null) ?? undefined,
        title: ev.title?.trim() || ev.event_type,
        description: ev.location ? `Location: ${ev.location}` : undefined,
        startAtUtcISO: ev.start_at,
        endAtUtcISO: ev.end_at ?? undefined,
        timezoneName: ev.timezone_name,
        metadata: ev.metadata ?? undefined,
      },
    })

    const syncedAt = new Date().toISOString()
    // THE WRITE THIS TABLE HAS BEEN WAITING FOR. is_synced is true because the provider
    // has just acknowledged the event and handed back its id — the only moment at which
    // that claim is true.
    const mappingRow = {
      brokerage_id: brokerageId,
      calendar_event_id: params.calendarEventId,
      provider_account_id: params.providerAccountId,
      provider_event_id: externalId,
      provider_type: accountRow.provider_type as CalendarProviderType,
      sync_hash: syncHash,
      last_synced_at: syncedAt,
      is_synced: true,
    }
    const { data: written, error: mappingWriteError } = existingMapping
      ? await supabase
          .from("calendar_sync_mappings")
          .update(mappingRow)
          .eq("id", existingMapping.id)
          .eq("brokerage_id", brokerageId)
          .select("id")
      : await supabase.from("calendar_sync_mappings").insert(mappingRow).select("id")

    if (mappingWriteError) {
      throw new Error(`Event pushed to ${adapter.name} but the sync mapping could not be written: ${mappingWriteError.message}`)
    }
    // COUNTED (§3): an UPDATE that matched nothing resolves exactly like one that worked.
    // Zero rows here means the tenant predicate refused or the row moved under us — and
    // the event IS on the provider's calendar now, so a silent success would strand it
    // with no mapping and the next push would create a duplicate.
    if (!written || written.length === 0) {
      throw new Error(`Event pushed to ${adapter.name} but no sync mapping row was written — the provider event ${externalId} is now unmapped.`)
    }

    const { error: successLogError } = await supabase.from("calendar_sync_logs").insert({
      brokerage_id: brokerageId,
      provider_account_id: params.providerAccountId,
      direction: "push",
      event_count: 1,
      status: "success",
      error_message: null,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })
    if (successLogError) {
      throw new Error(`Failed to insert sync log: ${successLogError.message}`)
    }

    // Keep the account's own recency stamp honest — a successful push IS a sync.
    const { error: accountStampError } = await supabase
      .from("calendar_provider_accounts")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", params.providerAccountId)
      .eq("brokerage_id", brokerageId)
    if (accountStampError) {
      throw new Error(`Failed to update last_sync_at: ${accountStampError.message}`)
    }
    return
  }

  // NO ADAPTER FOR THIS PROVIDER (outlook today). No id, so no mapping — the same
  // ruling as before, now scoped to the providers that genuinely lack an adapter. The
  // 'partial' log is the honest report and names WHICH provider is unbuilt.
  const { error: logError } = await supabase.from("calendar_sync_logs").insert({
    brokerage_id: brokerageId,
    provider_account_id: params.providerAccountId,
    direction: "push",
    event_count: 1,
    status: "partial",
    error_message: accountRow
      ? `Provider adapter not enabled for '${accountRow.provider_type}'`
      : "Provider adapter not enabled",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
  })

  if (logError) {
    throw new Error(`Failed to insert sync log: ${logError.message}`)
  }
}

export async function pullCalendarEventsFromProvider(params: {
  userId: string
  providerAccountId: string
}): Promise<void> {
  const supabase = await createClient()
  const { brokerageId, userType } = await requireUserContext(params.userId)

  await assertCanAccessAccount({
    supabase,
    userType,
    userId: params.userId,
    accountId: params.providerAccountId,
  })

  const startedAt = new Date().toISOString()

  // Stub: provider adapter not yet enabled
  const { error: logError } = await supabase.from("calendar_sync_logs").insert({
    brokerage_id: brokerageId,
    provider_account_id: params.providerAccountId,
    direction: "pull",
    event_count: null,
    status: "partial",
    error_message: "Provider adapter not enabled",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
  })

  if (logError) {
    throw new Error(`Failed to insert sync log: ${logError.message}`)
  }

  // Update last_sync_at on the provider account
  const { error: updateError } = await supabase
    .from("calendar_provider_accounts")
    .update({ last_sync_at: new Date().toISOString() })
    .eq("id", params.providerAccountId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    throw new Error(`Failed to update last_sync_at: ${updateError.message}`)
  }
}

export async function listProviderAccounts(params: {
  userId: string
}): Promise<CalendarProviderAccountRow[]> {
  const supabase = await createClient()
  const { brokerageId, userType } = await requireUserContext(params.userId)

  // Explicitly select only safe columns — never include token fields
  const selectColumns = [
    "id",
    "brokerage_id",
    "user_id",
    "provider_type",
    "provider_account_id",
    "token_expires_at",
    "is_active",
    "last_sync_at",
    "sync_direction",
    "created_at",
    "updated_at",
  ].join(", ")

  let query = supabase
    .from("calendar_provider_accounts")
    .select(selectColumns)
    .eq("brokerage_id", brokerageId)

  if (userType === "agent") {
    query = query.eq("user_id", params.userId)
  } else if (!isAdminOrBroker({ user_type: userType })) {
    throw new Error("Forbidden: insufficient permissions")
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list provider accounts: ${error.message}`)
  }

  return (data ?? []) as unknown as CalendarProviderAccountRow[]
}

/**
 * EVERY EVENT THIS ACCOUNT HAS MAPPED TO THE PROVIDER, newest sync first.
 *
 * The reader half of the mapping row (w26, lane C8). `pushCalendarEventToProvider` now
 * writes provider_event_id / provider_type / sync_hash / last_synced_at / is_synced, and
 * without this every one of them would be write-only — the agent could see that a push
 * was logged and still have no way to tell WHICH of their events are on the provider's
 * calendar, under which provider id, or how long ago each was last reconciled. That is
 * the question a calendar-sync screen exists to answer.
 *
 * `sync_hash` is deliberately NOT returned: it is an internal 16-char digest used to skip
 * unchanged pushes, and printing it would invite it to be read as a version an operator
 * can act on.
 */
export async function listSyncMappings(params: {
  userId: string
  providerAccountId: string
}): Promise<Array<Pick<CalendarSyncMappingRow, "id" | "calendar_event_id" | "provider_event_id" | "provider_type" | "last_synced_at" | "is_synced">>> {
  const supabase = await createClient()
  const { brokerageId, userType } = await requireUserContext(params.userId)

  await assertCanAccessAccount({
    supabase,
    userType,
    userId: params.userId,
    accountId: params.providerAccountId,
  })

  const { data, error } = await supabase
    .from("calendar_sync_mappings")
    .select("id, calendar_event_id, provider_event_id, provider_type, last_synced_at, is_synced")
    .eq("provider_account_id", params.providerAccountId)
    .eq("brokerage_id", brokerageId)
    .order("last_synced_at", { ascending: false })
    .limit(50)

  // §3 — an empty mapping list is this surface's normal state before the first push, so
  // a refusal rendered as "nothing synced" would be permanently invisible.
  if (error) {
    throw new Error(`Failed to list sync mappings: ${error.message}`)
  }

  return (data ?? []) as Array<Pick<CalendarSyncMappingRow, "id" | "calendar_event_id" | "provider_event_id" | "provider_type" | "last_synced_at" | "is_synced">>
}

export async function listSyncLogs(params: {
  userId: string
  providerAccountId: string
}): Promise<CalendarSyncLogRow[]> {
  const supabase = await createClient()
  const { brokerageId, userType } = await requireUserContext(params.userId)

  await assertCanAccessAccount({
    supabase,
    userType,
    userId: params.userId,
    accountId: params.providerAccountId,
  })

  const { data, error } = await supabase
    .from("calendar_sync_logs")
    .select(
      "id, brokerage_id, provider_account_id, direction, event_count, status, error_message, started_at, completed_at"
    )
    .eq("provider_account_id", params.providerAccountId)
    .eq("brokerage_id", brokerageId)
    .order("started_at", { ascending: false })
    .limit(50)

  if (error) {
    throw new Error(`Failed to list sync logs: ${error.message}`)
  }

  return (data ?? []) as CalendarSyncLogRow[]
}
