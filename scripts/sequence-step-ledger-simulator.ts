#!/usr/bin/env tsx
/**
 * scripts/sequence-step-ledger-simulator.ts  (npm run test:sequence-step-ledger)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE PER-STEP LEDGER FOR THE SEQUENCE ENGINE, AND A CONVERSION METRIC THAT
 * IS NOT ZERO BY OMISSION.
 *
 * The owner asked whether workflows and marketing campaigns are overlapping
 * systems ("one with increments and the other sequences"). They are NOT — the
 * orchestrator (workflow_runs + workflow_run_steps, chain_key driven, advances
 * by step index) and the sequence engine (campaign_sequences +
 * sequence_enrollments, per-contact multi-channel with delays) are genuinely
 * different concerns. The overlap was one table deep, and it was the reason
 * they LOOKED like the same system:
 *
 *     workflow_run_steps   → the orchestrator's steps
 *     workflow_step_runs   → the SEQUENCE engine's steps
 *
 * Three words, two orders, two systems. workflow_step_runs is keyed on
 * enrollment_id + step_id — it never belonged to the orchestrator at all, and
 * the sequence engine already had sequence_step_executions. step-executor.ts
 * wrote BOTH, from adjacent lines, for the same step.
 *
 * TWO PRIOR PASSES SAW THIS TABLE AND LEFT IT — correctly, given what they
 * were comparing. sequences_workflow_nav and workflow_engine_consolidation both
 * checked it against the ORCHESTRATOR tables, concluded "genuinely a different
 * concern", and moved on. Neither compared it against its actual twin.
 *
 * ── WHAT THE DUPLICATE COST ─────────────────────────────────────────────────
 * 1. CONVERSIONS WERE STRUCTURALLY ZERO. workflow_step_runs.converted_at /
 *    conversion_value_cents / attribution_source were declared for "per-step
 *    revenue attribution" and NOTHING ever wrote one. Both the workflow-reports
 *    page and the admin widget rendered "0" and "$0" for every brokerage,
 *    forever — a permanent zero in the typeface of a measurement. The same is
 *    true of the sequence-side columns that DO belong:
 *    sequence_enrollments.status='converted', converted_at, and
 *    campaign_sequences.conversions_total (written twice, both times as `0` at
 *    creation).
 * 2. BLOCKED STEPS EXCLUDED EVERY COMPLIANCE BLOCK. The workflow_step_runs row
 *    was inserted immediately before dispatch, so authority-blocked and
 *    lead-channel-restricted steps — which write sequence_step_executions —
 *    never reached it. The compliance gate could stop every send and the report
 *    would show zero blocks.
 * 3. It was the one sequence table with no brokerage_id of its own.
 * 4. Its writes were best-effort (`.catch(() => {})`), so failures vanished.
 *
 * ── THE RESOLUTION ──────────────────────────────────────────────────────────
 * sequence_step_executions keeps the ledger; the columns the duplicate had that
 * it lacked are ported first (step_output, output_variable_name, provider_key,
 * started_at, finished_at, duration_ms). The never-written attribution trio is
 * NOT ported — lib/marketing/attribution.ts already splits closed-transaction
 * GCI across four models, and a second scheme beside a complete one is the
 * duplication being removed. Conversion is measured where it is real:
 * lib/campaign-sequences/sequence-conversion.ts stamps the ENROLLMENT when the
 * enrolled contact's transaction closes, riding the same cron pass as the
 * attribution engine and the same 180-day lookback.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
/** Source with comments stripped — so a table NAMED in a comment never counts as a reference. */
const src = (p: string) => raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

console.log("══════════════════════════════════════════════════")
console.log(" Sequence step ledger — one table, one conversion truth")
console.log("══════════════════════════════════════════════════")

console.log("\n── the duplicate is gone from every contract ──")
{
  const snap = raw("scripts/schema-snapshot.ts")
  check("workflow_step_runs is out of the schema snapshot", !/\n\s*workflow_step_runs:\s*\[/.test(snap))
  check("…and sequence_step_executions is still in it", /\n\s*sequence_step_executions:\s*\[/.test(snap))
  check("…and the ORCHESTRATOR's workflow_run_steps is untouched", /\n\s*workflow_run_steps:\s*\[/.test(snap))

  check("its CHECK vocabulary entry is gone",
    !Object.prototype.hasOwnProperty.call(CHECK_VOCABULARIES, "workflow_step_runs"))
  check("the TABLE_MANAGER ownership row is gone",
    !/\n\s*workflow_step_runs:\s*"/.test(raw("lib/kernel/manager-registry.ts")))
  check("the migration drops it", raw("supabase/migrations/m302-consolidate-sequence-step-ledger.sql")
    .includes("DROP TABLE IF EXISTS workflow_step_runs"))
}

console.log("\n── no code reads or writes the duplicate any more ──")
{
  for (const f of [
    "lib/campaign-sequences/step-executor.ts",
    "app/actions/workflow-reports.ts",
    "app/dashboard/admin/components/workflow-reports-widget.tsx",
    "app/dashboard/campaigns/workflow-reports/page.tsx",
    "lib/workflow/intelligence/agent-pattern-insights.ts",
  ]) {
    check(`${f}: no workflow_step_runs reference`, !/workflow_step_runs/.test(src(f)))
  }
  const ex = src("lib/campaign-sequences/step-executor.ts")
  check("the executor no longer opens a second 'running' row", !/status:\s*"running"/.test(ex))
  check("…and no longer discards a ledger write with .catch(() => {})",
    !/from\("sequence_step_executions"\)[\s\S]{0,400}?\.catch\(\(\) => \{\}\)/.test(ex))
}

console.log("\n── the ported columns actually ride the surviving ledger ──")
{
  const ex = src("lib/campaign-sequences/step-executor.ts")
  // The OUTCOME insert — the one that records what a dispatched step did — must
  // carry what the duplicate used to hold, or the merge silently lost data
  // rather than consolidating it. Identified by `status: executionStatus`; the
  // other three inserts (authority block, deferral, logAndSkip) record steps
  // that never dispatched and legitimately have less to say.
  const outcomeStart = ex.indexOf('from("sequence_step_executions").insert(', ex.indexOf("status: executionStatus") - 800)
  const finalInsert = ex.slice(outcomeStart, ex.indexOf("})", ex.indexOf("status: executionStatus")))
  for (const col of ["step_output", "output_variable_name", "provider_key", "started_at", "finished_at", "duration_ms"]) {
    check(`the outcome row carries ${col}`, finalInsert.includes(`${col}:`))
  }
  check("the deferral row carries the timing too", /over-touch deferral[\s\S]{0,400}?duration_ms:/.test(ex))
}

console.log("\n── the report reads the ledger it can actually count ──")
{
  const r = src("app/actions/workflow-reports.ts")
  check("it reads sequence_step_executions", /from\("sequence_step_executions"\)/.test(r))

  // The old status sets came from the duplicate's vocabulary. Three of the words
  // are NOT in this column's CHECK, so each would have counted exactly nothing.
  const live = CHECK_VOCABULARIES.sequence_step_executions?.status ?? []
  check("the live vocabulary is known", live.length > 0)
  // Scope the search to the STEP tallies. 'completed' is a legitimate word
  // elsewhere in this file — it is a real sequence_enrollments status — so a
  // whole-file grep would flag correct code. The bug was only ever in the step
  // filters, which is where this looks.
  const stepTallies = r.slice(r.indexOf("const totalStepsRun"), r.indexOf("const totalConversions"))
  for (const dead of ["completed", "error", "blocked"]) {
    check(`'${dead}' is not a status the STEP column holds`, !live.includes(dead))
    check(`…and the step tallies no longer test for '${dead}'`,
      !new RegExp(`status === "${dead}"`).test(stepTallies))
  }
  check("authority_blocked IS admitted — the compliance gate's own word",
    live.includes("authority_blocked"))
  check("…and the report finally counts it as blocked", /"authority_blocked"/.test(r))
  for (const good of ["sent", "delivered", "opened", "clicked", "replied", "failed", "skipped"]) {
    check(`'${good}' is admitted`, live.includes(good))
  }
}

console.log("\n── the conversion metric is no longer zero by omission ──")
{
  const r = src("app/actions/workflow-reports.ts")
  check("conversions come from the ENROLLMENT, not a step column",
    /totalConversions = enrollments\?\.filter\(e => e\.converted_at\)/.test(r))
  check("the dead conversion_value_cents field is out of the report contract",
    !/totalConversionValueCents/.test(r))
  for (const f of [
    "app/dashboard/campaigns/workflow-reports/workflow-reports-client.tsx",
    "app/dashboard/admin/components/workflow-reports-widget.tsx",
  ]) {
    check(`${f}: no longer renders the dead dollar tile`, !/totalConversionValueCents/.test(src(f)))
  }

  const c = src("lib/campaign-sequences/sequence-conversion.ts")
  check("a real resolver exists", /export async function resolveSequenceConversions/.test(c))
  check("it stamps status='converted' AND converted_at",
    /status:\s*"converted"/.test(c) && /converted_at:/.test(c))
  check("it rolls campaign_sequences.conversions_total — dead since creation",
    /conversions_total/.test(c) && /from\("campaign_sequences"\)/.test(c))
  check("it is idempotent: already-converted enrollments are not re-counted",
    /\.in\("status", \["active", "completed", "paused"\]\)/.test(c))
  check("it excludes opt-outs — an unsubscribed contact did not convert",
    !/"unsubscribed"/.test(c) && !/"cancelled"/.test(c))
  check("'converted' is a status the enrollment column admits",
    (CHECK_VOCABULARIES.sequence_enrollments?.status ?? []).includes("converted"))

  const cron = src("app/api/cron/marketing-attribution-engine/route.ts")
  check("it rides the EXISTING attribution cron — no second schedule",
    /resolveSequenceConversions/.test(cron))
  check("…and a conversion failure cannot lose the attribution that succeeded",
    /catch \(convErr\)/.test(cron))
  check("the run reports what it converted", /enrollments_converted/.test(cron))
}

console.log("\n── the two ENGINES stay separate — that was never the problem ──")
{
  const orch = src("lib/workflow-orchestrator/engine.ts")
  check("the orchestrator still runs on workflow_runs", /from\("workflow_runs"\)/.test(orch))
  check("…and workflow_run_steps", /from\("workflow_run_steps"\)/.test(orch))
  check("…and never touches the sequence ledger", !/sequence_step_executions/.test(orch))
  const ex = src("lib/campaign-sequences/step-executor.ts")
  check("the sequence engine never touches the orchestrator's tables",
    !/workflow_runs/.test(ex) && !/workflow_run_steps/.test(ex))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SEQUENCE_STEP_LEDGER_FAIL"); process.exit(1) }
console.log(" ✅ SEQUENCE_STEP_LEDGER_PASS — one ledger, and conversions that can be non-zero")
