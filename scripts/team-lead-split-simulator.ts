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
 * THE ENGINE WIRING HAS SHIPPED. 08-team-split resolves the agreement from the
 * live `teams` row (id-spaces verified: transactions.agent_id and
 * commission_distributions.agent_id are AGENTS ids, teams.team_lead_id is a USERS
 * id, so the lead is resolved across before comparing or persisting). The note
 * that used to sit here saying the integration was still pending was left behind
 * by that change and said the opposite of the truth.
 *
 * ── THE OWNER'S RULING ON THE BASE, AND WHY IT IS LOCKED HERE ───────────────
 *
 *   "the decision about team percentage rebasing should be per deal net but all
 *    commission agreements can be negotiated per agent before signing."
 *
 * Stage 07 moves the brokerage's forgone share ACROSS to the agent when the
 * brokerage caps, so a capped agent reaches stage 08 with an inflated net. The
 * standing question was whether the lead's percentage should be re-based onto the
 * PRE-cap portion. It is NOT: the base is the PER-DEAL NET, whatever produced it.
 * An agent who wants different economics negotiates their own term, and
 * `agent_commission_profiles.team_override_percent` is where that term lives —
 * a column that existed on this schema and was read by NOTHING until now, the
 * same defect class as `agents.cap_amount` before m461/m463.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"
import {
  resolveTeamLeadOverride,
  isAgreementEffective,
  pickTeamTerms,
  type TeamLeadAgreement,
  type AgentNegotiatedTermRow,
} from "../lib/commission/team-lead-split"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const LEAD = "lead-uuid", AGENT = "agent-uuid", TEAM = "team-uuid"
const pct = (v: number, source: TeamLeadAgreement["source"] = "team_default"): TeamLeadAgreement =>
  ({ teamId: TEAM, teamLeadId: LEAD, splitType: "percent", splitValue: v, source })
const flat = (v: number): TeamLeadAgreement =>
  ({ teamId: TEAM, teamLeadId: LEAD, splitType: "flat", splitValue: v, source: "team_default" })

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

const TODAY = "2026-08-16"
const term = (o: Partial<AgentNegotiatedTermRow>): AgentNegotiatedTermRow =>
  ({ team_override_percent: null, is_active: true, effective_date: null, ...o })
const TEAM_DEFAULT = { teamSplitType: "percent" as const, teamSplitValue: 25, today: TODAY }

console.log("\n── OWNER RULING: an agent's NEGOTIATED term outranks the team default ──")
{
  check("N1 no negotiated term ⇒ the TEAM DEFAULT applies (25%), sourced as such",
    (() => { const t = pickTeamTerms({ profiles: [], ...TEAM_DEFAULT })
      return t.splitValue === 25 && t.source === "team_default" })())

  check("N2 a negotiated 15% BEATS the team's 25% — this is the whole ruling",
    (() => { const t = pickTeamTerms({ profiles: [term({ team_override_percent: 15 })], ...TEAM_DEFAULT })
      return t.splitValue === 15 && t.source === "agent_negotiated" })())

  check("N3 a negotiated ZERO is a REAL answer ('pays the team nothing'), not 'unset'",
    (() => { const t = pickTeamTerms({ profiles: [term({ team_override_percent: 0 })], ...TEAM_DEFAULT })
      return t.splitValue === 0 && t.source === "agent_negotiated" })())

  check("N4 an INACTIVE profile is ignored even though it carries a term",
    (() => { const t = pickTeamTerms({ profiles: [term({ team_override_percent: 15, is_active: false })], ...TEAM_DEFAULT })
      return t.splitValue === 25 && t.source === "team_default" })())

  check("N5 a term whose effective_date has NOT ARRIVED is ignored (next quarter is not this deal)",
    (() => { const t = pickTeamTerms({ profiles: [term({ team_override_percent: 15, effective_date: "2027-01-01" })], ...TEAM_DEFAULT })
      return t.splitValue === 25 && t.source === "team_default" })())

  check("N6 among in-force terms the LATEST effective_date wins",
    (() => { const t = pickTeamTerms({ profiles: [
        term({ team_override_percent: 12, effective_date: "2026-01-01" }),
        term({ team_override_percent: 18, effective_date: "2026-06-01" }),
      ], ...TEAM_DEFAULT })
      return t.splitValue === 18 })())

  check("N7 a NULL effective_date means 'from the start' and LOSES to a dated term that has arrived",
    (() => { const t = pickTeamTerms({ profiles: [
        term({ team_override_percent: 12, effective_date: null }),
        term({ team_override_percent: 18, effective_date: "2026-06-01" }),
      ], ...TEAM_DEFAULT })
      return t.splitValue === 18 })())

  check("N8 a numeric arriving as a STRING (PostgREST) still counts",
    (() => { const t = pickTeamTerms({ profiles: [term({ team_override_percent: "15.50" })], ...TEAM_DEFAULT })
      return t.splitValue === 15.5 && t.source === "agent_negotiated" })())

  check("N9 a negotiated term is always PERCENT-typed — it cannot become flat dollars",
    pickTeamTerms({ profiles: [term({ team_override_percent: 15 })], teamSplitType: "flat", teamSplitValue: 500, today: TODAY }).splitType === "percent")

  check("N10 the distribution NAMES which term ran, so a CDA is self-evidencing",
    (() => {
      const neg = resolveTeamLeadOverride(100_00, AGENT, pct(15, "agent_negotiated"))
      const def = resolveTeamLeadOverride(100_00, AGENT, pct(25, "team_default"))
      return /negotiated/.test(neg.distribution?.notes ?? "") && /team default/.test(def.distribution?.notes ?? "")
    })())
}

console.log("\n── THE RULED BASE IS THE PER-DEAL NET — a re-base must not land silently ──")
{
  // The ruling declines re-basing onto the pre-cap portion. Nothing in the pure
  // math may quietly start treating the base as anything but the net it is given.
  check("B1 the cut is a percentage of the NET IT IS HANDED, with no second base",
    resolveTeamLeadOverride(100_00, AGENT, pct(25)).leadCents === 25_00
    && resolveTeamLeadOverride(200_00, AGENT, pct(25)).leadCents === 50_00)

  const stage08 = src("lib/commission/waterfall/08-team-split.ts")
  const code08 = stripComments(stage08)
  check("B2 stage 08 passes the POST-cap agentNetCents, not the pre-cap agentPortionCents",
    /netForLead\s*=\s*context\.agentNetCents\s*-\s*totalTeamDeductionCents/.test(code08)
    && !/agentPortionCents/.test(code08))
  // Whitespace-NORMALISED before matching. The ruling is quoted across several
  // comment lines, so a regex run against the raw source depends on where the
  // lines happen to wrap — reflowing a comment would turn this red while the
  // ruling was still recorded, exactly the brittle-probe failure this repo has
  // been bitten by twice.
  // Strip the leading `//` of each comment line BEFORE flattening: a quoted
  // ruling that wraps mid-sentence leaves the marker sitting between two words
  // ("… before // signing"), so whitespace-normalising alone is not enough.
  const flat08 = stage08.replace(/^[ \t]*\/\/[ \t]?/gm, "").replace(/\s+/g, " ")
  check("B3 the RULING is recorded where the next reader will look",
    /per deal net/i.test(flat08) && /negotiated per agent before signing/i.test(flat08))
  check("B4 stage 08 actually READS the negotiated term (not just documents it)",
    /agent_commission_profiles/.test(code08) && /pickTeamTerms\(/.test(code08))
  check("B5 …and checks that read's error — a refusal must not fall back to the team default",
    /negotiatedError/.test(code08))
}

console.log("\n── THE LOOP IS CLOSED: the negotiated term can be SET, not only read ──")
{
  // A term the engine reads and no screen writes is the same defect one level up
  // — exactly what agents.cap_amount was before m461/m463. These assert the whole
  // round trip exists: form → action → column → engine.
  const action = src("app/actions/admin/agent-profile.ts")
  const actionCode = stripComments(action)
  const form = src("app/dashboard/admin/users/[userId]/user-edit-form.tsx")

  check("W1 the admin action WRITES team_override_percent",
    /team_override_percent/.test(actionCode) && /agent_commission_profiles/.test(actionCode))
  check("W2 …validated to the column's REAL bound (99.9999), not a guessed 100",
    /99\.9999/.test(actionCode))
  check("W3 …and an explicit CLEAR (null) is distinguished from 'not supplied' (undefined)",
    /teamOverridePercent\s*!==\s*undefined/.test(actionCode) && /teamOverridePercent\s*===\s*null/.test(actionCode))
  check("W4 …and the write is PROVEN — a zero-row RLS refusal arrives as error:null",
    /\.select\("id"\)/.test(actionCode) && /profileRows/.test(actionCode))
  check("W5 the term is READ from agent_commission_profiles, never off the agents row",
    /from\("agent_commission_profiles"\)[\s\S]{0,200}?team_override_percent/.test(actionCode))
  check("W6 an unreadable term is reported as such, not rendered as 'none negotiated'",
    /teamOverrideUnavailable/.test(actionCode) && /teamOverrideUnavailable/.test(form))
  check("W7 the broker FORM exposes the field (a writer with no screen is no way in)",
    /teamOverridePercent/.test(form) && /team_override_percent/.test(form))
  check("W8 …and a blank field CLEARS the term back to the team default",
    /team_override_percent === ""\s*\?\s*null/.test(form))
}

console.log("\n── NEGATIVE CONTROLS · each rule re-asserted against a broken implementation ──")
{
  type Picker = typeof pickTeamTerms
  const ignoresActive: Picker = (i) => {
    const e = i.profiles.filter(p => p.team_override_percent !== null && p.team_override_percent !== undefined)
    return e.length ? { splitType: "percent", splitValue: Number(e[0].team_override_percent), source: "agent_negotiated" }
                    : { splitType: i.teamSplitType, splitValue: i.teamSplitValue, source: "team_default" }
  }
  const zeroIsUnset: Picker = (i) => {
    const e = i.profiles.filter(p => p.is_active === true && Number(p.team_override_percent) > 0)
    return e.length ? { splitType: "percent", splitValue: Number(e[0].team_override_percent), source: "agent_negotiated" }
                    : { splitType: i.teamSplitType, splitValue: i.teamSplitValue, source: "team_default" }
  }
  const teamWins: Picker = (i) => ({ splitType: i.teamSplitType, splitValue: i.teamSplitValue, source: "team_default" })

  const neg = (name: string, broken: Picker, probe: (p: Picker) => boolean) => {
    const brokenFails = !probe(broken)
    const realPasses = probe(pickTeamTerms)
    check(`NEGATIVE CONTROL ${name} — went RED as required`, brokenFails && realPasses)
  }

  neg("a picker that ignores is_active", ignoresActive,
    (p) => p({ profiles: [term({ team_override_percent: 15, is_active: false })], ...TEAM_DEFAULT }).splitValue === 25)
  neg("a picker that reads a negotiated 0 as 'unset'", zeroIsUnset,
    (p) => p({ profiles: [term({ team_override_percent: 0 })], ...TEAM_DEFAULT }).source === "agent_negotiated")
  neg("a picker where the TEAM DEFAULT beats the signed term (the ruling inverted)", teamWins,
    (p) => p({ profiles: [term({ team_override_percent: 15 })], ...TEAM_DEFAULT }).splitValue === 15)
  neg("a picker that ignores effective_date", ignoresActive,
    (p) => p({ profiles: [term({ team_override_percent: 15, effective_date: "2027-01-01" })], ...TEAM_DEFAULT }).splitValue === 25)
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
