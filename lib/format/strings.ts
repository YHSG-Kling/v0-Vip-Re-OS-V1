// lib/format/strings.ts
// ─────────────────────────────────────────────────────────────────────────────
// SAME-BODY CENSUS, ROUND 4 (2026-09-09, lane FC) — small pure string
// formatters pasted into unrelated dashboard/portal components. PURE LEAF —
// no imports.

/** `snake_case` or `camelCase` key → `"Title Case"` label:
 *  underscores become spaces, an internal capital gets a space inserted
 *  before it, and the first character is capitalized. Survivor for the
 *  byte-identical private `formatFieldName` in
 *  app/portal/[contactId]/documents/[documentId]/page.tsx:93 and
 *  app/portal/[contactId]/documents/DocumentsClient.tsx:167. */
export function formatFieldName(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
}

/** Local hour-of-day → `"Good morning"` / `"Good afternoon"` /
 *  `"Good evening"`. Survivor for the byte-identical private
 *  `getTimeOfDayGreeting`/`getGreeting` in
 *  app/components/mobile/DailyBriefingCard.tsx:39 and
 *  app/dashboard/briefing/page.tsx:288. */
export function getTimeOfDayGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 17) return "Good afternoon"
  return "Good evening"
}
