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
import { readFileSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

function walk(dir: string, out: string[]) {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.ts$/.test(n)) out.push(relative(root, p).replace(/\\/g, "/"))
  }
}

const files: string[] = []
walk(join(root, "app", "actions"), files)

const violations: string[] = []
for (const f of files) {
  const src = readFileSync(join(root, f), "utf8")
  // Top-level "use server" directive (first ~3 non-empty lines, before any import)?
  const head = src.split("\n").slice(0, 3).join("\n")
  if (!/^\s*["']use server["']/m.test(head)) continue

  const lines = src.split("\n")
  lines.forEach((line, i) => {
    // export const/class/let/var/enum that is NOT an async function expression
    const m = /^export\s+(const|class|let|var|enum)\s+([A-Za-z0-9_]+)/.exec(line)
    if (m && !/=\s*async\b/.test(line)) {
      violations.push(`${f}:${i + 1}  export ${m[1]} ${m[2]} — move to a non-"use server" lib`)
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
for (const f of files) {
  const src = readFileSync(join(root, f), "utf8")
  const head = src.split("\n").slice(0, 3).join("\n")
  if (!/^\s*["']use server["']/m.test(head)) continue
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
console.log(`  scanned ${files.length} action files`)
const allOk = violations.length === 0 && cronViolations.length === 0 && detectorOk
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
  console.log(" RESULT: 3 passed, 0 failed")
  console.log(" ✅ USE_SERVER_EXPORTS_PASS — no RSC page-data build-breaker, no ungated cron sweep")
} else {
  console.log(` RESULT: ${[violations.length === 0, cronViolations.length === 0, detectorOk].filter(Boolean).length} passed, ${[violations.length > 0, cronViolations.length > 0, !detectorOk].filter(Boolean).length} failed`)
  process.exit(1)
}
