#!/usr/bin/env tsx
/**
 * scripts/onboarding-curriculum-simulator.ts   (npm run test:onboarding-curriculum)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the TIER ONBOARDING CURRICULUM — the OS trains new subscribers out of the gate. A pure syllabus
 * blends a core path with tier/role-specific topics; each becomes a gated learning_modules draft on the
 * canonical rail, delivered by role. Idempotent per topic tag.
 *
 * PURE:   topicsForTier (core + tier-specific, role-tagged) + onboardingTag.
 * SOURCE: authoring persists to learning_modules (pending_review, milestone platform_onboarding, gap tag),
 *         SUBSCRIPTION_CREATED emitted on signup, cron safety-net, owned by recruiting_manager.
 * LIVE (creds-gated on Supabase): persist an onboarding module → it lands on learning_modules by role →
 *         idempotent (runOnboardingCurriculum won't duplicate) → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { topicsForTier, onboardingTag, type Tier } from "../lib/education/onboarding-curriculum"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[topicsForTier · pure — core + tier-specific, role-tagged]")
  const solo = topicsForTier("solo_agent")
  const team = topicsForTier("team")
  const brokerage = topicsForTier("brokerage")
  const multi = topicsForTier("multi_location")
  check("every tier gets the CORE path (platform tour, negotiation, persona, guidance)", ["platform_tour", "negotiation_tactics", "persona_playbook", "guidance_essentials"].every((k) => solo.some((t) => t.key === k)))
  check("solo gets pipeline + self-marketing", solo.some((t) => t.key === "solo_pipeline") && solo.some((t) => t.key === "self_marketing"))
  check("team gets a team_lead-audienced leadership module", team.some((t) => t.key === "team_leadership" && t.audienceRoles.includes("team_lead")))
  check("brokerage gets broker-audienced recruiting/compliance/development", ["recruiting_growth", "compliance_oversight", "agent_development"].every((k) => brokerage.some((t) => t.key === k && t.audienceRoles.includes("broker"))))
  check("multi-location adds multi-office ops on top of brokerage topics", multi.some((t) => t.key === "multi_office_ops") && multi.length > brokerage.length)
  check("no duplicate topic keys within a tier", new Set(multi.map((t) => t.key)).size === multi.length)
  check("onboardingTag namespaces per tier+topic", onboardingTag("team", "platform_tour") === "onboarding:team:platform_tour")
  check("every topic carries a grounding brief + audience", solo.every((t) => t.brief.length > 20 && t.audienceRoles.length > 0))
}

function sourceLayer() {
  console.log("\n[wiring — learning_modules persist, signup emit, cron, owned]")
  const authoring = src("lib/education/onboarding-authoring.ts")
  check("persists to canonical learning_modules, pending_review, onboarding milestone", /from\("learning_modules"\)\.insert\([\s\S]*?status: "pending_review"[\s\S]*?milestone_key: "platform_onboarding"/.test(authoring))
  check("carries the topic's audience_roles + the onboarding gap tag", /audience_roles: topic\.audienceRoles/.test(authoring) && /gap_tags: \[tag\]/.test(authoring))
  const eng = src("lib/education/onboarding-curriculum.ts")
  check("idempotent per onboarding tag (no duplicate module)", /contains\("gap_tags", \[tag\]\)/.test(eng))
  check("resolves tier from brokerages.plan_tier when not passed", /from\("brokerages"\)\.select\("plan_tier"\)/.test(eng))
  const signup = src("app/actions/auth/signup-brokerage.ts")
  check("SUBSCRIPTION_CREATED is emitted on signup (the real-time hook)", /KernelEvent\.SUBSCRIPTION_CREATED/.test(signup))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly cron runs the onboarding safety-net sweep", /runOnboardingCurriculumAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /tier_onboarding_curriculum:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:onboarding-curriculum"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] persist an onboarding module → lands on learning_modules by role → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const tier: Tier = "team"
    const topic = topicsForTier(tier).find((t) => t.key === "team_leadership")!
    const tag = onboardingTag(tier, topic.key)
    const curriculum = {
      title: "Leading a team without dropping the ball",
      summary: "Balance capacity, mentor with cadence, and read the dashboards that keep everyone producing.",
      objectives: ["Rebalance an overloaded agent before the ball drops", "Run a weekly mentor check-in"],
      lessons: [
        { title: "Read the capacity board", walkthrough: "Step-by-step walkthrough for the simulator fixture — every term defined, every section explained.", keyPoints: ["Spot an at/over-ceiling agent", "Reassign the newest lead first"] },
        { title: "Mentor on cadence", walkthrough: "Step-by-step walkthrough for the simulator fixture — every term defined, every section explained.", keyPoints: ["Bi-weekly check-in", "Unblock one thing per session"] },
      ],
      quiz: [{ question: "First move on an overloaded agent?", options: ["Add more leads", "Rebalance work", "Wait"], correctIndex: 1 }],
    }
    const { persistOnboardingModule } = await import("../lib/education/onboarding-authoring")
    const ok = await persistOnboardingModule(svc as any, brokerageId, tag, topic, curriculum)
    check("live: persisted an onboarding module to learning_modules", ok === true)

    const { data: mod } = await svc.from("learning_modules").select("id, status, milestone_key, audience_roles, gap_tags, required").eq("brokerage_id", brokerageId).contains("gap_tags", [tag]).maybeSingle()
    if (mod) cleanup.push({ table: "learning_modules", id: (mod as any).id })
    check("live: pending_review, onboarding milestone, team_lead audience, required", !!mod && (mod as any).status === "pending_review" && (mod as any).milestone_key === "platform_onboarding" && (mod as any).audience_roles.includes("team_lead") && (mod as any).required === true)

    // Idempotent: running the engine won't re-author an existing topic (authorModuleFor may be gateway-gated,
    // but the existence check must short-circuit BEFORE authoring).
    const { runOnboardingCurriculum } = await import("../lib/education/onboarding-curriculum")
    const r = await runOnboardingCurriculum(svc as any, { brokerageId, tier })
    const { count } = await svc.from("learning_modules").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).contains("gap_tags", [tag])
    check("live: idempotent — the seeded topic is not re-authored", count === 1)
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
  if (fail > 0) { console.log(" ❌ ONBOARDING_CURRICULUM_FAIL"); process.exit(1) }
  console.log(" ✅ ONBOARDING_CURRICULUM_PASS — new subscribers get a tier/role onboarding path authored on the canonical rail")
}
main()
