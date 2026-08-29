import { createClient } from "@/lib/supabase/server"
import { createHash } from "crypto"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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

  // A MAPPING ROW CANNOT EXIST YET, AND THAT IS CORRECT — do not "fix" this by
  // inserting one.
  //
  // `calendar_sync_mappings` is read here (brokerage_id, calendar_event_id,
  // provider_account_id) and inserted by nothing, which reads like a missing
  // writer. It is not. Measured live on 2026-08-29 against
  // hrvaqgvukzxfskkcrwbt: the table holds 0 rows, and `provider_event_id` is
  // `text NOT NULL` with no default and no trigger. That column is the
  // PROVIDER'S id for the event — the one fact this module cannot know, because
  // the provider adapter is not enabled (the two sync logs below record exactly
  // that, status 'partial', error_message "Provider adapter not enabled").
  // Writing a mapping without it is impossible; writing one with a placeholder
  // would assert that a local event is synced to a Google/Outlook event that
  // does not exist, and `is_synced` would stop meaning anything.
  //
  // So the missing half is the ADAPTER, not a row. When it lands, the mapping is
  // inserted at the point the provider returns its event id, and this lookup
  // starts finding rows without changing. Until then the branch below is
  // correctly unreachable and the module correctly reports 'partial'.
  const { data: existingMapping, error: mappingError } = await supabase
    .from("calendar_sync_mappings")
    .select("id")
    .eq("calendar_event_id", params.calendarEventId)
    .eq("provider_account_id", params.providerAccountId)
    .maybeSingle()

  // A refused read resolves as data:null, which is indistinguishable from "no
  // mapping yet" — and "no mapping yet" is this path's normal state, so the
  // refusal would be invisible forever (CLAUDE.md §3).
  if (mappingError) {
    throw new Error(`Failed to read sync mapping: ${mappingError.message}`)
  }

  if (existingMapping) {
    // Update sync_hash only — provider_event_id is managed by the real provider adapter
    const { error: updateError } = await supabase
      .from("calendar_sync_mappings")
      .update({
        sync_hash: syncHash,
        last_synced_at: new Date().toISOString(),
        is_synced: false,
      })
      .eq("id", existingMapping.id)
      .eq("brokerage_id", brokerageId)

    if (updateError) {
      throw new Error(`Failed to update sync mapping: ${updateError.message}`)
    }
  }

  // Log the push attempt — provider adapter not yet enabled
  const { error: logError } = await supabase.from("calendar_sync_logs").insert({
    brokerage_id: brokerageId,
    provider_account_id: params.providerAccountId,
    direction: "push",
    event_count: 1,
    status: "partial",
    error_message: "Provider adapter not enabled",
    started_at: new Date().toISOString(),
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
