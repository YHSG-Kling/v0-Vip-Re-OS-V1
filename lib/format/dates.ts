// lib/format/dates.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE daysBetween (§1/§6, 2026-09-08, lane CC — duplicates round 2). Six
// private copies of "days between two dates" lived across the repo, agreeing
// on almost nothing: rounding rule (round / floor / ceil-via-calendar-day),
// input shape (ISO string / epoch-ms number / Date), argument order
// (`a - b` in one, `to - from` in the others), and null/clamp policy (a
// 9999-day "unknown" sentinel in one, clamp-to-zero in another, null-on-bad-
// input in a third). scripts/duplicate-function-census.ts flagged the name
// collision; none of the five non-canonical bodies were byte-identical to
// each other, so each is judged on its own contract below.
//
// This is the ARITHMETIC only — from/to → whole days, with an explicit
// rounding rule. Null handling, clamping, and sentinel values are POLICY, not
// date math, and stay at each call site (as a thin wrapper around this where
// the policy differs, so the actual day-diffing formula lives in exactly one
// place — see the tombstones at each of the five former copies for how each
// now delegates here).
//
// PURE LEAF — no imports, importable on either side of the Remotion/kernel
// bundling wall (see lib/format/ordinal.ts).

/** `from`/`to` accepted as an ISO/date string, epoch milliseconds, or a
 *  `Date` — every shape a prior copy of this function took. */
export type DaysBetweenInput = string | number | Date

function toMs(v: DaysBetweenInput): number {
  return v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime()
}

/** Whole days from `from` to `to` (positive when `to` is later), by an
 *  explicit rounding rule. Default `"floor"` — the rule four of the five
 *  duplicate copies used (dunning.ts, title-closing-watchtower.ts,
 *  closing-orchestration.ts, director-content.ts); only
 *  agent-action-queue/composer.ts rounded to the nearest day instead.
 *  NaN in either input propagates as `NaN`, same as every prior copy — a
 *  bad/missing date is each CALLER's policy to catch (see the wrappers this
 *  merge left behind), not this function's. */
export function daysBetween(
  from: DaysBetweenInput,
  to: DaysBetweenInput = new Date(),
  opts?: { round?: "floor" | "ceil" | "round" },
): number {
  const diff = (toMs(to) - toMs(from)) / 86_400_000
  const round = opts?.round ?? "floor"
  return round === "ceil" ? Math.ceil(diff) : round === "round" ? Math.round(diff) : Math.floor(diff)
}

/**
 * `daysBetween(iso, now, {round:"floor"})`, clamped to >=0, or `null` for a
 * missing/unparseable `iso` — the POLICY wrapper `daysBetween`'s own header
 * says stays at the call site. Survivor for two byte-identical private
 * `daysSince` copies (SAME BODY census round 3, 2026-09-09):
 * lib/education/skill-freshness-radar.ts:20 and
 * lib/recruiting/retention-radar.ts:14.
 */
export function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, daysBetween(t, now, { round: "floor" }))
}

/**
 * `'HH:MM'` (or `'HH:MM:SS'`, seconds ignored) 24-hour time → `'h:MM AM/PM'`.
 * Returns `t` unchanged when it doesn't parse. Survivor for two
 * byte-identical private copies (SAME BODY census round 3, 2026-09-09):
 * app/portal/[contactId]/showings/components/buyer-tour-card.tsx:260
 * `formatTime` and lib/showings/dispatchers.ts:386 `formatTimeShort`.
 */
export function formatTime24To12(t: string): string {
  const [hh, mm] = t.split(":").map(Number)
  if (hh == null || mm == null) return t
  const period = hh >= 12 ? "PM" : "AM"
  const h12 = hh % 12 || 12
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`
}

// ─────────────────────────────────────────────────────────────────────────────
// SAME-BODY CENSUS, ROUND 4 (2026-09-09, lane FC). Six distinct `formatDate`
// contracts were pasted around the lender/title/offer/portal surfaces — each
// recorded here under its OWN name (§6: one vocabulary PER function, not one
// function forced to cover six disagreeing contracts).

/** `"MMM D, YYYY"`, or `"TBD"` for a missing date. Survivor for the
 *  byte-identical private `formatDate` in
 *  app/components/lender/loan-list.tsx:65 and
 *  app/components/title/transaction-list.tsx:65. */
export function formatDateOrTBD(date: string | null | undefined): string {
  if (!date) return "TBD"
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** `"Wed, MMM D, YYYY"`, or `"TBD"` for a missing date — the weekday-carrying
 *  twin of `formatDateOrTBD` (a real contract difference, not a formatting
 *  whim: these two portal detail pages lead with the weekday). Survivor for
 *  app/portal/lender/[transactionId]/page.tsx:77 and
 *  app/portal/title/[transactionId]/page.tsx:57. */
export function formatDateOrTBDWithWeekday(date: string | null | undefined): string {
  if (!date) return "TBD"
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  })
}

/** `"MMM D, YYYY, H:MM AM/PM"` — non-nullable input, always carries the
 *  upload timestamp. Survivor for the byte-identical private `formatDate` in
 *  app/portal/lender/[transactionId]/document-upload.tsx:30 and
 *  app/portal/title/[transactionId]/document-upload.tsx:61. */
export function formatDateTimeShort(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  })
}

/** `"MMM D, YYYY"` — non-nullable input, no fallback. Survivor for FOUR
 *  byte-identical-in-effect private `formatDate` copies (two wrote the
 *  `new Date(x).toLocaleDateString(...)` chain inline, two assigned `date`
 *  first — same output, so the census caught them as two separate pairs, not
 *  one four-site group; consolidated here under one name per §6):
 *  app/components/financials/CommissionBreakdownTable.tsx:61,
 *  app/dashboard/marketing/podcast/components/episodes-tab.tsx:221,
 *  app/components/home-value/CompsTable.tsx:45,
 *  app/components/home-value/ValuationResultCard.tsx:35. */
export function formatDateShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** `"MMM D"` — no year, non-nullable input. Survivor for the byte-identical
 *  private `formatDate` in app/components/portal/OfferStatusCard.tsx:58 and
 *  app/dashboard/ai-quality/ai-quality-dashboard-client.tsx:137. */
export function formatMonthDay(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// ─── Relative "time ago" — three genuinely different contracts (§6: kept
// distinct, not forced onto one signature, because they disagree on the
// missing-input policy and the rounding rule) ────────────────────────────────

/** `iso` → "Xm/h/d ago", `"just now"` under a minute, or `"never"` for a
 *  missing timestamp. Survivor for the byte-identical private `fmtAgo` in
 *  app/dashboard/superadmin/a2p/page.tsx:20, .../engagement/page.tsx:50,
 *  .../vendors/page.tsx:37, app/dashboard/whats-new/page.tsx:30. */
export function agoOrNever(iso: string | null): string {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

/** Same "ago" ladder as `agoOrNever`, computed via a minutes-first rounding
 *  chain (visibly different arithmetic — rounds to whole minutes, then hours,
 *  then days — not just a restated version of it), and `"—"` rather than
 *  `"never"` for a missing timestamp. Survivor for the byte-identical private
 *  `fmtAgo` in app/dashboard/superadmin/connector-healing/page.tsx:39 and
 *  .../connectors/page.tsx:21. */
export function agoOrDash(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** `iso` → "Xm/h/d ago" — non-nullable input, no "just now" branch (minutes
 *  start at 0m). Survivor for the byte-identical private `relative` in
 *  app/dashboard/agent/refer/referral-panel-client.tsx:42 and
 *  app/dashboard/listings/health/health-client.tsx:32. */
export function agoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

/** `iso` → "Xm/h/d ago", `"just now"` under a minute, `""` for an unparseable
 *  timestamp (floor-rounded, second-precision — the ladder the manager
 *  command-center feed uses). Survivor for the byte-identical private
 *  `relTime` in app/dashboard/admin/command-center/manager-activity-feed.tsx:48
 *  and .../manager-talk-feed.tsx:51. */
export function agoFloorOrEmpty(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** `dateString` → "Xm/h/d ago", `"just now"` under a minute — minutes-first
 *  floor rounding, no null guard. A fourth, distinct "ago" ladder (§6: kept
 *  apart from `agoOrNever`/`agoOrDash`/`agoShort`/`agoFloorOrEmpty` because
 *  each rounds and gates differently). Survivor for the byte-identical
 *  private `formatTimeAgo` in app/approvals/page.tsx:227 and
 *  app/dashboard/admin/approvals/page.tsx:139. */
export function agoMinutesFloor(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}
