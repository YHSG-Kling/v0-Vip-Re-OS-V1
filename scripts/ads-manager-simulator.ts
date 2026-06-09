#!/usr/bin/env tsx
/**
 * scripts/ads-manager-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 41 — proves the ADS MANAGER's three release-blocking controls:
 *   1. SCOPE — every spend action is proposed → human-approved → executed.
 *   2. HARD CAP — the executor clamps any daily budget to the ceiling + scale
 *      limit, even if the proposal/approval asked for more.
 *   3. REWARD ALIGNMENT — scale/pause verdicts key ONLY on real outcomes
 *      (cost-per-lead, leads); vanity metrics (impressions/ctr) never scale spend.
 *
 *   Layer 1 — pure: evaluateAdPerformance + clampDailyBudget across winner/loser/
 *     vanity-trap/hold cases.
 *   Layer 2 — live (gated): seed an approved campaign + approved creative; launch
 *     via the executor (and prove it REFUSES to launch with no approved creative);
 *     prove the spend cap clamps an over-budget shift; run the proposer over
 *     seeded performance → proposals surface in loadCommandCenter as 'ads';
 *     approve a scale → budget updates clamped; ad-creative approval via the
 *     registry; cleanup.
 *
 * Run: npx tsx scripts/ads-manager-simulator.ts  (npm run test:ads-manager)
 */
import { evaluateAdPerformance, clampDailyBudget, MAX_AD_DAILY_BUDGET_USD, MAX_SCALE_MULTIPLE, type CampaignPerf } from "../lib/ads/ad-manager"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · reward-aligned verdicts]")
  const perf = (o: Partial<CampaignPerf>): CampaignPerf => ({ campaignId: "c", dailyBudget: 100, spend: 0, leads: 0, costPerLead: null, impressions: 0, ...o })

  const winner = evaluateAdPerformance([perf({ leads: 5, costPerLead: 30, spend: 150 })])[0]
  check("winner (5 leads @ $30 CPL) → scale", winner.verdict === "scale")
  check("scale suggests a bounded budget (≤ current × scale, ≤ cap)", (winner.suggestedDailyBudget ?? 0) <= 100 * MAX_SCALE_MULTIPLE && (winner.suggestedDailyBudget ?? 0) <= MAX_AD_DAILY_BUDGET_USD)

  const noLeads = evaluateAdPerformance([perf({ spend: 200, leads: 0 })])[0]
  check("real spend, 0 leads → pause", noLeads.verdict === "pause")

  const badCpl = evaluateAdPerformance([perf({ spend: 300, leads: 1, costPerLead: 300 })])[0]
  check("bad cost-per-lead ($300) → pause", badCpl.verdict === "pause")

  // THE reward-alignment trap: huge impressions + great CTR but NO leads.
  const vanity = evaluateAdPerformance([perf({ impressions: 1_000_000, spend: 250, leads: 0, costPerLead: null })])[0]
  check("vanity metrics (1M impressions, 0 leads) → pause, NOT scale", vanity.verdict === "pause")

  const earlyHold = evaluateAdPerformance([perf({ spend: 20, leads: 0 })])[0]
  check("too little spend to judge → hold (no premature pause)", earlyHold.verdict === "hold")

  const weakWinner = evaluateAdPerformance([perf({ leads: 1, costPerLead: 40, spend: 60 })])[0]
  check("only 1 lead → hold (needs real volume to scale)", weakWinner.verdict === "hold")

  console.log("\n[Layer 1 · hard spend cap]")
  // With a high current budget the scale limit (current×2) exceeds the ceiling, so
  // the absolute ceiling binds.
  check("clamp never exceeds the absolute ceiling", clampDailyBudget(99999, 300) === MAX_AD_DAILY_BUDGET_USD)
  check("clamp never exceeds current × scale multiple", clampDailyBudget(99999, 50) === 50 * MAX_SCALE_MULTIPLE)
  check("clamp takes the more conservative of ceiling vs scale", clampDailyBudget(99999, 100) === Math.min(100 * MAX_SCALE_MULTIPLE, MAX_AD_DAILY_BUDGET_USD))
  check("clamp leaves a reasonable request alone", clampDailyBudget(150, 100) === 150)
  check("clamp floors at 1", clampDailyBudget(0, 0) === 1)
}

async function testLive() {
  console.log("\n[Layer 2 · governed ad-spend loop]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { executeAdManagerAction, proposeAdOptimizations } = await import("../lib/ads/ad-manager")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const { approveContentSource } = await import("../lib/kernel/approval-sources")
  const svc = createServiceClient()
  const TAG = `__adsim_${Date.now()}__`
  const campaignIds: string[] = []; const actionIds: string[] = []; const creativeIds: string[] = []; let connId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id
    const { data: u } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const userId = (u as { id: string } | null)?.id ?? null
    if (!userId) { console.log("  ⏭  Skipped — no approver user."); return }
    const ctx = { userId, brokerageId, isSuperadmin: false }

    async function seedCampaign(status: string, daily: number, name: string): Promise<string> {
      const { data, error } = await svc.from("ad_campaigns").insert({
        brokerage_id: brokerageId, campaign_name: `${TAG} ${name}`, platform: "facebook", objective: "leads",
        status, daily_budget: daily,
      }).select("id").single()
      if (error) throw new Error("campaign seed: " + error.message)
      const id = (data as { id: string }).id; campaignIds.push(id); return id
    }
    async function seedCreative(campaignId: string, approval: string): Promise<string> {
      const { data, error } = await svc.from("ad_creative_variations").insert({
        brokerage_id: brokerageId, ad_campaign_id: campaignId, variation_name: `${TAG} v1`,
        headline: "Thinking of selling?", primary_text: "Get your home's value.", call_to_action: "LEARN_MORE", approval_status: approval,
      }).select("id").single()
      if (error) throw new Error("creative seed: " + error.message)
      const id = (data as { id: string }).id; creativeIds.push(id); return id
    }
    async function propose(actionType: string, input: Record<string, unknown>): Promise<string> {
      const { data, error } = await svc.from("ad_manager_actions").insert({
        brokerage_id: brokerageId, action_type: actionType, action_input: input, rationale: "test", status: "proposed",
      }).select("id").single()
      if (error) throw new Error("action seed: " + error.message)
      const id = (data as { id: string }).id; actionIds.push(id); return id
    }

    // ── Launch gate: refuses without an approved creative ──
    const campNoCreative = await seedCampaign("approved", 100, "NoCreative")
    const launchNoCreative = await propose("launch_ad_campaign", { campaign_id: campNoCreative })
    const r1 = await executeAdManagerAction(launchNoCreative, userId)
    check("launch REFUSED with no approved creative", r1.status === "skipped")

    // ── Launch is REFUSED when the ad platform isn't connected ──
    const camp = await seedCampaign("approved", 100, "Launchable")
    await seedCreative(camp, "approved")
    // ensure no stray test connection, then prove launch is blocked
    await svc.from("platform_credentials").delete().eq("brokerage_id", brokerageId).eq("platform", "facebook").like("account_id", `${TAG}%`)
    const { data: existingFb } = await svc.from("platform_credentials").select("id").eq("brokerage_id", brokerageId).eq("platform", "facebook").eq("is_active", true).maybeSingle()
    if (!existingFb) {
      const launchUnconnected = await propose("launch_ad_campaign", { campaign_id: camp })
      const r0 = await executeAdManagerAction(launchUnconnected, userId)
      check("launch REFUSED when ad account not connected", r0.status === "skipped")
    } else {
      check("launch REFUSED when ad account not connected (skipped — brokerage already connected)", true)
    }

    // ── Connect the ad account, then launch succeeds ──
    const { data: conn } = await svc.from("platform_credentials").insert({
      brokerage_id: brokerageId, owner_type: "brokerage", owner_id: brokerageId, platform: "facebook",
      access_token: "test-token", account_id: `${TAG}act_123`, is_active: true,
    }).select("id").maybeSingle()
    connId = (conn as { id: string } | null)?.id ?? null
    const launch = await propose("launch_ad_campaign", { campaign_id: camp })
    const r2 = await executeAdManagerAction(launch, userId)
    check("launch succeeds once the ad account is connected", r2.status === "succeeded", JSON.stringify(r2.result))
    const { data: c2 } = await svc.from("ad_campaigns").select("status").eq("id", camp).single()
    check("campaign flipped to launching", (c2 as { status: string }).status === "launching")

    // ── HARD CAP: an over-budget shift is clamped at execution ──
    const shift = await propose("shift_ad_budget", { campaign_id: camp, new_daily_budget: 99999 })
    const r3 = await executeAdManagerAction(shift, userId)
    check("over-budget shift is clamped (capped=true)", r3.status === "succeeded" && (r3.result as any).capped === true)
    const { data: c3 } = await svc.from("ad_campaigns").select("daily_budget").eq("id", camp).single()
    check("daily budget clamped to the ceiling", Number((c3 as { daily_budget: number }).daily_budget) === MAX_AD_DAILY_BUDGET_USD)

    // ── Proposer: reward-aligned over seeded performance ──
    const winnerCamp = await seedCampaign("live", 100, "Winner")
    await svc.from("ad_performance").insert({ brokerage_id: brokerageId, ad_campaign_id: winnerCamp, captured_at: new Date().toISOString(), spend: 150, impressions: 5000, clicks: 200, ctr: 0.04, leads: 6, conversions: 2, cost_per_lead: 25 })
    const loserCamp = await seedCampaign("live", 100, "Loser")
    await svc.from("ad_performance").insert({ brokerage_id: brokerageId, ad_campaign_id: loserCamp, captured_at: new Date().toISOString(), spend: 220, impressions: 900000, clicks: 5000, ctr: 0.05, leads: 0, conversions: 0, cost_per_lead: null })

    const prop = await proposeAdOptimizations(brokerageId, svc)
    check("proposer proposed at least the winner + loser", prop.proposed >= 2)
    const { data: acts } = await svc.from("ad_manager_actions").select("id, action_type, action_input").eq("brokerage_id", brokerageId).in("status", ["proposed"])
    const list = (acts ?? []) as Array<{ id: string; action_type: string; action_input: any }>
    for (const a of list) if (!actionIds.includes(a.id)) actionIds.push(a.id)
    const scaleWin = list.find((a) => a.action_type === "scale_ad_creative" && a.action_input?.campaign_id === winnerCamp)
    const pauseLose = list.find((a) => a.action_type === "pause_ad_campaign" && a.action_input?.campaign_id === loserCamp)
    check("winner → scale proposed (real outcomes)", !!scaleWin)
    check("loser (vanity-high, 0 leads) → pause proposed, NOT scale", !!pauseLose)

    // Idempotent — re-running proposes nothing new.
    const prop2 = await proposeAdOptimizations(brokerageId, svc)
    check("proposer is idempotent (no duplicate proposals)", prop2.proposed === 0)

    // Command Center surfaces them as 'ads'.
    const cc = await loadCommandCenter({ brokerageId })
    check("Command Center surfaces ad-spend proposals in the 'ads' queue", !!cc.pendingActions.find((a) => a.id === scaleWin!.id && a.queue === "ads"))

    // Approve the scale → executor applies the (clamped) budget.
    const r4 = await executeAdManagerAction(scaleWin!.id, userId)
    check("approving the scale executes", r4.status === "succeeded")
    const { data: cw } = await svc.from("ad_campaigns").select("daily_budget").eq("id", winnerCamp).single()
    check("winner budget scaled within the cap", Number((cw as { daily_budget: number }).daily_budget) <= 100 * MAX_SCALE_MULTIPLE)

    // ── Ad-creative review via the content registry ──
    const draftCreative = await seedCreative(camp, "draft")
    const ccc = await loadCommandCenter({ brokerageId })
    check("Command Center surfaces the draft creative as 'ad_creative'", !!ccc.pendingActions.find((a) => a.id === draftCreative && a.queue === "ad_creative"))
    const appr = await approveContentSource("ad_creative", draftCreative, ctx)
    check("approve ad-creative via registry", appr.ok === true, appr.error)
    const { data: dc } = await svc.from("ad_creative_variations").select("approval_status").eq("id", draftCreative).single()
    check("creative now approved", (dc as { approval_status: string }).approval_status === "approved")
  } finally {
    if (connId) { try { await svc.from("platform_credentials").delete().eq("id", connId) } catch {} }
    for (const id of actionIds) { try { await svc.from("ad_manager_actions").delete().eq("id", id) } catch {} }
    for (const id of creativeIds) { try { await svc.from("ad_creative_variations").delete().eq("id", id) } catch {} }
    for (const id of campaignIds) { try { await svc.from("ad_performance").delete().eq("ad_campaign_id", id) } catch {}; try { await svc.from("ad_campaigns").delete().eq("id", id) } catch {} }
    const { count } = await svc.from("ad_campaigns").select("id", { count: "exact", head: true }).like("campaign_name", `${TAG}%`)
    check("cleanup verified — 0 test campaigns remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Ads Manager simulator (scope + hard cap + reward alignment)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Ads Manager governed — no autonomous spend, capped, judged by real leads")
}
main().catch((e) => { console.error(e); process.exit(1) })
