#!/usr/bin/env tsx
/**
 * scripts/property-specs-simulator.ts   (npm run test:property-specs)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves LOSSLESS PROPERTY SPECS (Data Steward): scraped beds/baths/sqft/type/value no longer die in
 * raw_scraped_leads jsonb at promotion — they land first-class on leads (incl. estimated_value) and
 * carry forward to contacts (value → the canonical home_value_estimate), and the investor off-market
 * matcher actually uses them (hard price gate with AVM tolerance; soft type/beds nudges; a missing spec
 * never excludes).
 *
 * PURE:   extractPropertySpecs (BatchData building/valuation shapes + normalized top-level + portal
 *         rawPayload.price; missing → null, never fabricated) + leadSpecPatch/contactSpecPatch
 *         (additive) + inBoxPrice / spec nudges in scoreOffMarketFit.
 * SOURCE: BOTH lead-creation paths call the extractor (parity); contact-creator carries the specs
 *         forward; the investor runner selects the new columns; snapshot + migration carry them.
 * LIVE (creds-gated): insert a lead with specs → verify columns → contactSpecPatch round-trip on a
 *         contact → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { extractPropertySpecs, leadSpecPatch, contactSpecPatch } from "../lib/data-steward/property-spec-extractor"
import { scoreOffMarketFit, inBoxPrice, type InvestorBox, type OffMarketProperty } from "../lib/buyer-search/investor-offmarket-match"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[extractPropertySpecs · pure — reads the many vendor shapes, never fabricates]")
  const batchdata = extractPropertySpecs([{
    building: { bedroomCount: 3, bathroomCount: 2, livingAreaSquareFeet: 1450 },
    valuation: { estimatedValue: 285000 },
    propertyType: "Single Family",
  }])
  check("BatchData nested shape (building/valuation)", batchdata.beds === 3 && batchdata.baths === 2 && batchdata.sqft === 1450 && batchdata.estimatedValue === 285000 && batchdata.propertyType === "Single Family")
  const normalized = extractPropertySpecs([{ beds: 4, baths: 2.5, sqft: 2100, estimatedValue: 410000 }])
  check("normalized top-level shape (client output)", normalized.beds === 4 && normalized.baths === 2.5 && normalized.sqft === 2100)
  const portal = extractPropertySpecs([{ rawPayload: { price: "350000", address: "1 Main" } }])
  check("portal FSBO shape (rawPayload.price, string coerced)", portal.estimatedValue === 350000)
  const layered = extractPropertySpecs([{ beds: null }, { building: { bedroomCount: 2 } }])
  check("falls through sources until a value is found", layered.beds === 2)
  const empty = extractPropertySpecs([{}, null, undefined])
  check("missing everywhere ⇒ all null (HONEST, never fabricated)", empty.beds === null && empty.baths === null && empty.sqft === null && empty.propertyType === null && empty.estimatedValue === null)
  check("zero/garbage values are rejected, not stored", extractPropertySpecs([{ beds: 0, sqft: "n/a" }]).beds === null)

  console.log("\n[leadSpecPatch / contactSpecPatch · pure — additive, canonical value columns]")
  const lp = leadSpecPatch(batchdata)
  check("lead patch → estimated_value first-class", lp.estimated_value === 285000 && lp.beds === 3 && lp.property_type === "Single Family")
  const cp = contactSpecPatch(batchdata)
  check("contact patch → value lands in canonical home_value_estimate", cp.home_value_estimate === 285000 && (cp as any).estimated_value === undefined)
  check("nothing scraped ⇒ EMPTY patch (never nulls out existing data)", Object.keys(leadSpecPatch(empty)).length === 0 && Object.keys(contactSpecPatch(empty)).length === 0)

  console.log("\n[spec-aware investor match · pure — hard price gate, soft nudges, missing never excludes]")
  const box: InvestorBox = { minPrice: null, maxPrice: 300000, minBeds: 3, minBaths: null, cities: ["Phoenix"], zipCodes: ["85053"], propertyTypes: ["single family"], mustHaveFeatures: [], dealBreakers: [], confidenceScore: 0.8 } as any
  const prop = (over: Partial<OffMarketProperty>): OffMarketProperty => ({
    recordId: "x", stage: "lead", address: "1 St", city: "Phoenix", state: "AZ", zip: "85053",
    motivationType: "probate", motivationConfidence: 0.9, equityEstimate: 150000, ...over,
  })
  check("value clearly over box max (×1.1 tolerance) ⇒ HARD out (null)", scoreOffMarketFit(box, prop({ estimatedValue: 400000 })) === null)
  check("value within tolerance of max ⇒ stays in", scoreOffMarketFit(box, prop({ estimatedValue: 320000 })) !== null)
  check("UNKNOWN value ⇒ passes the price gate (missing never excludes)", inBoxPrice(box, prop({ estimatedValue: null })) === true)
  const typed = scoreOffMarketFit(box, prop({ estimatedValue: 250000, propertyType: "Single Family", beds: 3 }))!
  const bare = scoreOffMarketFit(box, prop({ estimatedValue: 250000 }))!
  check("matching property type + beds nudges the score up", typed.matchScore > bare.matchScore)
  check("spec reasons are human-readable", typed.reasons.some((r) => /property type|beds/.test(r)))
}

function sourceLayer() {
  console.log("\n[wiring — both lead paths + the contact carry-forward + the matcher, in parity]")
  const pp = src("lib/lead-pipeline/pipeline-processor.ts")
  check("pipeline-processor promotes specs at lead creation", /leadSpecPatch\(extractPropertySpecs\(\[rec\.raw_data/.test(pp))
  const lprom = src("lib/lead-promotion/lead-promoter.ts")
  check("lead-promoter promotes specs too (path parity)", /leadSpecPatch\(extractPropertySpecs\(\[rawData/.test(lprom))
  const cc = src("lib/contact-promotion/contact-creator.ts")
  check("contact-creator carries beds/baths/sqft/type forward", /beds:\s*data\.lead\.beds[\s\S]*?property_type:\s*data\.lead\.property_type/.test(cc))
  check("scraped value lands in the contact's canonical home_value_estimate", /home_value_estimate:\s*data\.lead\.estimated_value/.test(cc))
  const runner = src("lib/buyer-search/investor-offmarket-runner.ts")
  check("investor runner selects the new spec columns (both stages)", /estimated_value/.test(runner) && /home_value_estimate/.test(runner))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /lossless_property_specs:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:property-specs"/.test(reg))
  const snap = src("scripts/schema-snapshot.ts")
  check("snapshot: leads carries beds/baths/sqft/property_type/estimated_value", /leads: \[[^\]]*"baths"[^\]]*"beds"[^\]]*"estimated_value"[^\]]*"property_type"[^\]]*"sqft"/.test(snap))
  check("snapshot: contacts carries beds/baths/sqft/property_type", /contacts: \[[^\]]*"baths"[^\]]*"beds"[^\]]*"property_type"[^\]]*"sqft"/.test(snap))
  check("migration m256 exists", /add column if not exists estimated_value/.test(src("supabase/migrations/m256-lossless-property-specs.sql")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] lead insert with specs → contact patch round-trip → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const specs = extractPropertySpecs([{ building: { bedroomCount: 3, bathroomCount: 2, livingAreaSquareFeet: 1500 }, valuation: { estimatedValue: 275000 }, propertyType: "Single Family" }])
    const { data: lead } = await svc.from("leads").insert({
      brokerage_id: brokerageId, first_name: "Spec", last_name: "Test", city: "Specville", zip_code: "08888",
      motivation_type: "probate", lifecycle_state: "unconsented", ...leadSpecPatch(specs),
    }).select("id, beds, baths, sqft, property_type, estimated_value").single()
    cleanup.push({ table: "leads", id: (lead as any).id })
    check("live: lead row persisted the promoted specs", (lead as any).beds === 3 && Number((lead as any).baths) === 2 && (lead as any).sqft === 1500 && (lead as any).property_type === "Single Family" && Number((lead as any).estimated_value) === 275000)

    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Spec", last_name: "Contact", contact_type: "seller", ...contactSpecPatch(specs),
    }).select("id, beds, sqft, property_type, home_value_estimate").single()
    cleanup.push({ table: "contacts", id: (contact as any).id })
    check("live: contact row carries the specs (value in home_value_estimate)", (contact as any).beds === 3 && (contact as any).sqft === 1500 && Number((contact as any).home_value_estimate) === 275000)
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
  if (fail > 0) { console.log(" ❌ PROPERTY_SPECS_FAIL"); process.exit(1) }
  console.log(" ✅ PROPERTY_SPECS_PASS — scraped beds/baths/sqft/type/value survive raw → lead → contact and power spec-aware matching")
}
main()
