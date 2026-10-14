/**
 * scripts/server-only-boundary-guard.ts
 *
 * test:server-only-boundary — A CLIENT MODULE MUST NOT REACH `server-only`.
 *
 * WHY THIS EXISTS. m340 added one import — lib/kernel/agent-identity.ts began
 * importing lib/kernel/agent-identity-resolver.ts — and broke the production
 * build. The resolver carries `import "server-only"`; agent-identity is imported
 * by app/analytics/page.tsx, which is `"use client"`. Webpack refused it:
 *
 *     You're importing a module that depends on "server-only". This API is only
 *     available in Server Components in the App Router, but you are using it in
 *     the Pages Router.
 *
 * THE PART THAT MATTERS: `tsc --noEmit` was CLEAN, and every one of the 434
 * proofs passed. This is a bundler constraint, not a type error and not a
 * behavioural one, so nothing in the pre-commit chain could see it. The first
 * thing to run it was CI, twice, on two commits.
 *
 * A full `next build` catches it and takes seven minutes. This takes seconds,
 * and it catches the same class: from every "use client" module, walk the import
 * graph and fail if it reaches a module that imports "server-only".
 *
 * WHY `"use server"` FILES STOP THE WALK. A client component importing a server
 * ACTION module is normal and supported — Next replaces the import with an RPC
 * stub, so nothing from that file's graph is bundled into the client. Following
 * through it would produce false positives on the app's ordinary shape.
 *
 * This does NOT replace `next build`. It covers one specific, recurring, and
 * previously invisible failure — the one that actually bit.
 */
import { readFileSync, existsSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { dirname, resolve as resolvePath } from "node:path"
import { blankComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }

// TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
// 82 byte-identical copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// The copy was not a style problem. It enumerated DIRECTORIES, and a root-level
// FILE is not a directory, so `proxy.ts` — the Next 16 edge middleware, which
// gates auth and queries blog_posts, brokerages, users and tenant_custom_domains
// with a SERVICE client on EVERY request — was outside this guard's corpus. A file
// that is never opened reports green, which is the failure shape §2 of CLAUDE.md
// names. `rootRuntimeFiles()` from the same survivor supplies the root files.

/** Resolve an import specifier to a file on disk, or null for a package. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = spec.slice(2)
  else if (spec.startsWith(".")) base = resolvePath(dirname(fromFile), spec).replace(`${process.cwd()}/`, "")
  else return null
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(cand) && /\.tsx?$/.test(cand)) return cand
  }
  return null
}

/** The synthetic client file §3 uses to prove the traversal catches a real chain. */
const PROBE_PATH = "app/__server_only_probe__/page.tsx"

// TYPE-ONLY IMPORTS ARE NOT RUNTIME EDGES. `import type { X } from "@/lib/kernel"`
// is erased at compile time, so it cannot pull server-only into a client bundle.
// The first version of this guard counted them and reported 22 violations
// against a tree whose webpack compile passes — the detector was wrong, not the
// code. Both `import type ...` and `export type ...` are excluded; a statement
// with any VALUE specifier still counts.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;\n]*?from\s*["']([^"']+)["']/g
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g

/**
 * The file's leading `"use client"` / `"use server"` directive, if it has one.
 *
 * The leading comments are removed by the ONE scanner (scripts/strip-comments.ts,
 * finding #250) rather than by a regex that tries to SPELL them. The regex this
 * replaces —
 *   `^\s*(?:BLOCK\s*|LINE\n\s*)*["'](use (?:client|server))["']`
 * — could only skip a comment shaped exactly the way it expected: a line comment
 * on the last line before the directive with no trailing newline, a shebang, or
 * a block comment containing the two characters that end a block comment inside
 * a string, and it stops seeing the directive at all. A file that HAS `"use
 * client"` but is read as not having it drops straight out of the traversal, and
 * a guard that reports zero violations because it stopped looking is the exact
 * failure this class keeps producing.
 *
 * `blankComments` preserves every offset, so the directive is still the first
 * non-blank token and nothing else in the match shifts.
 */
const firstDirective = (src: string): string | null => {
  const m = blankComments(src).match(/^\s*["'](use (?:client|server))["']/)
  return m ? m[1] : null
}

const hasServerOnly = (src: string) => /(?:^|\n)\s*import\s+["']server-only["']/.test(src)

interface Violation { client: string; chain: string[] }

/**
 * @param inject synthetic (path → source) entries layered over the real tree.
 *        Used by §3 to prove the traversal actually catches a violation — a
 *        detector that has never been seen to fail is not evidence of anything.
 */
function findViolations(inject?: Record<string, string>): Violation[] {
  const cache = new Map<string, string>()
  const srcOf = (p: string) => {
    if (inject && p in inject) return inject[p]
    if (!cache.has(p)) cache.set(p, read(p))
    return cache.get(p)!
  }

  const all = [...walkTs("app"), ...walkTs("lib"), ...walkTs("components"), ...rootRuntimeFiles("."), ...Object.keys(inject ?? {})]
  const clients = all.filter((f) => firstDirective(srcOf(f)) === "use client")

  const violations: Violation[] = []
  for (const entry of clients) {
    const seen = new Set<string>()
    // DFS carrying the chain so a failure names the whole path, not just the ends.
    const stack: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }]
    while (stack.length) {
      const { file, chain } = stack.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const src = srcOf(file)
      if (file !== entry) {
        if (hasServerOnly(src)) { violations.push({ client: entry, chain }); break }
        // A server-action module is an RPC boundary — its graph is not bundled.
        if (firstDirective(src) === "use server") continue
      }
      for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) {
          const next = resolveSpecifier(file, m[1])
          if (next && !seen.has(next)) stack.push({ file: next, chain: [...chain, next] })
        }
      }
    }
  }
  return violations
}

console.log("\n═══ 1. No client module reaches a server-only module ═══")
{
  const v = findViolations()
  for (const x of v.slice(0, 10)) {
    console.log(`     ${x.chain.map((c) => c.replace(/^app\/|^lib\//, "")).join("\n       → ")}`)
  }
  ok(`ZERO client→server-only import chains (found ${v.length})`, v.length === 0,
    v.map((x) => `${x.client} → … → ${x.chain[x.chain.length - 1]}`).join(" ; "))
}

console.log("\n═══ 2. The regression that motivated this cannot come back ═══")
{
  const idm = read("lib/kernel/agent-identity.ts")
  ok("lib/kernel/agent-identity does not import the server-only resolver —\n    it is reached from app/analytics/page.tsx, which is \"use client\"",
    !/from ['"]\.\/agent-identity-resolver['"]/.test(idm))
  ok("...and app/analytics/page.tsx does still import agent-identity, so this\n    assertion is testing a live path rather than a dead one",
    /"use client"/.test(read("app/analytics/page.tsx")) &&
    /@\/lib\/kernel\/agent-identity"/.test(read("app/analytics/page.tsx")))
}

console.log("\n═══ 3. The detector actually detects ═══")
{
  // A guard that has never been seen to fail proves nothing. Inject a synthetic
  // "use client" module that imports the real server-only resolver and confirm
  // the SAME traversal flags it.
  const caught = findViolations({
    [PROBE_PATH]: `"use client"\nimport { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"\n`,
  })
  ok("an injected \"use client\" file importing the server-only resolver IS caught\n    by the same walk that reports zero above",
    caught.some((v) => v.client === PROBE_PATH), JSON.stringify(caught.map((c) => c.client)))
  ok("...and it is the ONLY thing caught, so §1's zero is a real zero and not a\n    traversal that quietly stopped early",
    caught.length === 1, `${caught.length} violations with the probe injected`)
  ok("...and a TYPE-ONLY import of the same module is NOT flagged, because it is\n    erased and cannot reach the client bundle",
    findViolations({
      [PROBE_PATH]: `"use client"\nimport type { AgentRecordId } from "@/lib/kernel/agent-identity-resolver"\n`,
    }).length === 0)
}

console.log(`\n${"═".repeat(70)}`)
console.log(`SERVER-ONLY BOUNDARY — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nA \"use client\" module cannot reach `server-only`. tsc cannot see this and")
  console.log("neither can the behavioural proofs — only the bundler, and CI is too late.")
  process.exit(1)
}
console.log("No client module reaches server-only. The m340 build break cannot recur.")
