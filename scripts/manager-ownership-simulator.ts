#!/usr/bin/env tsx
/**
 * scripts/manager-ownership-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 53 — proves the multi-manager governance invariant: EVERY activity surfaced
 * on the One Command Center egress is owned by an accountable Claude manager — ZERO
 * orphans. The full queue set is derived from the live registries (the 3 agent
 * queues + client_message + every CONTENT_SOURCES key), so adding a new Command
 * Center surface without assigning an owner FAILS this test.
 *
 *   Layer 1 — pure: resolveActionManager covers every queue; client_message resolves
 *     per-row to the proposing manager; every manager has a label + domain.
 *
 * Run: npx tsx scripts/manager-ownership-simulator.ts  (npm run test:manager-ownership) — no DB.
 */
import {
  MANAGERS, QUEUE_MANAGER, resolveActionManager,
  MAINTENANCE_DOMAINS, TABLE_MANAGER, resolveMaintenanceManager, resolveTableManager,
  CRON_MANAGER, resolveCronManager,
  type ManagerKey,
} from "../lib/kernel/manager-registry"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { CONTENT_SOURCES } from "../lib/kernel/approval-sources"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// The complete set of Command Center queues, derived from the live registries so this
// can't silently miss a newly-added surface.
const AGENT_QUEUES = ["marketing", "asset", "ads"]
const CONTENT_QUEUES = Object.keys(CONTENT_SOURCES)
const NON_CLIENT_QUEUES = [...AGENT_QUEUES, ...CONTENT_QUEUES]

// Deal-critical managers that can propose a client_message (its agent_kind owns the row).
const CLIENT_MESSAGE_MANAGERS: ManagerKey[] = [
  "listing_concierge", "deal_coordinator", "shopping_agent", "sphere_of_influence", "campaign_orchestrator", "recruiting_manager",
]

console.log("\n[1 · every non-client queue has an explicit, accountable owner]")
for (const q of NON_CLIENT_QUEUES) {
  const m = resolveActionManager(q)
  // Ownership = EXPLICITLY mapped in QUEUE_MANAGER (not rescued by the defensive fallback).
  const owned = q in QUEUE_MANAGER
  check(`'${q}' → ${m.label}`, owned, owned ? undefined : "ORPHAN — not in QUEUE_MANAGER")
}

console.log("\n[2 · client_message is owned by the PROPOSING manager (per-row agent_kind)]")
for (const k of CLIENT_MESSAGE_MANAGERS) {
  const m = resolveActionManager("client_message", k)
  check(`client_message by ${k} → ${m.label}`, m.key === k)
}
check("client_message with no agent_kind still resolves (never undefined)",
  resolveActionManager("client_message", null).label.length > 0)

console.log("\n[3 · zero-orphan guarantee across the whole egress]")
const allQueues = [...NON_CLIENT_QUEUES, "client_message"]
const orphans = allQueues.filter((q) => q !== "client_message" && !(q in QUEUE_MANAGER))
check("no Command Center queue is unmapped", orphans.length === 0, orphans.join(", "))
// Every CONTENT_SOURCES queue (the registry that drives the egress) is owned.
const unownedContent = CONTENT_QUEUES.filter((q) => !(q in QUEUE_MANAGER))
check("every content-approval source has a manager owner", unownedContent.length === 0, unownedContent.join(", "))

console.log("\n[4 · maintenance / burn-domain ownership — the cleanup itself is governed]")
const domains = Object.keys(MAINTENANCE_DOMAINS)
check(`every burn domain has a REAL manager owner (${domains.length} domains)`,
  domains.every((d) => MAINTENANCE_DOMAINS[d].manager in MANAGERS))
check("every burn domain ties its owner to a runnable proof (npm test target)",
  domains.every((d) => MAINTENANCE_DOMAINS[d].proof.startsWith("test:")))
check("resolveMaintenanceManager never returns undefined (unknown domain → fallback)",
  resolveMaintenanceManager("not_a_domain").label.length > 0)
// The workstreams this audit actually ran must each be owned:
for (const d of ["schema_drift_guard", "lossless_promotion", "import_value_normalization",
                 "qualification_chain", "assignment_routing", "lead_conversion",
                 "credit_pipeline", "briefing_isa_overnight"]) {
  check(`'${d}' → ${resolveMaintenanceManager(d).label}`, d in MAINTENANCE_DOMAINS)
}

console.log("\n[5 · guarded-table ownership — every drift entry lands on a manager's list]")
const guardedTables = Object.keys(SCHEMA_SNAPSHOT)
const unownedTables = guardedTables.filter((t) => !(t in TABLE_MANAGER))
check(`every guarded table has an owning manager (${guardedTables.length} tables, derived from the live snapshot)`,
  unownedTables.length === 0, unownedTables.join(", "))
check("every TABLE_MANAGER target is a real manager",
  Object.values(TABLE_MANAGER).every((k) => k in MANAGERS))
check("resolveTableManager: contacts → Data Steward (spine integrity)",
  resolveTableManager("contacts").key === "data_steward")
check("resolveTableManager: leads → AI ISA (owns leads until qualified)",
  resolveTableManager("leads").key === "ai_isa")

console.log("\n[5b · PRESERVED BOUNDARIES — buyer vs seller vs lead vs lifetime]")
// The user-set governance contract: each side of the business lands on exactly
// one manager. Re-mapping any of these is a product decision, not a refactor.
check("BUYER side: offers (the buyer writes them) → Shopping Agent",
  resolveTableManager("offers").key === "shopping_agent")
check("BUYER side: tours (taking our buyer out) → Shopping Agent",
  resolveTableManager("tours").key === "shopping_agent")
check("BUYER side: tour_stops → Shopping Agent",
  resolveTableManager("tour_stops").key === "shopping_agent")
check("SELLER side: in-house showings of OUR listings → Listing Concierge",
  resolveTableManager("showings").key === "listing_concierge")
check("SELLER side: listings → Listing Concierge",
  resolveTableManager("listings").key === "listing_concierge")
check("LEAD side: ISA engagement activities → AI ISA",
  resolveTableManager("activities").key === "ai_isa")
check("DEAL side: transactions (post-acceptance) → Deal Coordinator",
  resolveTableManager("transactions").key === "deal_coordinator")
check("LIFETIME side: Sphere Manager's charter names closed & past clients",
  /past client/i.test(MANAGERS.sphere_of_influence.domain))
check("boundary preservation is itself a governed burn domain",
  MAINTENANCE_DOMAINS.manager_boundaries?.manager === "data_steward")

console.log("\n[5c · CRON ownership — every schedule on the dispatcher is RUN BY a manager]")
// The owner's invariant: no code runs unmanaged. The path set is derived from the
// LIVE dispatcher registry, so registering a cron without an owner fails here.
const cronPaths = Array.from(new Set(CRON_REGISTRY.map((c) => c.path.split("?")[0])))
const unownedCrons = cronPaths.filter((p) => !(p in CRON_MANAGER))
check(`every registered cron has an owning manager (${cronPaths.length} schedules, derived from CRON_REGISTRY)`,
  unownedCrons.length === 0, unownedCrons.join(", "))
const staleCrons = Object.keys(CRON_MANAGER).filter((p) => !cronPaths.includes(p))
check("no stale CRON_MANAGER entry points at an unregistered schedule", staleCrons.length === 0, staleCrons.join(", "))
check("every CRON_MANAGER target is a real manager",
  Object.values(CRON_MANAGER).every((k) => k in MANAGERS))
check("resolveCronManager: signature-chase → Deal Coordinator; unknown → fallback (never undefined)",
  resolveCronManager("/api/cron/signature-chase").key === "deal_coordinator"
  && resolveCronManager("/api/cron/not-a-cron").label.length > 0)
check("every one of the 13 managers RUNS at least one schedule (no idle manager on the clock)",
  (Object.keys(MANAGERS) as ManagerKey[]).every((k) => Object.values(CRON_MANAGER).includes(k)))

console.log("\n[6 · every manager is well-formed]")
const keys = Object.keys(MANAGERS) as ManagerKey[]
check("all 13 managers present (11 lead-working agent_kinds + Compliance Officer & Finance Manager back-office oversight)", keys.length === 13)
// The two back-office oversight managers own their cross-cutting functions explicitly (no longer
// diffused into Data Steward / Deal Coordinator) — a re-map here is a product decision, not a refactor.
check("COMPLIANCE: Fair Housing logs → Compliance Officer",
  resolveTableManager("fair_housing_logs").key === "compliance_officer")
check("COMPLIANCE: compliance_flags (transaction + Fair Housing checks) → Compliance Officer",
  resolveTableManager("compliance_flags").key === "compliance_officer")
check("COMPLIANCE: the regulatory-change watcher is owned by the Compliance Officer it escalates to",
  resolveMaintenanceManager("regulatory_change_watcher").key === "compliance_officer")
check("FINANCE: the commission ledger → Finance Manager (disbursement is back-office, not the TC)",
  resolveTableManager("commissions").key === "finance_manager")
check("FINANCE: brokerage P&L → Finance Manager",
  resolveTableManager("brokerage_p_l").key === "finance_manager")
check("DEAL boundary intact: transactions still → Deal Coordinator (commissions moved, the deal didn't)",
  resolveTableManager("transactions").key === "deal_coordinator")
for (const k of keys) {
  const m = MANAGERS[k]
  check(`${k} has label + domain + matching key`, m.key === k && m.label.length > 0 && m.domain.length > 0)
}
// Each QUEUE_MANAGER target is a real manager.
const badTargets = Object.values(QUEUE_MANAGER).filter((k) => !(k in MANAGERS))
check("every QUEUE_MANAGER target is a real manager", badTargets.length === 0, badTargets.join(", "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(` ✅ All ${allQueues.length} Command Center queues owned by a manager — zero orphan activities on the egress`)
