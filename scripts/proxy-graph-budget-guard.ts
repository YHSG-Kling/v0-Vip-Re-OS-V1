/**
 * scripts/proxy-graph-budget-guard.ts — test:proxy-graph-budget (wave 101C)
 *
 * proxy.ts IS ITS OWN WEBPACK COMPILE. Wave 100's lesson, measured: ONE import edge into it
 * (billing-access → dunning → a lazy @/lib/providers/messaging) pulled 823 first-party modules into
 * the proxy bundle and cost three consecutive exit-134 heap aborts in next-build. The cut brought it
 * back to ~23. Nothing held that number — this guard does.
 *
 * WHAT IT MEASURES: every FIRST-PARTY module reachable from proxy.ts through STATIC imports/exports
 * AND dynamic import()/require() (webpack bundles both), read from COMMENT-BLANKED source
 * (scripts/strip-comments.ts blankComments — CLAUDE.md §2: a tombstone naming an import is not an
 * import). `import type` / `export type` and an `import { type A, type B }` list are erased by the
 * compiler and not followed. Resolution: relative paths, `@/components/*` → app/components (then
 * the root), `@/*` → the root, with the .ts/.tsx/.js/.jsx/.mjs/.cjs/.json and index.* candidates.
 * Packages (node_modules) are not counted — they are not what blew the heap.
 *
 * THE RULE: the reachable count (proxy.ts itself included) must be ≤ PROXY_GRAPH_BUDGET (40). The
 * number is DERIVED every run, never pinned; the budget is headroom over the measured ~23, far
 * below the 827 that aborted the build. On failure the guard prints the module list and, for every
 * module outside the AUDITED set below, the import chain that pulls it in — the fix is a cut
 * (a pure leaf module, a client seam), never a raised budget.
 *
 * POSITIVE CONTROLS (CLAUDE.md §2 — a broken walker and a clean tree both report small numbers):
 *   · a synthetic fixture tree whose entry reaches budget+1 modules through a DYNAMIC import fails;
 *   · the same fixture's commented-out import and `import type` edge are NOT followed;
 *   · the real walk finds billing-access.ts (the edge the proxy is known to hold) — a walker that
 *     resolves nothing would report 1 and pass.
 *
 * BLIND SPOTS (published, not hidden): a computed import specifier (`import(x)`), a re-export
 * through a package's own `exports` map, and tsconfig `paths` other than `@/*` / `@/components/*`
 * are invisible; webpack's own module count also includes packages and runtime chunks, so this is a
 * first-party LOWER BOUND, not the bundle size.
 *
 * Run: npx tsx scripts/proxy-graph-budget-guard.ts
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { blankComments } from "./strip-comments"

const PROXY_GRAPH_BUDGET = 40

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]
function tryFile(p: string): string | null {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  for (const e of EXT) if (fs.existsSync(p + e)) return p + e
  for (const e of EXT) if (fs.existsSync(path.join(p, "index" + e))) return path.join(p, "index" + e)
  return null
}

/** The first-party import graph of one tree. */
function makeWalker(root: string) {
  function resolve(spec: string, from: string): string | null {
    if (spec.startsWith("./") || spec.startsWith("../")) return tryFile(path.resolve(path.dirname(from), spec))
    if (spec.startsWith("@/components/")) return tryFile(path.join(root, "app/components", spec.slice(13))) ?? tryFile(path.join(root, spec.slice(2)))
    if (spec.startsWith("@/")) return tryFile(path.join(root, spec.slice(2)))
    return null
  }
  const cache = new Map<string, string[]>()
  function edges(file: string): string[] {
    const hit = cache.get(file); if (hit) return hit
    const src = file.endsWith(".json") ? "" : blankComments(fs.readFileSync(file, "utf8"))
    const out: string[] = []
    const reStatic = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([^'"`;]*?\bfrom\s*)?["']([^"']+)["']/g
    let m: RegExpExecArray | null
    while ((m = reStatic.exec(src))) {
      if (m[2]) continue
      if (m[3] && /\{[^}]*\}\s*from\s*$/.test(m[3].trim())) {
        const inner = m[3].slice(m[3].indexOf("{") + 1, m[3].lastIndexOf("}"))
        const parts = inner.split(",").map((s) => s.trim()).filter(Boolean)
        if (parts.length && parts.every((p) => p.startsWith("type "))) continue
      }
      const r = resolve(m[4], file); if (r) out.push(r)
    }
    const reDyn = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g
    while ((m = reDyn.exec(src))) { const r = resolve(m[1], file); if (r) out.push(r) }
    cache.set(file, out)
    return out
  }
  function reach(entry: string): { seen: Set<string>; parent: Map<string, string> } {
    const seen = new Set<string>([entry]); const parent = new Map<string, string>(); const q = [entry]
    while (q.length) {
      const f = q.pop()!
      for (const t of edges(f)) if (!seen.has(t)) { seen.add(t); parent.set(t, f); q.push(t) }
    }
    return { seen, parent }
  }
  return { reach, rel: (p: string) => path.relative(root, p) }
}

/** The rule as one function (the fixture and the real tree are judged by the same code). */
function judge(root: string, entryRel: string, budget: number) {
  const w = makeWalker(root)
  const entry = tryFile(path.join(root, entryRel))
  if (!entry) return { ok: false, count: 0, modules: [] as string[], chain: (_: string) => "", error: `entry ${entryRel} not found` }
  const { seen, parent } = w.reach(entry)
  const modules = [...seen].map(w.rel).sort()
  const chain = (relTarget: string) => {
    const out: string[] = []; let cur: string | undefined = path.join(root, relTarget)
    while (cur) { out.push(w.rel(cur)); cur = parent.get(cur) }
    return out.reverse().join(" → ")
  }
  return { ok: seen.size <= budget, count: seen.size, modules, chain, error: null as string | null }
}

// Modules the proxy is EXPECTED to reach today (the paywall's read path). Not a pass list — the
// budget decides; this only says which entries get a printed chain when the budget is broken.
const AUDITED = new Set([
  "proxy.ts", "app/constants/auth.ts", "lib/platform/site-url.ts", "lib/supabase/service.ts", "lib/supabase/server.ts",
  "lib/billing/billing-access.ts", "lib/billing/past-due-clock.ts", "lib/billing/stripe-status.ts", "lib/billing/plan-tier.ts",
  "lib/auth/resolve-user-role.ts", "lib/auth/role-grants.ts", "lib/security/types.ts", "lib/kernel/0.1-feature-access.ts",
  "lib/kernel/override-vocab.ts", "lib/entitlements/resolve.ts", "lib/platform/platform-controls.ts",
  "lib/platform/platform-staff-roster.ts", "lib/ai/fair-use.ts", "lib/usage/check-cap.ts", "lib/usage/period.ts",
  "lib/vendor-governance/budget-gate.ts", "lib/vendor-governance/budget-eval.ts", "lib/format/dates.ts",
])

function main() {
  console.log("\n[1 · positive controls — a synthetic tree the rule must judge]")
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-graph-"))
    try {
      const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body) }
      const n = PROXY_GRAPH_BUDGET // the entry + n leaves = budget + 1 modules
      write("proxy.ts", `// import "./lib/commented"\nimport type { T } from "./lib/typed"\nimport { a } from "./lib/hub"\nexport const p = a\n`)
      write("lib/hub.ts", `export const a = 1\nexport async function load() { return import("./leaf-0") }\n`)
      for (let i = 0; i < n - 1; i++) write(`lib/leaf-${i}.ts`, i < n - 2 ? `import "./leaf-${i + 1}"\nexport {}\n` : `export {}\n`)
      write("lib/commented.ts", `export {}\n`)
      write("lib/typed.ts", `export type T = number\n`)
      const over = judge(dir, "proxy.ts", PROXY_GRAPH_BUDGET)
      check(`POSITIVE CONTROL: a tree reaching budget+1 modules through a DYNAMIC import fails (${over.count} > ${PROXY_GRAPH_BUDGET})`,
        !over.ok && over.count === PROXY_GRAPH_BUDGET + 1, `count=${over.count}`)
      check("POSITIVE CONTROL: a commented-out import and an `import type` edge are NOT followed",
        !over.modules.includes("lib/commented.ts") && !over.modules.includes("lib/typed.ts"), over.modules.join(","))
      fs.writeFileSync(path.join(dir, "lib/hub.ts"), `export const a = 1\n`)
      const under = judge(dir, "proxy.ts", PROXY_GRAPH_BUDGET)
      check("CONTROL: the same tree with the dynamic edge cut passes (the walker counts what it reaches, nothing else)", under.ok && under.count === 2, `count=${under.count}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log("\n[2 · the real proxy.ts graph]")
  const root = process.cwd()
  const real = judge(root, "proxy.ts", PROXY_GRAPH_BUDGET)
  check("proxy.ts resolves", real.error === null, real.error ?? "")
  check("the walker sees the proxy's known edge (lib/billing/billing-access.ts) — a resolver that resolves nothing would report 1",
    real.modules.includes("lib/billing/billing-access.ts"))
  console.log(`  · proxy.ts reaches ${real.count} first-party module(s), static + dynamic (budget ${PROXY_GRAPH_BUDGET}; wave 100 abort: 827; denominator: first-party .ts/.tsx/.js/.json only)`)
  check(`RULE: proxy.ts reaches ≤ ${PROXY_GRAPH_BUDGET} first-party modules`, real.ok, `${real.count} reached`)
  const unaudited = real.modules.filter((m) => !AUDITED.has(m))
  if (unaudited.length) {
    console.log(`  · ${unaudited.length} module(s) outside the audited set — the chain that pulls each in:`)
    for (const m of unaudited) console.log(`      ${real.chain(m)}`)
  }
  if (!real.ok) for (const m of real.modules) console.log(`      P ${m}`)

  console.log("\n[blind spots]")
  console.log("  · computed import specifiers, package `exports` re-exports and tsconfig paths other than @/* and @/components/* are invisible; packages are not counted — a first-party LOWER BOUND, not webpack's module count")

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
