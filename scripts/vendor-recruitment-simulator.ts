#!/usr/bin/env tsx
/**
 * scripts/vendor-recruitment-simulator.ts   (npm run test:vendor-recruitment)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the VENDOR RECRUITMENT SCOUT — the marketplace-growth mirror of the switch-propensity scout.
 * A vendor the brokerage already relies on but who is OFF-PLATFORM is scored on reliance + quality +
 * spend; the top targets become ONE gated weekly "invite these vendors" broker brief. HONEST: missing
 * signals are neutral (never fabricated), and already-on-platform / already-invited vendors are excluded.
 *
 * PURE:   computeVendorRecruitmentPropensity (reliance/quality/spend, honest neutrals) + tiers + ranking.
 * SOURCE: the scout finds off-platform vendors, proposes ONE gated brief (deduped per ISO week), rides
 *         the weekly recruit-outreach cron, owned by recruiting_manager with a runnable proof.
 * LIVE (creds-gated): seed an off-platform vendor + real bookings/ratings → scout scores it → proposes a
 *         gated invite brief → idempotent (no second brief same week) → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  computeVendorRecruitmentPropensity, rankVendorsByRecruitmentPropensity, type VendorRecruitSignals,
} from "../lib/recruiting/vendor-recruitment-propensity"
import { buildVendorInviteBrief } from "../lib/recruiting/vendor-recruitment-scout"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const base = (o: Partial<VendorRecruitSignals> = {}): VendorRecruitSignals => ({ totalBookings: 12, totalSpend: 6000, avgRating: 4.8, fiveStarRatio: 0.8, ...o })

function pureLayer() {
  console.log("\n[computeVendorRecruitmentPropensity · pure — real signals, honest on missing]")
  const hot = computeVendorRecruitmentPropensity(base())
  check("heavily-used + high-rated + big spend → hot (≥0.7)", hot.tier === "hot" && hot.score >= 0.7)
  const occasional = computeVendorRecruitmentPropensity(base({ totalBookings: 1, totalSpend: 200, avgRating: null, fiveStarRatio: null }))
  check("used once + unrated + tiny spend → cool", occasional.tier === "cool")
  check("reasons name the real driver (reliance / rating / spend)", hot.reasons.some((r) => /engagements|Rated|flows/i.test(r)))
  const noData = computeVendorRecruitmentPropensity({ totalBookings: null, totalSpend: null, avgRating: null, fiveStarRatio: null })
  check("no signals at all → neutral-ish, never a fabricated hot", noData.tier !== "hot" && noData.score > 0)
  const goodButNew = computeVendorRecruitmentPropensity(base({ totalBookings: 2, totalSpend: null }))
  const heavy = computeVendorRecruitmentPropensity(base({ totalBookings: 18, totalSpend: 9000 }))
  check("more reliance + spend ranks a vendor higher", heavy.score > goodButNew.score)
  check("score clamped 0..1", noData.score >= 0 && hot.score <= 1)
  const ratingOnly = computeVendorRecruitmentPropensity({ totalBookings: null, totalSpend: null, avgRating: 5, fiveStarRatio: 1 })
  check("a strong QUALITY signal isn't dragged to zero by absent reliance/spend", ratingOnly.score > 0.4)

  console.log("\n[ranking + brief · pure]")
  const ranked = rankVendorsByRecruitmentPropensity([
    { id: "a", name: "Ace Inspections", category: "inspector", ...base() },
    { id: "b", name: "Budget Photos", category: "photographer", ...base({ totalBookings: 1, totalSpend: 150, avgRating: 3, fiveStarRatio: 0 }) },
  ])
  check("rank orders the heavily-relied-on vendor first", ranked[0].name === "Ace Inspections")
  const brief = buildVendorInviteBrief(ranked)
  check("brief lists the hot/warm targets (cool excluded), with a CTA", !!brief && /Ace Inspections/.test(brief!.body) && !/Budget Photos/.test(brief!.body))
  check("brief is null when nothing clears the cool bar", buildVendorInviteBrief([{ vendorId: "x", name: "X", category: null, score: 0.3, tier: "cool", reasons: [] }]) === null)
}

function sourceLayer() {
  console.log("\n[wiring — off-platform filter, gated weekly brief, owned]")
  const scout = src("lib/recruiting/vendor-recruitment-scout.ts")
  check("OFF-PLATFORM = no role assignment AND no pending invitation", /user_role_assignments[\s\S]*?vendor_invitations[\s\S]*?"pending"/.test(scout))
  check("gathers REAL signals (ratings + booking spend)", /vendor_ratings[\s\S]*?vendor_bookings/.test(scout))
  check("proposes a GATED brief via the proposal rail (nothing auto-sends)", /proposeClientMessage/.test(scout))
  check("deduped per (brokerage, ISO week)", /VENDOR RECRUITMENT BRIEF — \$\{isoWeekKey\(now\)\}/.test(scout))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly recruit-outreach cron runs the vendor scout", /runVendorRecruitmentScoutAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /vendor_recruitment_propensity:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:vendor-recruitment"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed an off-platform vendor + real usage → scout scores + proposes a gated invite brief → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: vend } = await svc.from("vendors").insert({ brokerage_id: brokerageId, name: "ZZ Test Inspections", category: "Inspector", rating: 4.9, status: "active" }).select("id").single()
    const vendorId = (vend as any).id
    cleanup.push({ table: "vendors", id: vendorId })
    const { data: rate } = await svc.from("vendor_ratings").insert({ brokerage_id: brokerageId, vendor_id: vendorId, avg_agent_rating: 4.9, avg_client_rating: 4.8, five_star_count: 14, total_bookings: 16 }).select("id").single()
    cleanup.push({ table: "vendor_ratings", id: (rate as any).id })
    for (let i = 0; i < 3; i++) {
      const { data: bk } = await svc.from("vendor_bookings").insert({ brokerage_id: brokerageId, vendor_id: vendorId, cost: 3000, status: "completed", service_type: "inspection" }).select("id").single()
      cleanup.push({ table: "vendor_bookings", id: (bk as any).id })
    }

    const { runVendorRecruitmentScout } = await import("../lib/recruiting/vendor-recruitment-scout")
    const r1 = await runVendorRecruitmentScout(svc as any, { brokerageId })
    check("live: scored the off-platform vendor(s)", r1.scored >= 1)
    check("live: our heavily-relied-on test vendor scored HOT", r1.hot >= 1)
    check("live: proposed exactly one gated invite brief", r1.briefProposed === true)

    const { data: msg } = await svc.from("agent_client_messages").select("id, entity_type, audience, status")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").ilike("rationale", "VENDOR RECRUITMENT BRIEF%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("live: the brief is a GATED proposal (status proposed, internal audience)", !!msg && (msg as any).status === "proposed" && (msg as any).audience === "agent")

    const r2 = await runVendorRecruitmentScout(svc as any, { brokerageId })
    check("live: idempotent — no second brief the same week", r2.briefProposed === false)
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
  if (fail > 0) { console.log(" ❌ VENDOR_RECRUITMENT_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_RECRUITMENT_PASS — off-platform vendors you rely on are scored; the top become a gated weekly invite brief")
}
main()
