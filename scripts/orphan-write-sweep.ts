#!/usr/bin/env tsx
/**
 * scripts/orphan-write-sweep.ts  (PASS 17)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "WRITE-ONLY LEDGER" SWEEP — the mirror of pass 16 (writer-less reads,
 * burned to zero). This finds the OTHER open-loop class: tables the code
 * WRITES but nothing ever READS — AI outputs, receipts, and ledgers that cost
 * compute/storage and inform nobody (contract_reviews, meeting_briefs,
 * fair_housing_logs were all this class). A write nothing consumes is either
 * a missing surface (build the reader) or waste (repoint/delete the write).
 *
 * Report-only with a committed baseline: NEW write-only tables fail CI; the
 * existing list is a burn-down (each entry needs a verdict — build the
 * reader, repoint the write to the canonical twin, or delete the dead write).
 * Audit-trail tables that are intentionally write-heavy get an AUDIT_EXEMPT
 * entry naming who consumes them out-of-band (compliance export, retention).
 *
 * Run: npx tsx scripts/orphan-write-sweep.ts  (npm run test:orphan-writes)
 * Tighten: GUARD_WRITE_BASELINE=1 npx tsx scripts/orphan-write-sweep.ts
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const BASELINE = join(process.cwd(), "scripts/orphan-write-baseline.json")

/** Intentionally write-heavy audit/forensic ledgers — each names its
 *  out-of-band consumer so the exemption stays auditable. */
const AUDIT_EXEMPT: Record<string, string> = {
  superadmin_audit_log: "app/dashboard/superadmin/audit (platform-action viewer)",
  lifecycle_events: "kernel event spine — consumed by processKernelEvent subscribers",
  tenant_transition_log: "forensic boundary-crossing ledger (compliance export)",
  audit_logs: "compliance export + retention",
  security_audit_log: "compliance export + retention",
}

function walk(dir: string, acc: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
}

function main() {
  const files: string[] = []
  for (const d of ["app", "lib"]) { try { walk(join(process.cwd(), d), files) } catch {} }

  const writers = new Map<string, Set<string>>()
  const readers = new Set<string>()
  const FROM = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  // Nested-embed reads: `tbl(...)` or `alias:tbl(...)` inside a .select string.
  const SELECT_EMBED = /\.select\(\s*[`"']([\s\S]{0,600}?)[`"']\s*[,)]/g
  const EMBED_TABLE = /(?:^|[,\s(])(?:[a-z_][a-z0-9_]*:)?([a-z_][a-z0-9_]*)\s*(?:!\w+)?\(/g

  for (const f of files) {
    const s = readFileSync(f, "utf8")
    let m: RegExpExecArray | null
    while ((m = FROM.exec(s))) {
      const table = m[1]
      const window = s.slice(m.index, m.index + m[0].length + 160)
      if (/\.(insert|upsert|update|delete)\s*\(/.test(window)) {
        const set = writers.get(table) ?? new Set<string>()
        set.add(f.replace(process.cwd() + "/", ""))
        writers.set(table, set)
      }
      if (/\.select\s*\(/.test(window)) readers.add(table)
    }
    // Embedded reads count as reads of the embedded table.
    let sm: RegExpExecArray | null
    while ((sm = SELECT_EMBED.exec(s))) {
      let em: RegExpExecArray | null
      while ((em = EMBED_TABLE.exec(sm[1]))) readers.add(em[1])
    }
  }

  const offenders = [...writers.keys()]
    .filter((t) => !readers.has(t) && !(t in AUDIT_EXEMPT))
    .sort()

  if (process.env.GUARD_WRITE_BASELINE === "1") {
    writeFileSync(BASELINE, JSON.stringify(offenders, null, 2) + "\n")
    console.log(`⚙ wrote baseline: ${offenders.length} write-only tables (burn-down list)`)
  }
  const baseline = new Set<string>(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : [])
  const fresh = offenders.filter((t) => !baseline.has(t))
  const fixed = [...baseline].filter((t) => !offenders.includes(t))

  console.log("══════════════════════════════════════════════════")
  console.log(" PASS 17 — write-only ledger sweep (outputs nothing consumes)")
  console.log("══════════════════════════════════════════════════")
  console.log(` ${writers.size} written tables · ${readers.size} read tables`)
  console.log(` write-only tables: ${offenders.length} (baseline ${baseline.size}, burn-down)`)
  for (const t of offenders.slice(0, 100)) {
    const mark = baseline.has(t) ? "·" : "✗ NEW"
    console.log(`  ${mark} ${t} ← ${[...(writers.get(t) ?? [])].slice(0, 2).join(", ")}`)
  }
  if (fixed.length > 0) console.log(` ↘ ${fixed.length} baseline entries now have readers — tighten with GUARD_WRITE_BASELINE=1`)
  if (fresh.length > 0) {
    console.log(` ✗ ${fresh.length} NEW write-only table(s): ${fresh.join(", ")}`)
    console.log("   Give each a verdict: build the reader, repoint the write, or delete the dead write.")
    process.exit(1)
  }
  console.log(" ✅ no NEW write-only tables")
}

main()
