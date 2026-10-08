#!/usr/bin/env tsx
/**
 * scripts/swallowed-refusal-census.ts   (npm run test:swallowed-refusal-census) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REFUSAL NOBODY READ — ON EVERY TABLE, NOT TWELVE.
 *
 * CLAUDE.md §3's first trap: supabase-js RESOLVES a refusal. RLS, a CHECK, a
 * NOT NULL, an FK (23503), an absent column (PGRST204 — the WHOLE row refused)
 * all come back as `{ error }`, never as a throw. So
 *
 *     await svc.from("x").update(patch).eq("id", id)
 *
 * with the result dropped cannot tell success from refusal, and the function
 * around it goes on to report success.
 *
 * ── ALREADY EXISTED — REUSED, NOT REBUILT ───────────────────────────────────
 *   · scripts/silent-write-guard.ts owns the DETECTOR (`splitStatements`,
 *     `silentWritesIn` — per-write windowing, the builder shape, bestEffort /
 *     sentinelWrite as declarations, `.catch(() => {})` as a swallow) and holds
 *     its 12 CONSEQUENTIAL_TABLES at ZERO. It is imported here in library mode;
 *     no second regex exists (§6).
 *   · scripts/notification-fanout-simulator.ts reuses the same detector over the
 *     four notification tables.
 *   · scripts/runtime-roots.ts `runtimeFiles` is the corpus; scripts/live-tables.ts
 *     `LIVE_TABLES` is the table list (a phantom table is schema-drift's finding,
 *     not this one's); scripts/strip-comments.ts reads every file (a tombstone
 *     naming an old write is not a write).
 *
 * ── WHAT THIS ADDS — THE TWO BLIND SPOTS OF THOSE TWO ───────────────────────
 *   1. TABLES. The guard judges 12 tables and the simulator 4. Every other live
 *      table was unjudged: a refused write to it was invisible to every census.
 *   2. FILES. The guard's corpus is app/actions + app/api + lib + root files,
 *      .ts only. A "use server" module elsewhere under app/ (app/dashboard/**
 *      /actions.ts), and every .tsx server component or client that writes,
 *      were outside it. This census reads EVERY runtime file. A .tsx file is
 *      judged as ONE chunk (the detector's per-write window was built for
 *      whole-file chunks — a semicolon-free module already is one) because
 *      splitStatements is not JSX-aware and an apostrophe in JSX text would
 *      desynchronise it.
 *
 * ── RATCHET ─────────────────────────────────────────────────────────────────
 * scripts/swallowed-refusal-baseline.json freezes "file → table" counts. A NEW
 * site, or a site that grows, fails. A shrink prints a tighten hint. The debt is
 * the census's point: a site in it is a write whose refusal nobody reads. Fix it
 * by READING the error (destructure and act), or DECLARE it allowed to fail with
 * bestEffort (user client) / sentinelWrite (service client) and a reason.
 * Refreeze: SWALLOWED_REFUSAL_BASELINE=1 npx tsx scripts/swallowed-refusal-census.ts
 *
 * ── BLIND SPOTS, PUBLISHED BESIDE THE NUMBER (§2) ───────────────────────────
 *   · `.rpc()` writes are not judged (no table name at the call site).
 *   · A write whose table name is not a string literal (`.from(table)`) is not
 *     judged; the count of such dynamic `.from(` sites is printed.
 *   · "Read the error" is syntactic: `const { error } = await …` followed by
 *     never branching on `error` still counts as read. The census sees a DROPPED
 *     result, not an IGNORED binding.
 *   · A DELETE/UPDATE that MATCHES NOTHING resolves with error null (§3's second
 *     trap). Reading the error does not see it; only `.select()` + a count does.
 *     This census does not judge row counts.
 *   · Storage (`.storage.from(…)`) is a different client and not judged.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { runtimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"
import { LIVE_TABLES } from "./live-tables"

process.env.SILENT_WRITE_AS_LIBRARY = "1"
const sw = await import("./silent-write-guard")
const { splitStatements, silentWritesIn, silentWriteSitesIn, CONSEQUENTIAL_TABLES } = sw
const nf = { NOTIFICATION_TABLES: ["notifications", "notification_log", "push_notification_queue", "email_queue"] as const }

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}

/** Every live table — the detector's allow-list, widened from 12 to all. */
const ALL_TABLES: readonly string[] = LIVE_TABLES

/** PURE — the swallowed-refusal sites in one file's source, as table names (one per site). */
function swallowedIn(path: string, raw: string, tables: readonly string[] = ALL_TABLES): string[] {
  return swallowedSitesIn(path, raw, tables).map((s) => s.table)
}

/** PURE — the same sites with their 1-based LINE (stripComments keeps line numbers). */
function swallowedSitesIn(path: string, raw: string, tables: readonly string[] = ALL_TABLES): Array<{ table: string; line: number }> {
  const src = stripComments(raw)
  // splitStatements keeps every character, so the chunks concatenate back to src
  // and a running offset maps a chunk-relative index to a file position.
  const chunks = path.endsWith(".tsx") ? [src] : splitStatements(src)
  const out: Array<{ table: string; line: number }> = []
  let offset = 0
  for (const chunk of chunks) {
    for (const s of silentWriteSitesIn(chunk, tables)) {
      out.push({ table: s.table, line: src.slice(0, offset + s.at).split("\n").length })
    }
    offset += chunk.length
  }
  return out
}

/** PURE — the ratchet: every site whose count exceeds its frozen allowance (a new site's allowance is 0). */
function grewOver(found: Map<string, number>, baseline: Record<string, number>): string[] {
  const out: string[] = []
  for (const [k, n] of found) if (n > (baseline[k] ?? 0)) out.push(`${k} — ${n} (baseline ${baseline[k] ?? 0})`)
  return out
}

console.log("══════════════════════════════════════════════════")
console.log(" Swallowed-refusal census (a write whose { error } nobody reads, on EVERY table)")
console.log("══════════════════════════════════════════════════")

console.log("\n[positive controls — the finder still sees the defect before any number is trusted]")
{
  check("PC1 a dropped update on a NON-consequential table is found (the guard's 12-table list would not see it)",
    swallowedIn("lib/x.ts", `await svc.from("tasks").update({ status: "done" }).eq("id", id)`).join() === "tasks"
    && silentWritesIn(`await svc.from("tasks").update({ status: "done" }).eq("id", id)`).length === 0)
  check("PC2 the same write with its error destructured is NOT found",
    swallowedIn("lib/x.ts", `const { error } = await svc.from("tasks").update({ status: "done" }).eq("id", id)`).length === 0)
  check("PC3 a DECLARED best-effort write is not found; a `.catch(() => {})` swallow IS",
    swallowedIn("lib/x.ts", `await bestEffort(svc.from("tasks").insert(row), "echo")`).length === 0
    && swallowedIn("lib/x.ts", `const r = await svc.from("tasks").insert(row).catch(() => {})`).join() === "tasks")
  check("PC4 a TOMBSTONE naming an old dropped write is not a write (§2)",
    swallowedIn("lib/x.ts", `// was: await svc.from("tasks").update(p).eq("id", i)\nexport const n = 1`).length === 0)
  check("PC5 a .tsx file is judged whole — a JSX apostrophe before the write does not blind it",
    swallowedIn("app/x/page.tsx", `const A = () => <p>Don't stop</p>\nasync function f() { await svc.from("tasks").delete().eq("id", i) }`).join() === "tasks")
  check("PC6 a PHANTOM table (not in LIVE_TABLES) is not this census's finding — schema-drift owns it",
    swallowedIn("lib/x.ts", `await svc.from("no_such_table_87e").insert(row)`).length === 0)
  check("PC7 a READ with its result dropped is not a swallowed write",
    swallowedIn("lib/x.ts", `await svc.from("tasks").select("id").eq("id", i)`).length === 0)
  check("PC8 the table list is the LIVE list, not a hand list (and it is non-trivially large)",
    ALL_TABLES.length > 300 && ALL_TABLES.includes("tasks") && ALL_TABLES.includes("contacts"),
    `${ALL_TABLES.length} live tables`)
  check("PC9 the reported LINE is the write's own line (stripComments keeps line numbers; chunk offsets add up)",
    JSON.stringify(swallowedSitesIn("lib/x.ts", `// header\nconst a = 1;\nconst b = 2;\nawait svc.from("tasks").insert(row)`)) === JSON.stringify([{ table: "tasks", line: 4 }]))
  check("PC10 the ratchet reports a NEW site and a GROWN site, and passes an unchanged or shrunk one",
    grewOver(new Map([["a.ts → tasks", 1], ["b.ts → leads", 3]]), { "b.ts → leads": 2 }).length === 2
    && grewOver(new Map([["b.ts → leads", 1]]), { "b.ts → leads": 2 }).length === 0)
  // ── lane 88F — the ~30 over-reported sites were FINDER blind spots, fixed in the
  //    one detector (silent-write-guard.ts "THE STRUCTURAL SHAPES"). Each accept is
  //    paired with the reject that must still fire, in a .tsx whole-file chunk too.
  check("PC11 a TERNARY ARM bound to `{ error }` is read; the same ternary bound to `{ data }` is still found (×2 arms)",
    swallowedIn("lib/x.ts", `const { error } = row\n  ? await svc.from("tasks").update(p).eq("id", i)\n  : await svc.from("tasks").insert(r)\nif (error) throw error`).length === 0
    && swallowedIn("lib/x.ts", `const { data } = row\n  ? await svc.from("tasks").update(p).eq("id", i)\n  : await svc.from("tasks").insert(r)`).join() === "tasks,tasks")
  check("PC12 a ternary bound to a NAME counts only when `name.error` is read",
    swallowedIn("lib/x.ts", `const write = row ? await svc.from("tasks").update(p).eq("id", i) : await svc.from("tasks").insert(r)\nif (write.error) return`).length === 0
    && swallowedIn("lib/x.ts", `const write = row ? await svc.from("tasks").update(p).eq("id", i) : await svc.from("tasks").insert(r)\nreturn write.data`).length === 2)
  check("PC13 a BUILDER awaited through a wrapper (`await applyTenantScope(q, s)`) counts only with `{ error }`",
    swallowedIn("lib/x.ts", `let q = svc.from("tasks").update(p).eq("id", i)\nconst { data, error } = await applyTenantScope(q, scope).select("id")`).length === 0
    && swallowedIn("lib/x.ts", `let q = svc.from("tasks").update(p).eq("id", i)\nawait applyTenantScope(q, scope)`).join() === "tasks")
  check("PC14 a Promise.all ELEMENT counts only when ITS OWN slot's error is read (in a .tsx whole-file chunk)",
    swallowedIn("app/x/c.tsx", `const A = () => <p>Don't</p>\nasync function f() {\n  const [a, b] = await Promise.all([\n    s.from("tasks").upsert(x),\n    s.from("leads").upsert(y),\n  ])\n  if (a.error) return\n}`).join() === "leads")
  check("PC15 a .map ARROW counts only when the awaited results are searched for `error`; a `;({ data } = await …)` reassignment is still found",
    swallowedIn("lib/x.ts", `const ups = ids.map((id, n) =>\n  s.from("tasks").update({ n }).eq("id", id))\nconst results = await Promise.all(ups)\nif (results.find((r) => r.error)) return`).length === 0
    && swallowedIn("lib/x.ts", `const ups = ids.map((id) => s.from("tasks").delete().eq("id", id))\nawait Promise.all(ups)`).join() === "tasks"
    && swallowedIn("lib/x.ts", `;({ data } = await s.from("tasks").update(p).eq("id", i))`).join() === "tasks")
}

const SITES = process.argv.includes("--sites")
console.log("\n[repo scan — every runtime file]")
const files = runtimeFiles(".").map((p) => p.replace(/^\.\//, "")).filter((p) => /\.(ts|tsx)$/.test(p)).sort()
const found = new Map<string, number>() // "file → table" → count
let dynamicFrom = 0
let writeSites = 0
for (const f of files) {
  const raw = readFileSync(f, "utf8")
  const code = stripComments(raw)
  dynamicFrom += (code.match(/\.from\(\s*[A-Za-z_$][\w$.]*\s*\)/g) ?? []).length
  writeSites += (code.match(/\.(insert|update|upsert|delete)\s*\(/g) ?? []).length
  for (const site of swallowedSitesIn(f, raw)) {
    const key = `${f} → ${site.table}`
    found.set(key, (found.get(key) ?? 0) + 1)
    if (SITES) console.log(`     ${f}:${site.line} ${site.table}`)
  }
}
const total = [...found.values()].reduce((a, b) => a + b, 0)
const byOwner = { consequential: 0, notification: 0, other: 0 }
const byTable = new Map<string, number>()
const byRoot = new Map<string, number>()
for (const [k, n] of found) {
  const [file, table] = k.split(" → ")
  if ((CONSEQUENTIAL_TABLES as readonly string[]).includes(table)) byOwner.consequential += n
  else if ((nf.NOTIFICATION_TABLES as readonly string[]).includes(table)) byOwner.notification += n
  else byOwner.other += n
  byTable.set(table, (byTable.get(table) ?? 0) + n)
  const root = file.split("/").slice(0, 2).join("/")
  byRoot.set(root, (byRoot.get(root) ?? 0) + n)
}
console.log(`  · corpus: ${files.length} runtime files (${files.filter((f) => f.endsWith(".tsx")).length} .tsx) · ${ALL_TABLES.length} live tables`)
console.log(`  · denominator: ${writeSites} .insert/.update/.upsert/.delete( call sites (all clients, all tables)`)
console.log(`  · BLIND SPOT: ${dynamicFrom} .from(<identifier>) site(s) with a non-literal table — not judged`)
console.log(`  · ${total} swallowed-refusal write(s) across ${found.size} file→table site(s)`)
console.log(`      consequential tables (silent-write-guard's set): ${byOwner.consequential} · notification tables: ${byOwner.notification} · every other table: ${byOwner.other}`)
console.log(`  · top tables: ${[...byTable].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t} ${n}`).join(" · ")}`)
console.log(`  · by root: ${[...byRoot].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t} ${n}`).join(" · ")}`)
if (process.argv.includes("--list")) {
  for (const k of [...found.keys()].sort()) console.log(`     ${k}${found.get(k)! > 1 ? ` ×${found.get(k)}` : ""}`)
}

const baselinePath = join(process.cwd(), "scripts", "swallowed-refusal-baseline.json")
const baseline: Record<string, number> = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {}
if (process.env.SWALLOWED_REFUSAL_BASELINE === "1") {
  const snap: Record<string, number> = {}
  for (const k of [...found.keys()].sort()) snap[k] = found.get(k)!
  writeFileSync(baselinePath, `${JSON.stringify(snap, null, 2)}\n`)
  console.log(`Baseline written: ${found.size} site(s), ${total} swallowed refusal(s) frozen (may only shrink)`)
  process.exit(0)
}
const grew = grewOver(found, baseline)
const burned = Object.keys(baseline).filter((k) => (found.get(k) ?? 0) < baseline[k])
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0)
console.log(`  · frozen debt ${baselineTotal}`)
if (burned.length > 0) console.log(`  ↓ ${burned.length} site(s) improved — tighten with SWALLOWED_REFUSAL_BASELINE=1`)
check(`no NEW swallowed refusal on any live table (${grew.length} new)`, grew.length === 0, grew.slice(0, 10).join(" | "))
check("the consequential tables stay at ZERO in the WIDER corpus too (silent-write-guard's invariant, beyond its roots)",
  byOwner.consequential === 0, [...found.keys()].filter((k) => (CONSEQUENTIAL_TABLES as readonly string[]).includes(k.split(" → ")[1])).slice(0, 8).join(" | "))

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SWALLOWED_REFUSAL_FAIL"); process.exit(1) }
console.log(` ✅ SWALLOWED_REFUSAL_PASS — no NEW swallowed refusal (${total} on the burn-down list)`)
