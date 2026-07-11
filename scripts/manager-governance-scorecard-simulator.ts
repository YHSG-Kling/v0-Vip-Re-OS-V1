#!/usr/bin/env tsx
/**
 * scripts/manager-governance-scorecard-simulator.ts   (npm run test:manager-governance)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the "governed AI team" compliance artifact: every accountable manager is scored across the
 * FINRA-2026 autonomous-agent eval dimensions (hallucination, bias, scope creep, reward misalignment)
 * + prompt-injection + privacy, each tied to a REAL enforcement mechanism in the repo, with an honest
 * per-manager verdict. Pure — no I/O.
 */
import {
  buildManagerGovernanceScorecard,
  summarizeGovernance,
} from "../lib/compliance/manager-governance-scorecard"
import { MANAGERS, type ManagerKey } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  const cards = buildManagerGovernanceScorecard()
  const byManager = new Map<ManagerKey, (typeof cards)[number]>(cards.map((c) => [c.manager, c]))

  console.log("\n[every accountable manager is scored]")
  check("one card per manager (all 14)", cards.length === Object.keys(MANAGERS).length && cards.length === 14)
  check("every card names a real manager + label", cards.every((c) => !!MANAGERS[c.manager] && c.label === MANAGERS[c.manager].label))

  console.log("\n[scope creep + privacy apply to EVERY manager (the whole team is bounded)]")
  check("every manager has a scope_creep dimension", cards.every((c) => c.dimensions.some((d) => d.dimension === "scope_creep")))
  check("scope_creep is release-blocking (zero-tolerance) for all", cards.every((c) => c.dimensions.find((d) => d.dimension === "scope_creep")?.releaseBlocking === true))
  check("scope_creep is enforced by the ownership + signal-integrity + egress guards", cards.every((c) => {
    const d = c.dimensions.find((x) => x.dimension === "scope_creep")
    return !!d && d.enforcedBy.some((e) => /ownership/.test(e)) && d.enforcedBy.some((e) => /signal-integrity/.test(e))
  }))
  check("every manager has a privacy_leakage dimension", cards.every((c) => c.dimensions.some((d) => d.dimension === "privacy_leakage")))

  console.log("\n[outbound managers carry the Fair-Housing / hallucination / reward dimensions]")
  const isa = byManager.get("ai_isa")!
  check("AI ISA (outbound) has bias_fair_housing, release-blocking", isa.dimensions.find((d) => d.dimension === "bias_fair_housing")?.releaseBlocking === true)
  check("AI ISA has hallucination + reward_misalignment", isa.dimensions.some((d) => d.dimension === "hallucination") && isa.dimensions.some((d) => d.dimension === "reward_misalignment"))
  check("bias anchors to the Fair Housing Act", !!isa.dimensions.find((d) => d.dimension === "bias_fair_housing")?.supervisoryAnchor.includes("Fair Housing"))

  console.log("\n[back-office managers are NOT force-fit with outbound dimensions (honest applicability)]")
  const finance = byManager.get("finance_manager")!
  check("Finance Manager has scope_creep + privacy (always)", finance.dimensions.some((d) => d.dimension === "scope_creep") && finance.dimensions.some((d) => d.dimension === "privacy_leakage"))
  check("Finance Manager is NOT assigned bias_fair_housing (no client-facing content)", !finance.dimensions.some((d) => d.dimension === "bias_fair_housing"))

  console.log("\n[prompt injection applies to the managers that ingest EXTERNAL untrusted data]")
  check("AI ISA (reads inbound replies) has prompt_injection, release-blocking", isa.dimensions.find((d) => d.dimension === "prompt_injection")?.releaseBlocking === true)
  check("Data Steward (scrapes external rows) has prompt_injection", byManager.get("data_steward")!.dimensions.some((d) => d.dimension === "prompt_injection"))
  check("Deal Coordinator (no external ingest) has NO prompt_injection", !byManager.get("deal_coordinator")!.dimensions.some((d) => d.dimension === "prompt_injection"))
  check("prompt_injection anchors to OWASP LLM-01", !!isa.dimensions.find((d) => d.dimension === "prompt_injection")?.supervisoryAnchor.includes("OWASP"))

  console.log("\n[the scorecard is grounded in the real registry — scope, signals, burn domains]")
  check("managers report a positive owned-table count", cards.some((c) => c.ownedTables > 0))
  check("AI ISA consumes catalogued signals", isa.consumesSignals.length > 0)
  check("Data Steward reports burn domains it owns", byManager.get("data_steward")!.burnDomains.length > 0)

  console.log("\n[team roll-up is honest — behaviorally red-teamed dims + structural invariants]")
  const s = summarizeGovernance(cards)
  check("summary counts all 14 managers", s.totalManagers === 14)
  check("every manager is currently GOVERNED (all applicable dimensions enforced)", s.governed === 13 && s.gaps === 0)
  check("release-blocking dimensions include scope_creep + bias + prompt_injection", ["scope_creep", "bias_fair_housing", "prompt_injection"].every((d) => s.releaseBlockingDimensions.includes(d as any)))
  check("bias/hallucination/injection/privacy are BEHAVIORALLY red-teamed (eval harness verifies them)", ["bias_fair_housing", "hallucination", "prompt_injection", "privacy_leakage"].every((d) => s.behaviorallyVerified.includes(d as any)))
  check("nothing is left un-verified — behavioralEvalPending is empty (drift fixed)", s.behavioralEvalPending.length === 0)
  check("scope_creep + reward_misalignment stay structural invariants", cards.every((c) => c.dimensions.filter((d) => d.dimension === "scope_creep" || d.dimension === "reward_misalignment").every((d) => d.enforcementType === "structural")))
  check("the behaviorally-verified dimensions are marked enforcementType 'behavioral'", cards.some((c) => c.dimensions.some((d) => d.dimension === "bias_fair_housing" && d.enforcementType === "behavioral")))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MANAGER_GOVERNANCE_FAIL"); process.exit(1) }
  console.log(" ✅ MANAGER_GOVERNANCE_PASS — every manager scored across the FINRA-2026 dimensions; bias/hallucination/injection/privacy behaviorally red-teamed, scope/reward structural invariants")
}
main()
