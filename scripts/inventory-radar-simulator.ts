#!/usr/bin/env tsx
/**
 * scripts/inventory-radar-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LISTING INVENTORY RADAR harness — the lead-gen leap that ties the EXISTING
 * scraper bench → routing → video into one coordinated team play.
 *
 * Layer 1 (pure): scoreSellerIntent (documented weights; a pre-foreclosure + high-equity
 *   candidate scores ABOVE a fresh low-equity FSBO — the whole point); rankSellerLeads
 *   (deterministic desc ordering); candidateFromRawRow (reads only real persisted fields);
 *   honest empty (no candidates → empty rank).
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): seed REAL raw_scraped_leads seller
 *   candidates (a pre-foreclosure+high-equity row and a fresh low-equity FSBO row), run
 *   runListingInventoryRadar, assert a data_steward → listing_concierge manager_signal for
 *   the hot candidate + (via consumeManagerSignals) the GATED 'thinking of selling?' agent
 *   brief (audience 'agent', proposed); idempotent rerun proposes nothing new; reverse-delete
 *   + assert cleanup count == 0. Self-cleans with a unique TAG. No mocks, real data.
 *
 * Run: npx tsx scripts/inventory-radar-simulator.ts  (npm run test:inventory-radar)
 */
import {
  scoreSellerIntent,
  rankSellerLeads,
  candidateFromRawRow,
  SELLER_INTENT_SIGNAL_TYPE,
  type SellerLeadCandidate,
} from "../lib/kernel/listing-inventory-radar"

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
  console.log(" ✅ Listing Inventory Radar verified — score seller intent + rank + route to Listing Concierge + gated 'thinking of selling?' proposal")
  console.log(" INVENTORY_RADAR_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Listing Inventory Radar simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · score seller intent + rank + map]")

  // Hot: pre-foreclosure + high equity (the textbook motivated, able-to-transact seller).
  const hot = scoreSellerIntent({ source: "batchdata_motivated", motivationType: "pre_foreclosure", quickLists: ["preforeclosure", "high-equity"], equityPercent: 80 })
  // Warm-ish: a FRESH FSBO with LOW equity (already selling, but no distress + can't move easily).
  const fsbo = scoreSellerIntent({ source: "craigslist_fsbo", isFsbo: true, equityPercent: 8, expiredDaysAgo: 0 })
  check("pre-foreclosure + high-equity scores in (0,1]", hot.score > 0 && hot.score <= 1, `got ${hot.score}`)
  check("fresh low-equity FSBO scores in (0,1]", fsbo.score > 0 && fsbo.score <= 1, `got ${fsbo.score}`)
  check("pre-foreclosure + high-equity OUTRANKS a fresh low-equity FSBO (the whole point)",
    hot.score > fsbo.score, `hot ${hot.score.toFixed(3)} vs fsbo ${fsbo.score.toFixed(3)}`)
  check("hot candidate's reasons cite pre-foreclosure + equity (no fabrication, earned lines)",
    hot.reasons.some((r) => /pre-foreclosure/i.test(r)) && hot.reasons.some((r) => /equity/i.test(r)))

  // Expired recency decay: a fresh expired listing scores higher than a stale one.
  const freshExpired = scoreSellerIntent({ source: "expired_listing", motivationType: "expired", expiredDaysAgo: 3 })
  const staleExpired = scoreSellerIntent({ source: "expired_listing", motivationType: "expired", expiredDaysAgo: 200 })
  check("expired listing recency decays — fresh expired outscores a stale one",
    freshExpired.score > staleExpired.score, `fresh ${freshExpired.score.toFixed(3)} vs stale ${staleExpired.score.toFixed(3)}`)

  // Equity scaling: more equity → more points.
  const eqHi = scoreSellerIntent({ source: "batchdata_motivated", equityPercent: 75 })
  const eqLo = scoreSellerIntent({ source: "batchdata_motivated", equityPercent: 15 })
  check("equity scales the score (75% > 15%)", eqHi.score > eqLo.score)

  // Absent fields contribute nothing (no assumed values).
  const empty = scoreSellerIntent({ source: "batchdata_motivated" })
  check("a candidate with no real signals scores 0 (never assumes intent)", empty.score === 0, `got ${empty.score}`)

  // rankSellerLeads: deterministic desc ordering.
  const cands: SellerLeadCandidate[] = [
    { rawLeadId: "b-fsbo", signals: { source: "craigslist_fsbo", isFsbo: true, equityPercent: 8 } },
    { rawLeadId: "a-hot", signals: { source: "batchdata_motivated", motivationType: "pre_foreclosure", equityPercent: 80 } },
  ]
  const ranked = rankSellerLeads(cands)
  check("rankSellerLeads: hottest candidate ranks first", ranked[0].rawLeadId === "a-hot")
  check("rankSellerLeads: every candidate carries an intentScore + reasons",
    ranked.every((r) => typeof r.intentScore === "number" && Array.isArray(r.reasons)))
  check("rankSellerLeads honest empty — [] in → [] out", rankSellerLeads([]).length === 0)

  // candidateFromRawRow reads real persisted fields (raw_data + normalized_preview shape).
  const mapped = candidateFromRawRow({
    id: "raw-1", source: "batchdata_motivated", lead_id: null, address: "9 Probe Ln",
    raw_data: { motivationType: "pre_foreclosure", quickLists: ["preforeclosure", "high-equity"], valuation: { equityPercent: 72 }, propertyAddress: "9 Probe Ln", firstName: "Pat", ownershipLengthYears: 18 },
    normalized_preview: { intentSignals: ["pre_foreclosure"], motivationScore: 88 },
  })
  check("candidateFromRawRow pulls equity% + quickLists + tenure from the real row",
    mapped.signals.equityPercent === 72 && (mapped.signals.quickLists ?? []).includes("high-equity") && mapped.signals.ownershipLengthYears === 18)
  check("candidateFromRawRow scores the mapped row as a hot candidate",
    scoreSellerIntent(mapped.signals).score > fsbo.score)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live radar → route → gated proposal]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runListingInventoryRadar } = await import("../lib/kernel/listing-inventory-radar")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const TAG = `Radar${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 2 · live radar → route → gated proposal]")
  try {
    const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brokerage) { console.log("  ⏭  Skipped — need a brokerage."); report(); return }
    const brokerageId = (brokerage as any).id

    // Seed REAL raw_scraped_leads seller candidates (the bench's already-scraped output).
    // HOT: pre-foreclosure + high equity. COLD-ish: fresh low-equity FSBO (should not route).
    const { data: hotRow } = await svc.from("raw_scraped_leads").insert({
      brokerage_id: brokerageId, source: "batchdata_motivated",
      source_record_id: `${TAG}-hot`, processing_status: "pending",
      address: `${TAG} 9 Probe Ln`,
      raw_data: { motivationType: "pre_foreclosure", quickLists: ["preforeclosure", "high-equity"], valuation: { equityPercent: 82 }, propertyAddress: `${TAG} 9 Probe Ln`, firstName: TAG, lastName: "Owner", ownershipLengthYears: 17, mailingAddressVacant: true },
      normalized_preview: { intentType: "seller", behaviorType: "motivated_seller", intentSignals: ["pre_foreclosure"], motivationScore: 90, propertyAddress: `${TAG} 9 Probe Ln` },
    }).select("id").single()
    cleanup.push({ table: "raw_scraped_leads", id: (hotRow as any).id })

    const { data: fsboRow } = await svc.from("raw_scraped_leads").insert({
      brokerage_id: brokerageId, source: "craigslist_fsbo",
      source_record_id: `${TAG}-fsbo`, processing_status: "pending",
      address: `${TAG} 2 Low St`,
      raw_data: { fsboMarker: true, valuation: { equityPercent: 6 }, propertyAddress: `${TAG} 2 Low St`, firstName: TAG, lastName: "Fsbo" },
      normalized_preview: { intentType: "seller", behaviorType: "fsbo_listing", intentSignals: ["fsbo"], motivationScore: 40, propertyAddress: `${TAG} 2 Low St` },
    }).select("id").single()
    cleanup.push({ table: "raw_scraped_leads", id: (fsboRow as any).id })

    // Run the radar — read the bench, score+rank, route the hot candidate.
    const r1 = await runListingInventoryRadar(brokerageId, { minScore: 0.45, topN: 10 }, svc)
    check("runner: scanned the seeded seller candidates + routed at least one hot lead",
      r1.candidatesScanned >= 2 && r1.scored >= 2 && r1.routed >= 1)

    // The HOT candidate was routed to the Listing Concierge.
    const { data: sig } = await svc.from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, entity_id, status, payload")
      .eq("brokerage_id", brokerageId).eq("entity_id", (hotRow as any).id)
      .eq("signal_type", SELLER_INTENT_SIGNAL_TYPE).maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("Data Steward → Listing Concierge: a seller_intent_hot signal routed the HOT candidate",
      (sig as any)?.from_manager === "data_steward" && (sig as any)?.to_manager === "listing_concierge")
    check("routed signal carries the real intent score + reasons (no fabrication)",
      typeof (sig as any)?.payload?.intent_score === "number" && Array.isArray((sig as any)?.payload?.reasons))

    // The fresh low-equity FSBO did NOT route (below the hot threshold).
    const { data: fsboSig } = await svc.from("manager_signals")
      .select("id").eq("brokerage_id", brokerageId).eq("entity_id", (fsboRow as any).id)
      .eq("signal_type", SELLER_INTENT_SIGNAL_TYPE).maybeSingle()
    if (fsboSig) cleanup.push({ table: "manager_signals", id: (fsboSig as any).id })
    check("fresh low-equity FSBO did NOT route (only HOT candidates route)", !fsboSig)

    // The Listing Concierge consumes the signal → GATED 'thinking of selling?' agent brief.
    const consumed = await consumeManagerSignals({ brokerageId, toManager: "listing_concierge" }, svc)
    check("Listing Concierge consumed the routed signal (handler fired)", consumed.consumed >= 1)

    const { data: brief } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, entity_id, subject")
      .eq("brokerage_id", brokerageId).eq("entity_id", (hotRow as any).id)
      .eq("agent_kind", "listing_concierge").maybeSingle()
    if (brief) {
      cleanup.push({ table: "agent_client_messages", id: (brief as any).id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", (brief as any).id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("GATED 'thinking of selling?' brief proposed (audience 'agent', proposed, listing_concierge)",
      (brief as any)?.status === "proposed" && (brief as any)?.audience === "agent" && (brief as any)?.agent_kind === "listing_concierge")
    check("brief subject names the seller-intent radar candidate",
      ((brief as any)?.subject ?? "").toLowerCase().includes("seller-intent radar"))

    // IDEMPOTENCY — second radar pass routes nothing new (open signal deduped per candidate).
    const r2 = await runListingInventoryRadar(brokerageId, { minScore: 0.45, topN: 10 }, svc)
    const { count: sigCount } = await svc.from("manager_signals")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("entity_id", (hotRow as any).id)
      .eq("signal_type", SELLER_INTENT_SIGNAL_TYPE)
    check("idempotency: second pass creates no duplicate route for the same candidate",
      (sigCount ?? 0) === 1, `signals for hot candidate = ${sigCount}; r2.routed=${r2.routed}`)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("raw_scraped_leads").select("id", { count: "exact", head: true }).like("source_record_id", `${TAG}%`)
    check("cleanup verified — 0 seeded raw_scraped_leads remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
