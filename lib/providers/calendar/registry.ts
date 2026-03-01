// TypeScript strict — no any, no default exports

import type { CalendarProviderName, CalendarProvider } from "./types"

export function resolveCalendarProvider(name: CalendarProviderName): CalendarProvider {
  switch (name) {
    case "google":
      throw new Error(`Calendar provider not implemented: ${name}`)
    case "outlook":
      throw new Error(`Calendar provider not implemented: ${name}`)
    case "ical":
      throw new Error(`Calendar provider not implemented: ${name}`)
  }
}
