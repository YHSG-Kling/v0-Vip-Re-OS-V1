/**
 * The ROI dashboard's date window — ONE spelling shared by the server page (which fetches the windowed
 * channel comparison) and the client (which offers the choice).
 *
 * Wave 142 (lane 142H — UI wiring audit): the "Date Window" select set `dateWindow` state that nothing
 * read — the page fetched the current month server-side and never re-fetched, so the control changed
 * nothing. The window now travels in the URL (`?window=`), the page resolves it here and passes it to
 * getChannelPerformanceData (the one windowed read). The campaign_roi rows are LIFETIME aggregates per
 * campaign (no period columns), so the select is labelled as applying to the channel comparison — a
 * window the data cannot honour is not pretended.
 */
export const ROI_WINDOW_OPTIONS = [
  { key: "this_month", label: "This Month" },
  { key: "last_month", label: "Last Month" },
  { key: "last_90_days", label: "Last 90 Days" },
  { key: "ytd", label: "Year to Date" },
] as const

export type RoiWindowKey = (typeof ROI_WINDOW_OPTIONS)[number]["key"]

export const DEFAULT_ROI_WINDOW: RoiWindowKey = "this_month"

export function isRoiWindowKey(v: unknown): v is RoiWindowKey {
  return typeof v === "string" && ROI_WINDOW_OPTIONS.some((o) => o.key === v)
}

/** `yyyy-mm-dd` bounds (UTC date parts, the spelling the page always used) for a window key. */
export function resolveRoiWindow(key: RoiWindowKey, now: Date = new Date()): { key: RoiWindowKey; label: string; start: string; end: string } {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const label = ROI_WINDOW_OPTIONS.find((o) => o.key === key)!.label
  switch (key) {
    case "last_month":
      return { key, label, start: iso(new Date(Date.UTC(y, m - 1, 1))), end: iso(new Date(Date.UTC(y, m, 0))) }
    case "last_90_days":
      return { key, label, start: iso(new Date(now.getTime() - 90 * 86_400_000)), end: iso(now) }
    case "ytd":
      return { key, label, start: iso(new Date(Date.UTC(y, 0, 1))), end: iso(now) }
    case "this_month":
    default:
      return { key, label, start: iso(new Date(Date.UTC(y, m, 1))), end: iso(new Date(Date.UTC(y, m + 1, 0))) }
  }
}
