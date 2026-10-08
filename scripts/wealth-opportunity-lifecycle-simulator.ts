#!/usr/bin/env tsx
/**
 * scripts/wealth-opportunity-lifecycle-simulator.ts   (npm run test:wealth-lifecycle) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE VOCABULARY FOR wealth_advisor_recommendations.status.
 *
 * The live CHECK, read off the database:
 *
 *   CHECK (status = ANY (ARRAY['open','reviewed','presented','converted','dismissed','stale']))
 *   DEFAULT 'open'
 *
 * The daily scan inserts these rows and never set a status, so every row an
 * agent could see was 'open'. Three readers each had their own idea of what the
 * column contained, and none of them contained 'open':
 *
 *   app/actions/predictive-surfaces.ts   in(status, [pending_review, ready_to_push, pushed])
 *   app/dashboard/wealth/actions.ts      status === 'new' || status === 'active'
 *   lib/lifetime-customer-npv/scorer.ts  in(status, [new, pushed, reviewed, acknowledged])
 *
 * Verified against the live database with a probe row (inserted 'open', driven
 * through the whole lifecycle, deleted):
 *
 *   old predictive filter → 0 rows      new → 1
 *   old NPV wealth signal → 0 rows      new → 1
 *
 * So the Wealth Advisor card on the predictive dashboard was structurally empty,
 * the agent's by-type grid sorted every live opportunity into "already acted on",
 * and the lifetime-NPV wealth signal was a constant zero. None of it would ever
 * throw: a filter on an impossible value is just an empty result set.
 *
 * The vocabulary now lives in lib/wealth-advisor/recommendation-status.ts and
 * every reader imports it. This pins that, and pins that the module never drifts
 * away from the CHECK as the schema snapshot records it.
 */
import { readFileSync } from "node:fs"
import {
  WEALTH_STATUSES,
  WEALTH_STATUS_DEFAULT,
  WEALTH_ACTIVE_STATUSES,
  WEALTH_CLOSED_STATUSES,
  WEALTH_STATUS_PRESENTED,
  WEALTH_STATUS_CONVERTED,
  WEALTH_STATUS_DISMISSED,
  isWealthActive,
} from "../lib/wealth-advisor/recommendation-status"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Every assertion reads CODE. These files quote the dead literals in their own
 *  headers, so the comments have to come off or the guard flags its own notes. */
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

console.log("\n── the module matches the live CHECK, value for value ──")
{
  const live = CHECK_VOCABULARIES.wealth_advisor_recommendations?.status ?? []
  check(`the schema snapshot still carries the column (${live.length} values)`, live.length === 6)
  check("every value the module declares is admitted by the CHECK",
    WEALTH_STATUSES.every((s) => live.includes(s)))
  check("every value the CHECK admits is declared by the module (no silent gap)",
    live.every((s) => (WEALTH_STATUSES as readonly string[]).includes(s)))
  check("active ∪ closed is the whole vocabulary, with no overlap",
    WEALTH_ACTIVE_STATUSES.length + WEALTH_CLOSED_STATUSES.length === WEALTH_STATUSES.length &&
    WEALTH_ACTIVE_STATUSES.every((s) => !WEALTH_CLOSED_STATUSES.includes(s)))
  check("the declared default is the one the column actually defaults to ('open')",
    WEALTH_STATUS_DEFAULT === "open" && live.includes(WEALTH_STATUS_DEFAULT))
}

console.log("\n── what the scan writes is what the readers look for ──")
{
  check("the row the scan produces is ACTIVE (this is the whole bug in one line)",
    isWealthActive(WEALTH_STATUS_DEFAULT) === true)
  check("presented stays active — showing a client is not closing it out",
    isWealthActive(WEALTH_STATUS_PRESENTED) === true)
  check("reviewed stays active", isWealthActive("reviewed") === true)
  check("converted is closed", isWealthActive(WEALTH_STATUS_CONVERTED) === false)
  check("dismissed is closed", isWealthActive(WEALTH_STATUS_DISMISSED) === false)
  check("stale is closed", isWealthActive("stale") === false)

  // The five literals that could never match. If any comes back, the surface dies again.
  for (const dead of ["new", "active", "pending_review", "ready_to_push", "pushed", "acknowledged"]) {
    check(`'${dead}' is not active, and is not in the vocabulary at all`,
      isWealthActive(dead) === false && !(WEALTH_STATUSES as readonly string[]).includes(dead))
  }
}

console.log("\n── every reader asks the ONE module, not its own list ──")
{
  const predictive = src("app/actions/predictive-surfaces.ts")
  check("predictive-surfaces filters on WEALTH_ACTIVE_STATUSES",
    /\.in\("status", \[\.\.\.WEALTH_ACTIVE_STATUSES\]\)/.test(predictive))
  check("predictive-surfaces no longer carries the impossible triple",
    !predictive.includes("pending_review") && !predictive.includes("ready_to_push"))

  const dash = src("app/dashboard/wealth/actions.ts")
  check("the agent grid buckets with isWealthActive", /isWealthActive\(v\.status\)/.test(dash))
  check("the grid no longer tests for 'new' or 'active'",
    !/status === "new"/.test(dash) && !/status === "active"/.test(dash))
  check("mark-acted writes the shared 'converted' constant",
    /status: WEALTH_STATUS_CONVERTED/.test(dash))
  check("dismiss writes the shared 'dismissed' constant",
    /status:\s+WEALTH_STATUS_DISMISSED/.test(dash))

  const scorer = src("lib/lifetime-customer-npv/scorer.ts")
  check("the lifetime-NPV wealth signal filters on WEALTH_ACTIVE_STATUSES",
    /\.in\("status", \[\.\.\.WEALTH_ACTIVE_STATUSES\]\)/.test(scorer))
  check("the NPV scorer no longer asks for 'acknowledged'", !scorer.includes("acknowledged"))
}

console.log("\n── push-to-portal is a real transition, and cannot resurrect a closed row ──")
{
  const dash = src("app/dashboard/wealth/actions.ts")
  check("pushing writes status 'presented', not just a timestamp",
    /status:\s+WEALTH_STATUS_PRESENTED/.test(dash) && /pushed_to_portal_at:\s+new Date/.test(dash))
  check("the push update is guarded to the active set",
    /\.in\("status", \[\.\.\.WEALTH_ACTIVE_STATUSES\]\)/.test(dash))

  // The guard replayed as the database applies it: a WHERE that excludes the row.
  const wouldPush = (current: string) => isWealthActive(current)
  check("open → push applies", wouldPush("open") === true)
  check("presented → push re-applies (re-sending is allowed)", wouldPush("presented") === true)
  check("converted → push is a no-op", wouldPush("converted") === false)
  check("dismissed → push is a no-op", wouldPush("dismissed") === false)
}

console.log("\n── the writer states the status instead of inheriting it silently ──")
{
  const scan = src("lib/wealth-advisor/scan-opportunities.ts")
  check("the scan inserts status: WEALTH_STATUS_DEFAULT", /status: WEALTH_STATUS_DEFAULT/.test(scan))
  check("the scan writes contacts.agent_id through unchanged (agents.id class)",
    /agent_id: c\.agent_id/.test(scan))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ WEALTH_LIFECYCLE_FAIL"); process.exit(1) }
console.log(" ✅ WEALTH_LIFECYCLE_PASS — one status vocabulary, and every reader asks it")
