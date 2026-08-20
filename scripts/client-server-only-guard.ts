#!/usr/bin/env tsx
/**
 * scripts/client-server-only-guard.ts   (npm run test:client-server-only)
 * ─────────────────────────────────────────────────────────────────────────────
 * A "use client" MODULE MUST NOT REACH `server-only`, AT ANY IMPORT DEPTH.
 *
 * THE BUILD HAZARD tsc CANNOT SEE. TypeScript type-checks a module graph; it has no
 * opinion about which half of the graph is allowed in a browser bundle. So a single
 * static import can drag the entire server kernel into a client chunk and
 * `tsc --noEmit` stays green while `next build` fails. The only signal was a 13-minute
 * production build in CI — which is exactly how this shipped:
 *
 *     lib/kernel/event-reactor.ts            (import "server-only")
 *       ← lib/kernel/notification-engine.ts
 *       ← lib/kernel/lifecycle.ts
 *       ← lib/buyer-lifecycle/lifecycle-logger.ts
 *       ← lib/buyer-lifecycle/gating-helpers.ts
 *       ← app/crm/contacts/[contactId]/buyer-overview-client.tsx   ("use client")
 *
 * It is not only a build error. Those modules construct the SERVICE-ROLE Supabase
 * client, which bypasses RLS. A client component importing one is asking for
 * privileged server logic to be evaluated in a browser; the correct shape is always a
 * server action, or a value the server computed and passed as a prop.
 *
 * WHAT IT CHECKS. Every "use client" module, followed transitively through its VALUE
 * imports (`import type` is erased at compile time and is deliberately ignored — the
 * panel in this very cluster imports a type from the logger and is correct). If any
 * reachable module contains `import "server-only"`, that is a failure, and the guard
 * prints the whole chain so the fix is obvious rather than a hunt.
 *
 * ZERO BASELINE, on purpose. This is not a burn-down: one instance breaks the
 * production build outright, so there is no such thing as an acceptable count.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { stripComments } from "./strip-comments"

const root = process.cwd()

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n === ".next" || n === ".git" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(n)) yield p
  }
}

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }

/** Resolve a local import specifier to a real file. Returns null for packages. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = join(root, spec.slice(2))
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec)
  else return null   // bare package — not ours to follow
  for (const cand of [
    base, `${base}.ts`, `${base}.tsx`,
    join(base, "index.ts"), join(base, "index.tsx"),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

/**
 * VALUE imports only. `import type {...}` and `import { type X }` are erased by the
 * compiler and never reach a bundle, so treating them as edges would produce false
 * failures on correct code — the kind of over-broad pattern that makes a guard get
 * disabled instead of obeyed.
 */
function valueImports(src: string): string[] {
  const out: string[] = []
  const re = /(?:^|\n)\s*import\s+(?!type\s)([^;'"]*?)\s*from\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const clause = m[1]
    // `import { type A, type B } from x` — every binding is type-only, so no runtime edge.
    const named = clause.match(/\{([\s\S]*?)\}/)
    if (named && !/\*/.test(clause)) {
      const bindings = named[1].split(",").map((b) => b.trim()).filter(Boolean)
      if (bindings.length > 0 && bindings.every((b) => b.startsWith("type "))) continue
    }
    out.push(m[2])
  }
  // Side-effect imports (`import "x"`) are real runtime edges.
  const side = /(?:^|\n)\s*import\s+["']([^"']+)["']/g
  while ((m = side.exec(src))) out.push(m[1])
  // DYNAMIC imports are edges too, and missing them is what let this defect through
  // once already: notification-engine reaches event-reactor via `await import(...)`,
  // so a static-only scan walked the chain to that module and stopped one hop short of
  // the `server-only` it was hunting for. webpack still emits the target as a chunk of
  // the client bundle, so `await import()` is NOT an escape hatch for this rule — only
  // a "use server" boundary is.
  const dyn = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  while ((m = dyn.exec(src))) out.push(m[1])
  return out
}

const isServerOnly = (src: string) => /(?:^|\n)\s*import\s+["']server-only["']/.test(src)

/**
 * The leading directive, if any — read AFTER stripping the comment header.
 *
 * A directive only has to precede the first STATEMENT, so `"use server"` sitting below a
 * file-header comment is entirely valid and extremely common here. An anchored
 * /^\s*["']use server["']/ misses every one of those, which made this guard walk straight
 * through five server-action boundaries and report correct code as broken. Strip comments
 * and blank lines first, then look at what is actually first.
 */
function leadingDirective(src: string): string | null {
  // The prologue is found by removing comments through the ONE scanner that can
  // actually decide where a comment ends (scripts/strip-comments.ts). The anchored
  // alternation this replaced was correct only by luck: it ordered the line-comment
  // branch first, so it dodged the block-first defect \u2014 but any header comment
  // containing a slash-star still ended the run early and left the directive hidden.
  const body = stripComments(src.replace(/^\uFEFF/, "")).trimStart()
  const m = /^["'](use (?:client|server))["']/.exec(body)
  return m ? m[1] : null
}

const isClientModule = (src: string) => leadingDirective(src) === "use client"
/**
 * A "use server" module is a HARD BOUNDARY, not an edge to follow.
 *
 * Next.js replaces every export of a server-action module with an RPC reference at the
 * client boundary; the implementation and everything it imports stay on the server and
 * never enter the browser bundle. That is exactly why "call a server action" is the
 * correct fix for this defect — so a guard that walked through server actions would
 * fail on the very shape it is meant to demand, and would be switched off within a day.
 */
const isServerActionModule = (src: string) => leadingDirective(src) === "use server"

const files = [...walk(root)].filter((f) => !f.includes(`${root}/scripts/`))
const clientFiles = files.filter((f) => isClientModule(read(f)))

interface Violation { entry: string; chain: string[] }
const violations: Violation[] = []

for (const entry of clientFiles) {
  // BFS so the reported chain is the SHORTEST route to server-only — the one edge a
  // human actually has to cut.
  const seen = new Set<string>([entry])
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }]
  let found: string[] | null = null
  while (queue.length > 0 && !found) {
    const { file, chain } = queue.shift()!
    for (const spec of valueImports(read(file))) {
      const target = resolveLocal(spec, file)
      if (!target || seen.has(target)) continue
      seen.add(target)
      const src = read(target)
      const nextChain = [...chain, target]
      // Stop at the server-action boundary BEFORE testing for server-only: a "use server"
      // module is allowed to import the kernel, and routing through one is the fix.
      if (isServerActionModule(src)) continue
      if (isServerOnly(src)) { found = nextChain; break }
      // A nested "use client" module is itself an entry we check separately; it cannot
      // legally reach server-only either, so following through it would only duplicate.
      if (!isClientModule(src)) queue.push({ file: target, chain: nextChain })
    }
  }
  if (found) violations.push({ entry, chain: found })
}

const rel = (p: string) => p.replace(`${root}/`, "")

console.log("══════════════════════════════════════════════════════════════════════")
console.log(' "use client" must never reach `server-only`')
console.log("══════════════════════════════════════════════════════════════════════")
console.log(`\n  ${clientFiles.length} client modules scanned of ${files.length} source files`)

if (violations.length > 0) {
  console.log(`\n  ✗ ${violations.length} client module(s) import a server-only module:\n`)
  for (const v of violations) {
    console.log(`     ${rel(v.entry)}`)
    for (let i = 1; i < v.chain.length; i++) {
      console.log(`       ${"  ".repeat(i)}→ ${rel(v.chain[i])}`)
    }
    console.log("")
  }
  console.log("  This breaks `next build` (tsc cannot see it) and would put service-role")
  console.log("  logic in a browser bundle. The fix is never a dynamic import — it is to")
  console.log("  call a server action, or to compute the value on the server and pass it")
  console.log("  down as a prop. `import type` is fine and is already ignored here.")
  console.log("\n ❌ CLIENT_SERVER_ONLY_FAIL")
  process.exit(1)
}

console.log("\n  ✓ no client module reaches a server-only module at any depth")
console.log("\n✅ CLIENT_SERVER_ONLY_PASS — the browser bundle stays out of the kernel")
