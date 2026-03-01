// TypeScript strict — no any, no default exports

import type { CalendarProviderName, CalendarProvider } from "./types"
import { GoogleCalendarProvider } from "./google"

export function resolveCalendarProvider(name: CalendarProviderName): CalendarProvider {
  switch (name) {
    case "google":
      return GoogleCalendarProvider
    case "outlook":
      throw new Error(`Calendar provider not implemented: ${name}`)
    case "ical":
      throw new Error(`Calendar provider not implemented: ${name}`)
  }
}
