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
 *   runListingInventoryRadar, and assert THE CANONICAL FLOW is respected:
 *     · the hot raw seller lead is PROMOTED THROUGH THE GATE into a `leads` row
 *       (ai_isa_owner=true, NO portal, NOT a contact) carrying the seller-intent score +
 *       reasons (leads.notes + lead_score floor);
 *     · the route is data_steward → AI ISA (NOT listing_concierge) — the default for a
 *       non-contact raw lead;
 *     · consuming the AI-ISA signal PRIORITIZES the lead for qualification with NO
 *       client-facing message proposed to the non-contact;
 *     · the CONTACT-BACKED branch still works: a candidate whose lead has converted
 *       (leads.contact_id) routes data_steward → listing_concierge and proposes the gated brief.
 *   Idempotent rerun promotes/routes nothing new; reverse-delete + assert cleanup count == 0.
 *   Self-cleans with a unique TAG. No mocks, real data. processRawRecord is server-bound so
 *   the gate is injected (opts.promote) running the SAME canonical eligibility + promotion.
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
  console.log(" ✅ Listing Inventory Radar verified — score+rank seller intent, PROMOTE through THE GATE into a `leads` row (ai_isa_owner, NOT a contact), route data_steward → AI ISA for qualification; contact-backed branch still routes to Listing Concierge")
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
  const { evaluateCanonicalLeadEligibility } = await import("../lib/lead-pipeline/canonical-lead-eligibility")
  const svc = createServiceClient()
  const TAG = `Radar${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  // THE GATE (injected) — processRawRecord is 'use server' + server-client-bound, so under
  // plain tsx we run the SAME canonical eligibility (evaluateCanonicalLeadEligibility) and
  // mirror its promotion: insert a real `leads` row (ai_isa_owner=true, NO portal/contact)
  // and stamp raw_scraped_leads.lead_id + processing_status='promoted'. This is the gate, not
  // a bypass — a row that fails eligibility is NOT promoted.
  const gate = async (rawLeadId: string, brokerageId: string): Promise<{ action: "created" | "merged" | "skipped"; leadId?: string }> => {
    const { data: raw } = await svc.from("raw_scraped_leads")
      .select("id, lead_id, source, first_name, last_name, email, phone, address, city, state, zip_code, mailing_address_verified, normalized_preview, raw_data")
      .eq("id", rawLeadId).maybeSingle()
    const r = raw as any
    if (!r) return { action: "skipped" }
    if (r.lead_id) return { action: "merged", leadId: r.lead_id } // already promoted — reuse
    const firstName = r.first_name ?? r.normalized_preview?.firstName ?? r.raw_data?.firstName ?? null
    const lastName = r.last_name ?? r.normalized_preview?.lastName ?? r.raw_data?.lastName ?? null
    const elig = evaluateCanonicalLeadEligibility({
      first_name: firstName, last_name: lastName,
      email: r.email, phone: r.phone, mailing_address_verified: r.mailing_address_verified,
    })
    if (!elig.eligible) return { action: "skipped" }
    const { data: newLead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: firstName, last_name: lastName,
      email: r.email, phone: r.phone, source: r.source,
      enrichment_status: "completed", lead_stage: "new",
      lifecycle_state: "unconsented", ai_isa_owner: true,
      minimum_viable_for_isa: !!r.email, mailing_address_verified: true,
      address: r.address, city: r.city, state: r.state, zip_code: r.zip_code,
      source_raw_ids: [rawLeadId], raw_record_id: rawLeadId,
    }).select("id").single()
    if (!newLead) return { action: "skipped" }
    cleanup.push({ table: "leads", id: (newLead as any).id })
    await svc.from("raw_scraped_leads").update({ lead_id: (newLead as any).id, processing_status: "promoted" }).eq("id", rawLeadId)
    return { action: "created", leadId: (newLead as any).id }
  }

  console.log("\n[Layer 2 · live radar → THE GATE → AI ISA (canonical flow)]")
  try {
    const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brokerage) { console.log("  ⏭  Skipped — need a brokerage."); report(); return }
    const brokerageId = (brokerage as any).id

    // Seed REAL raw_scraped_leads seller candidates (the bench's already-scraped output).
    // HOT: pre-foreclosure + high equity, WITH a first-class identity (full name + phone +
    // mailing_address_verified) so it passes the canonical promotion gate deterministically.
    const { data: hotRow } = await svc.from("raw_scraped_leads").insert({
      brokerage_id: brokerageId, source: "batchdata_motivated",
      source_record_id: `${TAG}-hot`, processing_status: "pending",
      first_name: TAG, last_name: "Owner", phone: "5550000001",
      address: `${TAG} 9 Probe Ln`, mailing_address_verified: true,
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

    // ── Run the radar: read the bench, score+rank, PROMOTE through the gate, route to AI ISA. ──
    const r1 = await runListingInventoryRadar(brokerageId, { minScore: 0.45, topN: 10, promote: gate }, svc)
    check("runner: scanned the seeded seller candidates, promoted + routed at least one hot lead",
      r1.candidatesScanned >= 2 && r1.scored >= 2 && r1.routed >= 1, JSON.stringify(r1))
    check("runner: the hot candidate was PROMOTED THROUGH THE GATE (raw → leads, ai_isa_owner)",
      r1.promoted >= 1 && r1.routedToIsa >= 1 && r1.contactBacked === 0, JSON.stringify(r1))

    // THE GATE created a `leads` row for the hot raw candidate (ai_isa_owner, NOT a contact).
    const { data: hotRawAfter } = await svc.from("raw_scraped_leads")
      .select("lead_id, processing_status").eq("id", (hotRow as any).id).maybeSingle()
    check("raw_scraped_leads.processing_status='promoted' with a lead_id (gate marked it)",
      (hotRawAfter as any)?.processing_status === "promoted" && !!(hotRawAfter as any)?.lead_id)
    const hotLeadId = (hotRawAfter as any)?.lead_id as string | null
    const { data: hotLead } = hotLeadId
      ? await svc.from("leads").select("id, ai_isa_owner, contact_id, lead_score, notes, lifecycle_state").eq("id", hotLeadId).maybeSingle()
      : { data: null }
    check("promoted lead is ai_isa_owner=true, has NO contact_id (NOT a contact, no portal)",
      (hotLead as any)?.ai_isa_owner === true && !(hotLead as any)?.contact_id)
    check("seller-intent carried onto the lead: notes stamped + lead_score floored to the intent",
      String((hotLead as any)?.notes ?? "").includes("[Listing Inventory Radar]") && Number((hotLead as any)?.lead_score ?? 0) >= 45,
      `notes=${String((hotLead as any)?.notes ?? "").slice(0,40)}… score=${(hotLead as any)?.lead_score}`)

    // ── The HOT candidate routed data_steward → AI ISA (NOT listing_concierge). ──
    const { data: sig } = await svc.from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, entity_id, status, payload, contact_id")
      .eq("brokerage_id", brokerageId).eq("entity_id", (hotRow as any).id)
      .eq("signal_type", SELLER_INTENT_SIGNAL_TYPE).maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("Data Steward → AI ISA: the non-contact hot lead routed to ai_isa (gate respected)",
      (sig as any)?.from_manager === "data_steward" && (sig as any)?.to_manager === "ai_isa")
    check("routed signal carries the lead_id + real intent score + reasons (no fabrication)",
      typeof (sig as any)?.payload?.intent_score === "number" && Array.isArray((sig as any)?.payload?.reasons) &&
      (sig as any)?.payload?.lead_id === hotLeadId && (sig as any)?.payload?.contact_backed === false)
    check("routed signal carries NO contact_id (the lead is not a contact)", !(sig as any)?.contact_id)

    // The fresh low-equity FSBO did NOT route (below the hot threshold).
    const { data: fsboSig } = await svc.from("manager_signals")
      .select("id").eq("brokerage_id", brokerageId).eq("entity_id", (fsboRow as any).id)
      .eq("signal_type", SELLER_INTENT_SIGNAL_TYPE).maybeSingle()
    if (fsboSig) cleanup.push({ table: "manager_signals", id: (fsboSig as any).id })
    check("fresh low-equity FSBO did NOT route (only HOT candidates route)", !fsboSig)

    // ── AI ISA consumes the signal → PRIORITIZES the lead, NO client-facing message. ──
    const consumed = await consumeManagerSignals({ brokerageId, toManager: "ai_isa" }, svc)
    check("AI ISA consumed the routed signal (handler fired)", consumed.consumed >= 1)
    const { data: isaActivity } = await svc.from("ai_isa_activities")
      .select("id, activity_type, lead_id").eq("brokerage_id", brokerageId)
      .eq("lead_id", hotLeadId).eq("activity_type", "seller_intent_prioritized").maybeSingle()
    if (isaActivity) cleanup.push({ table: "ai_isa_activities", id: (isaActivity as any).id })
    check("AI ISA prioritized the ISA-owned lead for qualification (activity ledger)", !!isaActivity)

    // CRITICAL: NO client-facing message proposed to the non-contact (the whole point of the fix).
    const { data: badBrief } = await svc.from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).eq("entity_id", (hotRow as any).id).maybeSingle()
    if (badBrief) cleanup.push({ table: "agent_client_messages", id: (badBrief as any).id })
    check("NO client-facing 'thinking of selling?' message proposed to the non-contact (gate honored)", !badBrief)

    // ── CONTACT-BACKED BRANCH — a candidate whose lead has CONVERTED routes to Listing Concierge. ──
    // Seed a separate raw row, promote it via the gate, then attach a real contact to its lead
    // (simulating post-qualification conversion) so the runner sees leads.contact_id.
    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Converted",
      lifecycle_stage: "lead",
    }).select("id").single()
    if (contact) cleanup.push({ table: "contacts", id: (contact as any).id })
    const { data: cbRow } = await svc.from("raw_scraped_leads").insert({
      brokerage_id: brokerageId, source: "batchdata_motivated",
      source_record_id: `${TAG}-cb`, processing_status: "pending",
      first_name: TAG, last_name: "Converted", phone: "5550000002",
      address: `${TAG} 7 Convert Rd`, mailing_address_verified: true,
      raw_data: { motivationType: "pre_foreclosure", quickLists: ["preforeclosure", "high-equity"], valuation: { equityPercent: 85 }, propertyAddress: `${TAG} 7 Convert Rd`, firstName: TAG, lastName: "Converted" },
      normalized_preview: { intentType: "seller", behaviorType: "motivated_seller", intentSignals: ["pre_foreclosure"], motivationScore: 92, propertyAddress: `${TAG} 7 Convert Rd` },
    }).select("id").single()
    cleanup.push({ table: "raw_scraped_leads", id: (cbRow as any).id })
    // Promote it through the gate, then mark its lead as converted (contact_id set).
    const cbPromo = await gate((cbRow as any).id, brokerageId)
    check("contact-backed: its raw row promoted through the gate", cbPromo.action === "created" && !!cbPromo.leadId)
    if (cbPromo.leadId && contact) {
      await svc.from("leads").update({ contact_id: (contact as any).id, lifecycle_state: "consented" })
        .eq("id", cbPromo.leadId)
    }

    const rCb = await runListingInventoryRadar(brokerageId, { minScore: 0.45, topN: 10, promote: gate }, svc)
    check("contact-backed candidate routed via the seller path (contactBacked >= 1)", rCb.contactBacked >= 1, JSON.stringify(rCb))
    const { data: cbSig } = await svc.from("manager_signals")
      .select("id, to_manager, contact_id, payload").eq("brokerage_id", brokerageId)
      .eq("entity_id", (cbRow as any).id).eq("signal_type", SELLER_INTENT_SIGNAL_TYPE).maybeSingle()
    if (cbSig) cleanup.push({ table: "manager_signals", id: (cbSig as any).id })
    check("Data Steward → Listing Concierge: the CONVERTED (contact-backed) candidate routed to listing_concierge",
      (cbSig as any)?.to_manager === "listing_concierge" && !!(cbSig as any)?.contact_id && (cbSig as any)?.payload?.contact_backed === true)

    const consumedLc = await consumeManagerSignals({ brokerageId, toManager: "listing_concierge" }, svc)
    check("Listing Concierge consumed the contact-backed signal (handler fired)", consumedLc.consumed >= 1)
    const { data: cbBrief } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, subject").eq("brokerage_id", brokerageId)
      .eq("entity_id", (cbRow as any).id).eq("agent_kind", "listing_concierge").maybeSingle()
    if (cbBrief) {
      cleanup.push({ table: "agent_client_messages", id: (cbBrief as any).id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", (cbBrief as any).id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("contact-backed branch: GATED 'thinking of selling?' brief proposed (audience 'agent', proposed, listing_concierge)",
      (cbBrief as any)?.status === "proposed" && (cbBrief as any)?.audience === "agent" && (cbBrief as any)?.agent_kind === "listing_concierge")

    // ── IDEMPOTENCY — second radar pass routes nothing new (open signals deduped per candidate). ──
    const r2 = await runListingInventoryRadar(brokerageId, { minScore: 0.45, topN: 10, promote: gate }, svc)
    const { count: sigCount } = await svc.from("manager_signals")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("entity_id", (hotRow as any).id)
      .eq("signal_type", SELLER_INTENT_SIGNAL_TYPE)
    check("idempotency: second pass creates no duplicate route for the same candidate",
      (sigCount ?? 0) === 1, `signals for hot candidate = ${sigCount}; r2.routed=${r2.routed}, r2.promoted=${r2.promoted}`)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("raw_scraped_leads").select("id", { count: "exact", head: true }).like("source_record_id", `${TAG}%`)
    check("cleanup verified — 0 seeded raw_scraped_leads remain", (count ?? 0) === 0)
    const { count: leadCount } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded leads remain", (leadCount ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
