// scripts/tenant-scope-guard.ts   (npm run test:tenant-scope — in the guard chain)
// ─────────────────────────────────────────────────────────────────────────────
// APP-LAYER TENANT-SCOPE LINT — the primary multi-tenant boundary is ~1,300
// service-client call sites each remembering to scope tenant tables; RLS is
// the verified BACKSTOP (test:tenant-isolation), not the primary. This guard
// makes the missing-filter class of leak impossible BY CI, not by diligence:
// every `.from("<tenant table>")` query chain must show SCOPING EVIDENCE —
// a brokerage_id filter, a primary-key/unique-id lookup, or a parent-id the
// caller already validated. Heuristic by design, so it carries a BASELINE
// (tenant-scope-baseline.json): existing debt is frozen and the surface can
// only SHRINK — any NEW unscoped query fails the build with its location.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// High-risk tenant tables — rows here belong to ONE brokerage.
const TENANT_TABLES = [
  "contacts", "leads", "listings", "transactions", "showings", "offers",
  "messages", "conversations", "voice_calls", "client_portal_messages",
  "documents", "open_house_events", "open_house_attendees", "agent_client_messages",
  "campaigns", "tasks", "referrals", "vendors", "agents",
] as const

// Evidence that a chain is scoped: a tenant filter, a PK/unique-sid lookup,
// or a validated parent id. Any ONE within the chain window passes.
const SCOPE_EVIDENCE = [
  "brokerage_id", "brokerageId",
  '.eq("id"', ".eq('id'", '.in("id"', ".in('id'",
  "vapi_call_id", "call_sid",
  '.eq("user_id"', ".eq('user_id'",
  // Unique-key lookups (globally unique — the row IS the scope):
  '.eq("slug"', '.eq("public_id"', '.eq("token"', '.eq("public_slug"', "stripe_",
  "contact_id", "conversation_id", "event_id", "listing_id", "transaction_id", "agent_id",
]

const WINDOW = 500 // chars of chain examined after .from("table")
const root = process.cwd()
const baselinePath = join(root, "scripts", "tenant-scope-baseline.json")

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|simulator|guard/.test(entry)) yield p
  }
}

const violations = new Map<string, number>() // "file :: table" → count
let scanned = 0
for (const dir of ["app", "lib"]) {
  for (const abs of walk(join(root, dir))) {
    const src = readFileSync(abs, "utf8")
    scanned += 1
    for (const table of TENANT_TABLES) {
      const needle = `.from("${table}")`
      let idx = src.indexOf(needle)
      while (idx !== -1) {
        const window = src.slice(idx, idx + WINDOW)
        // Head-only counts (count/head:true aggregate) still leak counts — no exemption.
        const scoped = SCOPE_EVIDENCE.some((e) => window.includes(e))
        if (!scoped) {
          const key = `${relative(root, abs).replace(/\\/g, "/")} :: ${table}`
          violations.set(key, (violations.get(key) ?? 0) + 1)
        }
        idx = src.indexOf(needle, idx + 1)
      }
    }
  }
}

const baseline: Record<string, number> = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : {}

if (process.env.TENANT_SCOPE_BASELINE === "1") {
  const snap: Record<string, number> = {}
  for (const [k, v] of [...violations.entries()].sort()) snap[k] = v
  writeFileSync(baselinePath, `${JSON.stringify(snap, null, 2)}\n`)
  console.log(`Baseline written: ${violations.size} known-unscoped site(s) frozen (surface can only shrink)`)
  process.exit(0)
}

let newViolations = 0
let shrunk = 0
const failures: string[] = []
for (const [key, count] of violations.entries()) {
  const allowed = baseline[key] ?? 0
  if (count > allowed) {
    newViolations += count - allowed
    failures.push(`${key} — ${count} unscoped quer${count === 1 ? "y" : "ies"} (baseline ${allowed})`)
  }
}
for (const [key, allowed] of Object.entries(baseline)) {
  const current = violations.get(key) ?? 0
  if (current < allowed) shrunk += allowed - current
}

console.log(`\n── TENANT-SCOPE GUARD ──`)
console.log(`  ${scanned} files scanned · ${violations.size} site(s) with unscoped tenant-table queries · baseline debt ${Object.values(baseline).reduce((a, b) => a + b, 0)}`)
if (shrunk > 0) console.log(`  ↓ ${shrunk} baseline site(s) fixed — run TENANT_SCOPE_BASELINE=1 to tighten the baseline`)
if (newViolations > 0) {
  console.log(`  ✗ ${newViolations} NEW unscoped tenant-table quer${newViolations === 1 ? "y" : "ies"} — add a brokerage_id filter (or a validated id lookup):`)
  for (const f of failures) console.log(`     - ${f}`)
  console.log(" ❌ TENANT_SCOPE_FAIL — cross-tenant reads must be impossible BY CI, not by diligence")
  process.exit(1)
}
console.log(" ✅ TENANT_SCOPE_PASS — no new unscoped tenant-table queries (the surface can only shrink)")
