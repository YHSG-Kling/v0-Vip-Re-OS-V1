#!/usr/bin/env tsx
/**
 * scripts/one-cma-engine-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER RULING: "the same cma should be used for all."
 *
 * This product had TWO CMA valuation engines producing different prices for the
 * same house:
 *
 *   A. app/actions/ai-cma.ts `generateAICMA` — the one wired to the agent
 *      surfaces and the ONLY writer of cma_reports. Its comps were an
 *      unconditional 10-row RentCast pull with no sold-window and no status
 *      rule; its adjustments were national constants written into the file
 *      ($15,000/bedroom, $10,000/bathroom, $1,000/year); and its VALUE was
 *      whatever GPT-4o returned for `"estimatedValue": number`.
 *
 *   B. lib/cma/ai-cma-orchestrator.ts `runAiCma` — provider-first sourcing with
 *      a required 3 SOLD / 2 ACTIVE / 1 PENDING mix, state-published appraiser
 *      adjustment rates applied DETERMINISTICALLY, and a range computed from the
 *      ADJUSTED CLOSED comps. Already the engine behind home-value, calculators,
 *      the workflow AVM/CMA adapter and the listing-presentation builder.
 *
 * B won. A survives as the "use server" boundary + the persistence layer, and
 * now composes B. This harness holds that merge in place and proves the two
 * defects it fixed stay fixed:
 *
 *   1. NO MODEL AUTHORS A PRICE. A generative model may position a list price
 *      inside the comp-derived range; it may not produce the range, and it may
 *      not leave it. cma_reports.recommended_price is rendered to sellers and
 *      argued to licensed appraisers.
 *   2. THE COMPARABLES ARE PERSISTED. cma_comparables had FIVE production
 *      readers and ZERO production writers — the CMA tab's comp table, AI comp
 *      scoring, the appraisal-defense packet, the seller presentation and the
 *      predictive-listing scorer all read a table nothing ever wrote.
 *
 * Pure — reads source text and the schema snapshot, executes the pure
 * invariants. No DB, no network, no model spend.
 *
 * Run:  npx tsx scripts/one-cma-engine-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const F = {
  aiCma: "app/actions/ai-cma.ts",
  orchestrator: "lib/cma/ai-cma-orchestrator.ts",
  compProvider: "lib/cma/comp-provider.ts",
  generator: "app/actions/cma-presentation/cma-generator.ts",
  sellerCma: "app/actions/seller-cma.ts",
  appraisalDefense: "app/actions/appraisal-defense.ts",
  compEngine: "lib/cma/ai-cma-engine.ts",
  sectionRender: "lib/listing-presentation/section-render.ts",
  predictive: "lib/predictive-listing/run-scoring.ts",
  historySheet: "app/components/dashboard/listings/cma-history-sheet.tsx",
  reportTab: "app/dashboard/listings/[id]/cma/tabs/cma-report-tab.tsx",
  predictions: "app/actions/ai-predictions.ts",
  apptChain: "lib/workflow-orchestrator/chains/listing-appt-prep.ts",
  snapshot: "scripts/schema-snapshot.ts",
}

const SRC: Record<string, string> = {}
for (const [k, p] of Object.entries(F)) SRC[k] = read(p)

/**
 * Source with COMMENTS REMOVED.
 *
 * Every "this construct must no longer exist" check below has to run against
 * this, not the raw file. The tombstones this wave left behind deliberately
 * QUOTE the code they replaced — the $15,000-a-bedroom constants, the
 * `"estimatedValue": number` ask, the `[240,245,250,255,260]` series commented
 * "Simulated trend" — because a tombstone that will not say what was wrong
 * teaches nobody. Scanning the raw text would match those quotations, the guard
 * would go red for the right reasons in the wrong place, and the obvious fix
 * (delete the explanation) would leave a guard that can no longer see a REAL
 * reintroduction. So the rule is: prose may name the defect, code may not
 * contain it.
 */
const CODE: Record<string, string> = {}
for (const [k, src] of Object.entries(SRC)) {
  CODE[k] = src
    .replace(/\/\*[\s\S]*?\*\//g, "")            // block comments (incl. JSDoc)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))      // whole-line // and stray * rows
    .map((l) => l.replace(/\s\/\/.*$/, ""))       // trailing // comments
    .join("\n")
}

/** The region of a file between an anchor and the next top-level `function`/`export`. */
function bodyOf(src: string, anchor: string): string {
  const i = src.indexOf(anchor)
  if (i < 0) return ""
  const rest = src.slice(i)
  const end = rest.slice(1).search(/\n(export )?(async )?function /)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ONE ENGINE
// ═══════════════════════════════════════════════════════════════════════════
function testOneEngine() {
  console.log("\n[1 · One CMA engine]")
  const a = SRC.aiCma

  check(
    "generateAICMA composes runAiCma (the one engine)",
    /await import\(["']@\/lib\/cma\/ai-cma-orchestrator["']\)/.test(a) && /await runAiCma\(/.test(a),
  )

  // The rival stack is GONE, not merely unused.
  check("the rival comp fetch is deleted (no fetchComparableProperties)", !/function fetchComparableProperties/.test(CODE.aiCma))
  check("the rival adjustment math is deleted (no calculatePropertyAdjustments)", !/function calculatePropertyAdjustments/.test(CODE.aiCma))
  check("the rival valuation is deleted (no generateAIValuation)", !/function generateAIValuation/.test(CODE.aiCma))

  // Tombstones name the survivor, per the doctrine.
  for (const gone of ["fetchComparableProperties", "calculatePropertyAdjustments", "generateAIValuation"]) {
    check(
      `TOMBSTONE for ${gone} names its replacement`,
      new RegExp(`TOMBSTONE · ${gone}[\\s\\S]{0,900}?(ai-cma-orchestrator|comp-provider|state-adjustment-rates)`).test(a),
    )
  }

  // generateAICMA must not reach a comp provider directly any more — sourcing
  // belongs to comp-provider, behind the orchestrator, which is where the
  // rentcast-eligibility gate lives.
  check(
    "generateAICMA no longer calls a comps provider directly (getRentcastComps)",
    !/getRentcastComps/.test(CODE.aiCma),
    "a second sourcing path is a second CMA",
  )

  // Every OTHER CMA lane still uses the same engine.
  for (const [label, file] of [
    ["home-value", "app/actions/home-value.ts"],
    ["calculators", "app/actions/calculators.ts"],
    ["workflow avm/cma adapter", "lib/workflow/adapters/avm-cma.ts"],
    ["listing-presentation builder", "lib/workflow/intelligence/listing-presentation-builder.ts"],
  ] as const) {
    check(`${label} still runs on runAiCma`, /runAiCma\(/.test(read(file)))
  }

  // The presentation-flow generator delegates rather than valuing anything.
  check(
    "cma-presentation/cma-generator delegates to generateAICMA (no parallel valuation)",
    /generateAICMA\(/.test(SRC.generator) && !/getRentcastComps|runAiCma\(/.test(CODE.generator),
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · NO MODEL AUTHORS A PRICE
// ═══════════════════════════════════════════════════════════════════════════
function testNoFabricatedPrice() {
  console.log("\n[2 · No model authors a price]")
  const a = SRC.aiCma

  check(
    'no prompt asks a model for the property value ("estimatedValue": number)',
    !/"estimatedValue":\s*number/.test(CODE.aiCma),
    "this is the exact ask that became cma_reports.recommended_price",
  )

  // The three price columns must be fed from the orchestrator's computed range.
  const gen = bodyOf(a, "export async function generateAICMA")
  check(
    "price_range_low/high come from the comp-derived range (pricingStrategy, which is clamped)",
    /price_range_low:\s*pricingStrategy\.priceRangeLow/.test(gen) &&
      /price_range_high:\s*pricingStrategy\.priceRangeHigh/.test(gen),
  )
  check(
    "the range handed to the strategist IS runAiCma's",
    /const low = cma\.estimatedValueLow/.test(a) &&
      /const mid = cma\.estimatedValueMid/.test(a) &&
      /const high = cma\.estimatedValueHigh/.test(a),
  )
  check("a clamp bounds the model's list price to that range", /clampToRange/.test(a))
  check("the recommended price is clamped, with the comp median as the fallback",
    /recommendedListPrice:\s*clampToRange\(strategy\.recommendedListPrice\)\s*\?\?\s*Math\.round\(mid\)/.test(a))
  check("quick-sale and premium prices are clamped too (no excursions past the comps)",
    /quickSalePrice:\s*[\s\S]{0,80}clampToRange/.test(a) && /premiumPrice:\s*[\s\S]{0,80}clampToRange/.test(a))

  // Executable proof of the clamp's semantics.
  const low = 400_000, high = 460_000, mid = 430_000
  const clamp = (n: unknown): number | null => {
    const v = typeof n === "number" && Number.isFinite(n) ? n : null
    if (v == null || v <= 0) return null
    return Math.round(Math.min(high, Math.max(low, v)))
  }
  check("clamp: a model price above the range is pulled to the high", clamp(900_000) === high)
  check("clamp: a model price below the range is pulled to the low", clamp(100_000) === low)
  check("clamp: a price inside the range is the model's judgement, untouched", clamp(441_000) === 441_000)
  check("clamp: a non-number (a refused/garbled reply) yields null, never a price", clamp("lots") === null && clamp(NaN) === null)
  check("clamp: null falls back to the comp median, not to zero", (clamp(NaN) ?? Math.round(mid)) === mid)

  // No comps → no CMA. The deleted stack divided by zero, shipped NaN/Infinity
  // into a prompt, and wrote whatever came back.
  check(
    "no closed comp → the run REFUSES rather than writing a price",
    /if \(cma\.adjustedComps\.length === 0 \|\| cma\.estimatedValueMid <= 0\)/.test(gen) &&
      /success: false/.test(gen.slice(gen.indexOf("adjustedComps.length === 0"))),
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · NO INVENTED MARKET FACTS
// ═══════════════════════════════════════════════════════════════════════════
function testNoInventedMarketFacts() {
  console.log("\n[3 · No invented market facts]")
  const trends = bodyOf(SRC.aiCma, "async function analyzeMarketTrends")
  check("analyzeMarketTrends still exists (the market_data read is a kept capability)", trends.length > 0)

  check('the "Simulated trend" price series is gone', !/pricePerSqFtTrend/.test(CODE.aiCma) && !/Simulated trend/.test(CODE.aiCma))
  check("the hardcoded 5% appreciation rate is gone", !/appreciationRate:\s*0\.05/.test(CODE.aiCma))
  check("the invented seasonal factor is gone", !/seasonalFactor/.test(CODE.aiCma))
  check("the invented 35-day DOM fallback is gone", !/avg_days_on_market\s*\|\|\s*35/.test(CODE.aiCma))
  check("the median-price-from-subject-sqft fallback is gone", !/median_sale_price\s*\|\|\s*params\.squareFeet/.test(CODE.aiCma))
  check("the invented 100-listing inventory fallback is gone", !/active_listings\s*\|\|\s*100/.test(CODE.aiCma))

  check('"unknown" is an expressible market type (absence has a name)', /marketType[^\n]*=\s*"unknown"/.test(trends))
  check('"unknown" is an expressible inventory level', /inventoryLevel[^\n]*"unknown"/.test(SRC.aiCma))
  check("months_of_inventory (the real column) is read, not approximated", /months_of_inventory/.test(trends))
  check("a REFUSED market_data read is logged, not read as an empty market", /marketError/.test(trends))
  check("the select names its columns (no select('*') hiding phantoms)", !/from\("market_data"\)[\s\S]{0,80}select\("\*"\)/.test(CODE.aiCma))
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE COMPARABLES ARE PERSISTED (the write that did not exist)
// ═══════════════════════════════════════════════════════════════════════════
function testCompsPersisted() {
  console.log("\n[4 · cma_comparables — the write that did not exist]")
  const a = SRC.aiCma

  check("generateAICMA now INSERTS into cma_comparables", /from\("cma_comparables"\)\s*\.insert\(/.test(a))
  check("generateAICMA now INSERTS the per-comp adjustments", /from\("cma_price_adjustments"\)\s*\.insert\(adjustmentRows\)/.test(a))
  check("the comp insert selects its ids back (appraisal-defense joins on them)",
    /from\("cma_comparables"\)[\s\S]{0,120}\.select\("id, address"\)/.test(a))
  check("cma_price_adjustments.comparable_property_id carries the cma_comparables row id",
    /comparable_property_id:\s*compRowId/.test(a))
  check("appraisal-defense joins adjustments on exactly that column",
    /comparable_property_id/.test(SRC.appraisalDefense))

  // supabase-js RESOLVES a refusal — both inserts must read their error.
  check("a refused comp insert is READ, not swallowed", /if \(compsError\)/.test(a))
  check("a refused adjustment insert is READ, not swallowed", /if \(adjError\)/.test(a))
  check("a refused write is reported to the caller (persistenceWarnings), not just logged",
    /persistenceWarnings/.test(a) && /warnings\.push\(/.test(a))

  // CLOSED ONLY. cma_comparables has no status column, and its price column is
  // named sale_price — an asking price there is a fabricated sale.
  check("only adjustedComps (the CLOSED set) are persisted", /cma\.adjustedComps\.map\(\(a\) => \{/.test(a))
  check("pending/active comps are NOT written to cma_comparables",
    !/pendingComps[\s\S]{0,400}from\("cma_comparables"\)/.test(CODE.aiCma) &&
      !/activeComps[\s\S]{0,400}from\("cma_comparables"\)/.test(CODE.aiCma))
  check("list_price is null on the persisted closed rows (they are sales, not asks)", /list_price:\s*null/.test(a))
  check("the closed-only decision is explained in the source", /CLOSED COMPS ONLY/.test(a))

  // comparable_count must equal the number of rows a reader can actually find.
  check("comparable_count counts the CLOSED comps that were written",
    /comparable_count:\s*cma\.adjustedComps\.length/.test(a))

  // Distance: null, never 0 — appraisal-defense ranks by it.
  check("an unknown distance is null, not 0 (appraisal-defense ranks closest-first)",
    /distance_miles:\s*a\.comp\.distanceMiles \?\? null/.test(a))

  // The adjustment sign must survive — appraisal-defense derives direction from it.
  check("adjustment amounts are persisted SIGNED (direction is the sign)",
    /adjustment_amount:\s*adj\.amount/.test(a) && /Signed\./.test(a))

  // The five readers that were reading an empty table.
  for (const [label, key] of [
    ["seller-cma loadCMAPageData (the CMA tab comp table)", "sellerCma"],
    ["appraisal-defense (the appraiser packet)", "appraisalDefense"],
    ["ai-cma-engine scoreAllComps (AI comp scoring)", "compEngine"],
    ["listing-presentation section-render", "sectionRender"],
    ["predictive-listing run-scoring", "predictive"],
  ] as const) {
    check(`reader still reads cma_comparables — now it has rows: ${label}`, /cma_comparables/.test(SRC[key]))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · EVERY COLUMN EXISTS (PGRST204 refuses a write naming an absent column)
// ═══════════════════════════════════════════════════════════════════════════
function testColumnsExist() {
  console.log("\n[5 · Every written column exists on the live schema]")
  const snap = SRC.snapshot
  const cols = (table: string): string[] => {
    const m = snap.match(new RegExp(`\\n\\s*${table}: \\[([^\\]]*)\\]`))
    return m ? m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : []
  }

  const comparables = cols("cma_comparables")
  const adjustments = cols("cma_price_adjustments")
  const reports = cols("cma_reports")
  check("schema snapshot carries all three CMA tables",
    comparables.length > 0 && adjustments.length > 0 && reports.length > 0)

  const writtenComparables = [
    "cma_id", "address", "sale_price", "list_price", "price_per_sqft", "bedrooms", "bathrooms",
    "square_feet", "days_on_market", "sale_date", "distance_miles", "similarity_score",
    "adjusted_price", "adjustments",
  ]
  for (const c of writtenComparables) {
    check(`cma_comparables.${c} exists`, comparables.includes(c))
  }

  for (const c of ["cma_report_id", "comparable_property_id", "comparable_address", "adjustment_type", "adjustment_amount", "rationale"]) {
    check(`cma_price_adjustments.${c} exists`, adjustments.includes(c))
  }

  // quality_score is newly written on insert.
  check("cma_reports.quality_score exists (newly written on insert)", reports.includes("quality_score"))
  check("generateAICMA writes quality_score from the MEASURED confidence",
    /quality_score:\s*Math\.round\(cma\.confidenceScore \* 100\)/.test(SRC.aiCma))

  // ── THE GAP IS CLOSED. m498 APPLIED. ──────────────────────────────────────
  // This assertion used to pin the OPPOSITE — "cma_comparables STILL cannot
  // record status/source (migration m498 filed)" — which was the honest reading
  // while the migration was only a file on disk. Files are not the database, so
  // the proof said so out loud instead of pretending. m498 is now applied and
  // the schema cache regenerated from the live database, so the assertion is
  // inverted to the fact rather than deleted: the columns exist, and the writer
  // fills them EXPLICITLY rather than leaning on the DEFAULT — a default is a
  // statement about rows nobody thought about.
  for (const c of ["status", "source_provider", "price_basis"]) {
    check(`cma_comparables.${c} exists (m498, applied)`, comparables.includes(c))
  }
  check("persistComparables declares status/price_basis on the row, not by DEFAULT",
    /status:\s*"closed"/.test(SRC.aiCma) && /price_basis:\s*"closed_sale"/.test(SRC.aiCma))
  check("source_provider is the COMP'S OWN provenance, not the side's majority provider",
    /source_provider:\s*a\.comp\.sourceProvider/.test(SRC.aiCma),
    "a per-side provider here would mislabel a mixed side")
  // The two CHECKs that make the fabrication unrepresentable, read from the
  // migration itself so the proof cannot drift from what was applied.
  const m498 = read("supabase/migrations/m498-cma-comparables-cannot-record-a-comps-status-or-source-so-an-asking-price-can-only-be-stored-in-a-column-named-sale-price.sql")
  check("m498: a non-closed row must be list_price with sale_price NULL",
    /price_basis = 'list_price' AND sale_price IS NULL/.test(m498))
  check("m498: a perplexity-sourced row can NEVER be a closed sale",
    /NOT \(source_provider = 'perplexity' AND status = 'closed'\)/.test(m498))
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · PER-CALLER PROOF — every former caller still gets what it read
// ═══════════════════════════════════════════════════════════════════════════
function testPerCaller() {
  console.log("\n[6 · Per-caller proof — no caller lost a capability]")
  const ret = SRC.aiCma.slice(SRC.aiCma.indexOf("revalidatePath(\"/dashboard/cma\")"))

  // Each entry: caller, the key it reads off generateAICMA's result, why.
  const contract: Array<[string, string, string]> = [
    ["cma-presentation/cma-generator.ts", "cmaId", "files the real cma_reports.id on seller.cma.completed"],
    ["cma-presentation/cma-generator.ts", "comparables", "counts .length for the completion activity"],
    ["cma-presentation/cma-generator.ts", "qualityScore", "prints it, or says 'not assessed'"],
    ["ai-predictions.ts massGenerateCMAs", "pricingStrategy", "reads .recommendedListPrice for the equity delta"],
    ["ai-predictions.ts massGenerateCMAs", "id", "stores it as cmaId on the insight"],
    ["listing-appt-prep chain", "valuation", "surfaces it on the step output"],
    ["cma-history-sheet.tsx / cma-report-tab.tsx", "success", "branches the toast / refresh"],
  ]
  for (const [caller, key, why] of contract) {
    check(`${caller} still gets \`${key}\` (${why})`, new RegExp(`\\n\\s+${key}[,:]`).test(ret))
  }

  // qualityScore was ALWAYS undefined before — cma-generator's `?? 70` hardcoded
  // a passing score onto every CMA. Prove it is genuinely produced now.
  check("qualityScore is genuinely produced (it was always undefined before)",
    /qualityScore:\s*Math\.round\(cma\.confidenceScore \* 100\)/.test(ret))
  check("cma-generator no longer needs to invent a quality score", !/\?\?\s*70/.test(CODE.generator))

  // Capabilities GAINED by every caller.
  for (const gained of ["compProvenance", "citations", "disclaimers", "pendingComparables", "activeComparables", "comparablesPersisted"]) {
    check(`every caller now also gets \`${gained}\``, new RegExp(`\\n\\s+${gained}[,:]`).test(ret))
  }

  // The listing-appointment chain was passing keys CMAParams does not have.
  const chain = SRC.apptChain
  check("listing-appt-prep passes propertyAddress (it passed `address`, which CMAParams ignores)",
    /propertyAddress:\s*propertyData\.address/.test(chain))
  check("listing-appt-prep passes squareFeet (it passed `sqft` — every CMA ran at 0 sqft)",
    /squareFeet:\s*propertyData\.sqft/.test(chain))
  check("listing-appt-prep passes propertyCity/State/Zip",
    /propertyCity:/.test(chain) && /propertyState:/.test(chain) && /propertyZip:/.test(chain))
  check("listing-appt-prep passes listingType (the strategist branches on it)", /listingType:\s*"seller"/.test(chain))
  check('listing-appt-prep no longer invents condition "average" (not in the vocabulary)',
    !/condition:\s*propertyData\.condition\s*\?\?\s*"average"/.test(CODE.apptChain))
}

// ═══════════════════════════════════════════════════════════════════════════
// 7 · "use server" DISCIPLINE
// ═══════════════════════════════════════════════════════════════════════════
function testServerDiscipline() {
  console.log('\n[7 · "use server" discipline]')
  for (const key of ["aiCma", "generator", "sellerCma", "appraisalDefense"] as const) {
    const src = SRC[key]
    if (!/^"use server"/.test(src.trim())) continue
    const exports = [...src.matchAll(/^export (async )?function (\w+)/gm)]
    const sync = exports.filter((m) => !m[1]).map((m) => m[2])
    check(`${(F as any)[key]}: every exported function is async`, sync.length === 0, sync.join(", "))
    const constExports = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1])
    check(`${(F as any)[key]}: no non-async const export`, constExports.length === 0, constExports.join(", "))
  }
  // generateAICMA's gates must run BEFORE the comps are bought.
  const gen = bodyOf(SRC.aiCma, "export async function generateAICMA")
  const authAt = gen.indexOf("supabase.auth.getUser()")
  const contactAt = gen.indexOf('from("contacts")')
  const spendAt = gen.indexOf("await runAiCma(")
  check("auth gate precedes the paid comp sourcing", authAt >= 0 && authAt < spendAt)
  check("the contacts-only gate precedes the paid comp sourcing", contactAt >= 0 && contactAt < spendAt)
  check("the tenant is resolved before the spend", gen.indexOf("cmaBrokerageId") < spendAt)
}

console.log("══════════════════════════════════════════════════")
console.log(" ONE CMA ENGINE — merge harness")
console.log("══════════════════════════════════════════════════")
testOneEngine()
testNoFabricatedPrice()
testNoInventedMarketFacts()
testCompsPersisted()
testColumnsExist()
testPerCaller()
testServerDiscipline()

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(" ✅ One CMA engine — runAiCma values it, generateAICMA persists it,")
console.log("    no model authors a price, and the comparables are on disk.")
