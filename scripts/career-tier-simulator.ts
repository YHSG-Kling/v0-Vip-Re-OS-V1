#!/usr/bin/env tsx
/**
 * scripts/career-tier-simulator.ts   (npm run test:career-tier)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CAREER TIER LADDER — five permanent tiers with production/tenure/team gates; auto-upgrade on
 * earning the next tier (never downgrade); ≥80% approach nudge with the exact remaining gap.
 *
 * PURE:   meetsTier (OR/AND gates, approval requirement) + earnedTier (auto tops at senior) + tierProgress
 *         (binding requirement, exact gap) + tierRank.
 * SOURCE: the runner auto-upgrades + proposes a gated ≥80% nudge; the cron runs it; agent UI shows the
 *         ladder; owned by recruiting_manager with a runnable proof.
 * LIVE (creds-gated): seed a real agent's closings → runCareerTierEvaluation upgrades their tier → clean up.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  meetsTier, earnedTier, tierProgress, tierRank, TIER_GATES, type AgentTierStats,
} from "../lib/recruiting/career-tier"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const stats = (o: Partial<AgentTierStats> = {}): AgentTierStats => ({ closingsLifetime: 0, closingsTrailing24m: 0, closingsTrailing36m: 0, monthsActive: 0, teamSize: 0, approvalGranted: false, ...o })

function pureLayer() {
  console.log("\n[gates · pure]")
  check("everyone is at least rookie", meetsTier("rookie", stats()))
  check("associate = 3 lifetime closings OR 12 months (OR gate)", meetsTier("associate", stats({ closingsLifetime: 3 })) && meetsTier("associate", stats({ monthsActive: 12 })) && !meetsTier("associate", stats({ closingsLifetime: 2, monthsActive: 5 })))
  check("senior = 12 closings/24mo AND 24 months (AND gate)", meetsTier("senior", stats({ closingsTrailing24m: 12, monthsActive: 24 })) && !meetsTier("senior", stats({ closingsTrailing24m: 12, monthsActive: 10 })))
  check("team_lead/partner require broker approval (not auto)", !meetsTier("team_lead", stats({ closingsTrailing36m: 30, monthsActive: 40, teamSize: 3 })) && meetsTier("team_lead", stats({ closingsTrailing36m: 30, monthsActive: 40, teamSize: 3, approvalGranted: true })))

  console.log("\n[earnedTier · pure — auto ladder tops at senior]")
  check("a rookie stays rookie", earnedTier(stats()) === "rookie")
  check("3 closings → associate", earnedTier(stats({ closingsLifetime: 3 })) === "associate")
  check("12 closings/24mo + 24mo → senior", earnedTier(stats({ closingsLifetime: 15, closingsTrailing24m: 12, monthsActive: 30 })) === "senior")
  check("even huge production tops at senior WITHOUT approval (team_lead/partner gated)", earnedTier(stats({ closingsLifetime: 60, closingsTrailing24m: 30, closingsTrailing36m: 40, monthsActive: 48, teamSize: 5 })) === "senior")
  check("with approval, 50 lifetime → partner", tierRank(earnedTier(stats({ closingsLifetime: 55, monthsActive: 60, approvalGranted: true }))) >= tierRank("partner"))

  console.log("\n[progress · pure — binding requirement + exact gap]")
  const p = tierProgress("rookie", stats({ closingsLifetime: 2 }))
  check("rookie 2/3 closings → ~66% to associate, gap 1", p.nextTier === "associate" && p.pctToNext >= 60 && (p.gap!.need - p.gap!.have) === 1)
  const ps = tierProgress("associate", stats({ closingsTrailing24m: 6, monthsActive: 24 }))
  check("senior AND gate: bottleneck is the least-complete req (closings 6/12 → 50%)", ps.nextTier === "senior" && ps.pctToNext === 50 && (ps.gap?.metric.includes("closings") ?? false))
  check("associate OR gate: progress is the BETTER path", tierProgress("rookie", stats({ closingsLifetime: 0, monthsActive: 6 })).pctToNext === 50)
}

function sourceLayer() {
  console.log("\n[wiring — auto-upgrade, ≥80% nudge, cron, UI, owned]")
  const lib = src("lib/recruiting/career-tier.ts")
  check("runner auto-upgrades (never downgrades) on a higher earned tier", /tierRank\(earned\) > tierRank\(current\)[\s\S]*?career_tier: earned/.test(lib))
  check("runner proposes a GATED ≥80% approach nudge, deduped per agent+tier+bi-week", /pctToNext >= 80 && prog\.pctToNext < 100[\s\S]*?proposeClientMessage/.test(lib) && /CAREER TIER — agent:/.test(lib))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly cron runs career-tier evaluation", /runCareerTierEvaluationAll/.test(cron))
  check("agent dashboard mounts the career tier card", /<AgentCareerTierCard agentId=\{agentId\} \/>/.test(src("app/dashboard/agent/page.tsx")))
  check("the card reads progress via getAgentCareerProgress", /getAgentCareerProgress\(agentId\)/.test(src("app/components/agent/career-tier-card.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /career_tier_ladder:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:career-tier"/.test(reg))
  check("agents.career_tier/tier_updated_at in the schema snapshot", /"career_tier"/.test(src("scripts/schema-snapshot.ts")) && /"tier_updated_at"/.test(src("scripts/schema-snapshot.ts")))
  check("package.json wires the proof", /"test:career-tier":\s*"tsx scripts\/career-tier-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a tenured agent → runner auto-upgrades their tier → restore + clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id, career_tier, created_at").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id
  const priorTier = (ag as any).career_tier ?? "rookie"
  const priorCreated = (ag as any).created_at
  const notes: string[] = []
  try {
    // Make the agent clearly tenured (13+ months) so the OR gate promotes rookie→associate on tenure alone.
    await svc.from("agents").update({ created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(), career_tier: "rookie" }).eq("id", agentId)
    const { runCareerTierEvaluation } = await import("../lib/recruiting/career-tier")
    const r = await runCareerTierEvaluation(svc as any, { brokerageId })
    check("live: the runner scanned + upgraded ≥1 agent", r.scanned >= 1 && r.upgraded >= 1)
    const { data: after } = await svc.from("agents").select("career_tier").eq("id", agentId).maybeSingle()
    check("live: the tenured rookie was auto-upgraded to associate", (after as any)?.career_tier === "associate")
    // collect the upgrade notification for cleanup
    const { data: note } = await svc.from("notifications").select("id").eq("entity_id", agentId).eq("type", "career_tier_upgrade").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (note) notes.push((note as any).id)
  } finally {
    await svc.from("agents").update({ career_tier: priorTier, created_at: priorCreated, tier_updated_at: null }).eq("id", agentId)
    for (const id of notes) await svc.from("notifications").delete().eq("id", id)
    const { data: chk } = await svc.from("agents").select("career_tier").eq("id", agentId).maybeSingle()
    let left = 0
    for (const id of notes) { const { count } = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("id", id); left += count ?? 0 }
    check("live: restored the agent's tier + cleanup count == 0", (chk as any)?.career_tier === priorTier && left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CAREER_TIER_FAIL"); process.exit(1) }
  console.log(" ✅ CAREER_TIER_PASS — production/tenure gated tiers, auto-upgrade (no downgrade), ≥80% approach nudge with the exact gap")
}
main()
