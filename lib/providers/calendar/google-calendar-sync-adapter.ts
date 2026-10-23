// lib/providers/calendar/google-calendar-sync-adapter.ts
//
// THE FIRST REAL IMPLEMENTATION OF THE CalendarProvider PORT (w26, lane C8).
//
// lib/kernel/calendar-sync.ts has carried a standing ruling that
// `calendar_sync_mappings` has no writer BECAUSE THE ADAPTER IS MISSING, not because a
// row was forgotten: `provider_event_id` is `text NOT NULL`, it is the PROVIDER's id for
// the event, and nothing in the tree could produce one. That ruling is now discharged for
// google_calendar — this adapter returns exactly that id, and the mapping is written at
// the point it comes back.
//
// ── WHERE THE CREDENTIAL COMES FROM, AND WHY IT IS THE RIGHT ONE ─────────────────────
// `calendar_provider_accounts` stores NO token (columns verified in
// scripts/schema-snapshot.ts:165 — brokerage_id, user_id, provider_type,
// provider_account_id, token_expires_at, is_active, sync_direction, timestamps; there is
// no access_token and no refresh_token). So the brokerage-level registry names WHOSE
// calendar to write to and cannot itself authorize the write. The authorization already
// exists one table over: the same Google consent that backs the agent's connected mailbox
// carries calendar scope, and `getFreshPersonalToken(userId)` mints a fresh access token
// for it (lib/providers/email/personal-email-adapter.ts:99), refreshing when stale. The
// registry row's `user_id` IS that person, so the token is the account owner's own — the
// adapter never borrows the caller's.
//
// ── HOW THIS DIFFERS FROM lib/providers/calendar/personal-calendar.ts ────────────────
// personal-calendar.ts is a best-effort convenience path: it DEGRADES TO A MOCK when
// nothing is connected (index.ts falls back to a fabricated event id) and returns
// `{ success, eventId }`. That contract is unusable here — a fabricated id written into
// `provider_event_id` would assert that a local event is synced to a Google event that
// does not exist, which is the exact failure the do-not-fix note refused. This adapter
// THROWS instead: no token, no id, no mapping row. Both call the same Google Calendar v3
// endpoints through the connector gateway, so there is one HTTP idiom (§6), not two.

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { getFreshPersonalToken } from "@/lib/providers/email/personal-email-adapter"
import type { CalendarProvider, CalendarProviderEventInput } from "./types"

const GOOGLE_CAL = "https://www.googleapis.com/calendar/v3"

/** The token this adapter can use. `getFreshPersonalToken` spells Google "gmail"
 *  (the credential is the mailbox connection); a connected Outlook mailbox cannot
 *  authorize a Google Calendar write, so it is refused rather than tried. */
async function requireGoogleToken(userId: string): Promise<string> {
  const tok = await getFreshPersonalToken(userId).catch(() => null)
  if (!tok) {
    throw new Error(
      `No usable Google credential for user ${userId} — the calendar account is registered but its Google connection is missing or expired. Reconnect it before syncing.`,
    )
  }
  if (tok.provider !== "gmail") {
    throw new Error(
      `User ${userId} has a '${tok.provider}' connection, which cannot authorize a Google Calendar write.`,
    )
  }
  return tok.accessToken
}

function toGoogleEvent(event: CalendarProviderEventInput): Record<string, unknown> {
  return {
    summary: event.title,
    description: event.description,
    // The timezone travels WITH each end of the range. Google resolves a naked
    // dateTime against the calendar's own zone, which is not necessarily the zone the
    // event was booked in — a showing would drift by hours for a cross-zone agent.
    start: { dateTime: event.startAtUtcISO, timeZone: event.timezoneName },
    end: { dateTime: event.endAtUtcISO ?? event.startAtUtcISO, timeZone: event.timezoneName },
  }
}

export const googleCalendarSyncAdapter: CalendarProvider = {
  name: "google_calendar",

  async upsertEvent({ userId, event }) {
    const accessToken = await requireGoogleToken(userId)
    const existingId = event.externalId?.trim()

    const res = await callConnector<{ id?: string }>({
      connector: "google_calendar",
      baseUrl: GOOGLE_CAL,
      // PATCH when we already hold the provider's id (a mapping row exists), POST
      // otherwise. Without this branch every re-push would create a DUPLICATE event on
      // the agent's calendar and orphan the id the mapping already points at.
      path: existingId
        ? `/calendars/primary/events/${encodeURIComponent(existingId)}`
        : "/calendars/primary/events",
      method: existingId ? "PATCH" : "POST",
      auth: { style: "bearer", token: accessToken },
      body: toGoogleEvent(event),
    })

    // callConnector NEVER THROWS — it resolves with { ok:false, status } — so an
    // unchecked call here would hand back `undefined` as the provider's event id and the
    // caller would write it into a NOT NULL column. Same class of trap as §3's "supabase
    // resolves refusals": read the result, refuse loudly.
    if (!res.ok) {
      throw new Error(`Google Calendar ${existingId ? "update" : "insert"} failed (${res.status ?? "no status"}): ${res.error ?? "no body"}`)
    }
    const externalId = res.data?.id ?? existingId
    if (!externalId) {
      throw new Error("Google Calendar accepted the event but returned no id — refusing to write a mapping with no provider id.")
    }
    return { externalId }
  },

  async deleteEvent({ userId, externalId }) {
    const accessToken = await requireGoogleToken(userId)
    const res = await callConnector({
      connector: "google_calendar",
      baseUrl: GOOGLE_CAL,
      path: `/calendars/primary/events/${encodeURIComponent(externalId)}`,
      method: "DELETE",
      auth: { style: "bearer", token: accessToken },
    })
    // 410 Gone = already deleted on Google's side. The teardown's goal is "it is not
    // there", and it is not there — same ruling personal-calendar.ts:163 already makes.
    if (!res.ok && res.status !== 410) {
      throw new Error(`Google Calendar delete failed (${res.status ?? "no status"}): ${res.error ?? "no body"}`)
    }
  },
}
