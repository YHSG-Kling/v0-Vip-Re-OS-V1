#!/usr/bin/env tsx
/**
 * scripts/schedule-newsletter-sim.ts  (npm run test:schedule-newsletter) — pure, no DB.
 *
 * Proves the pure schedule-time validation in lib/newsletter/schedule-time.ts —
 * the same verdict that gates the newsletter wizard's "Register Scheduled Send"
 * control (Step 6) client-side AND the authoritative future-time check inside the
 * scheduleNewsletter server action before it writes the governed
 * newsletter_scheduled_sends row. No mocks, no stubs: real Dates/strings in,
 * real verdicts out.
 *
 * The DB insert itself is pure I/O (auth → count contacts → insert row) and has
 * no extractable pure core beyond the time validation covered here.
 *
 * Covers: future/past/now boundary, datetime-local string parsing, ISO
 * normalization (incl. timezone), empty/invalid input, and determinism.
 */
import {
  validateScheduleTime,
  MIN_SCHEDULE_LEAD_MS,
} from "../lib/newsletter/schedule-time"

let pass = 0,
  fail = 0
const check = (n: string, c: boolean) => {
  if (c) {
    pass++
    console.log(`  ✓ ${n}`)
  } else {
    fail++
    console.log(`  ✗ ${n}`)
  }
}

console.log("\n[schedule newsletter · pure time validation]")

const NOW = new Date("2026-06-23T12:00:00.000Z")

// ── Future / past / now boundary ─────────────────────────────────────────────
{
  const future = validateScheduleTime(new Date("2026-06-24T12:00:00.000Z"), NOW)
  check("strictly-future instant is valid", future.valid === true)
  check("valid verdict carries empty reason", future.reason === "")
  check("valid verdict exposes parsed Date", future.date instanceof Date)

  const past = validateScheduleTime(new Date("2026-06-22T12:00:00.000Z"), NOW)
  check("past instant is invalid", past.valid === false)
  check("past reason is 'must be in the future'", past.reason === "Send time must be in the future")
  // Still parseable ⇒ ISO is populated even when rejected.
  check("rejected-but-parseable still exposes ISO", typeof past.iso === "string" && past.iso!.length > 0)

  const exactlyNow = validateScheduleTime(new Date(NOW.getTime()), NOW)
  check("exactly-now is invalid (<= now reject)", exactlyNow.valid === false)

  const oneMsAfter = validateScheduleTime(new Date(NOW.getTime() + 1 + MIN_SCHEDULE_LEAD_MS), NOW)
  check("1ms past the lead window is valid", oneMsAfter.valid === true)
}

// ── datetime-local string parsing (the wizard's <input> value shape) ─────────
{
  // "2026-07-01T09:30" has no timezone → parsed as LOCAL time by JS Date, same as
  // the browser. We assert validity + that it round-trips to a stable ISO.
  const r = validateScheduleTime("2026-07-01T09:30", NOW)
  check("datetime-local string (future) parses valid", r.valid === true)
  check("datetime-local string yields a canonical ISO", r.iso === r.date!.toISOString())
  check("ISO ends in Z (UTC, normalized)", r.iso!.endsWith("Z"))

  const rPast = validateScheduleTime("2020-01-01T00:00", NOW)
  check("datetime-local string (past) is invalid", rPast.valid === false)
}

// ── ISO normalization preserves the instant across input forms ───────────────
{
  // A Date and its own ISO string must produce the identical canonical ISO.
  const d = new Date("2026-12-31T23:59:00.000Z")
  const fromDate = validateScheduleTime(d, NOW)
  const fromIso = validateScheduleTime(d.toISOString(), NOW)
  check("Date and its ISO string normalize to the same ISO", fromDate.iso === fromIso.iso)
  check("normalized ISO equals the source instant", fromDate.iso === "2026-12-31T23:59:00.000Z")
}

// ── Empty / invalid input safety ─────────────────────────────────────────────
{
  const empty = validateScheduleTime("", NOW)
  check("empty string is invalid", empty.valid === false)
  check("empty string prompts to pick a time", empty.reason === "Pick a send date and time")
  check("empty string yields null ISO + null date", empty.iso === null && empty.date === null)

  const garbage = validateScheduleTime("not-a-date", NOW)
  check("unparseable string is invalid", garbage.valid === false)
  check("unparseable string reason is 'Invalid date or time'", garbage.reason === "Invalid date or time")
  check("unparseable string yields null ISO (no NaN ISO throw)", garbage.iso === null)
}

// ── Determinism ──────────────────────────────────────────────────────────────
{
  const a = validateScheduleTime("2026-08-15T10:00", NOW)
  const b = validateScheduleTime("2026-08-15T10:00", NOW)
  check("deterministic — same input → identical verdict", JSON.stringify(a) === JSON.stringify(b))
  check("lead-window constant intact (0 ⇒ any strict future)", MIN_SCHEDULE_LEAD_MS === 0)
}

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) {
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  process.exit(1)
}
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ SCHEDULE_NEWSLETTER_PASS — pure send-time validation holds (future gate, datetime-local parse, ISO normalize, safety)")
