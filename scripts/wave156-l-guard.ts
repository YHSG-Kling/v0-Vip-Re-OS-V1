#!/usr/bin/env tsx
/**
 * scripts/wave156-l-guard.ts — wave 156, lane 156L (canary C24): LARGER CAPABILITY WITHOUT A LARGER MONOLITH.
 *
 * The app import graph was over both ceilings of test:proxy-graph-budget (heaviest entry app/crm/page.tsx 1,307 of 1,300;
 * union of every app entry 5,306 of 5,300). The ceilings are not raised and no capability is removed: the lane cut SEAMS —
 * importers that named a re-export BARREL now name the module that DEFINES the binding, and the reaper_runs LEDGER left the
 * reaper REGISTRY — and closed one client → server-secret path the census found on the way. This guard proves, on ROOT:
 *
 * §A THE BUDGET'S OWN COUNTER. The two budgets are READ from scripts/proxy-graph-budget-guard.ts (comment-stripped), never
 *    retyped; the counts come from THE ONE walker (scripts/app-import-graph.ts). Heaviest entry ≤ entry budget, union ≤ union
 *    budget. With WAVE156L_BASE=<the tree before this lane> the five heaviest entries THERE are each LOWER here (derived, not
 *    pinned). Positive control: a synthetic tree in which a page that names one constant through a barrel reaches every
 *    sibling the barrel re-exports, and the same page naming the defining module reaches one module.
 * §B EVERY IMPORTED NAME STILL HAS AN EXPORTER. For every static `import { … } from "<first-party>"` in every module the app
 *    reaches, each VALUE name is exported by the target — locally or through its re-export chain (`export { a } from`,
 *    `export *`). A rewritten import that pointed at the wrong module would be found here. Positive control: a planted
 *    dangling import in a synthetic tree is found; a name exported only through an `export *` chain is resolved.
 *    The MOVED symbols (the names lib/intelligence/reaper-net.ts re-exports from ./reaper-runs-ledger — derived from its
 *    stripped source): each is DEFINED once, in the ledger, not in the registry; and no module imports only ledger names
 *    from the registry (a ledger-only caller importing the registry is the edge this lane cut).
 * §C THE MOVED LEDGER, DRIVEN. The real reaper-net and reaper-runs-ledger modules of ROOT are loaded (service client stubbed,
 *    counted). The registry's re-export IS the ledger's function (one binding); recordReaperRun writes exactly the reaper_runs
 *    row it always wrote, through the in-memory client (scripts/in-memory-supabase.ts); loadRecentReaperActivity aggregates
 *    per manager over the window and ignores another tenant's rows and rows outside the window.
 * §D NO CLIENT COMPONENT REACHES A SERVER-SECRET READER. From every "use client" module in the union, walked with the same
 *    walker and stopped at "use server" modules (Next replaces a server-action import with an RPC stub), no module that READS
 *    a secret environment variable (process.env.<NAME>, NAME not NEXT_PUBLIC_*, NAME containing SERVICE_ROLE / SECRET /
 *    PRIVATE / API_KEY / TOKEN / PASSWORD; source comment-stripped AND string-blanked, so prose naming a variable is not a
 *    read) may be reachable. Positive controls: a synthetic client → lib → secret reader is found; the same chain through a
 *    "use server" module is not.
 *
 * RED AT BASE (WAVE156L_ROOT=<the tree before this lane>): §A both budget rules, §B the moved-symbol checks (no ledger
 * module), §C (no ledger module to load), §D (the tech-stack client reached lib/supabase/service.ts).
 *
 * BLIND SPOTS (published): the walker's own (computed specifiers, package `exports`, tsconfig paths beyond @/* and
 * @/components/*; a first-party LOWER bound, not webpack's count). §B reads `export` statements by pattern: `export =`,
 * namespace merging and declaration-merged names are not modelled (a name it cannot resolve is reported, never assumed).
 * §D's secret test is a NAME test on process.env reads: a secret read through a computed key, a config object or a
 * package is invisible; NEXT_PUBLIC_* names are public by definition. Without WAVE156L_BASE the before/after comparison is
 * printed as not run — the absolute budget rules still run.
 *
 * Run: npx tsx scripts/wave156-l-guard.ts   (WAVE156L_ROOT=<tree> to judge another checkout; WAVE156L_BASE=<tree> to compare)
 */
import { registerHooks } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { makeWalker, appEntries, tryFile } from "./app-import-graph"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

const WT = process.cwd()
const ROOT = process.env.WAVE156L_ROOT || WT
const BASE = process.env.WAVE156L_BASE || ""
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const read = (root: string, f: string) => { const p = path.join(root, f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "" }
const code = (root: string, f: string) => stripComments(read(root, f))
const rel = (root: string, p: string) => path.relative(root, p)

/** The app side of test:proxy-graph-budget, measured with the one walker. */
function measure(root: string) {
  const w = makeWalker(root)
  const entries = appEntries(root)
  const union = new Set<string>()
  const ranked = entries.map((e) => { const s = w.reach(e).seen; for (const m of s) union.add(m); return { entry: rel(root, e), count: s.size } })
    .sort((a, b) => b.count - a.count)
  return { w, entries, ranked, union }
}
function budgets(root: string): { entry: number | null; union: number | null } {
  const src = code(root, "scripts/proxy-graph-budget-guard.ts")
  const e = /const\s+APP_ENTRY_GRAPH_BUDGET\s*=\s*(\d+)/.exec(src), u = /const\s+APP_UNION_GRAPH_BUDGET\s*=\s*(\d+)/.exec(src)
  return { entry: e ? Number(e[1]) : null, union: u ? Number(u[1]) : null }
}
function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w156l-"))
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body) }
  return dir
}

// ── §B machinery: who exports what ───────────────────────────────────────────
type ExportInfo = { local: Set<string>; named: Map<string, { from: string; orig: string }>; stars: string[] }
function exportsOf(root: string, file: string, cache: Map<string, ExportInfo>): ExportInfo {
  const hit = cache.get(file); if (hit) return hit
  const info: ExportInfo = { local: new Set(), named: new Map(), stars: [] }
  cache.set(file, info)
  if (file.endsWith(".json")) { info.local.add("default"); return info }
  const src = blankComments(fs.readFileSync(file, "utf8"))
  const res = (spec: string) => resolveSpec(root, spec, file)
  for (const m of src.matchAll(/(?:^|\n)[ \t]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|const|let|var|class|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/g)) info.local.add(m[2])
  for (const m of src.matchAll(/(?:^|\n)[ \t]*export\s+(?:const|let|var)\s+\{([^}]*)\}\s*=/g)) for (const p of m[1].split(",")) { const n = p.split(":").pop()!.trim(); if (n) info.local.add(n) }
  if (/(?:^|\n)[ \t]*export\s+default\b/.test(src)) info.local.add("default")
  for (const m of src.matchAll(/(?:^|\n)[ \t]*export\s+(?:type\s+)?\{([^}]*)\}\s*(from\s*["']([^"']+)["'])?/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().replace(/^type\s+/, ""); if (!t) continue
      const [orig, alias] = t.split(/\s+as\s+/).map((s) => s.trim())
      if (m[3]) { const r = res(m[3]); if (r) info.named.set(alias ?? orig, { from: r, orig }) }
      else info.local.add(alias ?? orig)
    }
  }
  for (const m of src.matchAll(/(?:^|\n)[ \t]*export\s+\*\s+from\s*["']([^"']+)["']/g)) { const r = res(m[1]); if (r) info.stars.push(r) }
  for (const m of src.matchAll(/(?:^|\n)[ \t]*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) info.local.add(m[1])
  return info
}
function resolveSpec(root: string, spec: string, from: string): string | null {
  if (spec.startsWith("./") || spec.startsWith("../")) return tryFile(path.resolve(path.dirname(from), spec))
  if (spec.startsWith("@/components/")) return tryFile(path.join(root, "app/components", spec.slice(13))) ?? tryFile(path.join(root, spec.slice(2)))
  if (spec.startsWith("@/")) return tryFile(path.join(root, spec.slice(2)))
  return null
}
function exportsName(root: string, file: string, name: string, cache: Map<string, ExportInfo>, depth = 0): boolean {
  if (depth > 12) return false
  const e = exportsOf(root, file, cache)
  if (e.local.has(name)) return true
  const n = e.named.get(name)
  if (n) return exportsName(root, n.from, n.orig, cache, depth + 1)
  return e.stars.some((s) => exportsName(root, s, name, cache, depth + 1))
}
/** Every VALUE name of every static first-party brace import in `files` that its target does not export. */
function danglingImports(root: string, files: Iterable<string>): string[] {
  const cache = new Map<string, ExportInfo>(); const out: string[] = []
  for (const f of files) {
    if (f.endsWith(".json")) continue
    const src = blankComments(fs.readFileSync(f, "utf8"))
    for (const m of src.matchAll(/(?:^|[;\n}])[ \t]*import\s+(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      if (m[1]) continue
      const target = resolveSpec(root, m[3], f); if (!target) continue
      for (const p of m[2].split(",")) {
        const t = p.trim(); if (!t || t.startsWith("type ")) continue
        const name = t.split(/\s+as\s+/)[0].trim()
        if (!exportsName(root, target, name, cache)) out.push(`${rel(root, f)} imports ${name} from ${rel(root, target)}`)
      }
    }
  }
  return out
}

// ── §D machinery: client graphs and secret readers ───────────────────────────
const SECRET_READ = /process\.env(?:\.|\[\s*["'`])([A-Z0-9_]+)/g
const isSecretName = (n: string) => !n.startsWith("NEXT_PUBLIC_") && /SERVICE_ROLE|SECRET|PRIVATE|API_KEY|TOKEN|PASSWORD/.test(n)
function secretReads(file: string): string[] {
  if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(file)) return []
  const src = blankStrings(stripComments(fs.readFileSync(file, "utf8")))
  return [...new Set([...src.matchAll(SECRET_READ)].map((m) => m[1]).filter(isSecretName))]
}
const directive = (file: string, d: string) => /\.(tsx?|jsx?)$/.test(file) && new RegExp(`^\\s*["']${d}["']`).test(stripComments(fs.readFileSync(file, "utf8")).trimStart().slice(0, 40))
function clientSecretPaths(root: string, clients: string[]): string[] {
  const w = makeWalker(root, { stopAt: (f) => directive(f, "use server") })
  const readerCache = new Map<string, string[]>()
  const out: string[] = []
  for (const c of clients) {
    const { seen, parent } = w.reach(c)
    for (const m of seen) {
      let r = readerCache.get(m); if (!r) { r = secretReads(m); readerCache.set(m, r) }
      if (!r.length) continue
      const chain: string[] = []; let cur: string | undefined = m
      while (cur) { chain.push(rel(root, cur)); cur = parent.get(cur) }
      out.push(`${chain.reverse().join(" → ")} [reads ${r.join(", ")}]`)
    }
  }
  return out
}

async function main() {
  console.log(`wave156-l-guard: ROOT=${ROOT}${BASE ? ` BASE=${BASE}` : ""}`)

  section("§A · the budget's own counter")
  {
    const dir = fixture({
      "app/page.tsx": `import { ONE } from "../lib/barrel"\nexport default function P() { return ONE }\n`,
      "app/direct/page.tsx": `import { ONE } from "../../lib/one"\nexport default function P() { return ONE }\n`,
      "lib/barrel.ts": `export { ONE } from "./one"\nexport { TWO } from "./two"\nexport * from "./three"\n`,
      "lib/one.ts": `export const ONE = 1\n`, "lib/two.ts": `export const TWO = 2\n`, "lib/three.ts": `export const THREE = 3\n`,
    })
    try {
      const m = measure(dir)
      const viaBarrel = m.ranked.find((r) => r.entry === "app/page.tsx")?.count, direct = m.ranked.find((r) => r.entry === "app/direct/page.tsx")?.count
      check(`POSITIVE CONTROL: one constant named through a barrel reaches every sibling (${viaBarrel} modules); named from its defining module it reaches ${direct}`,
        viaBarrel === 5 && direct === 2, { viaBarrel, direct })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const b = budgets(ROOT)
  check("the budgets are read from scripts/proxy-graph-budget-guard.ts (never retyped here)", b.entry !== null && b.union !== null, b)
  const now = measure(ROOT)
  check("the walker finds app entries and a real graph (heaviest > 100 modules)", now.entries.length > 0 && (now.ranked[0]?.count ?? 0) > 100, { entries: now.entries.length })
  console.log(`  · ${now.entries.length} entries; union ${now.union.size}; heaviest: ${now.ranked.slice(0, 5).map((r) => `${r.entry}=${r.count}`).join(", ")}`)
  check(`RULE: the heaviest app entry ≤ ${b.entry}`, b.entry !== null && now.ranked[0].count <= b.entry, now.ranked[0])
  check(`RULE: the union of all app entries ≤ ${b.union}`, b.union !== null && now.union.size <= b.union, now.union.size)
  if (BASE && fs.existsSync(path.join(BASE, "app"))) {
    const before = measure(BASE)
    console.log(`  · BASE: union ${before.union.size}; heaviest: ${before.ranked.slice(0, 5).map((r) => `${r.entry}=${r.count}`).join(", ")}`)
    for (const r of before.ranked.slice(0, 5)) {
      const after = now.ranked.find((x) => x.entry === r.entry)?.count ?? 0
      check(`BEFORE/AFTER: ${r.entry} ${r.count} → ${after} (lower)`, after > 0 && after < r.count, { before: r.count, after })
    }
    check(`BEFORE/AFTER: union ${before.union.size} → ${now.union.size} (lower)`, now.union.size < before.union.size)
  } else console.log("  · before/after comparison NOT RUN (set WAVE156L_BASE=<the tree before this lane>) — the absolute rules above still ran")

  section("§B · every imported name still has an exporter; the moved symbols")
  {
    const dir = fixture({
      "app/page.tsx": `import { ONE, GONE } from "../lib/barrel"\nimport { DEEP } from "../lib/barrel"\nexport default function P() { return ONE }\n`,
      "lib/barrel.ts": `export { ONE } from "./one"\nexport * from "./deep"\n`,
      "lib/one.ts": `export const ONE = 1\n`, "lib/deep.ts": `export * from "./deeper"\n`, "lib/deeper.ts": `export function DEEP() { return 1 }\n`,
    })
    try {
      const d = danglingImports(dir, [path.join(dir, "app/page.tsx")])
      check("POSITIVE CONTROL: a planted dangling import (GONE) is found", d.some((x) => /imports GONE from lib\/barrel\.ts/.test(x)), d)
      check("CONTROL: a name exported only through an `export *` chain (DEEP) and a named re-export (ONE) resolve", !d.some((x) => /imports (DEEP|ONE) /.test(x)), d)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const dangling = danglingImports(ROOT, now.union)
  check(`every static first-party value import in the ${now.union.size} modules the app reaches names an exported binding`, dangling.length === 0, dangling.slice(0, 8))

  const NET = "lib/intelligence/reaper-net.ts", LEDGER = "lib/intelligence/reaper-runs-ledger.ts"
  const netSrc = code(ROOT, NET), ledgerSrc = code(ROOT, LEDGER)
  const moved = new Set<string>()
  for (const m of netSrc.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*["']\.\/reaper-runs-ledger["']/g)) for (const n of m[1].split(",")) { const t = n.trim(); if (t && !t.startsWith("type ")) moved.add(t) }
  check("the registry names the symbols it moved: it re-exports each from ./reaper-runs-ledger", moved.size >= 2 && [...moved].every((n) => new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`).test(netSrc)), [...moved])
  for (const n of moved) {
    check(`${n}: DEFINED in ${LEDGER} and NOT in ${NET} (one definition)`, new RegExp(`export\\s+async\\s+function\\s+${n}\\b`).test(ledgerSrc) && !new RegExp(`function\\s+${n}\\b`).test(netSrc))
  }
  const ledgerOnly: string[] = []
  for (const f of now.union) {
    if (rel(ROOT, f) === NET || !/\.(tsx?)$/.test(f)) continue
    const s = blankComments(fs.readFileSync(f, "utf8"))
    for (const m of s.matchAll(/\{([^}]*)\}\s*(?:from\s*|=\s*await\s+import\(\s*)["']@\/lib\/intelligence\/reaper-net["']/g)) {
      const names = m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+|:/)[0].trim()).filter(Boolean)
      if (names.length && moved.size && names.every((x) => moved.has(x) || x === "ManagerReaperActivity")) ledgerOnly.push(rel(ROOT, f))
    }
  }
  check("no module imports ONLY ledger names from the reaper REGISTRY (the cut edge stays cut)", moved.size > 0 && ledgerOnly.length === 0, ledgerOnly)

  section("§C · the moved ledger, driven")
  {
    const G = globalThis as any
    G.__W156L = { svcCalls: 0 }
    const realUrl = (p: string) => pathToFileURL(path.join(ROOT, p)).href
    const dataUrl = (c: string) => `data:text/javascript,${encodeURIComponent(c)}`
    const REPLACE: Record<string, string> = {
      "lib/supabase/service.ts": "export function createServiceClient(){ globalThis.__W156L.svcCalls++; return globalThis.__W156L.mem }",
    }
    const aliasPath = (r: string) => { for (const c of [r, `${r}.ts`, `${r}.tsx`, `${r}/index.ts`, `${r}/index.tsx`]) { const p = path.join(ROOT, c); if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) return p } return null }
    registerHooks({
      resolve(spec: string, ctx: any, next: any) {
        if (spec === "server-only") return { url: dataUrl("export {}"), shortCircuit: true }
        const a = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
        const r = a ? { url: pathToFileURL(a).href, shortCircuit: true } : next(spec, ctx)
        const p = String(r.url ?? "").split("?")[0]
        const rep = Object.keys(REPLACE).find((k) => p === realUrl(k))
        return rep ? { url: dataUrl(REPLACE[rep]), shortCircuit: true } : r
      },
    })
    let net: any = null, ledger: any = null, loadErr = ""
    try { ledger = await import(realUrl(LEDGER)); net = await import(realUrl(NET)) } catch (e) { loadErr = e instanceof Error ? e.message.slice(0, 200) : String(e) }
    check("the real ledger and registry modules of ROOT load", !!ledger && !!net, loadErr)
    if (ledger && net) {
      check("ONE binding: the registry's recordReaperRun / loadRecentReaperActivity ARE the ledger's functions",
        net.recordReaperRun === ledger.recordReaperRun && net.loadRecentReaperActivity === ledger.loadRecentReaperActivity && typeof ledger.recordReaperRun === "function")
      const old = new Date(Date.now() - 48 * 3600_000).toISOString()
      const mem = memSupabase({ reaper_runs: [
        { brokerage_id: "b-1", domain: "stale_domain", manager: "deal_coordinator", scanned: 99, escalated: 9, reaped: 9, ran_at: old },
        { brokerage_id: "b-2", domain: "closing_overdue", manager: "deal_coordinator", scanned: 7, escalated: 7, reaped: 7, ran_at: new Date().toISOString() },
      ] as Row[] })
      G.__W156L.mem = mem
      await net.recordReaperRun({ brokerageId: "b-1", domain: "closing_overdue", manager: "deal_coordinator", scanned: 5, escalated: 2, reaped: 0, detail: "C24" })
      await ledger.recordReaperRun({ brokerageId: "b-1", domain: "stranded_offers", manager: "deal_coordinator", scanned: 3, escalated: 1, reaped: 0 }, mem)
      const ins = mem.writes.filter((w) => w.table === "reaper_runs" && w.op === "insert")
      check("recordReaperRun writes exactly the row it always wrote (tenant, domain, manager, counts, detail) — once per call",
        ins.length === 2 && ins[0].payload.brokerage_id === "b-1" && ins[0].payload.domain === "closing_overdue" && ins[0].payload.manager === "deal_coordinator"
          && ins[0].payload.scanned === 5 && ins[0].payload.escalated === 2 && ins[0].payload.reaped === 0 && ins[0].payload.detail === "C24" && ins[1].payload.detail === null,
        ins.map((w) => w.payload))
      check("without an injected client it asks the service client once (the default path is unchanged)", G.__W156L.svcCalls === 1, G.__W156L.svcCalls)
      for (const r of mem.tables.reaper_runs) r.ran_at ??= new Date().toISOString()
      const act = await ledger.loadRecentReaperActivity("b-1", 24, mem)
      const dc = act.deal_coordinator
      check("loadRecentReaperActivity aggregates the tenant's window per manager — not another tenant's rows, not rows outside the window",
        !!dc && dc.scanned === 8 && dc.escalated === 3 && dc.reaped === 0 && dc.domains.length === 2 && !dc.domains.includes("stale_domain") && Object.keys(act).length === 1, act)
    }
  }

  section("§D · no client component reaches a server-secret reader")
  {
    const dir = fixture({
      "app/c/page.tsx": `"use client"\nimport { x } from "../../lib/plain"\nexport default function P() { return x }\n`,
      "app/s/page.tsx": `"use client"\nimport { act } from "../../lib/act"\nexport default function P() { return act }\n`,
      "lib/plain.ts": `import { k } from "./reader"\nexport const x = k\n`,
      "lib/act.ts": `"use server"\nimport { k } from "./reader2"\nexport async function act() { return k }\n`,
      "lib/reader.ts": `// process.env.COMMENT_SECRET is prose\nexport const k = process.env.FIXTURE_SECRET_KEY ?? "" + "process.env.STRING_SECRET"\n`,
      "lib/reader2.ts": `export const k = process.env.FIXTURE_SERVICE_ROLE_KEY\n`,
    })
    try {
      const found = clientSecretPaths(dir, [path.join(dir, "app/c/page.tsx"), path.join(dir, "app/s/page.tsx")])
      check("POSITIVE CONTROL: client → lib → a module reading process.env.FIXTURE_SECRET_KEY is found (and only the real read, not prose or a string)",
        found.length === 1 && /app\/c\/page\.tsx → lib\/plain\.ts → lib\/reader\.ts \[reads FIXTURE_SECRET_KEY\]/.test(found[0]), found)
      check("CONTROL: the same read behind a \"use server\" module is not a client edge", !found.some((x) => x.includes("reader2")), found)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const clients = [...now.union].filter((f) => directive(f, "use client"))
  check("the census finds the app's client components", clients.length > 100, clients.length)
  const leaks = clientSecretPaths(ROOT, clients)
  console.log(`  · ${clients.length} "use client" modules walked (stopping at "use server"); ${leaks.length} path(s) to a secret reader`)
  check("no client component's graph reaches a module that reads a server secret", leaks.length === 0, leaks.slice(0, 5))

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of fails) console.log(`   ✗ ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
