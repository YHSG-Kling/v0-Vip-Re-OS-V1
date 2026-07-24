#!/usr/bin/env tsx
/**
 * scripts/legacy-tables-retired-simulator.ts   (npm run test:legacy-tables-retired)
 * ─────────────────────────────────────────────────────────────────────────────
 * LEGACY DEAD TABLES STAY RETIRED (drift consolidation — "let the others be removed").
 * The legacy agent-training spine (training_courses / agent_courses /
 * training_course_steps), its leaf practice_evaluations, and the orphaned
 * commission_records were proven zero-reference + dependency-closed + empty and
 * were physically dropped (scripts/L60-S02-retire-legacy-dead-tables.sql). This
 * guard is the ratchet: it fails CI if any runtime code re-introduces a reader/writer
 * of a retired table, or if a retired table sneaks back into the schema snapshot —
 * so the drift cannot silently return.
 *
 * It also documents the "zero-reference DDL" guard blind spot the consolidation
 * surfaced: the writer-less / orphan-write / orphan-route sweeps only see tables that
 * ARE referenced; a table referenced by NO code at all is invisible to all three.
 * These specific tables are now pinned; a general zero-ref-DDL sweep is a recommended
 * follow-up (it needs live-schema access, which CI lacks).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const RETIRED = [
  "training_courses",
  "agent_courses",
  "training_course_steps",
  "practice_evaluations",
  "commission_records",
]

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

/** Recursively collect .ts/.tsx under a dir (skipping node_modules/.next). */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

console.log("\n── retired tables have ZERO runtime .from() references (no reader/writer) ──")
{
  const files = [...walk("lib"), ...walk("app")]
  for (const t of RETIRED) {
    const re = new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]`)
    const hits = files.filter((f) => re.test(readFileSync(f, "utf8")))
    check(`no runtime code queries ${t}`, hits.length === 0)
    if (hits.length) console.log(`      ↳ ${hits.slice(0, 3).join(", ")}`)
  }
}

console.log("\n── retired tables are absent from the schema snapshot (snapshot matches the dropped live schema) ──")
{
  const snap = readFileSync(join("scripts", "schema-snapshot.ts"), "utf8")
  for (const t of RETIRED) {
    check(`${t} is not declared in SCHEMA_SNAPSHOT`, !new RegExp(`\\n\\s*${t}:\\s*\\[`).test(snap))
  }
}

console.log("\n── the retirement is codified + documented ──")
{
  const mig = (() => { try { return readFileSync(join("scripts", "L60-S02-retire-legacy-dead-tables.sql"), "utf8") } catch { return "" } })()
  check("a DROP migration codifies the retirement", RETIRED.every((t) => mig.includes(`DROP TABLE IF EXISTS ${t}`)))
  const reg = readFileSync(join("lib", "kernel", "manager-registry.ts"), "utf8")
  check("a legacy_tables_retired burn domain records it", reg.includes("legacy_tables_retired:"))
  check("the retired tables no longer carry a TABLE_MANAGER ownership row",
    !/\n\s*agent_courses:\s*"/.test(reg) && !/\n\s*training_courses:\s*"/.test(reg) && !/\n\s*commission_records:\s*"/.test(reg))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ LEGACY_TABLES_RETIRED_FAIL"); process.exit(1) }
console.log(" ✅ LEGACY_TABLES_RETIRED_PASS — the dead training/commission spine stays retired; drift cannot silently return")
