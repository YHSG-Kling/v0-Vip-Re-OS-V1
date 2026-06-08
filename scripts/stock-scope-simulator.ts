#!/usr/bin/env tsx
/**
 * scripts/stock-scope-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — verifies the stock-asset (uploaded b-roll / bookends / music)
 * resolution cascade: an agent render inherits agent → team → brokerage stock
 * (most specific wins), so b-roll uploaded by ANY of agent/team/brokerage is
 * available where it should be. Pure — runs fully in CI.
 *
 * Run:  npx tsx scripts/stock-scope-simulator.ts   (npm run test:stock-scope)
 */
import { resolveStockScopeOrder } from "../lib/remotion/stock-scope"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const order = (a: { scopeType: string; scopeId: string }[]) => a.map((r) => `${r.scopeType}:${r.scopeId}`).join(" → ")

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Stock-asset scope cascade simulator")
  console.log("══════════════════════════════════════════════════")
  const BRK = "brk-1", AGENT = "agt-1", TEAM = "team-1"

  console.log("\n[agent render]")
  const agentWithTeam = resolveStockScopeOrder({ scopeType: "agent", scopeId: AGENT, brokerageId: BRK }, TEAM)
  check("agent on a team cascades agent → team → brokerage", order(agentWithTeam) === `agent:${AGENT} → team:${TEAM} → brokerage:${BRK}`)
  check("team tier IS included (the bug this fixes)", agentWithTeam.some((r) => r.scopeType === "team" && r.scopeId === TEAM))

  const agentNoTeam = resolveStockScopeOrder({ scopeType: "agent", scopeId: AGENT, brokerageId: BRK }, null)
  check("agent with no team → agent → brokerage (no regression, team skipped)", order(agentNoTeam) === `agent:${AGENT} → brokerage:${BRK}`)

  console.log("\n[team + brokerage renders]")
  check("team render → team → brokerage", order(resolveStockScopeOrder({ scopeType: "team", scopeId: TEAM, brokerageId: BRK })) === `team:${TEAM} → brokerage:${BRK}`)
  check("brokerage render → brokerage only (no fallback)", order(resolveStockScopeOrder({ scopeType: "brokerage", scopeId: BRK, brokerageId: BRK })) === `brokerage:${BRK}`)

  console.log("\n[edge cases]")
  check("multi_location render falls back to brokerage", order(resolveStockScopeOrder({ scopeType: "multi_location", scopeId: "ml-1", brokerageId: BRK })) === `multi_location:ml-1 → brokerage:${BRK}`)
  // Dedupe: an agent whose scopeId happens to equal the brokerageId, no team.
  const dup = resolveStockScopeOrder({ scopeType: "agent", scopeId: BRK, brokerageId: BRK }, null)
  check("no duplicate scope entries when ids collide", dup.length === new Set(dup.map((r) => `${r.scopeType}:${r.scopeId}`)).size)
  check("most-specific scope is always tried first", resolveStockScopeOrder({ scopeType: "agent", scopeId: AGENT, brokerageId: BRK }, TEAM)[0].scopeType === "agent")
  check("empty/missing team id does not inject a blank scope", resolveStockScopeOrder({ scopeType: "agent", scopeId: AGENT, brokerageId: BRK }, "").every((r) => r.scopeId.length > 0))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Stock cascade verified — agent inherits team + brokerage b-roll")
}
main()
