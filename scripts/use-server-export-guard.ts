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

console.log("\n[use-server export guard — a 'use server' file may only export async functions]")
console.log(`  scanned ${files.length} action files`)
if (violations.length === 0) {
  console.log("  ✓ no non-async value exports in any top-level 'use server' file")
  console.log("\n──────────────────────────────────────────────────")
  console.log(" RESULT: 1 passed, 0 failed")
  console.log(" ✅ USE_SERVER_EXPORTS_PASS — no RSC page-data build-breaker")
} else {
  console.log(`  ✗ ${violations.length} non-async value export(s) in 'use server' file(s):`)
  for (const v of violations) console.log(`     - ${v}`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(" RESULT: 0 passed, 1 failed")
  process.exit(1)
}
