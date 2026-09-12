#!/usr/bin/env tsx
/**
 * scripts/team-membership-simulator.ts  (npm run test:team-membership)
 *
 * Proves the TEAM-MEMBER write path that was missing: teams could be created and the team
 * dashboard + the Finance commission waterfall both READ team_members, but nothing populated it,
 * so a team's commission split was always a no-op. This proves the rules + that members landing in
 * team_members are actually consumed by applyTeamSplit (the loop: Recruiting builds the roster →
 * Finance splits by it).
 *
 *  - PURE: validateTeamMember (split bounds, source-of-funds, the >100% agent-funded cap) +
 *    agentFundedTotal.
 *  - LIVE (creds-gated, self-cleaning): seed a team + an agent + two team_members (agent-funded +
 *    brokerage-funded), run applyTeamSplit, assert ONLY the agent-funded split is deducted.
 */
import { randomUUID } from "node:crypto"
import { validateTeamMember, agentFundedTotal } from "../lib/teams/membership"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[team-member rules · pure]")
  check("valid 30% agent-funded passes", validateTeamMember({ splitPercent: 30, sourceOfFunds: "agent" }).ok)
  check("0% rejected", !validateTeamMember({ splitPercent: 0, sourceOfFunds: "agent" }).ok)
  check("101% rejected", !validateTeamMember({ splitPercent: 101, sourceOfFunds: "agent" }).ok)
  check("bad source rejected", !validateTeamMember({ splitPercent: 30, sourceOfFunds: "client" as never }).ok)
  check("agent-funded cap: 80% existing + 30% new ⇒ rejected (>100%)", !validateTeamMember({ splitPercent: 30, sourceOfFunds: "agent", existingAgentFundedPct: 80 }).ok)
  check("agent-funded cap: 80% existing + 20% new ⇒ ok (=100%)", validateTeamMember({ splitPercent: 20, sourceOfFunds: "agent", existingAgentFundedPct: 80 }).ok)
  check("brokerage-funded ignores the agent cap", validateTeamMember({ splitPercent: 60, sourceOfFunds: "brokerage", existingAgentFundedPct: 80 }).ok)
  check("agentFundedTotal sums only active agent-funded", agentFundedTotal([
    { split_percent: 30, source_of_funds: "agent" },
    { split_percent: 20, source_of_funds: "brokerage" },
    { split_percent: 10, source_of_funds: "agent", is_active: false },
  ]) === 30)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[team membership · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the rules")
    return
  }
  console.log("\n[team membership · live — seed members → applyTeamSplit consumes them → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { applyTeamSplit } = await import("../lib/commission/waterfall/08-team-split")
  const svc = createServiceClient()
  const tag = `tm-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const teamId = randomUUID()
  const agentUserId = randomUUID()
  const agentId = randomUUID()
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (team test)` })
    await svc.from("users").insert({ id: agentUserId, brokerage_id: brokerageId, email: `${tag}@example.com`, first_name: "Team", last_name: tag, user_type: "agent" })
    await svc.from("agents").insert({ id: agentId, brokerage_id: brokerageId, user_id: agentUserId })
    await svc.from("teams").insert({ id: teamId, brokerage_id: brokerageId, name: `${tag} team`, team_lead_id: agentUserId })
    await svc.from("team_members").insert([
      { team_id: teamId, agent_id: agentId, brokerage_id: brokerageId, role: "buyers_agent", split_percent: 30, source_of_funds: "agent", is_active: true },
      { team_id: teamId, agent_id: agentId, brokerage_id: brokerageId, role: "isa", split_percent: 20, source_of_funds: "brokerage", is_active: true },
    ])

    // ── THE RULING (2026-08-28, closing the last m575 sibling): a
    // brokerage-funded member's share comes from the DEAL'S COMPANY DOLLAR
    // (deducted from brokerageFinalCents, conserving step 11's identity), and
    // when the deal cannot fund it — post-cap that dollar is $0 — it routes
    // WHOLE to company books (m577), never dropped and never an identity
    // violation. The retired assertion here pinned the defect itself:
    // "tracked but not deducted" was deducted from NOTHING, and step 11 failed
    // every deal carrying such a row.

    // Case 1 — the deal CAN fund the brokerage member (pre-cap company dollar).
    const funded = await applyTeamSplit({
      agentId, brokerageId, agentNetCents: 10000, brokerageFinalCents: 2500, capStatus: "pre_cap",
    } as unknown as Parameters<typeof applyTeamSplit>[0])
    check("funded: both members produce distributions", (funded.teamDistributions?.length ?? 0) === 2)
    check("funded: only the agent-funded 30% is deducted from the agent (10000 → 7000)", funded.agentFinalNetCents === 7000)
    check("funded: the brokerage-funded 20% is deducted from the COMPANY dollar (2500 → 500)", funded.brokerageFinalCents === 500)
    check("funded: no company-books obligation arises", (funded.companyObligations?.length ?? 0) === 0)

    // Case 2 — post-cap: the deal has NO company dollar to fund the member.
    const postCap = await applyTeamSplit({
      agentId, brokerageId, agentNetCents: 10000, brokerageFinalCents: 0, capStatus: "post_cap",
    } as unknown as Parameters<typeof applyTeamSplit>[0])
    check("post-cap: the agent-funded member still distributes in-deal", (postCap.teamDistributions ?? []).filter((d) => d.source_of_funds === "agent").length === 1)
    check("post-cap: the brokerage-funded member is NOT an in-deal distribution", !(postCap.teamDistributions ?? []).some((d) => d.source_of_funds === "brokerage"))
    check("post-cap: it is a company-books obligation instead (type team_member, whole share)",
      (postCap.companyObligations ?? []).some((o) => o.obligation_type === "team_member" && o.calculated_amount === 20))
    check("post-cap: the company dollar is not driven negative", postCap.brokerageFinalCents === 0)
  } finally {
    await svc.from("team_members").delete().eq("team_id", teamId)
    await svc.from("teams").delete().eq("id", teamId)
    await svc.from("agents").delete().eq("id", agentId)
    await svc.from("users").delete().eq("id", agentUserId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("team_members").select("id", { count: "exact", head: true }).eq("team_id", teamId)
    check("cleanup complete — zero tagged rows remain", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TEAM_MEMBERSHIP_FAIL"); process.exit(1) }
  console.log(" ✅ TEAM_MEMBERSHIP_PASS — members can be assigned with splits, and Finance splits by them")
}

main().catch((e) => { console.error(e); process.exit(1) })
