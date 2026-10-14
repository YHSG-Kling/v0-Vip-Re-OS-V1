// lib/kernel/milestone-calendar-bridge.ts
// Converts transaction milestone dates into calendar_events rows via emitCalendarEvent.
// Named exports only — no default exports.

import { fromZonedTime } from 'date-fns-tz'
import { emitCalendarEvent } from './calendar-engine'
import { CalendarEventType, KernelCalendarEvent } from './calendar-types'
import { getBrokerageSettings } from '@/lib/brokerage/get-brokerage-settings'

// ─── HELPER ──────────────────────────────────────────────────────────────────

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

  // primary_timezone may be present as an untyped additional field on settings
  const timezone: string =
    ((settings as unknown) as Record<string, unknown>)['primary_timezone'] as string | undefined
    ?? 'UTC'

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
