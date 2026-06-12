#!/usr/bin/env tsx
/**
 * scripts/lead-intake-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEAD INTAKE COCKPIT harness — proves the Data Steward's read-only command
 * surface over the FRONT of the lifecycle: the live raw → THE GATE → leads (AI ISA)
 * → contact funnel, the gate REJECTIONS + why, the per-SOURCE conversion truth
 * (raw→lead, lead→contact), and the hot seller-intent list the AI ISA is holding.
 *
 * Built on the content-studio / inventory-radar pure+live template. NO mocks, NO
 * stubs, NO demo data — Layer-2 seeds REAL raw_scraped_leads + leads rows, asserts the
 * aggregation against the live tables, then reverse-deletes and proves cleanup == 0.
 *
 * Layer 1 (pure, always runs):
 *   · computeFunnel — correct stage tallies + rejection breakdown over sample rows.
 *   · conversionRate — rate math + honest zero on empty denominator.
 *   · groupBySource — per-source raw→lead + lead→contact, honest zeros, sorted.
 *   · parseRadarNote / topHotIntent — Radar-note WHY parsing + hot-intent ranking.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   · seed real raw_scraped_leads across statuses (pending / promoted /
 *     unassigned_no_market / territory_mismatch / duplicate_pre_enrich) + two real
 *     leads (one converted — contact_id set; one AI-ISA-owned with a Radar note),
 *     assert the funnel counts + per-source rates + rejection breakdown + hot-intent
 *     list, then reverse-delete and assert cleanup count == 0.
 *
 * Run: npx tsx scripts/lead-intake-simulator.ts  (npm run test:lead-intake)
 */
import {
  computeFunnel,
  conversionRate,
  groupBySource,
  parseRadarNote,
  topHotIntent,
  loadLeadIntakeCockpit,
  type RawRowLite,
  type LeadRowLite,
} from "../lib/kernel/lead-intake-cockpit"

let passed = 0,
  failed = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) {
    passed++
    console.log(`  ✓ ${n}`)
  } else {
    failed++
    fails.push(n)
    console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`)
  }
}
const report = () => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) {
    for (const f of fails) console.log("   - " + f)
    process.exit(1)
  }
  console.log(" ✅ Lead Intake Cockpit verified")
}

async function main() {
  console.log("══ Lead Intake Cockpit simulator ══\n[Layer 1 · pure funnel + rates + grouping]")

  // ── computeFunnel — correct stage tallies + rejection breakdown ──
  const sampleRaw: RawRowLite[] = [
    { source: "batchdata_motivated", processing_status: "promoted", lead_id: "l1" },
    { source: "batchdata_motivated", processing_status: "promoted", lead_id: "l2" },
    { source: "batchdata_motivated", processing_status: "unassigned_no_market", lead_id: null },
    { source: "craigslist_fsbo", processing_status: "territory_mismatch", lead_id: null },
    { source: "craigslist_fsbo", processing_status: "duplicate_pre_enrich", lead_id: null },
    { source: "craigslist_fsbo", processing_status: "pending", lead_id: null },
    { source: "zillow", processing_status: "enriching", lead_id: null },
    { source: "zillow", processing_status: "error", lead_id: null },
  ]
  const funnel = computeFunnel(sampleRaw)
  check("computeFunnel: rawTotal counts every row", funnel.rawTotal === 8, `got ${funnel.rawTotal}`)
  check("computeFunnel: promoted tally", funnel.promoted === 2, `got ${funnel.promoted}`)
  check("computeFunnel: pending folds pending+enriching", funnel.pending === 2, `got ${funnel.pending}`)
  check("computeFunnel: rejected tally (3 rejection statuses)", funnel.rejected === 3, `got ${funnel.rejected}`)
  check("computeFunnel: error tally", funnel.error === 1, `got ${funnel.error}`)
  check(
    "computeFunnel: rejectionsByReason breakdown is per-status",
    funnel.rejectionsByReason["unassigned_no_market"] === 1 &&
      funnel.rejectionsByReason["territory_mismatch"] === 1 &&
      funnel.rejectionsByReason["duplicate_pre_enrich"] === 1,
    JSON.stringify(funnel.rejectionsByReason),
  )
  check(
    "computeFunnel: stages sum to rawTotal (no row dropped)",
    funnel.pending + funnel.promoted + funnel.rejected + funnel.error === funnel.rawTotal,
  )

  // ── computeFunnel honest empty ──
  const emptyFunnel = computeFunnel([])
  check(
    "computeFunnel: honest zeros on empty input",
    emptyFunnel.rawTotal === 0 &&
      emptyFunnel.promoted === 0 &&
      emptyFunnel.pending === 0 &&
      emptyFunnel.rejected === 0 &&
      emptyFunnel.error === 0 &&
      Object.keys(emptyFunnel.rejectionsByReason).length === 0,
  )

  // unknown status → honestly pending (not dropped)
  const unknown = computeFunnel([{ source: "x", processing_status: "some_new_status", lead_id: null }])
  check("computeFunnel: unknown status counts as pending (never dropped)", unknown.pending === 1 && unknown.rawTotal === 1)

  // ── conversionRate — rate math + honest zero ──
  check("conversionRate: 2/8 = 0.25", conversionRate(2, 8) === 0.25)
  check("conversionRate: 0 denominator → honest 0 (no NaN)", conversionRate(5, 0) === 0)
  check("conversionRate: clamps to [0,1]", conversionRate(10, 5) === 1 && conversionRate(-1, 5) === 0)
  check("conversionRate: 1/1 = 1", conversionRate(1, 1) === 1)

  // ── groupBySource — per-source raw→lead + lead→contact ──
  const sampleLeads: LeadRowLite[] = [
    { source: "batchdata_motivated", contact_id: "c1", ai_isa_owner: false, lead_score: 80, notes: null },
    { source: "batchdata_motivated", contact_id: null, ai_isa_owner: true, lead_score: 90, notes: null },
    { source: "zillow", contact_id: null, ai_isa_owner: true, lead_score: 50, notes: null },
  ]
  const bySource = groupBySource(sampleRaw, sampleLeads)
  const bd = bySource.find((s) => s.source === "batchdata_motivated")!
  check("groupBySource: batchdata raw count", bd.rawCount === 3 && bd.promotedCount === 2)
  check("groupBySource: batchdata raw→lead = 2/3", Math.abs(bd.rawToLeadRate - 2 / 3) < 1e-9)
  check("groupBySource: batchdata lead→contact = 1/2", bd.leadCount === 2 && bd.convertedCount === 1 && bd.leadToContactRate === 0.5)
  const cl = bySource.find((s) => s.source === "craigslist_fsbo")!
  check("groupBySource: craigslist promoted 0 → raw→lead honest 0", cl.promotedCount === 0 && cl.rawToLeadRate === 0)
  check(
    "groupBySource: source with leads but no raw still appears (honest)",
    bySource.some((s) => s.source === "zillow" && s.leadCount === 1),
  )
  check("groupBySource: sorted by rawCount desc", bySource[0].rawCount >= bySource[bySource.length - 1].rawCount)
  check("groupBySource: honest empty on []", groupBySource([], []).length === 0)

  // ── parseRadarNote — WHY parsing from the real Radar note format ──
  const radarNote =
    "[Listing Inventory Radar] Seller-intent 82/100 for 9 Probe Ln. Why now: pre-foreclosure/distress; equity 82%; absentee owner. Prioritize for AI-ISA qualification — NOT yet a contact."
  const parsed = parseRadarNote(radarNote)
  check("parseRadarNote: extracts the 3 WHY reasons", parsed.reasons.length === 3 && parsed.reasons[0] === "pre-foreclosure/distress")
  check("parseRadarNote: extracts the summary sentence", !!parsed.summary && parsed.summary.includes("Seller-intent 82/100"))
  check("parseRadarNote: non-radar note → empty", parseRadarNote("just a normal note").reasons.length === 0)
  check("parseRadarNote: null → empty", parseRadarNote(null).reasons.length === 0 && parseRadarNote(null).summary === null)

  // ── topHotIntent — ranks ISA-owned non-contact Radar leads by score ──
  const hotLeads = [
    { leadId: "h1", source: "batchdata_motivated", contact_id: null, ai_isa_owner: true, lead_score: 60, notes: radarNote },
    { leadId: "h2", source: "batchdata_motivated", contact_id: null, ai_isa_owner: true, lead_score: 90, notes: radarNote },
    { leadId: "h3", source: "zillow", contact_id: "c9", ai_isa_owner: false, lead_score: 99, notes: radarNote }, // a contact → excluded
    { leadId: "h4", source: "zillow", contact_id: null, ai_isa_owner: true, lead_score: 70, notes: "no radar note" }, // no stamp → excluded
  ]
  const hot = topHotIntent(hotLeads, 10)
  check("topHotIntent: excludes contacts + un-stamped leads", hot.length === 2 && !hot.some((h) => h.leadId === "h3" || h.leadId === "h4"))
  check("topHotIntent: ranked by score desc", hot[0].leadId === "h2" && hot[0].leadScore === 90)
  check("topHotIntent: carries parsed reasons", hot[0].reasons.length === 3)
  check("topHotIntent: respects the limit", topHotIntent(hotLeads, 1).length === 1)
  check("topHotIntent: honest empty on []", topHotIntent([], 10).length === 0)

  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2] ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live: real raw_scraped_leads + leads, read-only aggregation]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `LIC${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brokerage) {
      console.log("  ⏭  Skipped — need a brokerage.")
      report()
      return
    }
    const brokerageId = (brokerage as any).id as string

    // ── Seed REAL raw_scraped_leads across statuses for ONE source (batchdata_motivated):
    //    2 promoted, 1 unassigned_no_market, 1 territory_mismatch, 1 duplicate_pre_enrich,
    //    1 pending. A second source (craigslist_fsbo) with 1 promoted + 1 pending so the
    //    per-source rates differ. ──
    const seedRaw = async (source: string, status: string, leadId: string | null) => {
      const { data } = await svc
        .from("raw_scraped_leads")
        .insert({
          brokerage_id: brokerageId,
          source,
          source_record_id: `${TAG}-${source}-${status}-${Math.random().toString(36).slice(2, 8)}`,
          processing_status: status,
          lead_id: leadId,
          address: `${TAG} probe`,
          raw_data: { tag: TAG },
          normalized_preview: { tag: TAG },
        })
        .select("id")
        .single()
      cleanup.push({ table: "raw_scraped_leads", id: (data as any).id })
      return (data as any).id as string
    }

    // ── Seed 2 real leads first (so promoted raw rows can carry real lead_id FKs):
    //    one CONVERTED (contact_id set), one AI-ISA-owned with a Radar note (the hot one). ──
    const { data: convertedLead } = await svc
      .from("leads")
      .insert({
        brokerage_id: brokerageId,
        first_name: TAG,
        last_name: "Converted",
        source: "batchdata_motivated",
        lead_stage: "new",
        lifecycle_state: "unconsented",
        ai_isa_owner: false,
        lead_score: 80,
        // contact_id is set below after we mint a contact, so this lead is a real conversion.
      })
      .select("id")
      .single()
    cleanup.push({ table: "leads", id: (convertedLead as any).id })

    // Mint a real contact and point the converted lead at it (the conversion truth).
    const { data: contact } = await svc
      .from("contacts")
      .insert({
        brokerage_id: brokerageId,
        first_name: TAG,
        last_name: "Converted",
      })
      .select("id")
      .single()
    cleanup.push({ table: "contacts", id: (contact as any).id })
    await svc.from("leads").update({ contact_id: (contact as any).id }).eq("id", (convertedLead as any).id)

    const radarNoteLive = `[Listing Inventory Radar] Seller-intent 88/100 for ${TAG} 9 Probe Ln. Why now: pre-foreclosure/distress; equity 82%; absentee owner. Prioritize for AI-ISA qualification — NOT yet a contact (no portal, no client message until qualified + converted).`
    const { data: hotLead } = await svc
      .from("leads")
      .insert({
        brokerage_id: brokerageId,
        first_name: TAG,
        last_name: "HotIsa",
        source: "batchdata_motivated",
        lead_stage: "new",
        lifecycle_state: "unconsented",
        ai_isa_owner: true,
        lead_score: 88,
        notes: radarNoteLive,
      })
      .select("id")
      .single()
    cleanup.push({ table: "leads", id: (hotLead as any).id })

    // raw rows — 2 promoted (FK to the two real leads), then the rejections + pending.
    await seedRaw("batchdata_motivated", "promoted", (convertedLead as any).id)
    await seedRaw("batchdata_motivated", "promoted", (hotLead as any).id)
    await seedRaw("batchdata_motivated", "unassigned_no_market", null)
    await seedRaw("batchdata_motivated", "territory_mismatch", null)
    await seedRaw("batchdata_motivated", "duplicate_pre_enrich", null)
    await seedRaw("batchdata_motivated", "pending", null)
    await seedRaw("craigslist_fsbo", "promoted", null)
    await seedRaw("craigslist_fsbo", "pending", null)

    // ── Load the cockpit (read-only) and assert against the seeded truth. ──
    const data = await loadLeadIntakeCockpit(brokerageId, svc)

    // Funnel: our 8 raw rows are folded in (the brokerage may have pre-existing rows, so
    // assert our seeded deltas are PRESENT, not exact totals).
    check("live funnel: rawTotal >= our 8 seeded rows", data.funnel.rawTotal >= 8, `got ${data.funnel.rawTotal}`)
    check("live funnel: promoted >= our 3 promoted rows", data.funnel.promoted >= 3, `got ${data.funnel.promoted}`)
    check(
      "live funnel: rejection breakdown carries our seeded reasons",
      (data.funnel.rejectionsByReason["unassigned_no_market"] ?? 0) >= 1 &&
        (data.funnel.rejectionsByReason["territory_mismatch"] ?? 0) >= 1 &&
        (data.funnel.rejectionsByReason["duplicate_pre_enrich"] ?? 0) >= 1,
      JSON.stringify(data.funnel.rejectionsByReason),
    )

    // Per-source: batchdata raw→lead truth (our seed: 6 raw, 2 promoted from this source).
    const bdLive = data.bySource.find((s) => s.source === "batchdata_motivated")
    check("live per-source: batchdata source present with raw + promoted", !!bdLive && bdLive.rawCount >= 6 && bdLive.promotedCount >= 2)
    check("live per-source: batchdata raw→lead rate is a real fraction in (0,1]", !!bdLive && bdLive.rawToLeadRate > 0 && bdLive.rawToLeadRate <= 1)
    check(
      "live per-source: batchdata lead→contact reflects the 1 converted lead",
      !!bdLive && bdLive.convertedCount >= 1 && bdLive.leadToContactRate > 0,
    )

    // Overall conversion legs are honest fractions.
    check("live overall: raw→lead rate in (0,1]", data.overallRawToLead > 0 && data.overallRawToLead <= 1)
    check("live overall: lead→contact rate in (0,1]", data.overallLeadToContact > 0 && data.overallLeadToContact <= 1)
    check("live overall: convertedTotal >= 1 (our converted lead)", data.convertedTotal >= 1)

    // Hot-intent: our AI-ISA-owned, non-contact, Radar-stamped lead surfaces with reasons.
    const mineHot = data.hotIntent.find((h) => h.leadId === (hotLead as any).id)
    check("live hot-intent: the AI-ISA-owned Radar lead surfaces", !!mineHot, `hotIntent ids=${data.hotIntent.map((h) => h.leadId).join(",")}`)
    check("live hot-intent: carries the real lead_score (88)", !!mineHot && mineHot.leadScore === 88)
    check("live hot-intent: carries the parsed WHY reasons", !!mineHot && mineHot.reasons.length === 3)
    check(
      "live hot-intent: the CONVERTED lead is NOT in the hot list (it's a contact now)",
      !data.hotIntent.some((h) => h.leadId === (convertedLead as any).id),
    )
  } finally {
    for (const c of [...cleanup].reverse()) {
      try {
        await svc.from(c.table).delete().eq("id", c.id)
      } catch {}
    }
    const { count: rawLeft } = await svc
      .from("raw_scraped_leads")
      .select("id", { count: "exact", head: true })
      .like("source_record_id", `${TAG}%`)
    const { count: leadLeft } = await svc
      .from("leads")
      .select("id", { count: "exact", head: true })
      .like("last_name", `%`)
      .eq("first_name", TAG)
    check("cleanup verified — no seeded raw rows remain (count == 0)", (rawLeft ?? 0) === 0, `raw=${rawLeft}`)
    check("cleanup verified — no seeded leads remain (count == 0)", (leadLeft ?? 0) === 0, `leads=${leadLeft}`)
  }

  report()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
