#!/usr/bin/env tsx
/**
 * scripts/switch-propensity-simulator.ts   (npm run test:switch-propensity)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the RECRUIT SWITCH-PROPENSITY SCOUT — the marquee recruiting play. Each prospect is scored on
 * intent + production value + mobility, the pipeline is ranked, and a weekly gated "prioritize these
 * agents" brief is proposed to the broker. Nothing auto-sends.
 *
 * PURE:   computeSwitchPropensity (intent 45% / value 35% / mobility 20%, honest on missing) +
 *         rankRecruitsByPropensity + buildPriorityBrief (top hot/warm only) + isoWeekKey.
 * SOURCE: the scout proposes ONE gated weekly brief (idempotent per brokerage+week); rides the recruit
 *         cron; owned by recruiting_manager.
 * LIVE (creds-gated): seed a hot + a cool recruit → scout proposes a brief naming the hot one → idempotent
 *         second run adds nothing → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { computeSwitchPropensity, rankRecruitsByPropensity } from "../lib/recruiting/switch-propensity"
import { buildPriorityBrief, isoWeekKey } from "../lib/recruiting/switch-propensity-scout"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[computeSwitchPropensity · pure — intent + value + mobility]")
  const hot = computeSwitchPropensity({ referralSource: "reddit_switch_intent", annualVolume: 8_000_000, yearsExperience: 7 })
  check("switch-intent + high volume + mid-career → HOT (≥0.7)", hot.tier === "hot" && hot.score >= 0.7)
  const cold = computeSwitchPropensity({ referralSource: "cold_scrape", annualVolume: 200_000, yearsExperience: 1 })
  check("cold source + low volume + rookie → COOL", cold.tier === "cool" && cold.score < 0.5)
  const inbound = computeSwitchPropensity({ referralSource: "public_landing", annualVolume: 4_000_000, yearsExperience: 9 })
  check("inbound (they came to us) scores high on intent", inbound.score >= 0.7)
  check("switch-intent outranks a cold source at equal value/experience",
    computeSwitchPropensity({ referralSource: "thinking of switching", annualVolume: 3_000_000, yearsExperience: 6 }).score >
    computeSwitchPropensity({ referralSource: "cold", annualVolume: 3_000_000, yearsExperience: 6 }).score)
  check("a $10M producer outscores a $500k one at equal intent/experience",
    computeSwitchPropensity({ referralSource: "referral", annualVolume: 10_000_000, yearsExperience: 8 }).score >
    computeSwitchPropensity({ referralSource: "referral", annualVolume: 500_000, yearsExperience: 8 }).score)
  check("mid-career beats a 25-yr veteran at equal intent/value (mobility)",
    computeSwitchPropensity({ referralSource: "referral", annualVolume: 3_000_000, yearsExperience: 7 }).score >
    computeSwitchPropensity({ referralSource: "referral", annualVolume: 3_000_000, yearsExperience: 25 }).score)
  const missing = computeSwitchPropensity({ referralSource: null, annualVolume: null, yearsExperience: null })
  check("all-missing → a real neutral score, never fabricated high", missing.score > 0 && missing.score < 0.6 && missing.reasons.length > 0)
  check("score is clamped 0..1", hot.score <= 1 && cold.score >= 0)

  console.log("\n[rankRecruitsByPropensity + buildPriorityBrief · pure]")
  const ranked = rankRecruitsByPropensity([
    { id: "a", first_name: "Cold", last_name: "Rookie", referralSource: "cold", annualVolume: 100_000, yearsExperience: 1 },
    { id: "b", first_name: "Hot", last_name: "Producer", referralSource: "reddit_switch_intent", annualVolume: 9_000_000, yearsExperience: 8 },
    { id: "c", first_name: "Warm", last_name: "Referral", referralSource: "agent_referral", annualVolume: 2_000_000, yearsExperience: 5 },
  ])
  check("highest-propensity first", ranked[0].recruitId === "b")
  const brief = buildPriorityBrief(ranked)!
  check("brief names the hot target + a score", /Hot Producer/.test(brief.body) && /%/.test(brief.body))
  check("brief EXCLUDES cool prospects (only worth-it targets)", !/Cold Rookie/.test(brief.body))
  check("all-cool pipeline → no brief (honest — nothing to prioritize)", buildPriorityBrief(rankRecruitsByPropensity([{ id: "x", first_name: "Only", last_name: "Cool", referralSource: "cold", annualVolume: 0, yearsExperience: 1 }])) === null)
  check("isoWeekKey is stable YYYY-Www", /^\d{4}-W\d{2}$/.test(isoWeekKey(new Date("2026-06-30T00:00:00Z"))))
}

function sourceLayer() {
  console.log("\n[wiring — gated weekly brief; rides the recruit cron; owned]")
  const scout = src("lib/recruiting/switch-propensity-scout.ts")
  check("scout proposes a GATED brief (nothing auto-sends)", /proposeClientMessage\(\{[\s\S]*?agentKind: "recruiting_manager"[\s\S]*?entityType: "brokerage"/.test(scout))
  check("idempotent per (brokerage, ISO week)", /RECRUIT PRIORITY BRIEF — \$\{isoWeekKey\(now\)\}/.test(scout))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly recruit-outreach cron runs the scout", /runSwitchPropensityScoutAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /recruit_switch_propensity:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:switch-propensity"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a hot + a cool recruit → scout brief → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: hot } = await svc.from("recruits").insert({ brokerage_id: brokerageId, first_name: "HotScout", last_name: "Target", status: "prospect", referral_source: "reddit_switch_intent", annual_volume: 9_000_000, years_experience: 8 }).select("id").single()
    cleanup.push({ table: "recruits", id: (hot as any).id })
    const { data: cool } = await svc.from("recruits").insert({ brokerage_id: brokerageId, first_name: "CoolScout", last_name: "Rookie", status: "prospect", referral_source: "cold", annual_volume: 100_000, years_experience: 1 }).select("id").single()
    cleanup.push({ table: "recruits", id: (cool as any).id })

    const { runSwitchPropensityScout } = await import("../lib/recruiting/switch-propensity-scout")
    const r1 = await runSwitchPropensityScout(svc as any, { brokerageId })
    check("live: scored the pipeline + proposed a priority brief", r1.scored >= 2 && r1.briefProposed)
    const { data: msg } = await svc.from("agent_client_messages").select("id, body").eq("brokerage_id", brokerageId).eq("entity_type", "brokerage").eq("entity_id", brokerageId).eq("agent_kind", "recruiting_manager").ilike("rationale", "RECRUIT PRIORITY BRIEF%").maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("live: the brief names the hot target (not the cool one)", /HotScout Target/.test((msg as any)?.body ?? "") && !/CoolScout Rookie/.test((msg as any)?.body ?? ""))

    const r2 = await runSwitchPropensityScout(svc as any, { brokerageId })
    check("live: idempotent — no second brief this week", r2.briefProposed === false)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SWITCH_PROPENSITY_FAIL"); process.exit(1) }
  console.log(" ✅ SWITCH_PROPENSITY_PASS — the pipeline is ranked by switch-propensity; the broker gets the best talent first")
}
main()
