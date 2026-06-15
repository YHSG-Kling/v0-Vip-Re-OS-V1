#!/usr/bin/env tsx
/**
 * scripts/creative-fatigue-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE CREATIVE-FATIGUE MONITOR — verified white space (the ads stack ignored CTR + kept only
 * the latest snapshot). Pure decay engine over a CTR time-series, honest on thin data; the runner
 * captures the series + proposes a gated refresh when a creative fatigues.
 *
 * Layer 1 (pure): the decay/fatigue verdict matrix.
 * Layer 2 (live, gated): seed a decaying series into ad_performance_history → detect high fatigue +
 *   a gated bus signal. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/creative-fatigue-simulator.ts   (npm run test:creative-fatigue)
 */
import { computeEngagementDecay, type CtrPoint, MIN_SAMPLE } from "../lib/ads/ad-engagement-decay"

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
  console.log(" ✅ Creative-fatigue monitor verified — decay caught, thin data held, refresh proposed.")
  console.log(" CREATIVE_FATIGUE_PASS")
}

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString()
const series = (ctrs: number[]): CtrPoint[] => ctrs.map((ctr, i) => ({ capturedAt: day(i * 2), ctr }))

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Creative-fatigue monitor simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · decay verdict]")
  const fatigued = computeEngagementDecay(series([2.0, 1.6, 1.2, 0.9, 0.7])) // ~65% drop over 8 days
  check("a CTR collapse → HIGH fatigue", fatigued.fatigueRisk === "high")
  check("drop% measured from the opening CTR", Math.abs(fatigued.dropPct - 0.65) < 0.02)
  check("decay slope is negative", fatigued.decayPerDay < 0)

  const softening = computeEngagementDecay(series([2.0, 1.9, 1.75, 1.65, 1.55])) // ~22% drop
  check("a mild decline → MEDIUM (line up a variant)", softening.fatigueRisk === "medium")

  const holding = computeEngagementDecay(series([1.8, 1.82, 1.78, 1.8, 1.79]))
  check("a steady CTR → LOW (no refresh)", holding.fatigueRisk === "low")

  check("too few snapshots → insufficient (no false alarm)", computeEngagementDecay(series([2.0, 0.5])).fatigueRisk === "insufficient")
  check(`needs ≥${MIN_SAMPLE} points`, computeEngagementDecay([{ capturedAt: day(0), ctr: 2 }]).sample === 1)
  // Same big drop but compressed into <7 days → still insufficient (too early to call).
  const early = computeEngagementDecay([{ capturedAt: day(0), ctr: 2 }, { capturedAt: day(1), ctr: 1 }, { capturedAt: day(2), ctr: 0.6 }])
  check("a big drop in <7 days → insufficient (too early)", early.fatigueRisk === "insufficient")

  console.log("\n[Layer 2 · live: a decaying campaign is flagged + a gated refresh proposed]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { recordAdPerformanceSnapshot, detectCreativeFatigue } = await import("../lib/ads/creative-fatigue-runner")
  const supabase = createServiceClient()
  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const campaignId = (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  try {
    // 5 readings over 8 days, CTR collapsing.
    const ctrs = [2.0, 1.6, 1.2, 0.9, 0.7]
    for (let i = 0; i < ctrs.length; i++) {
      await supabase.from("ad_performance_history").insert({
        brokerage_id: brokerageId, ad_campaign_id: campaignId, ctr: ctrs[i], captured_at: day(i * 2),
      })
    }
    const r = await detectCreativeFatigue({ brokerageId, adCampaignId: campaignId, campaignName: "ZZ Test Ad", copyGenerator: stampGen }, supabase)
    check("the decaying campaign is flagged HIGH + escalated", r.decay.fatigueRisk === "high" && r.flagged === true, JSON.stringify(r.decay).slice(0, 100))
    const { count } = await supabase.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", campaignId).eq("signal_type", "creative_fatigue")
    check("a creative_fatigue bus signal was published (gated refresh)", (count ?? 0) >= 1)
  } finally {
    await supabase.from("manager_signals").delete().eq("entity_id", campaignId).then(() => {}, () => {})
    await supabase.from("ad_performance_history").delete().eq("ad_campaign_id", campaignId).then(() => {}, () => {})
    const { count } = await supabase.from("ad_performance_history").select("id", { count: "exact", head: true }).eq("ad_campaign_id", campaignId)
    check("cleanup: seed series removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
