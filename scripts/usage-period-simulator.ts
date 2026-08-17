#!/usr/bin/env tsx
/**
 * scripts/usage-period-simulator.ts  (npm run test:usage-period)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE BILLING PERIOD VOCABULARY (#190, m474).
 *
 * usage_counters' UNIQUE key includes period_end, and the AI-quota view
 * (v_brokerage_ai_quota) JOINS on the exclusive UTC month end — while
 * lib/usage.ts, the ONLY writer of ai_tokens_monthly, stamped LOCAL months
 * with an INCLUSIVE end. The join could never match on ANY timezone: AI usage
 * metered to a row nothing read, quota zero forever, the cap never tripped.
 *
 * The canon is lib/usage/period.ts, mirroring the view's own spelling
 * (date_trunc UTC month, + '1 mon'). Writers stamp both bounds from it;
 * READERS key on period_start alone — pinning the end is how the old rows
 * became unreadable. m474 normalised the rows already written (measured: one).
 *
 * ALSO CLOSED HERE: seller-offers metered its AI comparison to a users.id
 * passed AS the brokerageId — the counter row failed tenant RLS, the error was
 * swallowed, and the call was never metered.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { currentUsagePeriod } from "../lib/usage/period"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/** Strip comments so prose cannot satisfy (or trip) a scan. */
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))

const PERIOD = read("lib/usage/period.ts")
const USAGE = read("lib/usage.ts")
const CAP = read("lib/usage/check-cap.ts")
const MEDIA = read("lib/usage/log-media-usage.ts")
const OVERVIEW = read("app/actions/usage-overview.ts")
const OFFERS = read("app/actions/seller-offers.ts")

console.log("\n[the canon — computed once, UTC, half-open]")
{
  // The convention itself, executed: a moment late in a month, ANY local zone.
  const p = currentUsagePeriod(new Date("2026-08-31T23:30:00-07:00")) // = Sep 1 06:30Z
  check("the period is the UTC month of the instant (a late-local-August moment is UTC September)",
    p.periodStartIso === "2026-09-01T00:00:00.000Z" && p.periodEndIso === "2026-10-01T00:00:00.000Z")
  const q = currentUsagePeriod(new Date("2026-08-17T12:00:00Z"))
  check("...half-open: end is the NEXT month's first instant, never a 23:59:59",
    q.periodEndIso === "2026-09-01T00:00:00.000Z" && !q.periodEndIso.includes("23:59:59"))
}

console.log("\n[one definition — every usage file imports it, none re-derives it]")
for (const [name, src] of [["lib/usage.ts", USAGE], ["check-cap", CAP], ["log-media-usage", MEDIA], ["usage-overview", OVERVIEW]] as const) {
  check(`${name} imports currentUsagePeriod`, /import \{[^}]*currentUsagePeriod[^}]*\}/.test(src))
  check(`${name} carries NO local-month math (the defect's spelling)`,
    !/new Date\(now\.getFullYear\(\), now\.getMonth\(\)/.test(code(src)))
  check(`${name} carries NO private UTC re-derivation either (a second canon is still a second canon)`,
    !/Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\)/.test(code(src)))
}

console.log("\n[readers key on the start — the end is identity for WRITES only]")
check("incrementUsage's read does not pin period_end",
  !/\.eq\("period_end"[\s\S]{0,120}?maybeSingle\(\)/.test(code(USAGE).split("incrementUsage")[1]?.split("export")[0] ?? ""))
check("check-cap's read does not pin period_end", !/\.eq\("period_end"/.test(code(CAP)))
check("...but writers still stamp BOTH canonical bounds (period_end is in the UNIQUE key)",
  /period_end: periodEndIso/.test(USAGE) && /period_end: periodEndIso/.test(MEDIA))
check("a lost insert race folds the increment into the winner instead of dropping it",
  /23505/.test(USAGE))
check("a refused counter read/write is LOGGED as not-metered, never silently absorbed",
  /NOT be metered|NOT metered|not metered/.test(USAGE))

console.log("\n[the mis-metered call — a tenant id, not a person]")
check("seller-offers meters its AI comparison to the resolved brokerage id",
  /incrementUsage\(usageBrokerageId, "llm_calls"/.test(code(OFFERS)))
check("...and no call site passes userId as the tenant any more",
  !/incrementUsage\(userId,/.test(code(OFFERS)))

console.log("\n[the migration]")
{
  const MIG = read("supabase/migrations/m474-one-billing-period-vocabulary.sql")
  check("m474 normalises to date_trunc(month)+1mon and RAISES if any row is left off-canon",
    /date_trunc\('month', period_start\) \+ interval '1 mon'/.test(MIG) && /raise exception/.test(MIG))
}

console.log("\n[negative controls]")
check("NEGATIVE — the local-month scan trips on the old spelling",
  /new Date\(now\.getFullYear\(\), now\.getMonth\(\)/.test('const periodStart = new Date(now.getFullYear(), now.getMonth(), 1)'))
check("NEGATIVE — the comment mask hides the same spelling in prose",
  !/new Date\(now\.getFullYear\(\), now\.getMonth\(\)/.test(code('// old: new Date(now.getFullYear(), now.getMonth(), 1)')))

console.log("\n" + "─".repeat(78))
console.log(`${pass} passed, ${fail} failed`)
if (fail) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
