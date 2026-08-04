#!/usr/bin/env tsx
/**
 * scripts/listing-stage-reader-simulator.ts   (npm run test:listing-stage-reader)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAFETY NET THAT NEVER FIRED.
 *
 * lib/listing-lifecycle/lifecycle-logger.ts:getCurrentLifecycleStage resolved a
 * listing's stage from `activities` where activity_type =
 * 'listing_lifecycle_transition'. NOTHING HAS EVER WRITTEN THAT ROW — live count
 * 0, while three listings sit at real, distinct stages (COMING_SOON_ACTIVE,
 * MLS_ACTIVE, UNDER_CONTRACT). It returned null for every listing, always.
 *
 * A reader that always returns null is not merely useless here, because all three
 * of its callers treat null as a BENIGN state rather than a broken one:
 *
 *   · exception-recovery-limits.ts:checkStageDurationLimit returns
 *     { exceeded: false } when the stage is null. So THE STAGE-DURATION
 *     ESCALATION NET NEVER FIRED FOR ANY LISTING. A listing parked in one stage
 *     indefinitely was never escalated, and the surface looked like a working
 *     safety net the whole time. That is the worst shape a gate can have: it
 *     cannot tell a healthy listing from a stuck one, so it reports every listing
 *     healthy.
 *   · multi-listing-priority.ts ranked every listing at stageIndex -1, so the
 *     priority ordering carried no information.
 *   · the agent-assistant tool call answered "no stage" for every listing.
 *
 * A sibling fix already landed inside app/actions/listing-lifecycle-core.ts. This
 * closes the lib copy that those three callers still went through.
 *
 * AND THE FAILURE MODE IS NOW HONEST. Both readers used to swallow a refused
 * query — getLifecycleHistory destructured only `data` and returned `data ?? []`,
 * so a failed read was indistinguishable from a listing with no history, which
 * checkStageDurationLimit again reads as "nothing exceeded". A gate that cannot
 * read must not pass, so both throw; the priority sweep catches per listing so
 * one unreadable row cannot drop a whole brokerage's ranking.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so this file's own prose cannot satisfy an assertion. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const LOGGER   = "lib/listing-lifecycle/lifecycle-logger.ts"
const PRIORITY = "lib/listing-lifecycle/multi-listing-priority.ts"
const LIMITS   = "lib/listing-lifecycle/exception-recovery-limits.ts"

/** Body of a named exported function, up to the next top-level export. */
function fnBody(source: string, name: string): string {
  const m = new RegExp(`export\\s+async\\s+function\\s+${name}\\b\\s*\\(`).exec(source)
  if (!m) return ""
  const next = source.indexOf("\nexport ", m.index + 1)
  return next === -1 ? source.slice(m.index) : source.slice(m.index, next)
}

function sourceLayer() {
  const logger = code(LOGGER)

  console.log("\n[source · the stage comes from the column the writer writes]")
  const stageFn = fnBody(logger, "getCurrentLifecycleStage")
  check("getCurrentLifecycleStage exists", stageFn.length > 0)
  // THE DEFECT. Assert the phantom table is gone from THIS function, not merely
  // from the file — a neighbouring function may legitimately read activities.
  check("...it no longer reads the phantom activities row",
    !/listing_lifecycle_transition/.test(stageFn) && !/from\(\s*["']activities["']\s*\)/.test(stageFn))
  check("...it reads listings.lifecycle_stage, which transitionLifecycle writes",
    /from\(\s*["']listings["']\s*\)/.test(stageFn) && /lifecycle_stage/.test(stageFn))
  // supabase-js RESOLVES a refused query. Returning null on error would put the
  // exact same "every listing looks fine" behaviour back.
  check("...and a FAILED read throws instead of masquerading as 'no stage'",
    /if\s*\(\s*error\s*\)/.test(stageFn) && /throw new Error/.test(stageFn))

  console.log("\n[source · the history read cannot report a failure as 'no history']")
  const histFn = fnBody(logger, "getLifecycleHistory")
  check("getLifecycleHistory destructures error", /const\s*\{\s*data,\s*error\s*\}/.test(histFn))
  check("...and throws on a failed read", /if\s*\(\s*error\s*\)/.test(histFn) && /throw new Error/.test(histFn))
  // The construct that hid it: `data ?? []` with no error binding at all.
  check("...so no unchecked `const { data }` remains in either reader",
    !/const\s*\{\s*data\s*\}\s*=\s*await\s+supabase/.test(stageFn + histFn))

  console.log("\n[source · one unreadable listing cannot drop a whole ranking]")
  const priority = code(PRIORITY)
  check("the priority sweep guards its per-listing stage read",
    /try\s*\{[\s\S]{0,200}?getCurrentLifecycleStage\([\s\S]{0,200}?\}\s*catch/.test(priority))
  check("...and skips that listing rather than ranking it as stage-less",
    /catch[\s\S]{0,300}?continue/.test(priority))

  console.log("\n[source · the caller whose gate this actually protects]")
  const limits = code(LIMITS)
  // Prove the premise rather than assuming it: this is WHY a null stage was
  // dangerous, and if this stops being true the guard's rationale changes.
  check("checkStageDurationLimit still treats a null stage as 'not exceeded' (the reason a null reader was unsafe)",
    /exceeded:\s*false/.test(limits) && /getCurrentLifecycleStage/.test(limits))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape")
    return
  }
  console.log("\n[live · the row the old reader needed, and the column it should have read]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const { count: phantom, error: phantomErr } = await svc
    .from("activities")
    .select("id", { count: "exact", head: true })
    .eq("activity_type", "listing_lifecycle_transition")
  check("live: the phantom activity row the old reader needed does not exist",
    !phantomErr && (phantom ?? 0) === 0)

  const { data: staged, error: stagedErr } = await svc
    .from("listings")
    .select("id, lifecycle_stage")
    .not("lifecycle_stage", "is", null)
    .limit(50)
  check("live: listings.lifecycle_stage IS populated — the state existed the whole time",
    !stagedErr && (staged ?? []).length > 0)
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" LISTING STAGE READER — the escalation net reads a real column now")
  console.log("══════════════════════════════════════════════════════════════════════")
  sourceLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`LISTING STAGE READER — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nA stage reader that returns null for every listing turns the")
    console.log("stage-duration escalation into a gate that reports every listing")
    console.log("healthy — including the ones that are stuck.")
    process.exit(1)
  }
  console.log("✅ LISTING_STAGE_READER_PASS — the gate reads what the writer writes")
}

main().catch((e) => { console.error(e); process.exit(1) })
