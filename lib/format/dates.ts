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
