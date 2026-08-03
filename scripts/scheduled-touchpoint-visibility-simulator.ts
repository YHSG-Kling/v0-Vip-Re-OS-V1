#!/usr/bin/env tsx
/**
 * scripts/scheduled-touchpoint-visibility-simulator.ts
 * (npm run test:touchpoint-visibility)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY TOUCHPOINT THE AI SCHEDULED WAS SAVED, AND COULD NEVER BE SEEN.
 *
 * This is the missing-middle shape, not a failed write. `aiGenerateTouchpoint`
 * drafted a real message, inserted a real row, and returned success — and the
 * row was invisible forever, because it omitted `scheduled_date`.
 *
 * The ONLY surface that renders these rows is the calendar, and it reads them
 * (app/dashboard/calendar/components/os/calendar-shell.tsx) with
 *
 *     .eq("agent_id", agentId).eq("status", "scheduled")
 *     .gte("scheduled_date", startISO).lt("scheduled_date", endISO)
 *
 * A NULL never satisfies a range comparison, so an undated row matches no day
 * that will ever be requested. Verified live on brokerage b0000000…0001 by
 * running the calendar's own filter over both shapes: the undated row was
 * absent, the dated row was present.
 *
 * WHY IT SURVIVED. supabase-js RESOLVES a rejected insert rather than throwing,
 * and the write was `const { data: savedTouchpoint } = await …` with no `error`
 * destructured at all. The action then returned `{ success: true, touchpointId:
 * savedTouchpoint?.id }` — an undefined id is indistinguishable from a saved
 * one to every caller. Nothing anywhere could tell a scheduled touchpoint from
 * a lost one.
 *
 * WHO IT COST. Three live callers, one of them unattended:
 *   app/actions/lifetime-customers.ts:generateTouchpoint — the "Generate
 *     Check-In" button on the lifetime-customers radar tab, which IS in the nav.
 *   lib/sphere-resonance/run-resonance-scan.ts — the AUTONOMOUS sphere scan,
 *     drafting follow-ups nobody asked for and nobody could ever see.
 *   the referral repeat-business panel.
 *
 * The sibling writer, app/actions/lifetime-customers.ts:scheduleTouchpoint, had
 * it right the whole time: it sets scheduled_date, sets the tenant anchor, and
 * checks its error. This is the same "a complete implementation sits beside a
 * weaker one that is the one actually wired" pattern — except here BOTH were
 * wired, to different buttons.
 *
 * The tenant anchor was missing too: brokerage_id was never set, so these rows
 * were anchorless.
 */
import { readFileSync, existsSync } from "node:fs"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Comments stripped: this file's own prose must never satisfy an assertion. */
const src = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : ""

const SPHERE   = src("app/actions/ai-sphere-management.ts")
const LIFETIME = src("app/actions/lifetime-customers.ts")
const CALENDAR = src("app/dashboard/calendar/components/os/calendar-shell.tsx")

console.log("\n── the reader that decides whether a touchpoint exists ──")
{
  check("the calendar is still the surface that renders scheduled touchpoints",
    /from\("scheduled_touchpoints"\)/.test(CALENDAR))
  // This is the assertion that makes scheduled_date load-bearing. If the
  // calendar ever stops filtering on a date range, re-read this whole proof.
  check("…and it still selects them by a scheduled_date RANGE",
    /\.gte\("scheduled_date",[\s\S]{0,120}?\.lt\("scheduled_date",/.test(CALENDAR))
  check("…for rows in the 'scheduled' status",
    /\.eq\("status",\s*"scheduled"\)/.test(CALENDAR))
}

console.log("\n── the AI writer now writes a row the reader can find ──")
{
  check("aiGenerateTouchpoint sets scheduled_date",
    /scheduled_date:\s*\(params\.scheduledFor \?\? new Date\(\)\.toISOString\(\)\)\.split\("T"\)\[0\]/.test(SPHERE))
  check("…defaulting to today rather than leaving it null",
    /scheduledFor\?:\s*string/.test(SPHERE))
  check("…and carries the tenant anchor",
    /brokerage_id:\s*contact\.brokerage_id \?\? null/.test(SPHERE))
}

console.log("\n── the write can no longer fail silently ──")
{
  check("the insert destructures its error",
    /const \{ data: savedTouchpoint, error: saveError \} = await supabase/.test(SPHERE))
  check("…and a failed save is reported as a failure, not as success",
    /if \(saveError \|\| !savedTouchpoint\)[\s\S]{0,200}?success:\s*false/.test(SPHERE))
  check("…while still returning the draft it generated, so the work is not thrown away",
    /if \(saveError \|\| !savedTouchpoint\)[\s\S]{0,260}?data:\s*touchpoint/.test(SPHERE))
  check("the success path no longer reports an optional id",
    !/touchpointId:\s*savedTouchpoint\?\.id/.test(SPHERE))
}

console.log("\n── the sibling writer that was right all along still is ──")
{
  check("scheduleTouchpoint sets scheduled_date",
    /scheduled_date:\s*scheduledFor\.split\("T"\)\[0\]/.test(LIFETIME))
  check("…sets the tenant anchor",
    /from\("scheduled_touchpoints"\)[\s\S]{0,400}?brokerage_id:\s*brokerageId/.test(LIFETIME))
  check("…and checks its error",
    /from\("scheduled_touchpoints"\)[\s\S]{0,700}?if \(error\)/.test(LIFETIME))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ TOUCHPOINT_VISIBILITY_FAIL"); process.exit(1) }
console.log(" ✅ TOUCHPOINT_VISIBILITY_PASS — a scheduled touchpoint lands on a day, and a lost one says so")
