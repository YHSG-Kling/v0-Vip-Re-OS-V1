/**
 * scripts/sequence-counters-simulator.ts
 *
 * test:sequence-counters — EVERY ROLLED-UP SEQUENCE COUNTER THE UI RENDERS HAS A REAL WRITER.
 *
 * Wave 84E (sequence-reports open loop). campaign_sequences.completions_total was read by
 * the sequences list and the lifetime gifting panel and written exactly once — `0` at
 * creation — with no rpc and no trigger (live, 2026-09-26). enrollments_total was bumped by
 * three of seven enrollment writers. lib/campaign-sequences/sequence-counters.ts reconciles
 * both from sequence_enrollments on the daily marketing-attribution-engine cron.
 *
 * RULES (derived, never a waypoint):
 *   R1. Every campaign_sequences column named `*_total` (read from the generated schema
 *       snapshot, not listed here) that app/ lib/ READ has at least one NON-CONSTANT writer:
 *       a computed value in code, or an rpc whose migration body sets it. A column whose
 *       only writes are numeric literals is a permanent zero in the typeface of a count.
 *   R2. The reconciliation is mounted on a scheduled cron (lib/kernel/cron-dispatch.ts).
 *   R3. The pure tally counts a completion by the SAME rule workflow-reports uses
 *       (unenrolled stamps completed_at and is NOT a completion).
 *   R4. The rollup writes only drifted rows, counts updates via .select(), reports an
 *       unmatched update and a refused read by name (§3) — run against a fake client.
 * Positive controls: the base shape (completions_total written only as `0`) is flagged by R1;
 * a tally that counted `unenrolled` would be caught by R3; a refused read is not "0 updated".
 * Blind spots: R1 reads code text — a writer inside a DB trigger defined outside
 * supabase/migrations/ would be missed (the live read found none); counters are
 * brokerage-agnostic sums of one sequence's own enrollments.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { isSequenceCompletion, tallySequenceCounters, rollupSequenceCounters } from "../lib/campaign-sequences/sequence-counters"

let pass = 0
let fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? `\n      ${d}` : ""}`) }
}
const read = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

function walk(dir: string, out: string[]) {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".d.ts")) out.push(p)
  }
}

/** Writes of `col`: `col: <value>` INSIDE the argument of an .insert( / .update( / .upsert(
 *  call — a type annotation (`completions_total: number`) or a UI object is not a write. */
export function writeValues(code: string, col: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\.(insert|update|upsert)\s*\(/g)) {
    const open = m.index! + m[0].length - 1
    let d = 0, end = open
    for (let i = open; i < code.length; i++) {
      if (code[i] === "(") d++
      else if (code[i] === ")") { d--; if (d === 0) { end = i; break } }
    }
    const arg = code.slice(open, end + 1)
    for (const w of arg.matchAll(new RegExp(`\\b${col}\\s*:\\s*([^,}\\n]+)`, "g"))) out.push(w[1].trim())
  }
  return out
}
/** Reads of `col`: `.col` property access or a select-list mention. */
export function isRead(code: string, col: string): boolean {
  return new RegExp(`\\.${col}\\b`).test(code) || new RegExp(`select\\([^)]*\\b${col}\\b`).test(code)
}
const isConstant = (v: string) => /^-?\d+(\.\d+)?$/.test(v) || v === "null"

console.log("\n── R1: every *_total counter the code reads has a non-constant writer ──")
const cols = ((SCHEMA_SNAPSHOT as Record<string, readonly string[]>).campaign_sequences ?? []).filter((c) => /_total$/.test(c))
check(`campaign_sequences counters derived from the snapshot: ${cols.join(", ")}`, cols.length > 0)
const files: string[] = []
for (const r of ["app", "lib"]) walk(join(process.cwd(), r), files)
const code = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n")
const migrations = existsSync(join(process.cwd(), "supabase/migrations"))
  ? readdirSync(join(process.cwd(), "supabase/migrations")).filter((f) => f.endsWith(".sql")).map((f) => read(`supabase/migrations/${f}`)).join("\n")
  : ""
function counterVerdict(src: string, sql: string, col: string): { read: boolean; dynamic: string[]; viaRpc: boolean } {
  const dynamic = writeValues(src, col).filter((v) => !isConstant(v))
  const rpcs = [...src.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1])
  const viaRpc = rpcs.some((fn) => new RegExp(`FUNCTION\\s+(public\\.)?${fn}\\b[\\s\\S]{0,1500}?SET\\s+${col}\\s*=`, "i").test(sql))
  return { read: isRead(src, col), dynamic, viaRpc }
}
for (const col of cols) {
  const v = counterVerdict(code, migrations, col)
  if (!v.read) { check(`${col}: not read by app/ lib/ (out of scope)`, true); continue }
  check(`${col}: read, and written by a non-constant writer (${v.dynamic.length} computed write(s)${v.viaRpc ? " + an rpc" : ""})`,
    v.dynamic.length > 0 || v.viaRpc)
}
check("POSITIVE CONTROL: a counter written only as a literal `0` at creation is flagged",
  (() => { const v = counterVerdict(`interface S { completions_total: number }\ns.from("t").insert({ completions_total: 0 }); x.completions_total`, "", "completions_total"); return v.read && v.dynamic.length === 0 && !v.viaRpc })())
check("POSITIVE CONTROL: a computed value inside .update( IS a writer",
  counterVerdict(`s.from("t").update({ completions_total: t.completions }).eq("id", x); y.completions_total`, "", "completions_total").dynamic.length === 1)
check("POSITIVE CONTROL: an rpc whose migration body SETs the counter counts as a writer",
  counterVerdict(`x.enrollments_total; await s.rpc("increment_sequence_enrollments", {})`,
    "CREATE OR REPLACE FUNCTION increment_sequence_enrollments(seq_id uuid) RETURNS void AS $$ UPDATE campaign_sequences SET enrollments_total = COALESCE(enrollments_total,0)+1 $$", "enrollments_total").viaRpc)

console.log("\n── R2: the reconciliation rides a scheduled cron ──")
{
  const route = stripComments(read("app/api/cron/marketing-attribution-engine/route.ts"))
  check("marketing-attribution-engine awaits rollupSequenceCounters and reports it in the summary",
    /await rollupSequenceCounters\(svc\)/.test(route) && /sequence_counters:\s*sequenceCounters/.test(route))
  check("…and that cron is scheduled in CRON_REGISTRY",
    /path:\s*"\/api\/cron\/marketing-attribution-engine"/.test(stripComments(read("lib/kernel/cron-dispatch.ts"))))
}

console.log("\n── R3: a completion is a finish, never a pull-out ──")
{
  check("completed → completion", isSequenceCompletion({ status: "completed", completed_at: "2026-09-01" }))
  check("converted after finishing (completed_at kept) → completion", isSequenceCompletion({ status: "converted", completed_at: "2026-09-01" }))
  check("converted mid-run (no completed_at) → not a completion", !isSequenceCompletion({ status: "converted", completed_at: null }))
  check("POSITIVE CONTROL: unenrolled (completed_at stamped by unenrollContact) → NOT a completion",
    !isSequenceCompletion({ status: "unenrolled", completed_at: "2026-09-01" }))
  const t = tallySequenceCounters([
    { sequence_id: "s1", status: "active", completed_at: null },
    { sequence_id: "s1", status: "completed", completed_at: "x" },
    { sequence_id: "s1", status: "unenrolled", completed_at: "x" },
    { sequence_id: "s2", status: "converted", completed_at: "x" },
  ])
  check("tally: s1 = 3 enrolled / 1 completed, s2 = 1 / 1",
    t.get("s1")?.enrollments === 3 && t.get("s1")?.completions === 1 && t.get("s2")?.enrollments === 1 && t.get("s2")?.completions === 1)
  const wr = stripComments(read("app/actions/workflow-reports.ts"))
  check("workflow-reports' average completion uses the same finish rule (status completed)",
    /filter\(e => e\.status === "completed" && e\.completed_at/.test(wr))
}

console.log("\n── R4: the rollup against a fake client — drift only, counted, refusals by name ──")
type Row = Record<string, unknown>
function fakeSvc(tables: Record<string, Row[]>, opts: { refuse?: string; unmatch?: boolean } = {}) {
  const updates: Array<{ id: string; patch: Row }> = []
  const from = (table: string) => {
    const q: any = {
      _table: table, _patch: null as Row | null, _id: null as string | null,
      select() { return q }, order() { return q },
      range(a: number, b: number) {
        if (opts.refuse === table) return Promise.resolve({ data: null, error: { message: `${table} refused` } })
        return Promise.resolve({ data: (tables[table] ?? []).slice(a, b + 1), error: null })
      },
      update(p: Row) { q._patch = p; return q },
      eq(_c: string, v: string) { q._id = v; return q },
      then(res: (v: unknown) => void) {
        if (q._patch) {
          if (opts.unmatch) return res({ data: [], error: null })
          updates.push({ id: q._id!, patch: q._patch })
          return res({ data: [{ id: q._id }], error: null })
        }
        return res({ data: [], error: null })
      },
    }
    return q
  }
  return { svc: { from } as any, updates }
}
{
  const tables = {
    campaign_sequences: [
      { id: "s1", enrollments_total: 1, completions_total: 0 },  // drifted
      { id: "s2", enrollments_total: 1, completions_total: 1 },  // already right
      { id: "s3", enrollments_total: 0, completions_total: 0 },  // no enrollments, right
    ],
    sequence_enrollments: [
      { sequence_id: "s1", status: "completed", completed_at: "x" },
      { sequence_id: "s1", status: "active", completed_at: null },
      { sequence_id: "s2", status: "completed", completed_at: "x" },
    ],
  }
  const a = fakeSvc(tables)
  const r = await rollupSequenceCounters(a.svc)
  check(`reads every sequence and enrollment (${r.sequencesRead} / ${r.enrollmentsRead})`, r.sequencesRead === 3 && r.enrollmentsRead === 3)
  check("writes ONLY the drifted row, with the recomputed pair",
    r.updated === 1 && r.unchanged === 2 && a.updates.length === 1 && a.updates[0].id === "s1"
    && a.updates[0].patch.enrollments_total === 2 && a.updates[0].patch.completions_total === 1)
  const b = fakeSvc(tables, { unmatch: true })
  const rb = await rollupSequenceCounters(b.svc)
  check("POSITIVE CONTROL: an update that matches 0 rows is counted unmatched, never updated", rb.unmatched === 1 && rb.updated === 0)
  const c = fakeSvc(tables, { refuse: "sequence_enrollments" })
  const rc = await rollupSequenceCounters(c.svc)
  check("POSITIVE CONTROL: a refused enrollment read is reported by name and writes nothing",
    !!rc.refused.sequence_enrollments && rc.updated === 0 && c.updates.length === 0)
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ SEQUENCE_COUNTERS_FAIL"); process.exit(1) }
console.log(" ✅ SEQUENCE_COUNTERS_PASS — every sequence counter the UI renders has a real writer, reconciled daily")
