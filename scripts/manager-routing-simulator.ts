#!/usr/bin/env tsx
/**
 * scripts/manager-routing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MANAGER-ROUTING PROOF — owner rulings, wave 49 (2026-09-10), on kernel-event
 * reader routing (lib/kernel/event-reactor.ts D-octies/D-novies/D-decies/D-undecies,
 * lib/kernel/signal-registry.ts, lib/kernel/manager-signals.ts):
 *
 *   1. NO kernel event / signal exists for an AGENT CLAIMING A LEAD (owner, verbatim:
 *      "agents can't see leads until the lead gets converted to a contact and the
 *      agent is assigned that contact") — KernelEvent.LEAD_CLAIMED and the
 *      SIGNAL_REGISTRY "lead_claimed" entry are both retired.
 *   2. marketing_campaign_ended routes to campaign_orchestrator (the campaign
 *      manager), NOT finance_manager.
 *   3. ai_isa_handoff_to_agent BRANCHES on the contact's type into listing_concierge
 *      (seller) / shopping_agent (buyer) — not a single static "agent handoff" route.
 *   4. agent_escalated_to_human routes to recruiting_manager.
 *
 * PURE + SOURCE (CLAUDE.md §2): every rule is a pure function of SOURCE TEXT (read via
 * readFileSync, comments stripped via scripts/strip-comments.ts — no DB, no mocks) and
 * is POSITIVE-CONTROLLED — proven against a deliberately WRONG fixture snippet that
 * must fail the same rule, so a broken/vacuous parser reads as a failure rather than a
 * silent pass ("if you claim '0 found', prove the finder still recognises the defect
 * it was written for").
 *
 * Run: npx tsx scripts/manager-routing-simulator.ts   (npm run test:manager-routing)
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { SIGNAL_HANDLERS } from "../lib/kernel/manager-signals"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Manager routing whole — every wave-49 kernel-event routing ruling holds.")
  console.log(" MANAGER_ROUTING_PASS")
  process.exit(0)
}

const ROOT = process.cwd()
function readSrc(relPath: string): string {
  return stripComments(readFileSync(`${ROOT}/${relPath}`, "utf8"))
}

// ── Rule 1 — no agent-claim signal ──────────────────────────────────────────
// Pure: true only when BOTH the KernelEvent enum member and the SIGNAL_REGISTRY entry
// are absent. Either one surviving alone would leave a half-retired signal (an enum
// member nothing reads, or a registry entry nothing emits) — both must be gone.
function ruleNoAgentClaimSignal(eventsSrc: string, registrySrc: string): boolean {
  const hasEnumMember = /\bLEAD_CLAIMED\s*=\s*'lead_claimed'/.test(eventsSrc)
  const hasRegistryEntry = /\blead_claimed\s*:\s*\{/.test(registrySrc)
  return !hasEnumMember && !hasRegistryEntry
}

// ── Static (toManager → signalType) pair finder ─────────────────────────────
// Same convention scripts/signal-integrity-simulator.ts's scanRoutedPairs() uses: the
// codebase always writes fromManager → toManager → signalType in that order inside one
// publishManagerSignal({...}) call, so the toManager literal immediately preceding a
// given signalType literal is that route's STATIC destination. Returns null for a
// DYNAMIC route (toManager is a variable, not a string literal) — rule 3 checks those
// separately, since a single static answer would be the wrong shape for a branch.
function findStaticToManager(src: string, signalType: string): string | null {
  const re = /(toManager|signalType):\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g
  let pendingTo: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m[1] === "toManager") {
      pendingTo = /^[a-z_]+$/.test(m[2]) ? m[2] : null // a literal only, never a bare identifier like a variable name
    } else {
      // signalType — resolve against the pair standing right now, then clear it (matching
      // signal-integrity-simulator.ts's scanRoutedPairs convention): a block with no static
      // toManager (a dynamic route, e.g. a bare `toManager,` shorthand) must never let a
      // STALE pendingTo from an earlier block leak onto its own signalType.
      const resolved = m[1] === "signalType" && m[2] === signalType ? pendingTo : null
      pendingTo = null
      if (m[1] === "signalType" && m[2] === signalType) return resolved
    }
  }
  return null
}

// ── Rule 3 — ai_isa_handoff_to_agent branches on contact type ───────────────
// Isolates the event's own reactor block (bounded so a match elsewhere in the 2000+
// line file can never pass this) and requires BOTH agent-side destinations to appear
// as routing candidates AND a `toManager =`/`let toManager` assignment shape — the
// signature of the dynamic branch this ruling requires, not a static single route.
function ruleIsaHandoffBranches(reactorSrc: string): boolean {
  const marker = "KernelEvent.AI_ISA_HANDOFF_TO_AGENT"
  const idx = reactorSrc.indexOf(marker)
  if (idx === -1) return false
  const block = reactorSrc.slice(idx, idx + 1600)
  const hasBothDestinations = block.includes('"listing_concierge"') && block.includes('"shopping_agent"')
  const hasDynamicAssignment = /toManager\s*[:=]/.test(block) && /let\s+toManager/.test(block)
  return hasBothDestinations && hasDynamicAssignment
}

// ── Rule: every RULES consumer has a REAL SIGNAL_HANDLERS entry ─────────────
// "with a real handler" (owner ruling #3, #4) — a routed manager that never actually
// consumes the signal is the exact silent-drop class test:signal-integrity guards; this
// re-checks it narrowly for the four wave-49 types so this proof does not depend on
// that other script staying green to catch a regression here.
function consumerHasHandler(consumer: string, signalType: string): boolean {
  return typeof SIGNAL_HANDLERS[`${consumer}:${signalType}`] === "function"
}

const RULES: Array<{ name: string; run: () => boolean; control: () => boolean }> = [
  {
    name: "no kernel event / signal for an agent claiming a lead (LEAD_CLAIMED retired)",
    run: () => ruleNoAgentClaimSignal(readSrc("lib/kernel/events.ts"), readSrc("lib/kernel/signal-registry.ts")),
    // A fixture that still HAS both halves must correctly FAIL the rule.
    control: () => !ruleNoAgentClaimSignal("LEAD_CLAIMED = 'lead_claimed',", `lead_claimed: { consumers: [] },`),
  },
  {
    name: "marketing_campaign_ended → campaign_orchestrator",
    run: () => findStaticToManager(readSrc("lib/kernel/event-reactor.ts"), "marketing_campaign_ended") === "campaign_orchestrator",
    // The OLD (wrong) routing must correctly fail this same check.
    control: () => findStaticToManager(
      `toManager: "finance_manager", signalType: "marketing_campaign_ended",`, "marketing_campaign_ended",
    ) !== "campaign_orchestrator",
  },
  {
    name: "ai_isa_handoff_to_agent branches on contact type into listing_concierge / shopping_agent",
    run: () => ruleIsaHandoffBranches(readSrc("lib/kernel/event-reactor.ts")),
    // A single static route (the OLD wiring) must correctly fail this check.
    control: () => !ruleIsaHandoffBranches(
      `if (params.event === KernelEvent.AI_ISA_HANDOFF_TO_AGENT) { toManager: "deal_coordinator", signalType: "ai_isa_handoff_to_agent",`,
    ),
  },
  {
    name: "agent_escalated_to_human → recruiting_manager",
    run: () => findStaticToManager(readSrc("lib/kernel/event-reactor.ts"), "agent_escalated_to_human") === "recruiting_manager",
    // The OLD (wrong) routing must correctly fail this same check.
    control: () => findStaticToManager(
      `toManager: "deal_coordinator", signalType: "agent_escalated_to_human",`, "agent_escalated_to_human",
    ) !== "recruiting_manager",
  },
]

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager routing simulator (wave-49 kernel-event routing rulings)")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[1-4 · RULES map, each proven + positive-controlled]")
  for (const rule of RULES) {
    check(rule.name, rule.run())
    check(`[control] ${rule.name} — a wrong fixture is correctly rejected`, rule.control())
  }

  console.log("\n[5 · ai_isa_handoff_to_agent has a REAL handler for every declared consumer]")
  const handoffSpec = SIGNAL_REGISTRY["ai_isa_handoff_to_agent"]
  check("ai_isa_handoff_to_agent is declared 'handled' with listing_concierge + shopping_agent",
    !!handoffSpec && handoffSpec.disposition === "handled" &&
    handoffSpec.consumers.includes("listing_concierge") && handoffSpec.consumers.includes("shopping_agent"),
    JSON.stringify(handoffSpec))
  for (const consumer of handoffSpec?.consumers ?? []) {
    check(`SIGNAL_HANDLERS["${consumer}:ai_isa_handoff_to_agent"] exists`, consumerHasHandler(consumer, "ai_isa_handoff_to_agent"))
  }

  console.log("\n[6 · agent_escalated_to_human has a REAL handler]")
  const escalationSpec = SIGNAL_REGISTRY["agent_escalated_to_human"]
  check("agent_escalated_to_human is declared 'handled' with recruiting_manager",
    !!escalationSpec && escalationSpec.disposition === "handled" && escalationSpec.consumers.includes("recruiting_manager"),
    JSON.stringify(escalationSpec))
  check(`SIGNAL_HANDLERS["recruiting_manager:agent_escalated_to_human"] exists`,
    consumerHasHandler("recruiting_manager", "agent_escalated_to_human"))

  console.log("\n[7 · marketing_campaign_ended is no longer catalogued for finance_manager]")
  const campaignSpec = SIGNAL_REGISTRY["marketing_campaign_ended"]
  check("marketing_campaign_ended's consumers do not include finance_manager",
    !!campaignSpec && !campaignSpec.consumers.includes("finance_manager"), JSON.stringify(campaignSpec))

  console.log("\n[8 · lead_claimed is fully gone from the registry]")
  check("SIGNAL_REGISTRY has no lead_claimed entry", !SIGNAL_REGISTRY["lead_claimed"])
  check("no SIGNAL_HANDLERS key targets lead_claimed",
    !Object.keys(SIGNAL_HANDLERS).some((k) => k.endsWith(":lead_claimed")))

  report()
}

main()
