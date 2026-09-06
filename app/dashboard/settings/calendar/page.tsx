import { redirect } from "next/navigation"
import {
  fetchMyProviderAccounts,
  syncFromProvider,
  connectCalendarProvider,
  syncEventToProvider,
  fetchSyncLogs,
  fetchSyncMappings,
} from "@/app/actions/calendar/calendar-sync-actions"
import { createClient } from "@/lib/supabase/server"
import { hasPersonalCalendar } from "@/lib/providers/calendar/personal-calendar"
import type { CalendarProviderAccountRow, CalendarSyncLogRow } from "@/lib/kernel"
import { CopyToClipboardButton } from "./CopyToClipboardButton"

/**
 * Calendar Integrations.
 *
 * WHAT CHANGED (orphan burn-down). Three complete kernel capabilities reached
 * this page from nowhere:
 *
 *  · connectCalendarProvider — there was NO WAY TO CONNECT A CALENDAR. The
 *    page listed connected accounts and offered "Sync Now" and "Disconnect"
 *    for a list that could only ever be empty, because nothing in the product
 *    called the linker. "No connected calendars" was not a state, it was the
 *    only state.
 *  · fetchSyncLogs — "Recent Sync Activity" was a hard-coded sentence,
 *    "Sync logs will appear here after the first sync". They never did: the
 *    reader existed and had no caller. calendar_sync_logs is where the kernel
 *    records that the provider adapter is not enabled, which is precisely the
 *    fact an agent needs and could not see.
 *  · syncEventToProvider — push was unreachable; only pull had a button.
 *
 * TWO DEFECTS FIXED WHILE WIRING:
 *  · The iCal token was read with `.select(...).limit(1).single()` — no
 *    brokerage filter. `.limit(1)` on a multi-tenant table returns AN ARBITRARY
 *    BROKERAGE'S ROW, so this page could hand one brokerage another's private
 *    feed token. It is now filtered to the caller's own brokerage_id.
 *  · That same `.single()` THROWS on zero rows, and the throw was caught by a
 *    try/catch wrapping the entire page, so a brokerage with no global_settings
 *    row got "Failed to load calendar settings" for the whole screen —
 *    including the parts that had nothing to do with settings. It is now a
 *    maybeSingle() with its error destructured, and a missing token degrades to
 *    a message about the token only.
 *
 * NOTHING ON THIS PAGE CLAIMS DELIVERY IT CANNOT SHOW. The sync history below prints
 * calendar_sync_logs verbatim, so the screen and the database agree.
 *
 * ── UPDATED w27 (lane OUTLOOK): PUSH IS REAL FOR BOTH PROVIDERS ─────────────
 * This block used to read "lib/kernel/calendar-sync.ts has no provider adapter and stores
 * no OAuth token; every push and pull writes a calendar_sync_logs row with status
 * 'partial'". w26 corrected the Google half; the Outlook half is now false too, and
 * leaving either would make this page lie about its own behavior:
 *  · calendar_provider_accounts still stores NO OAuth token — that has not changed, and it
 *    is why the panel below still talks about the personal connection. Both adapters
 *    resolve the ACCOUNT OWNER'S own credential (the same connection that backs their
 *    mailbox) instead: google-calendar-sync-adapter.ts and outlook-calendar-sync-adapter.ts.
 *  · A push therefore reaches the provider, logs status 'success', and writes a
 *    calendar_sync_mappings row carrying the provider's event id. The "Events synced to
 *    this calendar" list below is that table.
 *  · WHAT STILL DECIDES THE OUTCOME is whether the account's OWNER has that Google or
 *    Microsoft account connected. A registered calendar whose owner has no connection
 *    refuses with that reason rather than reporting a delivery.
 *  · PULL IS STILL A STUB FOR BOTH PROVIDERS — sync is outbound only. Nothing edited in
 *    Google Calendar or Outlook comes back into VIP OS.
 *
 * ── THE BOOKINGS CALENDAR (w8) ──────────────────────────────────────────────
 * Everything above concerns calendar_provider_accounts — a registry that holds
 * no OAuth token and therefore delivers nothing. That is not the only calendar
 * in the product, and it was the only one this page mentioned.
 *
 * The calendar that actually RECEIVES BOOKINGS is the agent's own connected
 * Google / Microsoft account: lib/providers/calendar/index.ts routes
 * createCalendarEvent and getAvailability through
 * lib/providers/calendar/personal-calendar.ts whenever that account resolves,
 * and falls back to a MOCK event id / mock business-hours slots when it does
 * not. So an agent with no personal calendar connected gets bookings that
 * "succeed" and land nowhere, and this page — the one place they would look —
 * said nothing about it either way.
 *
 * hasPersonalCalendar is the readiness predicate for exactly that connection
 * (same OAuth token the personal-email adapter uses, so one consent covers
 * mail + calendar). It now answers the question on the surface that asks it.
 */

interface Props {
  searchParams: Promise<{ error?: string; linked?: string; pushed?: string }>
}

const PROVIDER_LABEL: Record<string, string> = {
  google_calendar: "Google Calendar",
  outlook: "Outlook",
}

const STATUS_STYLE: Record<string, string> = {
  success: "bg-green-100 text-green-800",
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
}

export default async function CalendarSettingsPage({ searchParams }: Props) {
  const sp = await searchParams

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) {
    return <div className="p-6 text-red-600">You must be signed in to manage calendar integrations.</div>
  }

  const { data: me, error: meError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (meError) {
    return <div className="p-6 text-red-600">Could not resolve your brokerage: {meError.message}</div>
  }
  const brokerageId = me?.brokerage_id ?? null

  let accounts: CalendarProviderAccountRow[] = []
  let accountsError: string | null = null
  try {
    accounts = await fetchMyProviderAccounts()
  } catch (e) {
    accountsError = e instanceof Error ? e.message : "Connected calendars could not be read"
  }

  // THE BOOKINGS CALENDAR (see header): does this agent have a personal
  // Google/Outlook connection with a usable token? A thrown error is reported
  // as an error — never as "not connected", which would be a different fact.
  let personalCalendarReady: boolean | null = null
  let personalCalendarError: string | null = null
  try {
    personalCalendarReady = await hasPersonalCalendar(user.id)
  } catch (e) {
    personalCalendarError =
      e instanceof Error ? e.message : "Your connected calendar account could not be checked"
  }

  // Sync history per account — a refused read is shown as a refusal, never as
  // an empty history.
  const logsByAccount = new Map<string, { logs: CalendarSyncLogRow[]; error: string | null }>()
  // WHICH EVENTS ARE ACTUALLY ON THE PROVIDER (w26) — calendar_sync_mappings. A log line
  // records that an attempt happened; a mapping records that the provider is holding this
  // event under this id. Same refusal contract as the logs above.
  type SyncMappings = Extract<Awaited<ReturnType<typeof fetchSyncMappings>>, { ok: true }>["mappings"]
  const mappingsByAccount = new Map<string, { mappings: SyncMappings; error: string | null }>()
  for (const account of accounts) {
    const res = await fetchSyncLogs(account.id)
    logsByAccount.set(
      account.id,
      res.ok ? { logs: res.logs, error: null } : { logs: [], error: res.error },
    )
    const mapRes = await fetchSyncMappings(account.id)
    mappingsByAccount.set(
      account.id,
      mapRes.ok
        ? { mappings: mapRes.mappings, error: null }
        : { mappings: [] as SyncMappings, error: mapRes.error },
    )
  }

  // Upcoming events the agent can push at a linked calendar.
  let upcoming: Array<{ id: string; title: string | null; event_type: string; start_at: string }> = []
  let upcomingError: string | null = null
  if (brokerageId) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, title, event_type, start_at")
      .eq("brokerage_id", brokerageId)
      .gte("start_at", new Date().toISOString())
      .order("start_at", { ascending: true })
      .limit(5)
    if (error) upcomingError = error.message
    else upcoming = data ?? []
  }

  // iCal token — scoped to the caller's brokerage, and its absence is a
  // statement about the token, not about the page.
  let iCalUrl: string | null = null
  let iCalNote: string | null = null
  if (!brokerageId) {
    iCalNote = "Your account is not attached to a brokerage, so no feed token exists."
  } else {
    const { data: settings, error: settingsError } = await supabase
      .from("global_settings")
      .select("additional_settings")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (settingsError) {
      iCalNote = `Feed token could not be read: ${settingsError.message}`
    } else {
      const extra = settings?.additional_settings as Record<string, unknown> | null
      const token = typeof extra?.ical_token === "string" ? extra.ical_token : null
      if (token) iCalUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/calendar/ical?token=${token}`
      else iCalNote = "No iCalendar feed token has been generated for your brokerage yet."
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Calendar Integrations</h1>
        <p className="text-gray-600 mt-2">Manage Google Calendar, Outlook, and iCalendar syncing</p>
      </div>

      {sp.error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {sp.error}
        </div>
      )}
      {sp.linked === "1" && (
        <div className="rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Calendar account linked. This registry stores no OAuth token of its own — a push uses the
          account owner&rsquo;s connected Google or Microsoft account, so it delivers only if that
          person has one connected. Every attempt&rsquo;s outcome is recorded below.
        </div>
      )}
      {sp.pushed === "1" && (
        <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          Push recorded. Its outcome is in the sync history below — read the status there before
          assuming the event reached the provider.
        </div>
      )}

      {/* ── Bookings calendar (the personal Google/Outlook connection) ──── */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Your Bookings Calendar</h2>
        <p className="text-sm text-gray-600 mb-4">
          Showings, appointments and availability checks run against your own connected Google or
          Microsoft account — the same connection your email uses. Without it, bookings are not
          written to any real calendar.
        </p>

        {personalCalendarError ? (
          <div className="rounded border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-medium text-red-800">
              Your connected calendar account could not be checked
            </p>
            <p className="text-xs text-red-700 mt-1">
              {personalCalendarError} — until this read succeeds, treat the status below as unknown
              rather than as &ldquo;not connected&rdquo;.
            </p>
          </div>
        ) : personalCalendarReady ? (
          <div className="rounded border border-green-200 bg-green-50 px-4 py-3">
            <p className="text-sm font-medium text-green-800">Connected</p>
            <p className="text-xs text-green-700 mt-1">
              A Google or Microsoft account is connected and its access token is current. New
              bookings are created on that calendar, and availability is read from its free/busy.
            </p>
          </div>
        ) : (
          <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-900">Not connected</p>
            <p className="text-xs text-amber-800 mt-1">
              No Google or Microsoft account with a usable token is on file for you — either none is
              connected, or the stored token could no longer be refreshed. Until one is,
              appointments booked in the app are recorded here but are never written to a real
              calendar, and availability falls back to generic business hours.
            </p>
            <a
              href="/settings/connections"
              className="inline-block mt-3 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium py-2 px-4 rounded"
            >
              Connect a calendar account
            </a>
          </div>
        )}
      </div>

      {/* ── Link a calendar account ─────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Link a Calendar Account</h2>
        <p className="text-sm text-gray-600 mb-4">
          Registers the account so events can be pushed to it. Google Calendar and Outlook both
          deliver, using the account owner&rsquo;s own connected Google or Microsoft account —
          registering a calendar for someone who has not connected one logs the refusal instead.
          Every attempt is logged either way.
        </p>
        <form
          action={async (formData: FormData) => {
            "use server"
            const res = await connectCalendarProvider({
              providerType: String(formData.get("providerType") ?? ""),
              providerAccountId: String(formData.get("providerAccountId") ?? ""),
            })
            if (!res.ok) redirect(`/dashboard/settings/calendar?error=${encodeURIComponent(res.error)}`)
            redirect("/dashboard/settings/calendar?linked=1")
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="providerType" className="text-xs font-medium text-gray-700">
              Provider
            </label>
            {/* Only the two values calendar_provider_accounts_provider_type_check accepts. */}
            <select
              id="providerType"
              name="providerType"
              defaultValue="google_calendar"
              className="border border-gray-300 rounded px-3 py-2 text-sm"
            >
              <option value="google_calendar">Google Calendar</option>
              <option value="outlook">Outlook</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1">
            <label htmlFor="providerAccountId" className="text-xs font-medium text-gray-700">
              Calendar account (email address or provider calendar id)
            </label>
            <input
              id="providerAccountId"
              name="providerAccountId"
              required
              placeholder="you@brokerage.com"
              className="border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 px-4 rounded"
          >
            Link Account
          </button>
        </form>
      </div>

      {/* ── Connected accounts ──────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Connected Accounts</h2>
        {accountsError ? (
          <p className="text-red-700 text-sm">Connected calendars could not be read — {accountsError}</p>
        ) : accounts.length === 0 ? (
          <p className="text-gray-500">No connected calendars. Link one above.</p>
        ) : (
          <div className="space-y-3">
            {accounts.map((account) => {
              const history = logsByAccount.get(account.id)
              return (
                <div key={account.id} className="border border-gray-200 rounded p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">
                        {PROVIDER_LABEL[account.provider_type] ?? account.provider_type}
                      </p>
                      <p className="text-sm text-gray-600">{account.provider_account_id}</p>
                      {account.last_sync_at && (
                        <p className="text-xs text-gray-500">
                          Last sync attempt: {new Date(account.last_sync_at).toLocaleString()}
                        </p>
                      )}
                      <div className="mt-2">
                        <span
                          className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                            account.is_active
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-800"
                          }`}
                        >
                          {account.is_active ? "Active" : "Inactive"}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2 flex-col">
                      <form
                        action={async () => {
                          "use server"
                          await syncFromProvider(account.id)
                        }}
                      >
                        <button
                          type="submit"
                          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-1 px-3 rounded"
                        >
                          Sync Now
                        </button>
                      </form>
                    </div>
                  </div>

                  {/* WHAT IS ON THE PROVIDER'S CALENDAR — calendar_sync_mappings. Until
                      w26 this table had no writer and no reader: the page could say a
                      push was attempted and never say what landed. */}
                  <div className="mt-4 border-t border-gray-100 pt-3">
                    <p className="text-xs font-medium text-gray-700 mb-2">Events synced to this calendar</p>
                    {(() => {
                      const m = mappingsByAccount.get(account.id)
                      if (m?.error) {
                        return <p className="text-xs text-red-700">Synced events could not be read — {m.error}</p>
                      }
                      if (!m || m.mappings.length === 0) {
                        return <p className="text-xs text-gray-500">No event has been synced to this calendar yet.</p>
                      }
                      return (
                        <ul className="flex flex-col gap-1">
                          {m.mappings.slice(0, 10).map((row) => (
                            <li key={row.id} className="text-xs text-gray-700 flex flex-wrap items-center gap-2">
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded font-medium ${
                                  row.is_synced ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {row.is_synced ? "in sync" : "changed since last sync"}
                              </span>
                              <span className="font-mono break-all">{row.provider_event_id}</span>
                              <span className="text-gray-500">
                                on {PROVIDER_LABEL[row.provider_type] ?? row.provider_type}
                                {row.last_synced_at
                                  ? ` · ${new Date(row.last_synced_at).toLocaleString()}`
                                  : " · never stamped"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )
                    })()}
                  </div>

                  {/* Push an upcoming event at THIS account */}
                  <div className="mt-4 border-t border-gray-100 pt-3">
                    <p className="text-xs font-medium text-gray-700 mb-2">Push an upcoming event</p>
                    {upcomingError ? (
                      <p className="text-xs text-red-700">
                        Upcoming events could not be read — {upcomingError}
                      </p>
                    ) : upcoming.length === 0 ? (
                      <p className="text-xs text-gray-500">No upcoming events on your calendar.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {upcoming.map((ev) => (
                          <div
                            key={ev.id}
                            className="flex items-center justify-between gap-3 rounded bg-gray-50 px-3 py-2"
                          >
                            <span className="text-xs text-gray-800 truncate">
                              {ev.title ?? ev.event_type} · {new Date(ev.start_at).toLocaleString()}
                            </span>
                            <form
                              action={async () => {
                                "use server"
                                const res = await syncEventToProvider(ev.id, account.id)
                                if (!res.ok) {
                                  redirect(
                                    `/dashboard/settings/calendar?error=${encodeURIComponent(res.error)}`,
                                  )
                                }
                                redirect("/dashboard/settings/calendar?pushed=1")
                              }}
                            >
                              <button
                                type="submit"
                                className="text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap"
                              >
                                Push
                              </button>
                            </form>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Sync history for THIS account — the database's own verdict */}
                  <div className="mt-4 border-t border-gray-100 pt-3">
                    <p className="text-xs font-medium text-gray-700 mb-2">Recent sync activity</p>
                    {history?.error ? (
                      <p className="text-xs text-red-700">
                        Sync history could not be read — {history.error}
                      </p>
                    ) : !history || history.logs.length === 0 ? (
                      <p className="text-xs text-gray-500">
                        No sync has been attempted against this account yet.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {history.logs.slice(0, 8).map((log) => (
                          <div
                            key={log.id}
                            className="flex items-start justify-between gap-3 rounded bg-gray-50 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <span className="text-xs font-medium text-gray-800">
                                {log.direction === "push" ? "Push" : "Pull"}
                              </span>
                              <span className="text-xs text-gray-500">
                                {" "}
                                · {new Date(log.started_at).toLocaleString()}
                                {typeof log.event_count === "number" && ` · ${log.event_count} event(s)`}
                              </span>
                              {log.error_message && (
                                <p className="text-xs text-gray-700 mt-0.5">{log.error_message}</p>
                              )}
                            </div>
                            <span
                              className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${
                                STATUS_STYLE[log.status] ?? "bg-gray-100 text-gray-800"
                              }`}
                            >
                              {log.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── iCal export ─────────────────────────────────────────────────── */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-3">iCalendar Feed (Read-Only Export)</h3>
        <p className="text-sm text-blue-800 mb-3">
          Share your VIP OS calendar with external tools (Apple Calendar, Thunderbird, etc.)
        </p>
        <div className="bg-white rounded border border-blue-200 p-3">
          {iCalUrl ? (
            <>
              <p className="text-xs text-gray-600 mb-2">Feed URL:</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={iCalUrl}
                  className="flex-1 border border-gray-300 rounded px-3 py-2 text-xs font-mono bg-gray-50"
                />
                <CopyToClipboardButton text={iCalUrl} />
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-700">{iCalNote}</p>
          )}
        </div>
      </div>
    </div>
  )
}
