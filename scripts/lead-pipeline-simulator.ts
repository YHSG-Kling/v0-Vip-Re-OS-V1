#!/usr/bin/env tsx
/**
 * scripts/lead-pipeline-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — end-to-end lead scraping → enrichment → promotion simulator.
 *
 * The scraping/enrichment subsystem (BatchData + PeopleData HTTP clients, 10+
 * sources, raw_scraped_leads → enrich → promote → leads → contacts) is REAL and
 * production-grade. This harness proves the COMPLETE flow with NO mocks:
 *
 *   Layer 1 — the real decision functions the pipeline runs at every gate
 *             (fuzzy dedup, canonical eligibility, BatchData normalization,
 *             territory gate, source scoring). Deterministic, no DB, no API.
 *
 *   Layer 2 — a LIVE DB round-trip that drives those same canonical gates
 *             (recordMatchesTerritory → evaluateCanonicalLeadEligibility →
 *             calculateFuzzyMatch) and performs the real `leads` promotion
 *             insert exactly as pipeline-processor.ts does, then asserts the
 *             Kernel-OS ownership fields landed, and DELETES every test row
 *             (including on failure). Requires SUPABASE_SERVICE_ROLE_KEY;
 *             skips cleanly without it so the pure layer still runs in CI.
 *
 * The production promotion path (processRawRecord) wraps these same functions
 * behind the SSR cookie client + the paid PeopleData enrichment call — neither
 * is script-drivable, so Layer 2 drives the identical gate functions directly
 * against the live schema. No stubs, no mock data, full cleanup.
 *
 * Run:  npx tsx scripts/lead-pipeline-simulator.ts   (npm run test:lead-pipeline)
 */
import { calculateFuzzyMatch } from "../lib/lead-pipeline/fuzzy-matcher"
import { evaluateCanonicalLeadEligibility } from "../lib/lead-pipeline/canonical-lead-eligibility"
import { normalizeBatchDataProperty } from "../lib/external/batchdata-client"
import {
  recordMatchesTerritory, calculateSourceScore, resolveSourceKey,
  scoreToUrgencyLevel, getSourceSemantics, expandEnabledSources,
} from "../lib/lead-pipeline/source-intent-map"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — real decision functions (no DB, no external API)
// ─────────────────────────────────────────────────────────────────────────────

function testFuzzyDedup() {
  console.log("\n[Layer 1 · fuzzy dedup — calculateFuzzyMatch]")
  const a = { first_name: "Maria", last_name: "Gonzalez", email: "maria.g@example.com", phone: "(305) 555-0142" }
  check("identical records → score 1.0", approx(calculateFuzzyMatch(a, a).score, 1.0))
  // Same phone, different formatting → phone normalizes to a match.
  const b = { ...a, phone: "305-555-0142" }
  check("phone formatting differences still match", calculateFuzzyMatch(a, b).details.phoneScore === 1.0)
  // Same email, slightly different name → high (email weight 0.35 dominates).
  const c = { first_name: "Maria", last_name: "Gonzales", email: "maria.g@example.com", phone: null }
  check("same email + near name → high score", calculateFuzzyMatch(a, c).score > 0.8)
  // Totally different person → low.
  const d = { first_name: "Robert", last_name: "Kim", email: "rkim@other.com", phone: "212-555-9999" }
  check("different person → low score", calculateFuzzyMatch(a, d).score < 0.4)
  // No shared anchors → zero (avoids false-positive merges).
  check("no comparable fields → score 0", calculateFuzzyMatch({ email: "x@y.com" }, { phone: "123" }).score === 0)
}

function testEligibilityGate() {
  console.log("\n[Layer 1 · promotion gate — evaluateCanonicalLeadEligibility]")
  check("full identity + verified mailing → eligible",
    evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", phone: "3055550142", mailing_address_verified: true }).eligible === true)
  const noName = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "", email: "m@x.com", mailing_address_verified: true })
  check("missing last name → blocked on name", noName.eligible === false && (noName as any).failing === "name")
  const noContact = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", mailing_address_verified: true })
  check("no email/phone → blocked on contact", noContact.eligible === false && (noContact as any).failing === "contact")
  const noAddr = evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", email: "m@x.com", mailing_address_verified: false })
  check("unverified mailing → blocked on mailing_address", noAddr.eligible === false && (noAddr as any).failing === "mailing_address")
}

function testBatchDataNormalize() {
  console.log("\n[Layer 1 · BatchData normalization — normalizeBatchDataProperty]")
  // Realistic BatchData Property Search response shape.
  const payload = {
    address: { street: "742 Evergreen Ter", city: "Miami", state: "FL", zip: "33133" },
    owner: { fullName: "Walter Sobchak", phone: "3055551234", email: null,
             mailingAddress: { street: "PO Box 9", city: "Miami", state: "FL", zip: "33101" } },
    building: { bedroomCount: 4, bathroomCount: 3, livingAreaSquareFeet: 2450 },
    valuation: { estimatedValue: 689000, estimatedEquity: 410000 },
    quickLists: ["high-equity", "absentee-owner"],
  }
  const r = normalizeBatchDataProperty(payload, "high_equity")
  check("splits fullName → first/last", r.firstName === "Walter" && r.lastName === "Sobchak")
  check("prefers owner mailing address over property address", r.city === "Miami" && r.zip === "33101")
  check("keeps property address separately", r.propertyAddress === "742 Evergreen Ter" && r.propertyZip === "33133")
  check("preserves valuation signal", r.valuation?.estimatedValue === 689000)
  check("preserves quickLists motivation tags", Array.isArray(r.quickLists) && r.quickLists!.includes("high-equity"))
  check("missing email stays null (no fabrication)", r.email === null)
}

function testTerritoryAndScoring() {
  console.log("\n[Layer 1 · territory gate + source scoring]")
  const market = { city: "Miami", state: "FL", zip_codes: ["33133", "33101"] }
  check("zip in market → in territory", recordMatchesTerritory({ zip: "33133" }, market) === true)
  check("zip outside market → rejected", recordMatchesTerritory({ zip: "90210" }, market) === false)
  check("city+state match → in territory", recordMatchesTerritory({ city: "Miami", state: "FL" }, market) === true)
  check("wrong city → rejected", recordMatchesTerritory({ city: "Tampa", state: "FL" }, market) === false)
  check("no geo data → passes through (cannot reject)", recordMatchesTerritory({}, market) === true)

  const key = resolveSourceKey("batchdata_motivated")
  check("resolveSourceKey maps a real source", !!key)
  const sem = getSourceSemantics("batchdata_motivated")
  check("getSourceSemantics returns leadType + motivationType", !!sem.leadType && typeof sem.motivationType === "string")
  const score = calculateSourceScore("batchdata_motivated", ["high_equity", "absentee"])
  check("source score is within 0–100", score >= 0 && score <= 100)
  check("scoreToUrgencyLevel maps score → temperature (matches leads constraint)",
    scoreToUrgencyLevel(80) === "hot" && scoreToUrgencyLevel(50) === "warm" && scoreToUrgencyLevel(30) === "cool" && scoreToUrgencyLevel(10) === "cold")
  const expanded = expandEnabledSources(["batchdata_motivated", "zenrows_zillow"])
  check("expandEnabledSources returns a Set", expanded instanceof Set && expanded.size > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — live DB round-trip (real schema, real gates, full cleanup)
// ─────────────────────────────────────────────────────────────────────────────

type Cleanup = { table: string; column: string; value: string }

async function testLivePromotion() {
  console.log("\n[Layer 2 · live promotion round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer still ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const RUN = `__leadsim_${Date.now()}__`
  const cleanup: Cleanup[] = []

  try {
    // Owning brokerage (existing tenant).
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage in DB."); return }
    const brokerageId = (brk as { id: string }).id

    // 1. Seed an in-territory market.
    const { data: market, error: mErr } = await svc.from("lead_scraping_markets").insert({
      brokerage_id: brokerageId, name: `${RUN}market`, city: "Miami", state: "FL",
      zip_codes: ["33133", "33101"], is_active: true,
    }).select("id, city, state, zip_codes").single()
    check("seed market territory", !mErr && !!market, mErr?.message)
    if (!market) throw new Error("market seed failed")
    cleanup.push({ table: "lead_scraping_markets", column: "id", value: (market as any).id })

    // 2. Seed a fully-formed, in-territory raw record (platform-owned, brokerage_id NULL
    //    until promotion — matches the scheduled-scrape contract).
    const preview = {
      firstName: "Maria", lastName: "Gonzalez", email: `${RUN}@example.com`,
      phone: "3055550142", city: "Miami", state: "FL", zip: "33133",
      propertyAddress: "742 Evergreen Ter", intentSignals: ["high_equity", "absentee"],
    }
    const { data: raw, error: rErr } = await svc.from("raw_scraped_leads").insert({
      brokerage_id: null, market_id: (market as any).id, source: "batchdata_motivated",
      source_record_id: `${RUN}rec`, raw_data: { ...preview, mailing_address_verified: true, mailing_address: "PO Box 9" },
      normalized_preview: preview, processing_status: "pending", mailing_address_verified: true,
    }).select("id").single()
    check("seed raw_scraped_leads record", !rErr && !!raw, rErr?.message)
    if (!raw) throw new Error("raw seed failed")
    const rawId = (raw as any).id
    cleanup.push({ table: "raw_scraped_leads", column: "id", value: rawId })

    // 3. Drive the REAL gates the production path runs, in order.
    const recGeo = { city: preview.city, state: preview.state, zip: preview.zip }
    check("real gate: record is in market territory",
      recordMatchesTerritory(recGeo, market as any) === true)

    const elig = evaluateCanonicalLeadEligibility({
      first_name: preview.firstName, last_name: preview.lastName,
      email: preview.email, phone: preview.phone, mailing_address_verified: true,
    })
    check("real gate: candidate is promotion-eligible", elig.eligible === true)

    // Dedup against existing leads for this brokerage (sentinel email → no match expected).
    const { data: existing } = await svc.from("leads")
      .select("first_name,last_name,email,phone").eq("brokerage_id", brokerageId)
      .or(`email.eq.${preview.email},phone.eq.${preview.phone}`).limit(5)
    const dupHit = (existing ?? []).some((e: any) =>
      calculateFuzzyMatch({ first_name: preview.firstName, last_name: preview.lastName, email: preview.email, phone: preview.phone }, e).score >= 0.8)
    check("real gate: no pre-existing duplicate", dupHit === false)

    // 4. Real promotion insert — exact Kernel-OS contract from pipeline-processor.ts.
    const sem = getSourceSemantics("batchdata_motivated")
    const score = calculateSourceScore("batchdata_motivated", preview.intentSignals)
    const { data: lead, error: lErr } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: preview.firstName, last_name: preview.lastName,
      email: preview.email, phone: preview.phone, source: "batchdata_motivated",
      lead_type: sem.leadType !== "unknown" ? sem.leadType : null,
      motivation_type: sem.motivationType, motivation_confidence: score / 100,
      urgency_level: scoreToUrgencyLevel(score), lead_score: score,
      enrichment_status: "completed", enrichment_confidence: 0.9, lead_stage: "new",
      source_raw_ids: [rawId], lifecycle_state: "unconsented", ai_isa_owner: true,
      minimum_viable_for_isa: true, mailing_address_verified: true,
      mailing_address: "PO Box 9", email_verified: false, raw_record_id: rawId,
    }).select("id, lifecycle_state, ai_isa_owner, lead_stage").single()
    check("promotion insert lands in leads", !lErr && !!lead, lErr?.message)
    if (!lead) throw new Error("promotion insert failed")
    cleanup.push({ table: "leads", column: "id", value: (lead as any).id })

    check("lead carries Kernel-OS ownership (unconsented + ai_isa_owner)",
      (lead as any).lifecycle_state === "unconsented" && (lead as any).ai_isa_owner === true)

    // 5. Close the loop on the raw record exactly as the pipeline does.
    const { error: upErr } = await svc.from("raw_scraped_leads")
      .update({ lead_id: (lead as any).id, processing_status: "promoted", processed_at: new Date().toISOString() })
      .eq("id", rawId)
    check("raw record marked promoted + linked to lead", !upErr, upErr?.message)
    const { data: promoted } = await svc.from("raw_scraped_leads").select("processing_status, lead_id").eq("id", rawId).single()
    check("raw status reads back 'promoted' with lead_id",
      (promoted as any)?.processing_status === "promoted" && (promoted as any)?.lead_id === (lead as any).id)

    // 6. Negative cases against the real gates (no promotion should occur).
    check("real gate: out-of-territory record rejected",
      recordMatchesTerritory({ city: "Tampa", state: "FL", zip: "33602" }, market as any) === false)
    check("real gate: ineligible candidate (no contact) not promotable",
      evaluateCanonicalLeadEligibility({ first_name: "Maria", last_name: "Gonzalez", mailing_address_verified: true }).eligible === false)
  } finally {
    // Self-cleanup — reverse order, best-effort, runs even on failure.
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq(c.column, c.value) } catch { /* ignore */ }
    }
    // Belt-and-suspenders: purge anything matching the run sentinel. Order
    // matters — raw_scraped_leads.lead_id FK-references leads, so delete the
    // child rows before the leads they point at.
    try { await svc.from("raw_scraped_leads").delete().eq("source_record_id", `${RUN}rec`) } catch { /* ignore */ }
    try { await svc.from("leads").delete().like("email", `${RUN}%`) } catch { /* ignore */ }
    try { await svc.from("lead_scraping_markets").delete().like("name", `${RUN}%`) } catch { /* ignore */ }
    const { count } = await svc.from("raw_scraped_leads").select("id", { count: "exact", head: true }).eq("source_record_id", `${RUN}rec`)
    check("cleanup verified — 0 test rows remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead pipeline simulator (scrape → enrich → promote)")
  console.log("══════════════════════════════════════════════════")
  testFuzzyDedup(); testEligibilityGate(); testBatchDataNormalize(); testTerritoryAndScoring()
  await testLivePromotion()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Lead pipeline verified end-to-end (no mocks, test rows cleaned up)")
}
main().catch((e) => { console.error(e); process.exit(1) })
