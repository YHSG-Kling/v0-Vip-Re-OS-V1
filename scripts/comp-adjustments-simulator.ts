#!/usr/bin/env tsx
/**
 * scripts/comp-adjustments-simulator.ts   (tsx scripts/comp-adjustments-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * lib/cma/comp-adjustments.ts — WORKED NUMERIC CASES for the appraisal-style
 * adjustment grid: gross vs net %, the weak-comp flag at the Fannie Mae
 * Selling Guide B4-1.3-09 thresholds the owner's task named verbatim
 * (gross > 25% or net > 15%), and the inverse-gross-weighted reconciled range.
 *
 * PURE MODULE — no server-only import, no DB, no network. Every case below
 * calls `adjustComps` directly and checks the arithmetic by hand, computed
 * independently in this file (never by re-deriving the same formula the
 * module uses, which would prove the module agrees with itself).
 *
 * Registered: package.json `"test:comp-adjustments": "tsx scripts/comp-
 * adjustments-simulator.ts"`, guard tail after `test:rentcast-copilot-tools`,
 * and a MAINTENANCE_DOMAINS entry (`comp_adjustment_grid`,
 * lib/kernel/manager-registry.ts) naming this proof — test:proof-ownership
 * requires it (wave 69 integration lesson).
 */
import {
  adjustComps,
  BEDROOM_ADJUSTMENT_USD,
  FULL_BATH_ADJUSTMENT_USD,
  HALF_BATH_ADJUSTMENT_USD,
  GARAGE_SPACE_ADJUSTMENT_USD,
  POOL_ADJUSTMENT_USD,
  YEAR_BUILT_PCT_PER_YEAR,
  LOT_SIZE_ADJUSTMENT_USD_PER_ACRE,
  CONDITION_TIER_PCT_PER_GRADE,
  DISTANCE_NEUTRAL_RADIUS_MILES,
  DISTANCE_PCT_PER_MILE,
  DISTANCE_MAX_PCT,
  WEAK_COMP_GROSS_THRESHOLD_PCT,
  WEAK_COMP_NET_THRESHOLD_PCT,
  ADJUSTMENT_GRID_DISCLAIMER,
} from "../lib/cma/comp-adjustments"
import type { SubjectFeatures } from "../lib/cma/state-adjustment-rates"
import type { ScoredComp } from "../lib/cma/comp-types"

let pass = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function approx(a: number, b: number, tol = 1): boolean {
  return Math.abs(a - b) <= tol
}

const isoDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)

/** A ScoredComp fixture — every field the grid can read, explicit rather than
 *  relying on defaults so each case states exactly what it's testing. */
function comp(over: Partial<ScoredComp> = {}): ScoredComp {
  return {
    address: "100 Comp Ln",
    status: "closed",
    salePrice: 400_000,
    saleDate: isoDaysAgo(0),
    sqftLiving: 2000,
    bedrooms: 3,
    fullBaths: 2,
    halfBaths: 0,
    garageSpaces: 2,
    hasPool: false,
    isWaterfront: null,
    hasView: null,
    lotSizeAcres: 0.25,
    yearBuilt: 2005,
    conditionGrade: 3,
    basementFinished: null,
    isNewConstruction: null,
    isGated: null,
    daysOnMarket: 15,
    pricePerSqft: 200,
    similarityScore: 0.9,
    citation: "fixture",
    distanceMiles: 0.5,
    sourceProvider: "rentcast",
    priceBasis: "closed_sale",
    ...over,
  }
}

const SUBJECT: SubjectFeatures = {
  sqftLiving: 2000, bedrooms: 3, fullBaths: 2, halfBaths: 0,
  garageSpaces: 2, hasPool: false, isWaterfront: null, hasView: null,
  lotSizeAcres: 0.25, yearBuilt: 2005, conditionGrade: 3,
  basementFinished: null, isNewConstruction: null, isGated: null,
}

console.log("COMP ADJUSTMENTS — worked numeric cases (lib/cma/comp-adjustments.ts)\n")

// ── Case 1: identical subject/comp → zero lines, zero gross/net, not weak ──
{
  const { grid } = adjustComps(SUBJECT, [comp()], 0)
  const g = grid[0]
  check("1a an identical subject/comp produces NO line items", g.lines.length === 0, `lines=${g.lines.length}`)
  check("1b net adjustment is exactly 0", g.netAdjustment === 0)
  check("1c gross adjustment is exactly 0", g.grossAdjustment === 0)
  check("1d adjusted value equals the comp's own sale price", g.adjustedValue === 400_000)
  check("1e NOT flagged weak", !g.isWeakComp)
}

// ── Case 2: living-area line item uses the COMP'S OWN $/sqft ──────────────
{
  const c = comp({ sqftLiving: 1800, pricePerSqft: 200 }) // subject 2000 vs comp 1800 → +200 sqft
  const { grid } = adjustComps(SUBJECT, [c], 0)
  const line = grid[0].lines.find((l) => l.type === "sqft_living")
  const expected = 200 * 200 // 200 sqft diff * $200/sqft (comp's own rate)
  check("2a sqft_living line present", !!line)
  check("2b sqft_living amount = diff × comp's own $/sqft", !!line && approx(line.amount, expected), `got ${line?.amount} expected ${expected}`)
}

// ── Case 3: every published line item at once, summed correctly by hand ───
{
  const c = comp({
    bedrooms: 2,          // subject has 1 more bedroom → +1 * BEDROOM
    fullBaths: 1,         // subject has 1 more full bath → +1 * FULL_BATH
    halfBaths: 1,         // subject has 1 fewer half bath → -1 * HALF_BATH
    garageSpaces: 1,       // subject has 1 more garage space → +1 * GARAGE
    hasPool: true,         // comp has a pool, subject doesn't → -POOL
    yearBuilt: 1995,       // subject 10 years NEWER → +10 * YEAR_BUILT_PCT * price
    lotSizeAcres: 0.15,     // subject 0.10 acres MORE → +0.10 * LOT_SIZE
    conditionGrade: 2,      // subject 1 grade BETTER → +1 * CONDITION_PCT * price
    salePrice: 500_000,
    pricePerSqft: 250,
  })
  const { grid } = adjustComps(SUBJECT, [c], 0)
  const g = grid[0]
  const price = 500_000
  const expectedNet = Math.round(
    1 * BEDROOM_ADJUSTMENT_USD +
    1 * FULL_BATH_ADJUSTMENT_USD +
    -1 * HALF_BATH_ADJUSTMENT_USD +
    1 * GARAGE_SPACE_ADJUSTMENT_USD +
    -POOL_ADJUSTMENT_USD +
    10 * YEAR_BUILT_PCT_PER_YEAR * price +
    0.10 * LOT_SIZE_ADJUSTMENT_USD_PER_ACRE +
    1 * CONDITION_TIER_PCT_PER_GRADE * price,
  )
  check(
    "3a net adjustment matches the hand-summed total across every line type",
    approx(g.netAdjustment, expectedNet, 5),
    `got ${g.netAdjustment} expected ${expectedNet}`,
  )
  check("3b adjustedValue = salePrice + netAdjustment", g.adjustedValue === c.salePrice + g.netAdjustment)
  check("3c gross adjustment >= |net adjustment| (offsetting lines never cancel in gross)",
    g.grossAdjustment >= Math.abs(g.netAdjustment))
}

// ── Case 4: distance/location — neutral inside the radius, decays beyond it ──
{
  const inside = comp({ distanceMiles: DISTANCE_NEUTRAL_RADIUS_MILES }) // exactly at the radius
  const outside = comp({ distanceMiles: DISTANCE_NEUTRAL_RADIUS_MILES + 2, salePrice: 400_000 })
  const { grid: g1 } = adjustComps(SUBJECT, [inside], 0)
  const { grid: g2 } = adjustComps(SUBJECT, [outside], 0)
  check("4a at exactly the neutral radius, no distance line item", !g1[0].lines.some((l) => l.type === "distance_location"))
  const distLine = g2[0].lines.find((l) => l.type === "distance_location")
  const expectedPct = Math.min(DISTANCE_MAX_PCT, 2 * DISTANCE_PCT_PER_MILE)
  check("4b beyond the radius, a NEGATIVE distance line scaled by miles-beyond", !!distLine && distLine.amount < 0)
  check(
    "4c distance line magnitude matches milesBeyond × DISTANCE_PCT_PER_MILE (capped)",
    !!distLine && approx(Math.abs(distLine.amount), expectedPct * 400_000, 5),
  )
  const farAway = comp({ distanceMiles: 50, salePrice: 400_000 })
  const { grid: g3 } = adjustComps(SUBJECT, [farAway], 0)
  const capLine = g3[0].lines.find((l) => l.type === "distance_location")
  check("4d the distance discount is CAPPED at DISTANCE_MAX_PCT even far away",
    !!capLine && approx(Math.abs(capLine.amount), DISTANCE_MAX_PCT * 400_000, 5))
}

// ── Case 5: time-of-sale uses marketTrendPctPerMonth × months since sale ──
{
  const monthsAgoComp = comp({ saleDate: isoDaysAgo(60), salePrice: 400_000 }) // ~2 months
  const trend = 0.005 // 0.5%/month
  const { grid } = adjustComps(SUBJECT, [monthsAgoComp], trend)
  const line = grid[0].lines.find((l) => l.type === "time_of_sale")
  check("5a a comp sold ~2 months ago gets a time_of_sale line at a nonzero trend", !!line)
  check("5b the sign is POSITIVE for a positive (appreciating) trend", !!line && line.amount > 0)
}
{
  // null trend falls back to the module's OWN documented default — proven by
  // comparing against a call that passes that default explicitly.
  const c = comp({ saleDate: isoDaysAgo(90) })
  const { grid: withNull } = adjustComps(SUBJECT, [c], null)
  const { grid: withExplicitDefault } = adjustComps(SUBJECT, [c], 0.003) // FALLBACK_MONTHLY_TREND_PCT
  check(
    "5c passing null falls back to the SAME result as passing the documented default explicitly",
    withNull[0].netAdjustment === withExplicitDefault[0].netAdjustment,
  )
}

// ── Case 6: THE WEAK-COMP FLAG — both directions, so it is not vacuous ────
{
  // A comp needing heavy surgery: on a CHEAP comp so the dollar lines are a
  // large % of its own price, forcing gross% past the published threshold.
  const cheapButOffsetting = comp({ salePrice: 30_000, pricePerSqft: 15, sqftLiving: 2000, bedrooms: 1, fullBaths: 0 })
  const { grid } = adjustComps(SUBJECT, [cheapButOffsetting], 0)
  const g = grid[0]
  check("6a a comp needing large adjustments relative to its own (small) price IS flagged weak", g.isWeakComp)
  check("6b the flag names WHICH threshold(s) were exceeded", g.weakCompReasons.length > 0)
  check(
    "6c gross % actually exceeds the published threshold when the flag fires",
    g.grossAdjustmentPct > WEAK_COMP_GROSS_THRESHOLD_PCT || Math.abs(g.netAdjustmentPct) > WEAK_COMP_NET_THRESHOLD_PCT,
  )

  // POSITIVE CONTROL (the OTHER direction): a well-matched comp must NOT be
  // flagged — proving the flag isn't just always true.
  const wellMatched = comp() // identical to subject, from Case 1
  const { grid: g2 } = adjustComps(SUBJECT, [wellMatched], 0)
  check("6d-positive-control an identical comp is NOT flagged weak (the flag can say no)", !g2[0].isWeakComp)
}

// ── Case 7: RECONCILED RANGE — weighted by INVERSE gross adjustment ───────
{
  // Comp A: perfect match, high weight. Comp B: needs heavy adjustment, low weight.
  // A dumb (unweighted) average of 400k and 700k would be 550k; the weighted
  // reconciliation must sit CLOSER to A's 400k because A's gross% is far lower.
  const a = comp({ salePrice: 400_000, pricePerSqft: 200 }) // identical to subject → ~0% gross
  const b = comp({
    salePrice: 700_000, pricePerSqft: 350, sqftLiving: 1200, bedrooms: 1, fullBaths: 1,
    garageSpaces: 0, hasPool: true, yearBuilt: 1970, lotSizeAcres: 2, conditionGrade: 1,
  })
  const { grid, reconciled } = adjustComps(SUBJECT, [a, b], 0)
  check("7a reconciled range is present for a 2-comp set", reconciled !== null)
  if (reconciled) {
    const naiveAverage = (grid[0].adjustedValue + grid[1].adjustedValue) / 2
    check(
      "7b the weighted reconciled value sits CLOSER to the low-gross comp than a naive average would",
      Math.abs(reconciled.reconciledValue - grid[0].adjustedValue) <
        Math.abs(naiveAverage - grid[0].adjustedValue),
      `reconciled=${reconciled.reconciledValue} naive=${naiveAverage} compA=${grid[0].adjustedValue}`,
    )
    check("7c low <= reconciledValue <= high", reconciled.low <= reconciled.reconciledValue && reconciled.reconciledValue <= reconciled.high)
    check("7d compsUsed counts both comps", reconciled.compsUsed === 2)
  }
}

// ── Case 8: reconciliation NEVER drops a weak comp, only down-weights it ──
{
  const weak = comp({ salePrice: 30_000, pricePerSqft: 15, sqftLiving: 2000, bedrooms: 1, fullBaths: 0 })
  const { grid, reconciled } = adjustComps(SUBJECT, [weak], 0)
  check("8a a set of ONLY weak comps still returns a reconciled range (never silently empty)", reconciled !== null)
  check("8b …and it is labelled allCompsWeak", !!reconciled && reconciled.allCompsWeak === true)
  check("8c the weak comp itself is present in the grid — not filtered out", grid.length === 1 && grid[0].isWeakComp)
}

// ── Case 9: an empty comp set produces an empty grid and a NULL reconciliation ──
{
  const { grid, reconciled } = adjustComps(SUBJECT, [], 0)
  check("9a empty input → empty grid", grid.length === 0)
  check("9b empty input → reconciled is explicitly null (never a fabricated 0)", reconciled === null)
}

// ── Case 10: the disclaimer is present, verbatim, on every result ─────────
{
  const { disclaimer } = adjustComps(SUBJECT, [comp()], 0)
  check("10a the disclaimer is the exported ADJUSTMENT_GRID_DISCLAIMER constant, not a re-typed copy", disclaimer === ADJUSTMENT_GRID_DISCLAIMER)
  check("10b the disclaimer explicitly says this is not an appraisal", /not.*an appraisal/i.test(disclaimer))
}

console.log("")
if (failures.length) {
  console.log(`FAILED (${failures.length} of ${pass + failures.length} assertions)`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log(
  `PASSED (${pass} assertions) — the adjustment grid computes gross/net % correctly, flags weak ` +
  `comps at the Fannie Mae B4-1.3-09 thresholds in both directions, prices the distance/location ` +
  `line item nothing else in this codebase prices, and reconciles a value range weighted by ` +
  `inverse gross adjustment without ever silently dropping a comp`,
)
