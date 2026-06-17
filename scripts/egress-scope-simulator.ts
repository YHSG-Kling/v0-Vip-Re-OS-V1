#!/usr/bin/env tsx
/**
 * scripts/egress-scope-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves EGRESS SCOPE — one resolver for "what does this user oversee?" across every tier: solo agent
 * (own work), team lead (their team), broker/admin (the brokerage), and a MULTI-LOCATION brokerage's
 * location admin (their location) vs the brokerage admin (all locations). The scope drives the column
 * filters the Command Center / egress loaders apply, so the multi-location, team, and role tiers are
 * real instead of one undifferentiated pool. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/egress-scope-simulator.ts   (npm run test:egress-scope)
 */
import { resolveEgressScope, scopeFilter, describeScope } from "../lib/kernel/egress-scope"

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
  console.log(" ✅ Egress scope verified — every tier sees exactly its slice; multi-location is real.")
  console.log(" EGRESS_SCOPE_PASS")
  process.exit(0)
}

const B = "brokerage-1"

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Egress scope simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[scope resolution per tier]")
  const broker = resolveEgressScope({ userType: "broker", userId: "u1", brokerageId: B })
  check("broker → brokerage scope, ALL locations", broker.kind === "brokerage" && broker.seesAllLocations)

  const orgAdmin = resolveEgressScope({ userType: "admin", userId: "u2", brokerageId: B })
  check("admin with no location → brokerage-wide (single office)", orgAdmin.kind === "brokerage" && orgAdmin.seesAllLocations)

  const locAdmin = resolveEgressScope({ userType: "admin", userId: "u3", brokerageId: B, locationId: "loc-west" })
  check("admin WITH a location → location scope (multi-location office admin)", locAdmin.kind === "location" && locAdmin.locationId === "loc-west" && !locAdmin.seesAllLocations)

  const teamLead = resolveEgressScope({ userType: "team_lead", userId: "u4", brokerageId: B, teamId: "team-a" })
  check("team_lead with a team → team scope", teamLead.kind === "team" && teamLead.teamId === "team-a")

  const teamLeadNoTeam = resolveEgressScope({ userType: "team_lead", userId: "u4b", brokerageId: B })
  check("team_lead with NO team → falls back to own work", teamLeadNoTeam.kind === "agent" && teamLeadNoTeam.agentUserId === "u4b")

  const agent = resolveEgressScope({ userType: "agent", userId: "u5", brokerageId: B })
  check("agent → own work only", agent.kind === "agent" && agent.agentUserId === "u5")

  const isa = resolveEgressScope({ userType: "isa", userId: "u6", brokerageId: B })
  const staff = resolveEgressScope({ userType: "staff", userId: "u7", brokerageId: B })
  check("isa + staff → own work (not brokerage-wide)", isa.kind === "agent" && staff.kind === "agent")

  console.log("\n[scope → query filters]")
  check("agent filter narrows to brokerage + agent", (() => { const f = scopeFilter(agent); return f.brokerage_id === B && f.agent_user_id === "u5" && !f.location_id && !f.team_id })())
  check("location filter narrows to brokerage + location", (() => { const f = scopeFilter(locAdmin); return f.brokerage_id === B && f.location_id === "loc-west" && !f.agent_user_id })())
  check("team filter narrows to brokerage + team", (() => { const f = scopeFilter(teamLead); return f.brokerage_id === B && f.team_id === "team-a" })())
  check("brokerage filter is tenant-only (sees all)", (() => { const f = scopeFilter(broker); return f.brokerage_id === B && !f.location_id && !f.team_id && !f.agent_user_id })())

  console.log("\n[scope labels]")
  check("labels read for a human header", describeScope(broker) === "Brokerage — all locations" && describeScope(locAdmin) === "This location" && describeScope(teamLead) === "My team" && describeScope(agent) === "My work")

  // The multi-location invariant: two location admins NEVER see each other's location.
  const east = resolveEgressScope({ userType: "admin", userId: "ue", brokerageId: B, locationId: "loc-east" })
  check("two location admins are isolated (no cross-location leakage)", scopeFilter(locAdmin).location_id !== scopeFilter(east).location_id)

  report()
}

main()
