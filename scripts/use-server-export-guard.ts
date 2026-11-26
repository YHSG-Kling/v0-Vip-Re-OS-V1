#!/usr/bin/env tsx
/**
 * scripts/use-server-export-guard.ts  (npm run test:use-server-exports) — pure, no DB.
 *
 * BUILD-BREAKER RATCHET. A top-level "use server" file may ONLY export async functions —
 * exporting a const/class/enum/value (or re-exporting a value) makes Next.js fail page-data
 * collection ("a use server file can only export async functions"), which the compile step
 * does NOT surface (it prints "Compiled successfully" and then exits 1 later). This guard
 * catches that class in seconds so it never reaches a slow build — it twice slipped through
 * (a type re-export, then const arrays) because earlier checks grepped "Compiled successfully"
 * instead of the exit code.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Does this module carry a TOP-LEVEL "use server" directive?
 *
 * WAS: `src.split("\n").slice(0, 3)` tested against the RAW source. Next.js
 * accepts a directive preceded by comments — it is the first STATEMENT that
 * counts, and a comment is not a statement — so a directive sitting under a
 * doc block that runs past line 3 was invisible to this guard. Measured on
 * 2026-09-02: 13 files sat in that gap (lib/kernel/users.ts at line 34,
 * lib/kernel/crm.ts at 30, lib/kernel/onboarding.ts at 20,
 * lib/kernel/communications.ts at 16, and nine app/actions files), every one of
 * them a real "use server" module this guard reported green for without ever
 * having judged it. The count moved 615 → 628 when this was fixed; the
 * direction is the finding (§2 — more findings = the check was blind).
 *
 * The rule is now the one Next applies: the first non-empty line of the
 * COMMENT-STRIPPED source is the directive, either quote style, optional
 * semicolon. Stripping is done by scripts/strip-comments.ts (§2 — never
 * hand-roll a comment stripper), so a `//` line containing `/*` cannot swallow
 * the directive, and prose that merely MENTIONS "use server" inside a header
 * comment is not mistaken for one.
 */
export function hasUseServerDirective(src: string): boolean {
  const first = stripComments(src).split("\n").find((l) => l.trim().length > 0) ?? ""
  return /^\s*["']use server["']\s*;?\s*$/.test(first)
}

// POSITIVE CONTROL for the detector (§2 — a broken finder and a clean tree
// both report zero). A directive at line 12 under a doc block MUST be seen; a
// module with no directive, one whose only "use server" is comment prose, and
// one whose directive sits AFTER an import (Next ignores it there) MUST NOT.
const directiveDetectorOk =
  hasUseServerDirective(
    "/**\n * doc block\n * line 3\n * line 4\n * line 5\n * line 6\n * line 7\n * line 8\n * line 9\n */\n\n\"use server\"\n\nimport x from \"y\"\n",
  ) &&
  hasUseServerDirective("'use server';\nexport async function a() {}\n") &&
  hasUseServerDirective("// header\n\"use server\"\n") &&
  !hasUseServerDirective("import x from \"y\"\nexport async function a() {}\n") &&
  !hasUseServerDirective("/*\n\"use server\" is what the ACTION file says; this helper is plain.\n*/\nexport function a() {}\n") &&
  !hasUseServerDirective("import x from \"y\"\n\"use server\"\n")

// TOMBSTONE (orphan doctrine §1.1) — the private `walk(dir, out)` that stood here
// was one of 82 copies of the same readdirSync walker. Survivor:
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// The header below already states this guard's own rule — a guard that inspects a
// SUBSET of the surface its rule applies to reports green over the files it never
// opened. The private walker was that same defect one level up: it enumerated
// DIRECTORIES, and a root-level FILE is not a directory, so `proxy.ts` was one of
// the files this guard never opened. `rootRuntimeFiles()` supplies it.

// SCAN EVERY TREE THAT CAN HOLD A "use server" MODULE, not just app/actions.
//
// This guard was written to stop exactly one build-breaker and then missed a live
// instance of it, because it only ever walked app/actions. The directive is not
// confined there: lib/ads/ad-monitor.ts carries "use server" and grew two
// `export const` arrays, which failed page-data collection in CI with
//   A "use server" file can only export async functions, found object.
// while this guard reported "scanned 548 action files ✓".
//
// A guard that inspects a subset of the surface its rule applies to reports green
// for the files it never opened, which is worse than no guard — it is a green light
// over an unexamined area. `app` also covers route handlers and co-located action
// files outside app/actions.
const files = [
  ...walkTs(join(root, "app")),
  ...walkTs(join(root, "lib")),
  ...rootRuntimeFiles(root),
]
  .filter((p) => p.endsWith(".ts"))   // a .tsx cannot carry the "use server" module directive
  .map((p) => relative(root, p).replace(/\\/g, "/"))

const violations: string[] = []
// Every module that carries the directive — computed ONCE, on stripped source,
// and published as a count beside the result so the denominator is visible.
const useServerFiles = files.filter((f) => hasUseServerDirective(readFileSync(join(root, f), "utf8")))
for (const f of useServerFiles) {
  const src = readFileSync(join(root, f), "utf8")

  const lines = src.split("\n")
  lines.forEach((line, i) => {
    // export const/class/let/var/enum that is NOT an async function expression
    const m = /^export\s+(const|class|let|var|enum)\s+([A-Za-z0-9_]+)/.exec(line)
    if (m && !/=\s*async\b/.test(line)) {
      violations.push(`${f}:${i + 1}  export ${m[1]} ${m[2]} — move to a non-"use server" lib`)
    }
    // A NON-ASYNC `export function`. This was the guard's blind spot and it cost a
    // red CI build: the rule above only ever matched const/class/let/var/enum, so a
    // plain `export function qrDisplayName(...)` in a "use server" module sailed
    // past a guard whose whole job is this build-breaker, and tsc cannot see it
    // either (the constraint is Next's, not TypeScript's). `export default` and
    // type-only exports are erased and stay legal.
    const fn = /^export\s+function\s+([A-Za-z0-9_]+)/.exec(line)
    if (fn) {
      violations.push(
        `${f}:${i + 1}  export function ${fn[1]} — a "use server" export must be ` +
        `async; make it a Server Action, or (if it is a pure helper) drop the ` +
        `export or move it to a non-"use server" lib`,
      )
    }
  })
}

// ── CHECK 2: no PLATFORM-WIDE cron sweep may be a "use server" export ────────
//
// Every export of a top-level "use server" module is an RPC endpoint any
// authenticated session can call. A cron TICK is the opposite of session work:
// it runs on the service client (RLS bypassed), sweeps every brokerage, and acts
// on their behalf — emailing past clients, posting publicly. The /api/cron route
// gates on verifyCronAuth, but that gate protects the ROUTE, not the function;
// importing the action and calling it directly walked straight past it.
//
// Two shipped this way (generateAnnualHomeValueReportsCronTick +
// generateQuarterlyHomeValueReportsCronTick emailing past clients, and
// gbpAutoPostsCronTick posting to Google Business Profile). Both moved to lib/,
// which REMOVES the endpoint instead of guarding it — the shape
// lib/showings/showing-brief.ts already used. The GBP sweep has since been
// collapsed into the canonical lifecycle-promo path and now sweeps as
// listingPromoCatchupCronTick, still in lib/.
//
// Name-based on purpose: "CronTick" is this repo's settled name for a sweep
// entrypoint, so the rule reads as a naming convention with teeth. A sweep that
// evades it by renaming is a different (and much rarer) problem than the
// copy-the-neighbouring-file drift this prevents.
export function cronTickExports(src: string): string[] {
  const out: string[] = []
  const re = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]*[Cc]ronTick[A-Za-z0-9_]*)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

const cronViolations: string[] = []
for (const f of useServerFiles) {
  const src = readFileSync(join(root, f), "utf8")
  for (const name of cronTickExports(src)) {
    cronViolations.push(`${f}  export ${name} — a platform-wide sweep must live in lib/, not behind a "use server" RPC`)
  }
}

// Pure checks for the detector itself.
const detectorOk =
  cronTickExports('export async function listingPromoCatchupCronTick() {}').length === 1 &&
  cronTickExports('export function generateAnnualHomeValueReportsCronTick() {}').length === 1 &&
  cronTickExports('export async function getCronHealth() {}').length === 0 &&
  cronTickExports('async function privateCronTick() {}').length === 0

console.log("\n[use-server export guard — a 'use server' file may only export async functions]")
console.log(`  scanned ${files.length} .ts files under app/, lib/ and the root; ${useServerFiles.length} carry a top-level "use server" directive (${useServerFiles.filter((f) => f.startsWith("lib/")).length} of them under lib/)`)
console.log(`  ${directiveDetectorOk ? "✓" : "✗"} directive detector: sees a directive under a doc block, ignores prose / post-import / absent`)
const allOk = violations.length === 0 && cronViolations.length === 0 && detectorOk && directiveDetectorOk
if (violations.length === 0) {
  console.log("  ✓ no non-async value exports in any top-level 'use server' file")
} else {
  console.log(`  ✗ ${violations.length} non-async value export(s) in 'use server' file(s):`)
  for (const v of violations) console.log(`     - ${v}`)
}
console.log(`  ${detectorOk ? "✓" : "✗"} cron-tick detector: matches CronTick exports, ignores getCronHealth and non-exported helpers`)
if (cronViolations.length === 0) {
  console.log("  ✓ no platform-wide cron sweep is exposed as a 'use server' RPC")
} else {
  console.log(`  ✗ ${cronViolations.length} cron sweep(s) reachable as an authenticated RPC:`)
  for (const v of cronViolations) console.log(`     - ${v}`)
}
console.log("\n──────────────────────────────────────────────────")
if (allOk) {
  console.log(" RESULT: 4 passed, 0 failed")
  console.log(" ✅ USE_SERVER_EXPORTS_PASS — no RSC page-data build-breaker, no ungated cron sweep")
} else {
  const checks = [violations.length === 0, cronViolations.length === 0, detectorOk, directiveDetectorOk]
  console.log(` RESULT: ${checks.filter(Boolean).length} passed, ${checks.filter((c) => !c).length} failed`)
  process.exit(1)
}
