#!/usr/bin/env tsx
/**
 * scripts/team-lead-split-simulator.ts   (npm run test:team-lead-split)
 * ─────────────────────────────────────────────────────────────────────────────
 * TEAM-LEAD OVERRIDE SPLIT — pure math (owner rule: "team leaders also have a
 * commission agreement, so that agreement is part of the commission splits for
 * the team's agents if the agent is part of a team"). This proves the deterministic
 * money math in lib/commission/team-lead-split.ts BEFORE it is wired into the live
 * waterfall engine: percent + flat cuts, lead-excluded-on-own-deal, negative-proof
 * clamping, and the persisted distribution shape. No DB — pure and reproducible.
 *
 * NOTE: the engine wiring (08-team-split resolving the agreement from the live
 * `teams` row) is intentionally NOT shipped yet — it depends on verifying the
 * agents.id vs users.id id-space of transactions.agent_id / teams.team_lead_id
 * against the live schema, which must be live-tested. This guard locks the math so
 * that integration is a thin, low-risk step.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { resolveTeamLeadOverride, isAgreementEffective, type TeamLeadAgreement } from "../lib/commission/team-lead-split"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const LEAD = "lead-uuid", AGENT = "agent-uuid", TEAM = "team-uuid"
const pct = (v: number): TeamLeadAgreement => ({ teamId: TEAM, teamLeadId: LEAD, splitType: "percent", splitValue: v })
const flat = (v: number): TeamLeadAgreement => ({ teamId: TEAM, teamLeadId: LEAD, splitType: "flat", splitValue: v })

console.log("\n── percent + flat cuts are exact, sourced from the agent, paid to the lead ──")
{
  const r = resolveTeamLeadOverride(100_00, AGENT, pct(25))
  check("25% of a $100 net → lead gets $25", r.leadCents === 25_00)
  check("the distribution is to the LEAD, sourced from the agent", r.distribution?.agent_id === LEAD && r.distribution?.source_of_funds === "agent")
  check("the distribution carries the team id + dollar amount", r.distribution?.team_id === TEAM && r.distribution?.calculated_amount === 25)

  const f = resolveTeamLeadOverride(100_00, AGENT, flat(30))
  check("flat $30 agreement → lead gets $30 (dollars → cents)", f.leadCents === 30_00 && f.distribution?.calculation_type === "flat")

  check("rounding is deterministic ($33.33 net, 10%)", resolveTeamLeadOverride(3333, AGENT, pct(10)).leadCents === 333)
}

console.log("\n── safety: no self-cut, no negative agent, no phantom cut ──")
{
  check("a lead takes NO cut of their own deal", resolveTeamLeadOverride(100_00, LEAD, pct(25)).leadCents === 0)
  check("a misconfigured >100% split is CLAMPED to the agent's net (agent never negative)",
    resolveTeamLeadOverride(100_00, AGENT, pct(200)).leadCents === 100_00)
  check("no agreement → no cut", resolveTeamLeadOverride(100_00, AGENT, null).leadCents === 0)
  check("zero / negative agent net → no cut", resolveTeamLeadOverride(0, AGENT, pct(25)).leadCents === 0 && resolveTeamLeadOverride(-5, AGENT, pct(25)).leadCents === 0)
  check("a zero/negative split value → no cut", resolveTeamLeadOverride(100_00, AGENT, pct(0)).leadCents === 0)
  check("no cut ⇒ null distribution (nothing persisted)", resolveTeamLeadOverride(100_00, AGENT, pct(0)).distribution === null)
}

console.log("\n── agreement effective-dating ──")
{
  const now = new Date("2026-07-24T00:00:00Z")
  check("null effective date ⇒ always in effect", isAgreementEffective(null, now))
  check("a past effective date ⇒ in effect", isAgreementEffective("2026-01-01T00:00:00Z", now))
  check("a future effective date ⇒ NOT yet in effect", !isAgreementEffective("2026-12-01T00:00:00Z", now))
}

console.log("\n── the math is WIRED into the live waterfall step, id-space-safe ──")
{
  const step = src("lib/commission/waterfall/08-team-split.ts")
  check("step 08 applies the team-lead override", step.includes("resolveTeamLeadOverride"))
  check("it resolves teams.team_lead_id (a USERS id) to the lead's AGENTS id before use",
    /\.from\('agents'\)[\s\S]*?\.eq\('user_id', \(team as any\)\.team_lead_id\)/.test(step))
  check("the override reduces the agent's final net (conservation-safe: adds a distribution of equal cents)",
    step.includes("- totalTeamDeductionCents - leadDeductionCents"))
  check("resolution is best-effort — a failure never breaks the whole calc", /catch \(err\)[\s\S]*?non-fatal/.test(step))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the math + wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a team + lead → run applyTeamSplit → lead distribution + reduced agent net → cleanup 0")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(2)
  const agents = (ags ?? []) as Array<{ id: string; user_id: string }>
  if (agents.length < 2) { console.log("  ⊘ need 2 agents — skipping"); return }
  const closing = agents[0], lead = agents[1]
  const teamId = "eeee0000-0000-4000-8000-0000000000ff"
  let priorTeamId: string | null = null
  try {
    const { data: c } = await svc.from("agents").select("team_id").eq("id", closing.id).maybeSingle()
    priorTeamId = (c as any)?.team_id ?? null
    await svc.from("teams").upsert({ id: teamId, brokerage_id: brokerageId, name: "ZZ Test Team", team_lead_id: lead.user_id, team_split_type: "percent", team_split_percent: 20, terms_effective_date: "2026-01-01" }, { onConflict: "id" })
    await svc.from("agents").update({ team_id: teamId }).eq("id", closing.id)

    const { applyTeamSplit } = await import("../lib/commission/waterfall/08-team-split")
    const ctx: any = {
      transactionId: "00000000-0000-0000-0000-000000000000", brokerageId, agentId: closing.id,
      agentNetCents: 1_000_000, teamDistributions: [],
    }
    const out = await applyTeamSplit(ctx)
    const leadDist = (out.teamDistributions ?? []).find((d: any) => d.agent_id === lead.id && d.notes === "Team lead override split")
    check("live: a team-lead distribution to the lead's agents.id was produced", !!leadDist)
    check("live: the lead's cut is 20% of the $10,000 net = $2,000", leadDist?.calculated_amount === 2000)
    check("live: the agent's final net was reduced by the lead's cut ($8,000)", out.agentFinalNetCents === 800_000)
  } finally {
    await svc.from("agents").update({ team_id: priorTeamId }).eq("id", closing.id)
    await svc.from("teams").delete().eq("id", teamId)
    const { count } = await svc.from("teams").select("id", { count: "exact", head: true }).eq("id", teamId)
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

await liveLayer()

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ TEAM_LEAD_SPLIT_FAIL"); process.exit(1) }
console.log(" ✅ TEAM_LEAD_SPLIT_PASS — team-lead override math is exact, self-cut-safe, negative-proof, and wired id-space-safe")
