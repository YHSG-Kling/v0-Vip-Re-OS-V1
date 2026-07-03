#!/usr/bin/env tsx
/**
 * scripts/vendor-rating-simulator.ts   (npm run test:vendor-rating)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves VENDOR RATING GOVERNANCE — the marketplace quality gate. A poorly-rated vendor is SUPPRESSED
 * from the orchestration auto-pick (client protection), a slipping vendor is FLAGGED for admin review,
 * a standout EARNS a badge; thin data is never a verdict. All from the existing vendor_ratings rollup.
 *
 * PURE:   blendedAvg + computeRatingHealth (suppress < 3.0 w/ sample, flag < 3.5 / repeated one-stars,
 *         badges Top Rated ≥4.5/10 + Highly Recommended ≥4.8/20, honest unrated below MIN_SAMPLE).
 * SOURCE: orchestration filters suppressed vendors from the eligible bench; the governance runner + gated
 *         weekly admin brief; the cron runs it; owned by deal_coordinator with a runnable proof.
 * LIVE (creds-gated): seed a suppressed + a badge-worthy vendor_ratings row → runVendorRatingGovernance
 *         proposes ONE gated admin brief + loadSuppressedVendorIds includes the bad vendor → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  blendedAvg,
  computeRatingHealth,
  healthByVendor,
  MIN_SAMPLE,
  type RatingSignals,
} from "../lib/kernel/vendor-rating-governance"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const sig = (o: Partial<RatingSignals> = {}): RatingSignals => ({ avgAgentRating: 4.6, avgClientRating: 4.7, sampleSize: 12, oneStarCount: 0, ...o })

function pureLayer() {
  console.log("\n[blendedAvg · pure]")
  check("blends client + agent averages", blendedAvg(4.0, 5.0) === 4.5)
  check("falls back to whichever exists", blendedAvg(null, 4.2) === 4.2 && blendedAvg(3.8, null) === 3.8)
  check("no ratings → null", blendedAvg(null, null) === null && blendedAvg(0, 0) === null)

  console.log("\n[computeRatingHealth · pure — honest, sample-gated]")
  check(`below MIN_SAMPLE (${MIN_SAMPLE}) → unrated, never suppressed`, computeRatingHealth(sig({ sampleSize: 2, avgAgentRating: 1, avgClientRating: 1 })).tier === "unrated")
  const suppressed = computeRatingHealth(sig({ avgAgentRating: 2.5, avgClientRating: 2.7, sampleSize: 6 }))
  check("avg < 3.0 with sample → SUPPRESSED", suppressed.tier === "suppressed" && suppressed.suppressed && suppressed.reasons.length > 0)
  const flaggedAvg = computeRatingHealth(sig({ avgAgentRating: 3.3, avgClientRating: 3.4, sampleSize: 7 }))
  check("avg < 3.5 with sample ≥ 5 → FLAGGED (not suppressed)", flaggedAvg.tier === "flagged" && !flaggedAvg.suppressed)
  const flaggedOneStar = computeRatingHealth(sig({ avgAgentRating: 4.2, avgClientRating: 4.3, sampleSize: 12, oneStarCount: 3 }))
  check("3+ one-stars → FLAGGED regardless of a healthy average", flaggedOneStar.tier === "flagged")
  const topRated = computeRatingHealth(sig({ avgAgentRating: 4.6, avgClientRating: 4.6, sampleSize: 12 }))
  check("avg ≥ 4.5 with ≥10 → Top Rated badge", topRated.tier === "ok" && topRated.badges.includes("top_rated") && !topRated.badges.includes("highly_recommended"))
  const highly = computeRatingHealth(sig({ avgAgentRating: 4.9, avgClientRating: 4.9, sampleSize: 25 }))
  check("avg ≥ 4.8 with ≥20 → Highly Recommended (+ Top Rated)", highly.badges.includes("highly_recommended") && highly.badges.includes("top_rated"))
  const healthySmall = computeRatingHealth(sig({ avgAgentRating: 4.9, avgClientRating: 4.9, sampleSize: 6 }))
  check("great avg but thin sample → ok, no badge yet (honest)", healthySmall.tier === "ok" && healthySmall.badges.length === 0)

  console.log("\n[healthByVendor · pure]")
  const map = healthByVendor([
    { vendor_id: "bad", avg_agent_rating: 2.4, avg_client_rating: 2.5, total_bookings: 8, one_star_count: 4 },
    { vendor_id: "good", avg_agent_rating: 4.9, avg_client_rating: 4.8, total_bookings: 22, one_star_count: 0 },
    { vendor_id: "thin", avg_agent_rating: 1.0, avg_client_rating: null, total_bookings: 1, one_star_count: 1 },
  ])
  check("maps rows → suppressed / badged / unrated", map.get("bad")?.suppressed === true && map.get("good")?.badges.length! > 0 && map.get("thin")?.tier === "unrated")
}

function sourceLayer() {
  console.log("\n[wiring — suppression gates the pick, runner + brief + cron, owned]")
  const orch = src("lib/kernel/vendor-orchestration.ts")
  check("orchestration loads the suppressed set + filters the eligible bench", /loadSuppressedVendorIds\(supabase, brokerageId\)/.test(orch) && /eligibleBench = /.test(orch))
  check("the pick runs against the eligible (non-suppressed) bench", /pickVendorForGap\(eligibleBench,/.test(orch))
  const gov = src("lib/kernel/vendor-rating-governance.ts")
  check("the governance runner proposes a GATED admin brief, deduped per ISO week", /proposeClientMessage/.test(gov) && /VENDOR QUALITY — \$\{isoWeekKey/.test(gov))
  const cron = src("app/api/cron/vendor-orchestration/route.ts")
  check("the daily vendor cron runs rating governance", /runVendorRatingGovernanceAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by deal_coordinator with a runnable proof", /vendor_rating_governance:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:vendor-rating"/.test(reg))
  check("package.json wires the proof", /"test:vendor-rating":\s*"tsx scripts\/vendor-rating-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a suppressed vendor rating → governance briefs it + suppression set includes it → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: vend } = await svc.from("vendors").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!vend) { console.log("  ⊘ no vendor — skipping"); return }
  const vendorId = (vend as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const {
    loadSuppressedVendorIds,
    runVendorRatingGovernance,
  } = await import("../lib/kernel/vendor-rating-governance")

  try {
    // Seed a below-floor rating for a real vendor.
    const { data: rr } = await svc.from("vendor_ratings").upsert({
      vendor_id: vendorId, brokerage_id: brokerageId,
      avg_agent_rating: 2.4, avg_client_rating: 2.5, total_bookings: 8, five_star_count: 0, one_star_count: 4,
      last_updated: new Date().toISOString(),
    }, { onConflict: "vendor_id" }).select("id").single()
    if (rr) cleanup.push({ table: "vendor_ratings", id: (rr as any).id })

    const suppressedSet = await loadSuppressedVendorIds(svc as any, brokerageId)
    check("live: the suppressed set includes the below-floor vendor", suppressedSet.has(vendorId))

    const r1 = await runVendorRatingGovernance(svc as any, { brokerageId })
    check("live: governance scored + suppressed ≥ 1", r1.scored >= 1 && r1.suppressed >= 1)
    const { data: brief } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("entity_type", "brokerage").eq("entity_id", brokerageId)
      .eq("agent_kind", "deal_coordinator").ilike("rationale", "VENDOR QUALITY —%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    check("live: a gated admin quality brief was proposed", r1.briefProposed && !!brief)
    if (brief) cleanup.push({ table: "agent_client_messages", id: (brief as any).id })

    const r2 = await runVendorRatingGovernance(svc as any, { brokerageId })
    check("live: idempotent — no duplicate brief for the same ISO week", r2.briefProposed === false)
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
  if (fail > 0) { console.log(" ❌ VENDOR_RATING_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_RATING_PASS — poorly-rated vendors suppressed from auto-surfacing, slipping ones flagged, standouts badged")
}
main()
