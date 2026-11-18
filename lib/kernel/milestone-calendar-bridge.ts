// lib/kernel/milestone-calendar-bridge.ts
// Converts transaction milestone dates into calendar_events rows via emitCalendarEvent.
// Named exports only — no default exports.

import { fromZonedTime } from 'date-fns-tz'
import { emitCalendarEvent } from './calendar-engine'
import { CalendarEventType, KernelCalendarEvent } from './calendar-types'
import { getBrokerageSettings } from '@/lib/brokerage/get-brokerage-settings'
import { resolveTenantTimeZone } from '@/lib/transactions/cda-closing-policy'
import { createServiceClient } from '@/lib/supabase/service'

// ─── HELPER ──────────────────────────────────────────────────────────────────

/** The tenant's zone for milestone instants — through the ONE resolver (resolveTenantTimeZone). */
async function milestoneTimeZone(
  brokerageId: string,
  settings: Awaited<ReturnType<typeof getBrokerageSettings>>,
): Promise<{ zone: string; source: 'explicit' | 'brokerage_state' | 'fallback' }> {
  const svc = createServiceClient()
  const { data: gs, error: gsErr } = await svc.from('global_settings').select('timezone').eq('brokerage_id', brokerageId).maybeSingle()
  if (gsErr) console.error(`[milestone-calendar-bridge] global_settings.timezone read refused for ${brokerageId} (falls through to the state): ${gsErr.message}`)
  const { data: b, error: bErr } = await svc.from('brokerages').select('state').eq('id', brokerageId).maybeSingle()
  if (bErr) console.error(`[milestone-calendar-bridge] brokerages.state read refused for ${brokerageId}: ${bErr.message}`)
  const columnZone = gsErr ? null : ((gs as { timezone?: string | null } | null)?.timezone ?? null)
  // additional_settings.primary_timezone is DEFAULTED to 'UTC' by the settings resolver — that default is not a choice.
  const jsonZone = settings.primary_timezone && settings.primary_timezone !== 'UTC' ? settings.primary_timezone : null
  return resolveTenantTimeZone({
    state: (bErr ? null : ((b as { state?: string | null } | null)?.state ?? null)) ?? settings.primary_state,
    explicitZone: columnZone ?? jsonZone,
  })
}

function convertDateToUTC(dateStr: string, timezone: string): Date {
  const localISO = `${dateStr}T09:00:00`
  return fromZonedTime(localISO, timezone)
}

// TRID requires the Closing Disclosure to be in the buyer's hands at least 3 BUSINESS days
// before closing (weekends + Sundays excluded; federal holidays are not modeled here — this
// is a deadline REMINDER, not the legal delivery-tracking system, so a conservative business-day
// count is the right level of precision). Walks backward from closingDate, skipping Sat/Sun.
function threeBusinessDaysBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  let remaining = 3
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1)
    const day = d.getUTCDay() // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) remaining--
  }
  return d.toISOString().slice(0, 10)
}

// ─── MILESTONE DEFINITION ────────────────────────────────────────────────────

interface MilestoneDefinition {
  dateStr: string
  eventType: CalendarEventType
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

export async function createTransactionMilestoneCalendarEvents(params: {
  brokerageId:        string
  transactionId:      string
  inspectionDate?:    string
  appraisalDate?:     string
  financingDeadline?: string
  closingDate?:       string
}): Promise<void> {
  const {
    brokerageId,
    transactionId,
    inspectionDate,
    appraisalDate,
    financingDeadline,
    closingDate,
  } = params

  // Load brokerage settings — single call, destructure locally
  const settings = await getBrokerageSettings(brokerageId)

  // WAVE 154 (lane 154K — ledger 143H-OL-02, m841's coupled code; the CDA reaper half closed at
  // lib/transactions/cda-delivery-reaper.ts in wave 148). TOMBSTONE: this read the untyped
  // additional_settings.primary_timezone, which get-brokerage-settings.ts DEFAULTS to 'UTC' — so every
  // tenant's inspection / appraisal / financing / closing / CD milestone was stamped at the UTC instant of
  // the date, not the tenant's. The ONE resolver now answers, with the same precedence as the reaper: the
  // tenant's own chosen zone (global_settings.timezone, m841: NULL = not chosen), then an explicit
  // additional_settings value, then the brokerage's state. A refused read is SAID and falls through.
  const timezone: string = (await milestoneTimeZone(brokerageId, settings)).zone

  // Build milestone array — only include dates that were provided
  const milestones: MilestoneDefinition[] = []

  if (inspectionDate) {
    milestones.push({ dateStr: inspectionDate, eventType: CalendarEventType.INSPECTION })
  }
  if (appraisalDate) {
    milestones.push({ dateStr: appraisalDate, eventType: CalendarEventType.APPRAISAL })
  }
  if (financingDeadline) {
    milestones.push({ dateStr: financingDeadline, eventType: CalendarEventType.FINANCING_DEADLINE })
  }
  if (closingDate) {
    milestones.push({ dateStr: closingDate, eventType: CalendarEventType.CLOSING })
    // CLAUDE.md §1 (BUILD the missing half, lane Z1 2026-09-08 hunt 2): notification_rules has
    // live rows on trigger_event='cd_due' but nothing ever created the calendar event that
    // calendar-deadline-watcher.ts polls to fire KernelEvent.CD_DUE — so it never fired. TRID's
    // 3-business-day rule anchors it off the same closingDate already available here.
    milestones.push({ dateStr: threeBusinessDaysBefore(closingDate), eventType: CalendarEventType.CLOSING_DISCLOSURE })
  }

  // Emit one calendar event per milestone — in series to respect DB constraints cleanly
  for (const milestone of milestones) {
    const startAt: Date = convertDateToUTC(milestone.dateStr, timezone)

    const event: KernelCalendarEvent = {
      brokerageId,
      entityType:        'transaction',
      entityId:          transactionId,
      eventType:         milestone.eventType,
      startAt,
      timezoneName:      timezone,
      isSystemGenerated: true,
      metadata: {
        sourceMilestoneId: transactionId,
      },
    }

    await emitCalendarEvent(event)
  }
}
