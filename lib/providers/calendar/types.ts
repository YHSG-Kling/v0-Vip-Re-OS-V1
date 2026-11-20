// TypeScript strict — no any, no default exports
//
// THE CALENDAR SYNC ADAPTER PORT — deliberately unimplemented (capability wanted, §1.2).
//
// Business-process ruling (2026-08-31, lane L5): this is NOT an abandoned duplicate of the
// LIVE per-agent calendar path (lib/providers/calendar/index.ts + personal-calendar.ts). The
// two answer different questions:
//   · personal-calendar.ts writes to the AGENT'S OWN connected Google/Outlook account via the
//     personal-email OAuth token, returns `{ success, eventId, mock? }`, and deliberately
//     degrades to a mock when nothing is connected — a best-effort convenience contract.
//   · THIS port is the adapter contract the brokerage-level sync registry is waiting for:
//     lib/kernel/calendar-sync.ts syncs calendar_events through calendar_provider_accounts and
//     records provider ids in calendar_sync_mappings, whose writer CANNOT exist until an
//     adapter returns the provider's event id — see the do-not-fix note at
//     lib/kernel/calendar-sync.ts:176 ("the missing half is the ADAPTER, not a row"). Its
//     `upsertEvent` returning `{ externalId }` is exactly the fact that note says is missing,
//     and `deleteEvent` is the outbound half of a mapping's teardown. When an implementer
//     lands, calendar-sync's 'partial' logs and the writerless-gate canary on
//     calendar_sync_mappings resolve without this contract changing.
//
// VOCABULARY CONVERGED (§6, 2026-08-31): `CalendarProviderName` ("google" | "outlook" | "ical")
// is DELETED — it was a second spelling of the provider vocabulary that
// lib/kernel/calendar-sync.ts:7 already derives from the LIVE CHECKs
// (calendar_provider_accounts.provider_type and calendar_sync_mappings.provider_type both admit
// exactly ["google_calendar", "outlook"] — scripts/check-vocabularies.ts:369/:380). SURVIVOR:
// `CalendarProviderType` there, imported type-only below. A mapping row keyed "google" while the
// account row says "google_calendar" could never join, so the port's own spelling would have
// broken the exact table it exists to fill. `ical` did not survive the merge: no CHECK admits
// it, and an iCal feed is a pull-only subscription format — it has no API that can accept an
// upsert or a delete, so it can never satisfy this contract.

import type { CalendarProviderType } from "@/lib/kernel/calendar-sync"

export interface CalendarProviderEventInput {
  externalId?: string
  title: string
  description?: string
  startAtUtcISO: string
  endAtUtcISO?: string
  timezoneName: string
  metadata?: Record<string, unknown>
}

export interface CalendarProvider {
  /** The provider this adapter serves — the CHECK-backed vocabulary of
   *  calendar_provider_accounts.provider_type. */
  name: CalendarProviderType

  upsertEvent(params: {
    brokerageId: string
    userId: string
    event: CalendarProviderEventInput
  }): Promise<{ externalId: string }>

  deleteEvent(params: {
    brokerageId: string
    userId: string
    externalId: string
  }): Promise<void>
}
