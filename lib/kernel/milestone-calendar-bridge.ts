// lib/kernel/milestone-calendar-bridge.ts
// Converts transaction milestone dates into calendar_events rows via emitCalendarEvent.
// Named exports only — no default exports.

import { zonedTimeToUtc } from 'date-fns-tz'
import { emitCalendarEvent } from './calendar-engine'
import { CalendarEventType, KernelCalendarEvent } from './calendar-types'
import { getBrokerageSettings } from '@/lib/brokerage/get-brokerage-settings'

// ─── HELPER ──────────────────────────────────────────────────────────────────

function convertDateToUTC(dateStr: string, timezone: string): Date {
  const localISO = `${dateStr}T09:00:00`
  return zonedTimeToUtc(localISO, timezone)
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
    (settings as Record<string, unknown>)['primary_timezone'] as string | undefined
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
