#!/usr/bin/env tsx
/**
 * scripts/vendor-coverage-simulator.ts   (npm run test:vendor-coverage)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the VENDOR COVERAGE FORECAST + GAP RADAR — the forward-looking half of the bench. Forecast the
 * vendor categories the pipeline will soon need, assess whether reliable vendors can cover it, and flag
 * a gap (demand but 0 reliable vendors) before a deal stalls. Honest: no demand → never a gap.
 *
 * PURE:   forecastVendorDemand (stage→categories) + assessCoverage (gap/thin/covered, gaps first).
 * SOURCE: the runner forecasts real pipeline, counts reliable bench (SLA-aware), proposes a gated brief;
 *         rides the vendor-orchestration cron; owned by deal_coordinator.
 * LIVE (creds-gated): seed pipeline deals + a bench with a gap → runner flags the gap + proposes a gated
 *         brief → idempotent → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { forecastVendorDemand, assessCoverage, type VendorCategory } from "../lib/kernel/vendor-coverage-forecast"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[forecastVendorDemand · pure — stage → upcoming category demand]")
  const demand = forecastVendorDemand([{ stage: "UNDER_CONTRACT" }, { stage: "under_contract" }, { stage: "APPRAISAL" }, { stage: "CLOSING_PREP" }, { stage: "NEW" }])
  check("under-contract deals forecast inspector demand", demand.get("Inspector") === 2)
  check("appraisal forecasts a lender", demand.get("Lender") === 1)
  check("closing-prep forecasts title", demand.get("Title Company") === 1)
  check("a stage with no vendor need contributes nothing", !demand.has("Stager"))

  console.log("\n[assessCoverage · pure — gap / thin / covered, honest]")
  const d = new Map<VendorCategory, number>([["Inspector", 3], ["Lender", 2], ["Title Company", 1]])
  const reliable = new Map<VendorCategory, number>([["Inspector", 0], ["Lender", 1], ["Title Company", 2]])
  const a = assessCoverage(d, reliable)
  check("category with demand + 0 reliable → GAP", a.find((x) => x.category === "Inspector")!.status === "gap")
  check("category with demand + exactly 1 reliable → THIN (single point of failure)", a.find((x) => x.category === "Lender")!.status === "thin")
  check("category with demand + ≥2 reliable → COVERED", a.find((x) => x.category === "Title Company")!.status === "covered")
  check("gaps sort first", a[0].status === "gap")
  check("a category with NO demand is never assessed (never a fabricated gap)", assessCoverage(new Map(), new Map([["Inspector", 0]])).length === 0)
}

function sourceLayer() {
  console.log("\n[wiring — SLA-aware bench, gated brief, cron, owned]")
  const lib = src("lib/kernel/vendor-coverage-forecast.ts")
  check("reliability reuses the shared computeVendorSla/slaTier (no drift)", /computeVendorSla\(rows, \{\}\)\[v\.id\][\s\S]*?slaTier\(sla\.slaPct\) !== "breach"/.test(lib))
  check("unproven vendors are presumed reliable (honest on thin data)", /sla\.total < COVERAGE_MIN_SAMPLE/.test(lib))
  check("proposes ONE gated weekly brief on gaps (deduped)", /VENDOR COVERAGE GAP — \$\{isoWeekKey\(now\)\}[\s\S]*?proposeClientMessage/.test(lib))
  const cron = src("app/api/cron/vendor-orchestration/route.ts")
  check("the daily vendor-orchestration cron runs the forecast", /runVendorCoverageForecastAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by deal_coordinator with a runnable proof", /vendor_coverage_forecast:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:vendor-coverage"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed pipeline demand with no inspector on the bench → gap flagged + gated brief → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    // Two deals heading into inspection; ensure the bench has NO active Inspector for this brokerage
    // (seed a Lender only, so Inspector is a gap).
    for (let i = 0; i < 2; i++) {
      const { data: t } = await svc.from("transactions").insert({ brokerage_id: brokerageId, stage: "UNDER_CONTRACT", status: "active", deal_name: `ZZ Coverage Test ${i}` }).select("id").single()
      cleanup.push({ table: "transactions", id: (t as any).id })
    }
    const { data: v } = await svc.from("vendors").insert({ brokerage_id: brokerageId, name: "ZZ Cover Lender", category: "Lender", status: "active" }).select("id").single()
    cleanup.push({ table: "vendors", id: (v as any).id })

    const { runVendorCoverageForecast } = await import("../lib/kernel/vendor-coverage-forecast")
    const r = await runVendorCoverageForecast(svc as any, { brokerageId })
    check("live: forecast saw the pipeline demand", r.deals >= 2)
    check("live: flagged an Inspector coverage gap", r.gaps >= 1)

    const { data: brief } = await svc.from("agent_client_messages").select("id, status, audience")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "deal_coordinator").ilike("rationale", "VENDOR COVERAGE GAP%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (brief) cleanup.push({ table: "agent_client_messages", id: (brief as any).id })
    check("live: proposed a gated coverage brief to the broker", !!brief && (brief as any).status === "proposed" && (brief as any).audience === "agent")

    const r2 = await runVendorCoverageForecast(svc as any, { brokerageId })
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
  if (fail > 0) { console.log(" ❌ VENDOR_COVERAGE_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_COVERAGE_PASS — the OS forecasts its own vendor supply gaps and warns before deals stall")
}
main()
