#!/usr/bin/env tsx
/**
 * scripts/appraiser-guidelines-simulator.ts   (npm run test:appraiser-guidelines)
 * ─────────────────────────────────────────────────────────────────────────────
 * "THE CURRENT YEAR'S STATE APPRAISER GUIDELINES" — MADE TRUE AT RUNTIME, AND
 * MADE HONEST WHEN THE CURRENT YEAR IS NOT THERE.
 *
 * OWNER, VERBATIM: "we use the current years state appraiser guidelines for
 * adjustments."
 *
 * That is a decision, not a question, and until m505 it had neither an
 * implementation nor a place to live. Four defects sat in this lane, all of them
 * reported by scripts/cma-provider-lane-simulator.ts as ⚠ FINDINGS and none of
 * them fixed. This proof stands over all four.
 *
 *   F1  THE VINTAGE WAS NEVER READ, AND COULD NOT HAVE BEEN STORED.
 *       `state_appraiser_adjustment_rates.effective_year` existed from the day
 *       the table was created and nothing ever selected it; all 39 live rows are
 *       2024, so every CMA ever produced quoted two-year-old guidance and no
 *       report said so. Worse, UNIQUE (state, adjustment_type, rate_basis) could
 *       not hold two vintages of one rate at all — the ruling was UNSTORABLE.
 *       m505 widens the key; the resolver now takes the year FROM THE CMA'S OWN
 *       DATE and picks the most recent vintage at or before it.
 *
 *   F2  A PARAMETER NOTHING COULD REACH. `apply(..., rateOverride?: number)` was
 *       declared and never passed by ANY of its call sites. Removed
 *       rather than wired: the only actor with an opinion about where inside a
 *       published band a comp sits is the narrative model, and this lane exists
 *       to keep the model out of the dollar math. Tombstoned, naming `rate.mid`
 *       as the survivor at file:line.
 *
 *   F3  A PROMPT THAT ASKED FOR AN IMPOSSIBLE CHOICE. The rate block told the
 *       model to apply a figure selected from each low-high band, while the same
 *       prompt told it the dollar figures were already computed and not its to
 *       revise. A request the caller discards is an invitation to narrate a
 *       selection that never happened. The block now states what was applied.
 *
 *   F4  THE AI FINDER DEFAULTED TO ASKING FOR CLOSED SALES. `want` defaulted to
 *       `{ closed: 3 }` — the one thing lib/cma/perplexity-comp-finder.ts's own
 *       header forbids it to supply, because a wrong AI sale price does not
 *       degrade a CMA's estimate, it BECOMES it. Default is now closed: 0.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 * TWO LAYERS, and the first is the one that matters.
 *
 *   BEHAVIOUR — the REAL getStateAdjustmentRates, formatRatesForPrompt,
 *   computeCompAdjustments, runAiCma and findCompsViaPerplexity are executed.
 *   Only the lane's EDGES are stubbed (the Supabase client, the routed model,
 *   the vendor ledger, and comp sourcing) through `registerHooks`, so what is
 *   asserted is what the production functions DO with a given rate table — not
 *   what their source text looks like.
 *
 *   CONSTRUCT — a small number of facts a behaviour test cannot see: that the
 *   year handed to the resolver is derived rather than typed, that the removed
 *   parameter is tombstoned, and that m505 does not fabricate a current-year
 *   vintage.
 *
 * ── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
 * Each control re-introduces a defect INTO AN IN-MEMORY COPY of the real source
 * and re-runs the SAME predicate that guards it, requiring it to go RED. The
 * copy is in memory on purpose: this repo runs waves of agents in parallel, and
 * a control that writes a defect into a real file on disk can be read by another
 * process, or left behind by a crash. Each patch is verified to have APPLIED —
 * a find-string that silently stops matching is theatre, not a control.
 *
 * Comment-BLANKED source is scanned throughout (scripts/strip-comments.ts). This
 * is load-bearing: the fixes quote the old code in the comments that explain
 * them, and a raw-source scan would accuse the fix of being the defect.
 *
 * Run: npx tsx scripts/appraiser-guidelines-simulator.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { blankComments } from "./strip-comments"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** Comment-blanked source (offsets preserved, so slices stay accurate). */
const code = (p: string) => blankComments(raw(p))

const F = {
  rates: "lib/cma/state-adjustment-rates.ts",
  orch: "lib/cma/ai-cma-orchestrator.ts",
  finder: "lib/cma/perplexity-comp-finder.ts",
  action: "app/actions/ai-cma.ts",
  migration:
    "supabase/migrations/m505-a-rate-table-that-cannot-hold-two-vintages-cannot-hold-the-current-years-guidelines.sql",
}

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string): boolean {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
  return cond
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PREDICATES — defined ONCE, used by the construct layer and re-used
// verbatim by the negative controls. A control that re-implements the check it
// is testing proves only that two regexes disagree.
// ─────────────────────────────────────────────────────────────────────────────
const P = {
  /** F1a — the resolver SELECTS and FILTERS on the vintage column. */
  resolverReadsVintage: (src: string) =>
    /\.select\(\s*[\s\S]{0,400}?effective_year/.test(src) &&
    /\.lte\(\s*"effective_year"\s*,\s*effectiveYear\s*\)/.test(src),

  /** F1b — the year handed to the resolver is DERIVED, never a literal. */
  yearIsDerived: (src: string) =>
    /const effectiveYear\s*=\s*new Date\(effectiveDate\)\.getUTCFullYear\(\)/.test(src) &&
    /getStateAdjustmentRates\(\s*input\.subject\.state\s*,\s*effectiveYear\s*\)/.test(src) &&
    !/getStateAdjustmentRates\([^)]*,\s*\d{4}\s*\)/.test(src),

  /**
   * F1c — a carried-forward vintage is REPORTED, on BOTH surfaces a reader could
   * reach it from. Requiring both is deliberate: the two sentences are worded
   * differently, so a control that deletes one cannot be satisfied by the other
   * still being there — which is exactly how the first version of this control
   * passed while the disclaimer had been removed.
   */
  fallbackIsReported: (src: string) =>
    /rateVintage\.carriedForward/.test(src) &&
    // the seller-facing disclaimer
    /THE ADJUSTMENT RATES IN THIS REPORT ARE NOT \$\{rateVintage\.requestedYear\} RATES/.test(src) &&
    // the narrative writer's hard rule
    /THE ADJUSTMENT RATES ARE NOT \$\{rateVintage\.requestedYear\} RATES/.test(src),

  /** F2 — the unreachable parameter is gone from the code (not just renamed). */
  noRateOverride: (src: string) => !/rateOverride/.test(src),

  /** F3 — the prompt does not ask the model to select a rate. */
  promptAsksForNoChoice: (src: string) => {
    const at = src.indexOf("export function formatRatesForPrompt")
    if (at === -1) return false
    const body = src.slice(at, at + 2200)
    const asksForSelection =
      /Apply each within the low-high range/i.test(body) ||
      /(select|choose|pick)[^.\n]{0,40}(within|from)[^.\n]{0,30}(range|band)/i.test(body)
    const statesWhatWasApplied = /ACTUALLY APPLIED/.test(body) && /applied \$\{fmt\(r\.mid\)\}/.test(body)
    return !asksForSelection && statesWhatWasApplied
  },

  /** F4 — the AI finder cannot be asked for closed comps by default. */
  finderDefaultsClosedToZero: (src: string) =>
    /closed:\s*Math\.max\(\s*0\s*,\s*input\.want\?\.closed\s*\?\?\s*0\s*\)/.test(src),
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE INTERCEPTION — so the REAL resolver and the REAL orchestrator run
// ─────────────────────────────────────────────────────────────────────────────
const STUBS: Record<string, string> = {
  "@/lib/supabase/service":
    "export const createServiceClient = (...a) => globalThis.__AGS.createServiceClient(...a)",
  "@/lib/ai/models":
    "export const generateTextRouted = (...a) => globalThis.__AGS.generateTextRouted(...a)",
  "@/lib/vendor-governance/usage-logger":
    "export const logVendorUsage = (...a) => globalThis.__AGS.logVendorUsage(...a)",
  // comp-provider belongs to the sourcing lane and has its own proof; stubbing it
  // keeps this proof pointed at the ADJUSTMENT stage.
  "./comp-provider":
    "export const sourceCompsForCma = (...a) => globalThis.__AGS.sourceCompsForCma(...a);" +
    "export const REQUIRED_SOLD_COMPS = 3;" +
    "export const PROVIDER_AVM_BASELINE_LABEL = 'baseline'",
}

registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true }
    const stub = STUBS[spec]
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// THE WORLD each scenario configures
// ─────────────────────────────────────────────────────────────────────────────
interface RateRow {
  state: string
  adjustment_type: string
  rate_basis: "pct_of_comp_price" | "per_unit_dollars"
  typical_rate_low: number
  typical_rate_mid: number
  typical_rate_high: number
  unit: string
  notes: string | null
  source: string | null
  effective_year: number
}

function row(
  state: string,
  type: string,
  year: number,
  mid: number,
  over: Partial<RateRow> = {}
): RateRow {
  return {
    state,
    adjustment_type: type,
    rate_basis: "pct_of_comp_price",
    typical_rate_low: mid / 2,
    typical_rate_mid: mid,
    typical_rate_high: mid * 2,
    unit: "per unit",
    notes: null,
    source: `${state} board ${year}`,
    effective_year: year,
    ...over,
  }
}

interface World {
  /** Every row the "table" holds, of every vintage. */
  table: RateRow[]
  /** A refusal the read resolves with, supabase-js style. */
  readError: { message: string } | null
  /** Spy: exactly what the resolver asked the table for. */
  query: { states: string[] | null; vintageColumn: string | null; vintageBound: number | null }
  /** Spy: prompts handed to the routed model. */
  prompts: string[]
  ledger: any[]
  /** What the stubbed comp sourcing returns. */
  sourced: any
}

let W: World

function newWorld(over: Partial<World> = {}): World {
  return {
    table: [],
    readError: null,
    query: { states: null, vintageColumn: null, vintageBound: null },
    prompts: [],
    ledger: [],
    sourced: null,
    ...over,
  }
}

/** A CompProvenance shaped like the sourcing lane's, with no AI rows in it. */
function provenance(over: Record<string, any> = {}): any {
  return {
    soldProvider: "rentcast",
    activeProvider: "rentcast",
    pendingProvider: "none",
    soldWindowMonths: 6,
    soldWindowWidened: false,
    soldCompCount: 2,
    activeCompCount: 0,
    pendingCompCount: 0,
    meetsRequiredMix: false,
    aiGapFillAttempted: false,
    aiGapFilledSlots: [],
    aiGapFilledCompCount: 0,
    citations: [],
    estimatedCostCents: 15,
    notes: [],
    rentcastEligibility: "eligible",
    tenantOwnsIdx: false,
    rentcastConfigured: true,
    avmBaseline: {
      available: false,
      value: null,
      rangeLow: null,
      rangeHigh: null,
      provider: "rentcast",
      kind: "provider_automated_estimate",
      label: "baseline",
      unavailableNote: "The provider published no automated valuation for this address.",
    },
    ...over,
  }
}

function comp(address: string, salePrice: number, saleDate: string, sqft: number): any {
  return {
    address,
    status: "closed",
    salePrice,
    saleDate,
    sqftLiving: sqft,
    bedrooms: 3,
    fullBaths: 2,
    halfBaths: 0,
    garageSpaces: null,
    hasPool: null,
    isWaterfront: null,
    hasView: null,
    lotSizeAcres: null,
    yearBuilt: 2005,
    conditionGrade: null,
    basementFinished: null,
    isNewConstruction: null,
    isGated: null,
    daysOnMarket: 20,
    pricePerSqft: null,
    similarityScore: 0.9,
    citation: null,
    distanceMiles: 0.4,
    sourceProvider: "rentcast",
    priceBasis: "closed_sale",
  }
}

;(globalThis as any).__AGS = {
  createServiceClient: () => {
    const q: any = {
      select: () => q,
      in: (_col: string, vals: string[]) => {
        W.query.states = vals
        return q
      },
      lte: (col: string, bound: number) => {
        W.query.vintageColumn = col
        W.query.vintageBound = bound
        if (W.readError) return Promise.resolve({ data: null, error: W.readError })
        return Promise.resolve({
          data: W.table.filter((r) => r.effective_year <= bound && (W.query.states ?? []).includes(r.state)),
          error: null,
        })
      },
    }
    return { from: () => q }
  },
  generateTextRouted: async (args: any) => {
    W.prompts.push(String(args?.prompt ?? ""))
    return { text: "NARRATIVE" }
  },
  logVendorUsage: async (r: any) => {
    W.ledger.push(r)
    return null
  },
  sourceCompsForCma: async () => W.sourced,
}

const SUBJECT = {
  address: "1 Subject St",
  city: "Tampa",
  state: "FL",
  zip: "33601",
  propertyType: "single_family" as const,
  sqftLiving: 2000,
  bedrooms: 3,
  fullBaths: 2,
  halfBaths: 0,
  yearBuilt: 2005,
}

/** The live table's shape as of this wave: FL + US, every row 2024. */
function live2024Table(): RateRow[] {
  return [
    row("US", "sqft_living", 2024, 0.005),
    row("US", "bedroom", 2024, 0.03),
    row("US", "time_market_trend", 2024, 0.005),
    row("FL", "pool_inground", 2024, 0.06),
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("APPRAISER GUIDELINES — which year priced this CMA, and does it say so\n")

  const { getStateAdjustmentRates, formatRatesForPrompt, computeCompAdjustments } = await import(
    "../lib/cma/state-adjustment-rates"
  )
  const { runAiCma } = await import("../lib/cma/ai-cma-orchestrator")
  const { findCompsViaPerplexity } = await import("../lib/cma/perplexity-comp-finder")

  // ── 1 · THE VINTAGE IS READ, AND THE READ IS BOUNDED BY THE ASKED-FOR YEAR ──
  console.log("[1 · the resolver reads effective_year and bounds it by the requested year]")
  W = newWorld({ table: live2024Table() })
  let r = await getStateAdjustmentRates("FL", 2026)
  check(
    "1a the read filters on the vintage column, bounded by the requested year",
    W.query.vintageColumn === "effective_year" && W.query.vintageBound === 2026,
    `col=${W.query.vintageColumn} bound=${W.query.vintageBound}`
  )
  check(
    "1b the state's own rows and the US default are both asked for",
    (W.query.states ?? []).includes("FL") && (W.query.states ?? []).includes("US"),
    JSON.stringify(W.query.states)
  )
  check("1c the rates load", r.rates.size === 4, `size=${r.rates.size}`)

  // ── 2 · A CARRIED-FORWARD VINTAGE IS REPORTED, NEVER RE-DATED ──────────────
  console.log("\n[2 · an older vintage is carried forward AS ITSELF and said out loud]")
  check(
    "2a a 2026 request against a 2024-only table reports the carry-forward",
    r.carriedForward === true && r.requestedYear === 2026,
    JSON.stringify({ carried: r.carriedForward, req: r.requestedYear })
  )
  check(
    "2b the rows keep their OWN year — nothing is relabelled 2026",
    [...r.rates.values()].every((x) => x.effectiveYear === 2024) &&
      JSON.stringify(r.vintagesUsed) === JSON.stringify([2024]),
    JSON.stringify(r.vintagesUsed)
  )
  check(
    "2c the note names the vintage in force AND says it was not re-dated",
    /2024/.test(r.vintageNote) && /2026/.test(r.vintageNote) && /carried forward/i.test(r.vintageNote),
    r.vintageNote
  )
  check(
    "2d the note is never empty — an unstated basis is the defect this closes",
    typeof r.vintageNote === "string" && r.vintageNote.length > 40
  )

  // The same table, asked for the year it was actually published for.
  const r2024 = await getStateAdjustmentRates("FL", 2024)
  check(
    "2e the SAME table asked for 2024 is NOT reported as carried forward",
    r2024.carriedForward === false && r2024.rates.size === 4,
    JSON.stringify({ carried: r2024.carriedForward, size: r2024.rates.size })
  )

  // A newer vintage exists → it wins, and nothing is reported as stale.
  W = newWorld({
    table: [
      ...live2024Table(),
      row("US", "sqft_living", 2026, 0.007),
      row("US", "bedroom", 2026, 0.035),
      row("US", "time_market_trend", 2026, 0.006),
      row("FL", "pool_inground", 2026, 0.08),
    ],
  })
  const rNew = await getStateAdjustmentRates("FL", 2026)
  check(
    "2f when the current year IS seeded, the current year wins and nothing reads as stale",
    rNew.carriedForward === false &&
      rNew.rates.get("sqft_living")!.effectiveYear === 2026 &&
      rNew.rates.get("sqft_living")!.mid === 0.007,
    JSON.stringify({ carried: rNew.carriedForward, year: rNew.rates.get("sqft_living")?.effectiveYear })
  )

  // A FUTURE vintage does not price a CMA dated before it.
  W = newWorld({ table: [...live2024Table(), row("US", "sqft_living", 2030, 0.02)] })
  const rFuture = await getStateAdjustmentRates("FL", 2026)
  check(
    "2g guidance published for a LATER year never prices an earlier CMA",
    rFuture.rates.get("sqft_living")!.effectiveYear === 2024 &&
      rFuture.rates.get("sqft_living")!.mid === 0.005,
    JSON.stringify(rFuture.vintagesUsed)
  )

  // The state's own published rate still beats the US default.
  W = newWorld({ table: [row("US", "pool_inground", 2026, 0.04), row("FL", "pool_inground", 2024, 0.06)] })
  const rState = await getStateAdjustmentRates("FL", 2026)
  check(
    "2h a state's own guidance outranks the US default, and its vintage is the one reported",
    rState.rates.get("pool_inground")!.state === "FL" &&
      rState.rates.get("pool_inground")!.effectiveYear === 2024 &&
      rState.carriedForward === true,
    JSON.stringify([...rState.rates.values()].map((x) => [x.state, x.effectiveYear]))
  )

  // ── 3 · A REFUSED READ IS NOT AN EMPTY TABLE, AND NEITHER INVENTS A RATE ───
  console.log("\n[3 · a refused read and an unseeded state are different facts]")
  W = newWorld({ table: live2024Table(), readError: { message: "permission denied" } })
  const rFail = await getStateAdjustmentRates("FL", 2026)
  check(
    "3a a refusal reports readFailed and names the failure — not 'no rates for this state'",
    rFail.readFailed === true && rFail.rates.size === 0 && /permission denied/.test(rFail.vintageNote),
    rFail.vintageNote
  )
  check("3b a refusal claims NO vintage rather than the requested one", rFail.newestVintage === null && rFail.carriedForward === false)

  W = newWorld({ table: [] })
  const rEmpty = await getStateAdjustmentRates("FL", 2026)
  check(
    "3c an unseeded state says so, and does not read as a provider failure",
    rEmpty.readFailed === false && rEmpty.rates.size === 0 && /No state appraiser adjustment rates/i.test(rEmpty.vintageNote),
    rEmpty.vintageNote
  )
  check(
    "3d neither case fabricates a rate to fill the hole",
    rFail.rates.size === 0 && rEmpty.rates.size === 0
  )

  // ── 4 · EVERY ADJUSTMENT LINE CARRIES THE VINTAGE THAT PRICED IT ───────────
  console.log("\n[4 · the vintage rides on the LINE ITEM, not only the header]")
  W = newWorld({ table: live2024Table() })
  const rr = await getStateAdjustmentRates("FL", 2026)
  const adj = computeCompAdjustments({
    subject: { sqftLiving: 2000, bedrooms: 3 },
    comp: { salePrice: 600_000, saleDate: "2026-01-15", sqftLiving: 1800, bedrooms: 2 },
    rates: rr.rates,
    effectiveDate: "2026-06-01",
  })
  check(
    "4a adjustments were computed",
    adj.adjustments.length >= 2 && adj.adjustedPrice !== 600_000,
    `${adj.adjustments.length} lines, adjusted ${adj.adjustedPrice}`
  )
  check(
    "4b every line names the guideline year that produced its dollar figure",
    adj.adjustments.every((a: any) => a.rateEffectiveYear === 2024),
    JSON.stringify(adj.adjustments.map((a: any) => a.rateEffectiveYear))
  )
  check(
    "4c every line still names the rate and the basis it was applied on",
    adj.adjustments.every(
      (a: any) => typeof a.rateUsed === "number" && typeof a.rateBasis === "string" && typeof a.amount === "number"
    )
  )
  check(
    "4d the applied rate is the published TYPICAL figure — no other figure can reach the math",
    adj.adjustments.every((a: any) => a.rateUsed === rr.rates.get(a.type)!.mid)
  )

  // ── 5 · THE PROMPT STATES WHAT WAS APPLIED, IT DOES NOT ASK FOR A CHOICE ───
  console.log("\n[5 · the rate block does not ask the model for a rate it cannot supply]")
  const block = formatRatesForPrompt(rr)
  check("5a the block names the vintage in force", /2024/.test(block) && /carried forward/i.test(block))
  check(
    "5b the block says the figure was APPLIED rather than asking for one to be chosen",
    /ACTUALLY APPLIED/.test(block) && /applied /.test(block) && !/Apply each within/i.test(block)
  )
  check(
    "5c every rate line carries its own vintage, not only the header",
    block.split("\n").filter((l) => l.trim().startsWith("•")).every((l) => /vintage/.test(l)),
    block.split("\n").filter((l) => l.trim().startsWith("•"))[0]
  )
  const emptyBlock = formatRatesForPrompt(rEmpty)
  check(
    "5d with no rates loaded the block refuses instead of inviting an invented one",
    /do not supply, estimate or infer a rate/i.test(emptyBlock),
    emptyBlock.slice(0, 120)
  )

  // ── 6 · THE YEAR REACHING THE RESOLVER IS DERIVED FROM THE CMA'S OWN DATE ──
  console.log("\n[6 · the year comes from the CMA's date — proven by moving the date]")
  const runFor = async (effectiveDate: string, table: RateRow[]) => {
    W = newWorld({
      table,
      sourced: {
        closedComps: [
          comp("10 Sold Ln", 600_000, "2025-11-01", 1800),
          comp("12 Sold Ln", 620_000, "2025-12-01", 2100),
        ],
        pendingComps: [],
        activeComps: [],
        provenance: provenance(),
      },
    })
    return runAiCma({ mode: "standard", brokerageId: "b1", subject: SUBJECT, effectiveDate })
  }

  const cma2026 = await runFor("2026-06-01T00:00:00.000Z", live2024Table())
  const bound2026 = W.query.vintageBound
  const narrativePrompt = W.prompts[W.prompts.length - 1] ?? ""
  const cma2024 = await runFor("2024-03-04T00:00:00.000Z", live2024Table())
  const bound2024 = W.query.vintageBound
  check(
    "6a the SAME code asked for two different years — a literal cannot do that",
    bound2026 === 2026 && bound2024 === 2024,
    `${bound2026} / ${bound2024}`
  )
  check(
    "6b a 2026-dated CMA reports the 2024 rates as carried forward…",
    cma2026.stateGuidelineVintage.carriedForward === true &&
      cma2026.stateGuidelineVintage.requestedYear === 2026,
    JSON.stringify(cma2026.stateGuidelineVintage)
  )
  check(
    "6c …and a 2024-dated CMA reports the SAME rows as current, because for it they are",
    cma2024.stateGuidelineVintage.carriedForward === false &&
      cma2024.stateGuidelineVintage.requestedYear === 2024
  )
  check(
    "6d the vintage is on the result, not only in a log line",
    JSON.stringify(cma2026.stateGuidelineVintage.vintagesUsed) === JSON.stringify([2024]) &&
      cma2026.stateGuidelineVintage.note.length > 40
  )

  // ── 7 · THE FALLBACK IS REPORTED TO THE SELLER AND TO THE WRITER ───────────
  console.log("\n[7 · the carried-forward vintage reaches the report and the narrative]")
  check(
    "7a the seller-facing disclaimers say the rates are NOT the current year's",
    cma2026.disclaimers.some((d: string) => /ARE NOT 2026 RATES/.test(d)),
    cma2026.disclaimers.find((d: string) => /RATES/.test(d))?.slice(0, 100)
  )
  check(
    "7b the disclaimer names the vintage that DID price it",
    cma2026.disclaimers.some((d: string) => /ARE NOT 2026 RATES/.test(d) && /2024/.test(d))
  )
  check(
    "7c the narrative prompt carries the hard rule against describing them as current",
    /THE ADJUSTMENT RATES ARE NOT 2026 RATES/.test(narrativePrompt) &&
      /Do NOT call them current/.test(narrativePrompt),
    narrativePrompt.length ? "(prompt captured, rule missing)" : "(no prompt captured)"
  )
  check(
    "7d the prompt's rate block shows the vintage beside every rate",
    /2024 vintage/.test(narrativePrompt)
  )
  check(
    "7e a CMA whose year IS seeded says so positively rather than saying nothing",
    (
      await runFor("2026-06-01T00:00:00.000Z", [
        ...live2024Table(),
        row("US", "sqft_living", 2026, 0.007),
        row("US", "bedroom", 2026, 0.035),
        row("US", "time_market_trend", 2026, 0.006),
        row("FL", "pool_inground", 2026, 0.08),
      ])
    ).disclaimers.some((d: string) => /using the 2026 state appraiser adjustment guidelines/.test(d))
  )

  // A refused rate read must not silently produce an unadjusted report.
  W = newWorld({
    table: live2024Table(),
    readError: { message: "permission denied" },
    sourced: {
      closedComps: [comp("10 Sold Ln", 600_000, "2025-11-01", 1800)],
      pendingComps: [],
      activeComps: [],
      provenance: provenance({ soldCompCount: 1 }),
    },
  })
  const cmaNoRates = await runAiCma({
    mode: "standard",
    brokerageId: "b1",
    subject: SUBJECT,
    effectiveDate: "2026-06-01T00:00:00.000Z",
  })
  check(
    "7f a CMA whose rate read was REFUSED says no adjustment was applied, rather than showing an unadjusted price as adjusted",
    cmaNoRates.disclaimers.some((d: string) => /NO STATE APPRAISER ADJUSTMENT RATES WERE APPLIED/.test(d)) &&
      cmaNoRates.stateGuidelineVintage.readFailed === true,
    JSON.stringify(cmaNoRates.stateGuidelineVintage)
  )
  check(
    "7g …and no adjustment line was invented to fill the gap",
    cmaNoRates.adjustedComps.every((a: any) => a.adjustments.length === 0)
  )

  // ── 8 · THE AI FINDER CANNOT BE ASKED FOR CLOSED COMPS BY DEFAULT ──────────
  console.log("\n[8 · the AI gap-filler's DEFAULT cannot reach the closed set]")
  W = newWorld()
  ;(globalThis as any).__AGS.generateTextRouted = async (args: any) => {
    W.prompts.push(String(args?.prompt ?? ""))
    // The model answers with closed rows REGARDLESS of what it was asked for.
    // This is the adversarial case: the guard must be the request, not the model.
    return {
      text: JSON.stringify({
        closed_comps: [
          { address: "9 Web St, Tampa, FL 33601", sale_price: 999_000, sale_date: "2026-01-01", citation: "https://example.com/a" },
        ],
        pending_comps: [
          { address: "11 Web St, Tampa, FL 33601", sale_price: 650_000, sale_date: "2026-05-01", citation: "https://example.com/b" },
        ],
        active_comps: [
          { address: "13 Web St, Tampa, FL 33601", sale_price: 640_000, sale_date: "2026-05-10", citation: "https://example.com/c" },
        ],
        citations: ["https://example.com/a"],
      }),
    }
  }

  const defaulted = await findCompsViaPerplexity({
    brokerageId: "b1",
    subjectAddress: "1 Subject St",
    subjectCity: "Tampa",
    subjectState: "FL",
  })
  const defaultPrompt = W.prompts[W.prompts.length - 1] ?? ""
  check(
    "8a with no `want` at all, the prompt asks for ZERO closed comps",
    !/CLOSED comp\(s\)/.test(defaultPrompt) && !/"closed_comps"/.test(defaultPrompt),
    defaultPrompt.match(/Return:[\s\S]{0,200}/)?.[0]?.replace(/\s+/g, " ").slice(0, 120)
  )
  check(
    "8b …and not one closed row survives, though the model returned one anyway",
    defaulted.closedComps.length === 0,
    `${defaulted.closedComps.length} closed rows`
  )
  check(
    "8c the pending and active sides — the ones RentCast cannot hold — ARE served",
    defaulted.pendingComps.length === 1 && defaulted.activeComps.length === 1
  )
  check(
    "8d the ledger records that zero closed comps were requested",
    W.ledger.length === 1 && W.ledger[0].metadata.requested_closed === 0,
    JSON.stringify(W.ledger[0]?.metadata)
  )
  // SENSITIVITY CONTROL — the check above must react to the value, not pass
  // vacuously because the prompt never mentions closed comps at all.
  W.prompts = []
  W.ledger = []
  const explicit = await findCompsViaPerplexity({
    brokerageId: "b1",
    subjectAddress: "1 Subject St",
    want: { closed: 3, pending: 0, active: 0 },
  })
  check(
    "8e a caller that TYPES closed:3 still gets asked for them — the check reacts to the value",
    /3 CLOSED comp\(s\)/.test(W.prompts[W.prompts.length - 1] ?? "") && explicit.closedComps.length === 1
  )

  // ── 9 · CONSTRUCT — what a behaviour test cannot see ───────────────────────
  console.log("\n[9 · construct · the shape of the fix]")
  const ratesSrc = code(F.rates)
  const orchSrc = code(F.orch)
  const finderSrc = code(F.finder)

  check("9a the resolver reads and bounds the vintage column", P.resolverReadsVintage(ratesSrc))
  check("9b the year handed to the resolver is derived, never a literal", P.yearIsDerived(orchSrc))
  check("9c a carried-forward vintage is reported on the report", P.fallbackIsReported(orchSrc))
  check("9d the unreachable rateOverride parameter is gone from the code", P.noRateOverride(ratesSrc))
  check("9e the prompt states what was applied instead of asking for a choice", P.promptAsksForNoChoice(ratesSrc))
  check("9f the AI finder defaults to zero closed comps", P.finderDefaultsClosedToZero(finderSrc))

  // The tombstone is a comment, so it is read from RAW source on purpose.
  const ratesRaw = raw(F.rates)
  check(
    "9g rateOverride is TOMBSTONED, naming its survivor at file:line",
    /TOMBSTONE · apply\(\.\.\., rateOverride/.test(ratesRaw) &&
      /AdjustmentRate\.mid/.test(ratesRaw) &&
      /lib\/cma\/state-adjustment-rates\.ts:\d+/.test(ratesRaw)
  )
  const tombLine = /lib\/cma\/state-adjustment-rates\.ts:(\d+)/.exec(ratesRaw)?.[1]
  const survivorLine = ratesRaw.split("\n").findIndex((l) => /const r = rate\.mid/.test(l)) + 1
  check(
    "9h …and the file:line the tombstone names is where the survivor actually is",
    tombLine !== undefined && Number(tombLine) === survivorLine,
    `tombstone says ${tombLine}, survivor at ${survivorLine}`
  )

  check(
    "9i the persisted adjustment rationale carries the guideline vintage to the appraiser packet",
    /guideline vintage/.test(code(F.action)) && /adj\.rateEffectiveYear/.test(code(F.action))
  )

  // ── 10 · THE MIGRATION — and what it deliberately does NOT do ─────────────
  console.log("\n[10 · m505 · vintages can coexist, and none was fabricated]")
  check("10a the migration exists", existsSync(join(ROOT, F.migration)))
  const mig = existsSync(join(ROOT, F.migration)) ? raw(F.migration) : ""
  check(
    "10b the unique key gains effective_year, so two vintages of one rate can coexist",
    /UNIQUE\s*\(\s*state\s*,\s*adjustment_type\s*,\s*rate_basis\s*,\s*effective_year\s*\)/i.test(mig)
  )
  check(
    "10c the old three-column key is dropped rather than left beside the new one",
    /DROP CONSTRAINT IF EXISTS state_appraiser_adjustment_ra_state_adjustment_type_rate_ba_key/i.test(mig)
  )
  check(
    "10d a rate must NAME its year — NOT NULL, and the 2024 default is dropped",
    /ALTER COLUMN effective_year SET NOT NULL/i.test(mig) &&
      /ALTER COLUMN effective_year DROP DEFAULT/i.test(mig)
  )
  check(
    "10e NO current-year rows are fabricated — the migration inserts nothing into the rate table",
    !/INSERT\s+INTO/i.test(mig),
    "an invented vintage is worse than a stale one"
  )

  // ── 11 · NEGATIVE CONTROLS ────────────────────────────────────────────────
  console.log("\n[11 · negative controls · each defect re-introduced into a COPY]")
  const controlled = (
    label: string,
    src: string,
    find: string,
    replace: string,
    predicate: (s: string) => boolean
  ) => {
    if (!predicate(src)) {
      check(`NEGATIVE CONTROL ${label} — predicate is not green on the real source`, false)
      return
    }
    const patched = src.replace(find, replace)
    if (patched === src) {
      check(`NEGATIVE CONTROL ${label} — patch APPLIED (a find-string that stops matching proves nothing)`, false)
      return
    }
    check(`NEGATIVE CONTROL ${label} — went RED with the defect present`, !predicate(patched))
  }

  // F1a — the resolver stops reading the vintage.
  controlled(
    "the resolver ignoring effective_year (the original defect)",
    ratesSrc,
    `.lte("effective_year", effectiveYear)`,
    ``,
    P.resolverReadsVintage
  )
  // F1b — the year becomes a hard-coded literal, which is what "2024 forever" was.
  controlled(
    "the year hard-coded instead of derived from the CMA's date",
    orchSrc,
    `getStateAdjustmentRates(input.subject.state, effectiveYear)`,
    `getStateAdjustmentRates(input.subject.state, 2024)`,
    P.yearIsDerived
  )
  // F1c — the fallback goes silent on the SELLER-FACING disclaimer.
  controlled(
    "a carried-forward vintage dropped from the seller-facing disclaimers",
    orchSrc,
    `THE ADJUSTMENT RATES IN THIS REPORT ARE NOT \${rateVintage.requestedYear} RATES.`,
    `The adjustment rates in this report are current.`,
    P.fallbackIsReported
  )
  // F1c — …and on the narrative writer's hard rule, which is the other place a
  // stale vintage could be described as this year's.
  controlled(
    "a carried-forward vintage dropped from the narrative writer's hard rule",
    orchSrc,
    `THE ADJUSTMENT RATES ARE NOT \${rateVintage.requestedYear} RATES.`,
    `The adjustment rates are current.`,
    P.fallbackIsReported
  )
  // F2 — the unreachable parameter comes back.
  controlled(
    "rateOverride re-introduced as an unreachable parameter",
    ratesSrc,
    `    const r = rate.mid`,
    `    const r = (undefined as unknown as { rateOverride?: number }).rateOverride ?? rate.mid`,
    P.noRateOverride
  )
  // F3 — the prompt goes back to asking for a choice it will discard.
  controlled(
    "the prompt asking the model to select a rate from the band",
    ratesSrc,
    `\`State: \${state.toUpperCase()} — Sales-Comparison Adjustment Rates ACTUALLY APPLIED\`,`,
    `\`State: \${state.toUpperCase()} — Adjustment Starting Points\`,\n    \`(Apply each within the low-high range based on comp similarity.)\`,`,
    P.promptAsksForNoChoice
  )
  // F4 — the finder defaults to asking an AI web search for recorded sales.
  controlled(
    "the AI finder defaulting to 3 closed comps",
    finderSrc,
    `closed: Math.max(0, input.want?.closed ?? 0)`,
    `closed: Math.max(0, input.want?.closed ?? 3)`,
    P.finderDefaultsClosedToZero
  )

  // ── RESULT ────────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ APPRAISER_GUIDELINES_FAIL")
    process.exit(1)
  }
  console.log(
    " ✅ The rate vintage is read from the CMA's own year, an older vintage is carried forward wearing"
  )
  console.log(
    "    its own year and said out loud on the report, no model can choose a rate, and the AI finder"
  )
  console.log("    cannot be asked for a recorded sale by default.")
  console.log(" APPRAISER_GUIDELINES_PASS")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
