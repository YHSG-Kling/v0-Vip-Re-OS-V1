// TypeScript strict — no any, no default export
// Google Calendar provider stub — OAuth + API integration not yet implemented

import type { CalendarProvider } from "./types"

export const GoogleCalendarProvider: CalendarProvider = {
  name: "google",

  async upsertEvent() {
    throw new Error(
      "Google Calendar provider not implemented yet: OAuth + API integration required"
    )
  },

  async deleteEvent() {
    throw new Error(
      "Google Calendar provider not implemented yet: OAuth + API integration required"
    )
  },
}
