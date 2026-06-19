#!/usr/bin/env tsx
/**
 * scripts/egress-coverage-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EGRESS COVERAGE AUDIT — the meta-regression that proves ALL governed code is burned
 * by the egress. Where manager-ownership proves every Command Center QUEUE has an owner
 * and schema-drift proves every guarded TABLE matches the live schema, this proves the
 * GOVERNANCE GRAPH itself is whole:
 *   1. Every MAINTENANCE_DOMAINS proof points to a REAL npm script (no dangling proof —
 *      a domain can't claim coverage it doesn't have).
 *   2. Every Claude manager is referenced by ≥1 domain / queue / table (no orphan manager
 *      sitting in the registry with nothing to own).
 *   3. Every queue/table/domain target is a real manager (no dangling ownership).
 *   4. Every loop entity_type the gate produces maps to a real manager kind.
 * Pure (reads package.json + the registry) — no DB. Fails CI the moment a new manager,
 * domain, or loop is added without being wired into the egress.
 *
 * Run: npx tsx scripts/egress-coverage-simulator.ts  (npm run test:egress-coverage)
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  MANAGERS, MAINTENANCE_DOMAINS, QUEUE_MANAGER, TABLE_MANAGER, type ManagerKey,
} from "../lib/kernel/manager-registry"
import { OUTBOUND_COPY_QUEUES, extractProposalCopy } from "../lib/kernel/command-center"
import { compliancePreflight } from "../lib/kernel/manager-dissent"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { scripts: Record<string, string> }
const scriptNames = new Set(Object.keys(pkg.scripts))

console.log("══════════════════════════════════════════════════")
console.log(" Egress coverage audit")
console.log("══════════════════════════════════════════════════")

// ── 1. Every domain proof is a real npm script ──
console.log("\n[1 · every burn-domain proof is a runnable npm script]")
const domains = Object.entries(MAINTENANCE_DOMAINS)
for (const [name, d] of domains) {
  const scriptKey = d.proof.replace(/^test:/, "test:")
  const exists = scriptNames.has(scriptKey)
  check(`'${name}' → ${d.proof}`, exists, exists ? undefined : `missing npm script '${scriptKey}'`)
}
check(`all ${domains.length} domains have a runnable proof`,
  domains.every(([, d]) => scriptNames.has(d.proof)))

// ── 2. No orphan managers — every manager owns something ──
console.log("\n[2 · every manager is referenced by ≥1 domain / queue / table]")
const referenced = new Set<ManagerKey>()
for (const d of Object.values(MAINTENANCE_DOMAINS)) referenced.add(d.manager)
for (const m of Object.values(QUEUE_MANAGER)) referenced.add(m)
for (const m of Object.values(TABLE_MANAGER)) referenced.add(m)
const allManagers = Object.keys(MANAGERS) as ManagerKey[]
for (const k of allManagers) {
  check(`${MANAGERS[k].label} owns something`, referenced.has(k), referenced.has(k) ? undefined : "ORPHAN manager — owns no domain/queue/table")
}
const orphans = allManagers.filter((k) => !referenced.has(k))
check("zero orphan managers", orphans.length === 0, orphans.join(", "))

// ── 3. No dangling ownership — every target is a real manager ──
console.log("\n[3 · every ownership target is a real manager (no dangling references)]")
check("every MAINTENANCE_DOMAINS manager is real", Object.values(MAINTENANCE_DOMAINS).every((d) => d.manager in MANAGERS))
check("every QUEUE_MANAGER target is real", Object.values(QUEUE_MANAGER).every((m) => m in MANAGERS))
check("every TABLE_MANAGER target is real", Object.values(TABLE_MANAGER).every((m) => m in MANAGERS))

// ── 4. The gate's producing managers are all real ──
// The agent_kind values the client-message gate producers stamp (kept in sync with the
// proposeClientMessage call sites; any new producer manager must be a registered manager).
console.log("\n[4 · every gate-producing manager kind is registered]")
const GATE_PRODUCER_KINDS = [
  "deal_coordinator", "listing_concierge", "shopping_agent", "sphere_of_influence",
  "campaign_orchestrator", "recruiting_manager",
]
for (const k of GATE_PRODUCER_KINDS) {
  check(`gate producer '${k}' is a registered manager`, k in MANAGERS)
}

// ── 5. Coverage breadth sanity — the egress hasn't shrunk ──
console.log("\n[5 · coverage breadth — the governance graph is substantial]")
check("≥ 11 managers registered", allManagers.length >= 11)
check("≥ 18 burn domains governed", domains.length >= 18)
check("every domain proof string is well-formed (test:*)", domains.every(([, d]) => /^test:[a-z0-9-]+$/.test(d.proof)))

// ── 6. Compliance Officer pre-flights every OUTBOUND-COPY queue (no unreviewed egress) ──
console.log("\n[6 · Compliance Officer pre-flights every outbound-copy queue]")
const emptyCtx = { recipientWithdrawn: false, emailRevoked: false, smsRevoked: false, hoursSinceLastSend: null, openFireDrill: false }
const preflight = (input: Record<string, unknown>) =>
  compliancePreflight({ proposer: "marketing_agent", channel: "content", subject: null, body: extractProposalCopy(input) }, emptyCtx)
// Each content source stores its copy under a different key — the scan must read them all.
const FH = "This home is perfect for families in a safe neighborhood."
const COPY_BY_QUEUE: Record<string, Record<string, unknown>> = {
  social: { content: FH }, newsletter: { subject_line: "Open house", content_preview: FH },
  direct_mail: { copy_text: FH }, ad_creative: { headline: "Tour today", primary_text: FH },
  predictive_listing: { subject: "Thinking of selling?", body: FH }, blog: { title: "Guide", content_preview: FH },
  podcast: { title: "Episode 4", description: FH },
}
for (const q of OUTBOUND_COPY_QUEUES) {
  const v = preflight(COPY_BY_QUEUE[q] ?? {})
  check(`'${q}': Fair Housing copy → Compliance Officer ADVISORY`, v.manager === "compliance_officer" && v.status === "advisory")
}
check("clean broadcast copy → Compliance Officer CLEARED",
  preflight({ content: "Newly listed — 3 bed, 2 bath. Open Saturday, come take a look." }).status === "clear")
check("every outbound-copy queue is a real Command Center queue (no phantom surface)",
  Array.from(OUTBOUND_COPY_QUEUES).every((q) => q in QUEUE_MANAGER))
check("broadcast content is advisory-only (no single-recipient consent → never a hard block)",
  Array.from(OUTBOUND_COPY_QUEUES).every((q) => preflight(COPY_BY_QUEUE[q] ?? {}).status !== "blocked"))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(` ✅ Egress coverage whole — ${allManagers.length} managers, ${domains.length} burn domains, all proofs runnable, zero orphans`)
