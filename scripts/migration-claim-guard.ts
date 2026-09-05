#!/usr/bin/env tsx
/**
 * scripts/migration-claim-guard.ts   (npm run test:migration-claim)
 * ─────────────────────────────────────────────────────────────────────────────
 * A MIGRATION FILE MAKES A CLAIM ABOUT ITSELF. THIS CHECKS THE CLAIM.
 *
 * ── THE FINDING THAT MADE THIS EXIST (2026-09-04) ───────────────────────────
 *
 * TWENTY files in supabase/migrations carried a header saying they had NEVER
 * BEEN APPLIED. Every single one had been. Measured against the project's own
 * ledger, `supabase_migrations.schema_migrations`:
 *
 *   m498 m502 m508 m509 m511 m523 m524 m535 m536 m538
 *   m539 m570 m571 m572 m573 m575 m576 m577 m586 m587      → 20 of 20 in the ledger
 *
 * SEVEN MAINTENANCE_DOMAINS entries in lib/kernel/manager-registry.ts repeated
 * those claims in prose ("m575, WRITTEN not applied", "m530 is written and NOT
 * applied", …), and the registry is where a reader goes to find out what is
 * still open. So the repo's own record said twenty defects were outstanding
 * when every one was closed. The cost of that is not cosmetic: the next wave
 * either re-applies an applied migration or designs around a defect that no
 * longer exists, and both are expensive ways to learn the record was stale.
 *
 * NOBODY DID ANYTHING WRONG AT THE TIME. CLAUDE.md §3 says "a migration that
 * exists as a .sql file has not been applied", and a lane writing a migration
 * correctly writes that header. The gap is that nothing ever came back and
 * flipped it, and no check could tell.
 *
 * ── THE ASYMMETRY, STATED FIRST BECAUSE IT IS THE WHOLE DESIGN ──────────────
 *
 * The ledger is EVIDENCE IN ONE DIRECTION ONLY:
 *
 *   PRESENT in the ledger  →  the migration RAN. Certain.
 *   ABSENT from the ledger →  NOTHING follows.
 *
 * Absence proves nothing because the ledger records only what was applied
 * through the migration tool. Measured the same day: m599 and m602, m603, m604
 * and m605 are all applied and NONE of them is in the ledger, because they were
 * executed as direct SQL. A guard that read absence as "not applied" would
 * therefore accuse five correct migrations and would be exactly the shape
 * CLAUDE.md §2 forbids — a check that cannot see what it judges.
 *
 * So this guard only ever fails a file in the direction the evidence supports:
 * a file claiming NOT APPLIED that the ledger positively vouches for. It never
 * fails a file for being absent.
 *
 * ── WHAT IT CHECKS, IN TWO LAYERS ───────────────────────────────────────────
 *
 * OFFLINE (always runs, no credentials):
 *   1. Every migration file states its status in ONE of the two recognised
 *      forms, or states nothing at all — never both at once. A file that says
 *      both "APPLIED LIVE" and "NOT APPLIED" is a record nobody can read.
 *   2. The manager registry does not claim a migration is un-applied while that
 *      migration's own file says it IS applied. Two records in this repo,
 *      disagreeing about the same fact, is catchable without a database.
 *   3. A RATCHET on the count of files claiming NOT APPLIED. That list is real
 *      work-in-flight and it may only SHRINK. A new entry is fine — a lane
 *      wrote a migration — but it must be deliberate, so it lands as a
 *      baseline bump a human writes down.
 *
 * LIVE (only with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
 *   4. No file claiming NOT APPLIED appears in the ledger. This is the check
 *      that would have caught all twenty, and it is the only one that can.
 *
 * A SKIP IS NOT A PASS. When the live layer cannot run, that is printed as a
 * BLIND SPOT beside the result rather than folded into the pass count.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, "supabase", "migrations")

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

/**
 * A migration's stated status, read from its header.
 *
 * THE HEADER ONLY. A migration body legitimately contains the words "not
 * applied" inside an explanatory paragraph about some OTHER migration — the
 * whole reason this repo writes long headers — so a whole-file scan would
 * report prose as a claim. 3000 characters is the measured header budget: the
 * longest real status banner in this tree is under 2200.
 */
const HEADER_BYTES = 3000

type Claim = "applied" | "not_applied" | "unstated" | "both"

function claimOf(sql: string): Claim {
  const head = sql.slice(0, HEADER_BYTES)
  // The stale-banner this wave added says BOTH things on purpose — it exists to
  // say "the claim below is wrong" — so it is recognised as a single
  // `applied` claim rather than read as a contradiction.
  if (/THE "NOT APPLIED" CLAIM BELOW IS STALE/.test(head)) return "applied"
  // THE RECOGNISER MUST SEE EVERY SPELLING THE TREE ACTUALLY USES (§2, §6).
  // It began as /APPLIED LIVE|✅ APPLIED/, the two banner forms this guard's own
  // wave had written — and a recogniser scoped to the forms its author happened
  // to write is blind by construction. m601 states its status as
  //   "APPLIED 2026-09-03 by the integrator (MCP apply_migration; postflight: …)"
  // with no "LIVE" and no ✅, so this returned "unstated" and layer 2 could not
  // adjudicate it. The result was the worst possible reading: a guard script said
  // "m601 is WRITTEN, NOT APPLIED" while the migration's own header said applied
  // and the database agreed (verified live 2026-09-05 — 33 remotion_compositions,
  // 14 with requires_voiceover, exactly the postflight the header records), and
  // this guard reported no contradiction because it could not read one side.
  // The third alternative is APPLIED followed by a date, and the `(?!\s*LIVE)`
  // is not needed — "APPLIED LIVE" already matches the first branch.
  // \bNOT APPLIED\b is checked separately below and wins ties via the "both" case,
  // so a header saying "NOT APPLIED" can never be mistaken for one of these.
  const saysApplied = /APPLIED LIVE|✅\s*APPLIED|(?<!NOT )\bAPPLIED\s+\d{4}-\d{2}-\d{2}\b/i.test(head)
  const saysNot = /\bNOT APPLIED\b/i.test(head)
  if (saysApplied && saysNot) return "both"
  if (saysApplied) return "applied"
  if (saysNot) return "not_applied"
  return "unstated"
}

/** `m575-some-slug.sql` → `m575`. Files without an m-prefix are not m-numbered. */
function prefixOf(file: string): string | null {
  const m = file.match(/^(m\d+[a-z]?)-/)
  return m ? m[1] : null
}

console.log("\n══════════════════════════════════════════════════════════")
console.log(" Migration claim guard — does a migration's header tell the truth?")
console.log("══════════════════════════════════════════════════════════")

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
const claims = new Map<string, Claim>()
for (const f of files) claims.set(f, claimOf(readFileSync(join(MIGRATIONS, f), "utf8")))

const applied = files.filter((f) => claims.get(f) === "applied")
const notApplied = files.filter((f) => claims.get(f) === "not_applied")
const unstated = files.filter((f) => claims.get(f) === "unstated")
const both = files.filter((f) => claims.get(f) === "both")

console.log(`\n[census]`)
console.log(`  ${files.length} migration files · applied ${applied.length} · NOT APPLIED ${notApplied.length} · unstated ${unstated.length} · self-contradictory ${both.length}`)
console.log(`  BLIND SPOT: "unstated" is the overwhelming majority and this guard says NOTHING about those.`)
console.log(`  A file that makes no claim cannot make a false one; requiring a banner on all ${files.length}`)
console.log(`  would be churn, not measurement.`)

// ── 1 · No file contradicts itself ─────────────────────────────────────────
console.log("\n[1 · a file states its status one way, or not at all]")
check(`no migration header claims BOTH applied and not-applied (${both.length})`,
  both.length === 0, both.join(", "))

// ── 2 · Every PROSE claim in the repo agrees with the migration's own file ──
//
// The claim is read comment-stripped from .ts files whose payload is string
// literals; blankStrings is deliberately NOT used, because here the string
// literals ARE the payload.
//
// THE CORPUS IS WIDER THAN THE REGISTRY, AND IT HAD TO BECOME SO (2026-09-05).
// This layer originally read exactly one file — lib/kernel/manager-registry.ts —
// because that was where the twenty stale claims had been found. Scoping a
// finder to the place a defect was last seen is how the next instance survives:
// on 2026-09-05 `scripts/writerless-arrivals-simulator.ts:583` was printing
// "m515 is written and NOT applied" in its published blind-spot block, and m515
// had in fact landed (verified live: idx_comp_risk_flags_open and
// idx_compliance_alerts_open both present in pg_indexes). A GUARD'S OWN OUTPUT
// is exactly where a stale claim does the most damage, because a blind-spot
// note is what the next reader trusts when the number looks clean.
//
// So the corpus is now every .ts under scripts/ and lib/kernel/ — the two places
// this repo keeps its record of what is still open. Migration FILES are excluded
// (layer 1 already adjudicates those, and their headers legitimately discuss
// other migrations' status in prose).
console.log("\n[2 · no prose claim in the repo contradicts a migration's own file]")
const CLAIM_NOT_APPLIED_A = /\b(m\d+[a-z]?)\b[^.]{0,80}?\b(?:is\s+)?(?:WRITTEN|written)[,\s]+(?:and\s+)?(?:NOT|not)\s+(?:APPLIED|applied)/g
const CLAIM_NOT_APPLIED_B = /\b(m\d+[a-z]?)\b[^.]{0,40}?\((?:WRITTEN|written)[,\s]+(?:NOT|not)\s+(?:APPLIED|applied)\)/g

function claimCorpus(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p)
    }
  }
  walk(join(ROOT, "scripts"))
  walk(join(ROOT, "lib", "kernel"))
  return out
}

const appliedPrefixes = new Set(applied.map(prefixOf).filter(Boolean) as string[])
// migration -> the files claiming it un-applied
const proseClaims = new Map<string, string[]>()
for (const file of claimCorpus()) {
  // This guard's OWN header quotes both claim shapes as specimens. Reading it
  // would make the guard accuse itself forever — a tombstone is not a call site
  // (§2), and neither is a documented specimen.
  if (file.endsWith("migration-claim-guard.ts")) continue
  const src = stripComments(readFileSync(file, "utf8"))
  const rel = file.slice(ROOT.length + 1)
  for (const re of [CLAIM_NOT_APPLIED_A, CLAIM_NOT_APPLIED_B]) {
    for (const m of src.matchAll(new RegExp(re.source, "g"))) {
      const list = proseClaims.get(m[1]) ?? []
      if (!list.includes(rel)) list.push(rel)
      proseClaims.set(m[1], list)
    }
  }
}
const contradicted = [...proseClaims.keys()].filter((p) => appliedPrefixes.has(p)).sort()
console.log(`  ${claimCorpus().length} file(s) scanned · prose claims ${proseClaims.size} migration(s) un-applied: ${[...proseClaims.keys()].sort().join(", ") || "none"}`)
check(`no prose claim contradicts a migration file that says it IS applied (${contradicted.length})`,
  contradicted.length === 0,
  contradicted.length
    ? contradicted.map((p) => `${p} — the ledger vouches it RAN, but ${(proseClaims.get(p) ?? []).join(" + ")} says not`).join("; ")
    : undefined)

// ── CONTROLS ON THE STATUS RECOGNISER ITSELF ───────────────────────────────
// claimOf decides which side of layer 2 a file lands on, so a gap in it makes
// the whole layer report "no contradiction" for files it simply cannot read.
// That is exactly what happened to m601. Each spelling the tree actually uses
// gets a control, and each is paired with the near-miss it must still refuse.
check("recogniser: the banner form",            claimOf("-- ✅ APPLIED LIVE 2026-01-01 to x") === "applied")
check("recogniser: APPLIED + a date (m601's form, which it used to miss)",
  claimOf("-- APPLIED 2026-09-03 by the integrator (MCP apply_migration)") === "applied")
check("NEGATIVE CONTROL recogniser: NOT APPLIED is never read as applied",
  claimOf("-- WRITTEN, NOT APPLIED — the integrator applies it") === "not_applied")
check("NEGATIVE CONTROL recogniser: 'not applied 2026-09-03' does not slip through the dated form",
  claimOf("-- this is NOT APPLIED 2026-09-03") === "not_applied")
check("NEGATIVE CONTROL recogniser: a header stating nothing stays unstated",
  claimOf("-- m999 adds a column and an index") === "unstated")
check("NEGATIVE CONTROL recogniser: saying both at once is still 'both', not a silent pick",
  claimOf("-- ✅ APPLIED LIVE … and also NOT APPLIED") === "both")

// POSITIVE CONTROL — a finder that matched nothing would pass layer 2 vacuously.
check("POSITIVE CONTROL — the claim-finder recognises the shape it hunts",
  /\b(m\d+[a-z]?)\b[^.]{0,80}?\b(?:is\s+)?(?:WRITTEN|written)[,\s]+(?:and\s+)?(?:NOT|not)\s+(?:APPLIED|applied)/
    .test("m999 is written and NOT applied"))
check("…and the parenthesised spelling too",
  /\b(m\d+[a-z]?)\b[^.]{0,40}?\((?:WRITTEN|written)[,\s]+(?:NOT|not)\s+(?:APPLIED|applied)\)/
    .test("m999 (written, not applied) adds the column"))
check("NEGATIVE CONTROL …and does NOT fire on a migration merely being mentioned",
  !/\b(m\d+[a-z]?)\b[^.]{0,80}?\b(?:is\s+)?(?:WRITTEN|written)[,\s]+(?:and\s+)?(?:NOT|not)\s+(?:APPLIED|applied)/
    .test("m999 applied the canonical CHECK and is the survivor"))

// THE CORPUS CONTROL — this is the assertion that would have caught the 2026-09-05
// miss, and it asserts the RULE (the record of what is open is searched wherever
// this repo keeps it) rather than the waypoint (a hardcoded file list). Scoping
// layer 2 to lib/kernel/manager-registry.ts alone let a stale "m515 is written
// and NOT applied" sit in a GUARD'S published blind-spot text for several waves.
{
  const corpus = claimCorpus().map((f) => f.slice(ROOT.length + 1))
  check("the claim corpus reaches BOTH places this repo records open work, not just the registry",
    corpus.some((f) => f === "lib/kernel/manager-registry.ts") &&
    corpus.some((f) => f.startsWith("scripts/")),
    `${corpus.length} files`)
  check("…and it reaches guard scripts specifically, where a stale claim reads as a clean bill of health",
    corpus.includes("scripts/writerless-arrivals-simulator.ts"))
}

// ── 3 · The un-applied list may only shrink ────────────────────────────────
//
// 20 → 0 in this wave, because all twenty were measured live and found applied.
// A NEW entry is legitimate work — a lane writing a migration the integrator has
// not run — so this is a ratchet with a written-down number, not a zero-forever
// invariant.
const NOT_APPLIED_BASELINE = 0
console.log("\n[3 · the work-in-flight list only shrinks]")
if (notApplied.length) for (const f of notApplied) console.log(`     · ${f}`)
check(`files claiming NOT APPLIED at or below ${NOT_APPLIED_BASELINE} (found ${notApplied.length})`,
  notApplied.length <= NOT_APPLIED_BASELINE,
  notApplied.length > NOT_APPLIED_BASELINE
    ? `${notApplied.length} > ${NOT_APPLIED_BASELINE} — if a lane wrote a new migration, raise the baseline deliberately and say which`
    : undefined)

// ── 4 · LIVE — the ledger is the only thing that can catch the real defect ──
console.log("\n[4 · live — no file claiming NOT APPLIED is in the migration ledger]")
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.log("  ⊘ SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.")
  console.log("    A SKIP IS NOT A PASS: this is the ONLY layer that can catch the defect")
  console.log("    this guard was written for (a header saying 'never ran' about a migration")
  console.log("    that ran). The offline layers above catch self-contradiction and")
  console.log("    registry drift, which is strictly less.")
  console.log("    To run it:")
  console.log("      select name from supabase_migrations.schema_migrations where name like 'm575\\_%';")
} else {
  const run = async () => {
    const { createClient } = await import("@supabase/supabase-js")
    const svc = createClient(url, key, { auth: { persistSession: false } })
    // The ledger lives outside the `public` schema, so PostgREST cannot reach it
    // through .from(). It is queried through the same RPC door the schema caches
    // use, or not at all — and "not at all" is reported, never assumed clean.
    const { data, error } = await svc.rpc("live_migration_ledger_json")
    if (error) {
      console.log(`  ⊘ UNAVAILABLE — the ledger RPC is absent or refused (${error.message}).`)
      console.log("    NOT scored as a pass. Create it, or run the SQL above by hand.")
      return
    }
    const names = new Set<string>((data as { name: string }[] ?? []).map((r) => r.name))
    const vouchedFor = notApplied
      .map((f) => ({ file: f, prefix: prefixOf(f) }))
      .filter((x) => x.prefix && [...names].some((n) => n.startsWith(`${x.prefix}_`)))
    for (const v of vouchedFor) console.log(`     ✗ ${v.file} — the ledger has ${v.prefix}_…, so it RAN`)
    check(`no file claiming NOT APPLIED is vouched for by the ledger (${vouchedFor.length})`,
      vouchedFor.length === 0)
    check("POSITIVE CONTROL — the ledger read returned rows (an empty read would pass the line above vacuously)",
      names.size > 0, `${names.size} ledger rows`)
  }
  await run()
}

console.log(`\n${"─".repeat(58)}`)
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ MIGRATION_CLAIM_FAIL — a migration file's claim about itself is not true")
  process.exit(1)
}
console.log(" ✅ MIGRATION_CLAIM_PASS — every migration that states its status states it once, the registry agrees, and nothing claims to be un-applied")
