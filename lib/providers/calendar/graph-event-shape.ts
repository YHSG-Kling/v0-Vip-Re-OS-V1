// lib/providers/calendar/graph-event-shape.ts
//
// PURE Microsoft Graph event-body construction, extracted from the Outlook sync adapter for
// exactly the reason lib/providers/calendar/free-slots.ts was extracted from personal-calendar.ts:
// the adapter carries `import "server-only"`, and `server-only/index.js` THROWS on import under a
// plain node/tsx run — so anything a simulator must exercise cannot live in the adapter file.
// scripts/calendar-sync-adapter-simulator.ts imports this module and unit-tests the mapping;
// lib/providers/calendar/outlook-calendar-sync-adapter.ts is its only production caller.
//
// ── WHY THE ZONE IS SENT AS UTC AND NOT AS THE EVENT'S OWN ZONE ──────────────────────────
// Google and Graph disagree about what a `timeZone` beside a datetime MEANS, and getting this
// wrong moves a showing by hours rather than failing loudly.
//   · Google Calendar v3 reads the OFFSET OUT OF the dateTime string when it carries one
//     ("…Z"), so the sibling google adapter can pass the event's booking zone through and the
//     instant is still exact.
//   · Graph's dateTimeTimeZone resource does the opposite: `dateTime` is a NAKED local
//     wall-clock reading ({date}T{time}, no offset), and `timeZone` is the zone that reading is
//     expressed IN. Handing Graph a UTC instant while naming America/New_York as its zone would
//     not convert it — it would REINTERPRET 14:00Z as 14:00 Eastern and land the event four
//     hours late.
// Converting the instant into the booking zone's wall clock is possible but needs a real tz
// database at the call site, and a conversion that is subtly wrong is worse here than one that
// is absent: the INSTANT is the load-bearing fact for a showing, and UTC preserves it exactly.
// So the wall-clock reading is normalized to UTC and declared as UTC. The cost is stated rather
// than hidden — see the blind-spot list in outlook-calendar-sync-adapter.ts: the event lands at
// the right moment and displays correctly in every attendee's own calendar zone, but the zone
// STORED on the Outlook event is UTC, not the zone the showing was booked in.

/** The subset of a VIP OS calendar event this mapping consumes. Structurally the fields
 *  CalendarProviderEventInput carries — spelled locally so this pure module does not have to
 *  import the port (which pulls in lib/kernel/calendar-sync for the provider vocabulary). */
export interface GraphEventSource {
  title: string
  description?: string
  startAtUtcISO: string
  endAtUtcISO?: string
}

/**
 * One end of a Graph time range: an ISO instant re-expressed as the naked wall-clock reading
 * Graph wants, in UTC.
 *
 * THROWS on an unparseable instant. It must: the caller is about to write the returned id into
 * `calendar_sync_mappings.provider_event_id`, and Graph would happily accept a malformed
 * `dateTime` as a 400 that this adapter reports — but a SILENTLY coerced date (Invalid Date →
 * "Invalid Date") would create a real event at a nonsense time and map it as synced.
 */
export function graphDateTimeUtc(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new Error(`Unparseable calendar timestamp '${iso}' — refusing to send it to Microsoft Graph.`)
  }
  // toISOString is always "…THH:MM:SS.sssZ"; Graph wants the same reading with no zone suffix,
  // and takes the zone from the sibling `timeZone` field instead.
  return new Date(ms).toISOString().replace(/Z$/, "")
}

/**
 * The Graph `event` body for a create (POST /me/events) or a patch (PATCH /me/events/{id}).
 *
 * A missing end falls back to the start — the same ruling the google adapter makes. A
 * zero-length event is a visible, correctable artifact on the agent's calendar; omitting `end`
 * entirely makes Graph refuse the whole write, which would strand a booking that did happen.
 */
export function toGraphEvent(event: GraphEventSource): Record<string, unknown> {
  const startAt = graphDateTimeUtc(event.startAtUtcISO)
  const endAt = event.endAtUtcISO ? graphDateTimeUtc(event.endAtUtcISO) : startAt
  return {
    subject: event.title,
    // Graph requires the contentType alongside the content; a bare string is refused.
    body: { contentType: "HTML", content: event.description ?? "" },
    start: { dateTime: startAt, timeZone: "UTC" },
    end: { dateTime: endAt, timeZone: "UTC" },
  }
}
