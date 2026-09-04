// lib/providers/calendar/outlook-calendar-sync-adapter.ts
//
// THE SECOND IMPLEMENTATION OF THE CalendarProvider PORT — the half wave 26 deliberately left
// out (w27, lane OUTLOOK; owner instruction: "outlook needs adapter setup").
//
// lib/kernel/calendar-sync.ts carried, verbatim: "OUTLOOK IS STILL ABSENT, AND DELIBERATELY SO:
// the same reasoning that made a placeholder mapping row forbidden makes a placeholder adapter
// forbidden." That reasoning is discharged the only way it can be — by an adapter that returns a
// REAL Microsoft Graph event id, so the mapping row can be written from a fact rather than from a
// guess. Registration is what turns the push path on, so nothing here may degrade to a fabricated
// id: every failure THROWS.
//
// ── WHERE THE CREDENTIAL COMES FROM ──────────────────────────────────────────────────────
// Identical in shape to the google sibling, and for the same structural reason.
// `calendar_provider_accounts` stores NO token (columns verified in scripts/schema-snapshot.ts:165
// — brokerage_id, user_id, provider_type, provider_account_id, token_expires_at, is_active,
// sync_direction, timestamps; there is no access_token and no refresh_token). The brokerage-level
// registry therefore names WHOSE calendar to write to and cannot itself authorize the write.
//
// The authorization already existed in this tree and was not invented here: the Microsoft consent
// requested by app/api/integrations/oauth/[provider]/route.ts:62-68 is
// [offline_access, User.Read, Calendars.ReadWrite, Mail.Send, Mail.ReadWrite] — one consent
// covering mail AND calendar — and `getFreshPersonalToken(userId)`
// (lib/providers/email/personal-email-adapter.ts:99) mints/refreshes an access token against it,
// reporting `provider: "outlook"` for a Microsoft connection. The registry row's `user_id` IS that
// person, so the token used is the ACCOUNT OWNER'S OWN: a broker pushing to an agent's calendar
// spends the agent's Microsoft connection, never their own, and never a caller-supplied identity
// (CLAUDE.md §4 — tenant and identity come from the row, not from a parameter).
//
// ── HOW THIS DIFFERS FROM lib/providers/calendar/personal-calendar.ts ─────────────────────
// personal-calendar.ts hits the same Graph endpoints, but it is a best-effort convenience path:
// it returns `{ success, error }` and lib/providers/calendar/index.ts falls back to a MOCK event
// id when nothing is connected. That contract is unusable here — `provider_event_id` is
// `text NOT NULL` and a fabricated id would assert that a local event is synced to an Outlook
// event that does not exist, after which `is_synced` means nothing. Both files speak ONE Graph
// idiom (§6): same base URL, same connector id, same /me/events verbs.
//
// ── BLIND SPOTS — WHAT MICROSOFT GRAPH DOES THAT THIS ADAPTER DOES NOT ────────────────────
// Published here rather than implied away, because a mapping row that says `is_synced: true`
// invites the reader to believe more than this actually reconciles (CLAUDE.md §2):
//  · RECURRENCE — not sent and not read. Graph's `recurrence` (pattern + range) and its
//    seriesMaster/occurrence/exception event types are untouched. A VIP OS calendar_events row is
//    a single instant, so every event this adapter writes is a SINGLE Graph event. Pointing a
//    mapping at a seriesMaster and patching it would silently rewrite an entire series.
//  · ATTENDEES — not sent. `attendees` is omitted entirely, so Graph issues NO meeting invitation
//    and no acceptance tracking; the event appears only on the account owner's own calendar.
//    (personal-calendar.ts:79 DOES send attendees on the per-agent booking path — that is a
//    different question with a different consent story, not an inconsistency to "fix" by copying.)
//  · TIME ZONES — the instant is exact, the stored zone is not. Everything is sent as UTC; see
//    lib/providers/calendar/graph-event-shape.ts for why converting into the event's booking zone
//    was refused rather than approximated.
//  · DELTA SYNC / INBOUND — nothing here reads. Graph's `/me/events/delta` and change
//    notifications (subscriptions/webhooks) are not used, so a change made IN Outlook never
//    reaches VIP OS: `pullCalendarEventsFromProvider` is still a stub for BOTH providers. Sync is
//    one-directional, outbound only.
//  · CANCELLATION/DECLINE state, categories, reminders, online-meeting (Teams) creation,
//    free/busy `showAs`, sensitivity, and non-default calendars (everything goes to the owner's
//    DEFAULT calendar, `/me/events`) are all outside this adapter.
//  · IDS ARE OPAQUE AND NOT ETERNAL — a Graph event id can change if the event is moved between
//    mail folders/calendars. This adapter treats a 404 on update as a genuine failure rather than
//    silently re-creating, because re-creating would orphan the id the mapping already holds.

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { getFreshPersonalToken } from "@/lib/providers/email/personal-email-adapter"
import { toGraphEvent } from "./graph-event-shape"
import type { CalendarProvider } from "./types"

/** Same base the personal calendar path uses (personal-calendar.ts:25) — one spelling, §6. */
const GRAPH = "https://graph.microsoft.com/v1.0"

/**
 * The token this adapter can use, or a refusal.
 *
 * `getFreshPersonalToken` spells Microsoft "outlook" (the credential is the mailbox connection).
 * A connected GOOGLE mailbox cannot authorize a Microsoft Graph write, so it is refused rather
 * than tried — an unrefused mismatch would spend a round trip to earn a 401 and then report the
 * provider's message as though the Outlook connection itself were broken.
 */
async function requireMicrosoftToken(userId: string): Promise<string> {
  const tok = await getFreshPersonalToken(userId).catch(() => null)
  if (!tok) {
    throw new Error(
      `No usable Microsoft credential for user ${userId} — the calendar account is registered but its Microsoft connection is missing or expired. Reconnect it before syncing.`,
    )
  }
  if (tok.provider !== "outlook") {
    throw new Error(
      `User ${userId} has a '${tok.provider}' connection, which cannot authorize a Microsoft Graph calendar write.`,
    )
  }
  return tok.accessToken
}

export const outlookCalendarSyncAdapter: CalendarProvider = {
  name: "outlook",

  async upsertEvent({ userId, event }) {
    const accessToken = await requireMicrosoftToken(userId)
    const existingId = event.externalId?.trim()

    const res = await callConnector<{ id?: string }>({
      connector: "outlook_calendar",
      baseUrl: GRAPH,
      // PATCH when we already hold the provider's id (a mapping row exists), POST otherwise.
      // Without this branch every re-push would create a DUPLICATE event on the agent's
      // calendar and orphan the id the mapping already points at. Graph event ids are opaque
      // base64-ish strings containing '/', '+' and '=', so the encode is load-bearing, not
      // decorative.
      path: existingId
        ? `/me/events/${encodeURIComponent(existingId)}`
        : "/me/events",
      method: existingId ? "PATCH" : "POST",
      auth: { style: "bearer", token: accessToken },
      body: toGraphEvent(event),
    })

    // callConnector NEVER THROWS — it resolves with { ok:false, status } — so an unchecked call
    // here would hand back `undefined` as the provider's event id and the caller would write it
    // into a NOT NULL column. Same class of trap as CLAUDE.md §3's "supabase resolves refusals":
    // read the result, refuse loudly.
    //
    // A 403 here is the one worth naming: it means the access token carries mail scope but not
    // Calendars.ReadWrite, which is a REFRESH-SCOPE problem and not a connection problem — see
    // refreshMicrosoft in lib/providers/email/personal-email-adapter.ts.
    if (!res.ok) {
      throw new Error(
        `Microsoft Graph ${existingId ? "update" : "insert"} failed (${res.status ?? "no status"}): ${res.error ?? "no body"}`,
      )
    }
    // A PATCH returns the updated event (id unchanged); the fallback keeps a body-less 204 from
    // losing an id we already hold. On a CREATE there is nothing to fall back to, which is
    // exactly when the refusal below must fire.
    const externalId = res.data?.id ?? existingId
    if (!externalId) {
      throw new Error(
        "Microsoft Graph accepted the event but returned no id — refusing to write a mapping with no provider id.",
      )
    }
    return { externalId }
  },

  async deleteEvent({ userId, externalId }) {
    const accessToken = await requireMicrosoftToken(userId)
    const res = await callConnector({
      connector: "outlook_calendar",
      baseUrl: GRAPH,
      path: `/me/events/${encodeURIComponent(externalId)}`,
      method: "DELETE",
      auth: { style: "bearer", token: accessToken },
    })
    // ALREADY GONE IS THE GOAL, NOT A FAILURE. Graph answers a delete for an event that is not
    // there with 404 (where Google answers 410 — see the google sibling's identical ruling and
    // personal-calendar.ts:164). The teardown's goal is "it is not on the calendar", and it is
    // not. Every other status still throws: a 403 or a 401 means the event may well still be
    // sitting on the agent's calendar, and reporting that as a completed teardown is the failure
    // this whole file exists to refuse.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Microsoft Graph delete failed (${res.status ?? "no status"}): ${res.error ?? "no body"}`)
    }
  },
}
