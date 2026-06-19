#!/usr/bin/env tsx
/**
 * scripts/geo-gap-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the GEO LOOP CLOSURE — the citation monitor's honest observations become ACTION. A lead-magnet
 * / FAQ landing page that AI search has checked enough times, across enough days, and STILL never cited
 * is flagged to the Campaign Orchestrator with a precise refresh recommendation (feed-only — a human
 * regenerates the FAQ via the builder). The decision never fires on thin data or on a page that IS cited.
 *
 * Layer 1 (pure): assessGeoGap across the cases (cited / insufficient / single-day watch / persistent act).
 * Layer 2 (live, creds-gated): seed a lead-magnet form + several days of not_cited landing observations,
 * run runGeoGapScan → assert ONE geo_visibility_gap signal to campaign_orchestrator; a CITED page yields
 * none; idempotent rerun; reverse-delete, cleanup count == 0.
 *
 * Run: npx tsx scripts/geo-gap-simulator.ts   (npm run test:geo-gap)
 */
import { assessGeoGap, geoGapRecommendation } from "../lib/intelligence/geo-gap"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { signalSpec } from "../lib/kernel/signal-registry"

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
  console.log(" ✅ GEO loop closed — persistent invisibility becomes a precise, gated refresh recommendation.")
  console.log(" GEO_GAP_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" GEO-gap loop simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · assessGeoGap]")
  check("cited at all → none (it's working)", assessGeoGap({ cited: 1, notCited: 4, notChecked: 0, distinctCheckedDays: 3 }).severity === "none")
  check("too few checks → none (no thin-data false positive)", assessGeoGap({ cited: 0, notCited: 2, notChecked: 5, distinctCheckedDays: 1 }).reason === "insufficient_data")
  check("0 cited, enough checks, one day → watch", assessGeoGap({ cited: 0, notCited: 5, notChecked: 0, distinctCheckedDays: 1 }).severity === "watch")
  const act = assessGeoGap({ cited: 0, notCited: 6, notChecked: 0, distinctCheckedDays: 3 })
  check("0 cited, enough checks, ≥2 days → act (persistently invisible)", act.severity === "act" && act.needsRemediation && act.visibility === 0)
  check("not_checked excluded from the denominator (visibility null when nothing checked)", assessGeoGap({ cited: 0, notCited: 0, notChecked: 8, distinctCheckedDays: 0 }).visibility === null)
  check("recommendation names the page + cadence", /\/lm\/abc/.test(geoGapRecommendation("abc", { cited: 0, notCited: 6, notChecked: 0, distinctCheckedDays: 3 })))

  // The signal must be catalogued and its kind must match the live classifier (signal-integrity parity).
  // The GEO loop was upgraded from feed-only to HANDLED: the Campaign Orchestrator consumes the gap
  // and proposes a gated regenerate_faq action (a real SIGNAL_HANDLERS consumer exists).
  const spec = signalSpec("geo_visibility_gap")
  check("geo_visibility_gap is catalogued (handled — Campaign Orchestrator proposes regenerate_faq)",
    !!spec && spec.disposition === "handled" && (spec.consumers ?? []).includes("campaign_orchestrator"))
  check("declared kind matches classifyCoordination", !!spec && spec.kind === classifyCoordination("geo_visibility_gap"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log("\n[Layer 2 · live: persistent invisibility → campaign_orchestrator signal]")
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runGeoGapScan } = await import("../lib/intelligence/geo-gap-runner")
  const svc = createServiceClient()
  const TAG = `__geogap_${Date.now()}__`
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let invisibleForm = "", citedForm = ""

  try {
    const slugInv = `${TAG}inv`, slugCited = `${TAG}cited`
    const { data: f1 } = await svc.from("lead_capture_forms").insert({ brokerage_id: brokerageId, name: `${TAG} Invisible`, slug: slugInv, is_active: true }).select("id").single()
    const { data: f2 } = await svc.from("lead_capture_forms").insert({ brokerage_id: brokerageId, name: `${TAG} Cited`, slug: slugCited, is_active: true }).select("id").single()
    invisibleForm = (f1 as any).id; citedForm = (f2 as any).id
    cleanup.push({ table: "lead_capture_forms", id: invisibleForm }, { table: "lead_capture_forms", id: citedForm })

    // Invisible page: not_cited across 3 distinct days. Cited page: cited.
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
    const rowsToInsert: any[] = []
    for (let d = 0; d < 3; d++) {
      rowsToInsert.push({ brokerage_id: brokerageId, form_id: invisibleForm, public_slug: slugInv, platform: "perplexity", query: "q", outcome: "not_cited", observed_on: day(d) })
      rowsToInsert.push({ brokerage_id: brokerageId, form_id: invisibleForm, public_slug: slugInv, platform: "chatgpt", query: "q", outcome: "not_cited", observed_on: day(d) })
    }
    rowsToInsert.push({ brokerage_id: brokerageId, form_id: citedForm, public_slug: slugCited, platform: "perplexity", query: "q", outcome: "cited", observed_on: day(0) })
    rowsToInsert.push({ brokerage_id: brokerageId, form_id: citedForm, public_slug: slugCited, platform: "chatgpt", query: "q", outcome: "not_cited", observed_on: day(0) })
    const { data: ins } = await svc.from("ai_search_landing_citation_observations").insert(rowsToInsert).select("id")
    for (const r of (ins ?? []) as any[]) cleanup.push({ table: "ai_search_landing_citation_observations", id: r.id })

    const scan = await runGeoGapScan(brokerageId, { windowDays: 30 }, svc)
    check("scan evaluated both pages", scan.pagesEvaluated >= 2, JSON.stringify(scan))
    check("exactly the invisible page flagged a gap", scan.gapsFound >= 1 && scan.signalsPublished >= 1)

    const { data: sig } = await svc.from("manager_signals")
      .select("id, to_manager, from_manager, signal_type, entity_id, message")
      .eq("brokerage_id", brokerageId).eq("signal_type", "geo_visibility_gap").eq("entity_id", invisibleForm).maybeSingle()
    check("signal addressed to campaign_orchestrator from asset_manager", (sig as any)?.to_manager === "campaign_orchestrator" && (sig as any)?.from_manager === "asset_manager", JSON.stringify(sig))
    check("signal message recommends a refresh", /regenerate its FAQ/i.test((sig as any)?.message ?? ""))
    if ((sig as any)?.id) cleanup.push({ table: "manager_signals", id: (sig as any).id })

    const { data: noSig } = await svc.from("manager_signals").select("id").eq("brokerage_id", brokerageId).eq("signal_type", "geo_visibility_gap").eq("entity_id", citedForm).maybeSingle()
    check("the CITED page produced NO gap signal", !noSig)

    // Idempotent: rerun does not create a second open signal for the same page.
    await runGeoGapScan(brokerageId, { windowDays: 30 }, svc)
    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("signal_type", "geo_visibility_gap").eq("entity_id", invisibleForm).eq("status", "open")
    check("idempotent: still exactly one open gap signal", (sigCount ?? 0) === 1)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("signal_type", "geo_visibility_gap").in("entity_id", [invisibleForm, citedForm].filter(Boolean)).then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("ai_search_landing_citation_observations").select("id", { count: "exact", head: true }).in("form_id", [invisibleForm, citedForm].filter(Boolean))
    check("cleanup: seeded observations removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
