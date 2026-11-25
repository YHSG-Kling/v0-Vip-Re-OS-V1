#!/usr/bin/env tsx
/**
 * scripts/wave156-h-calculators-guard.ts — WAVE 156, LANE 156H: CALCULATORS AS PUBLISHED ARTIFACTS / LEAD MAGNETS.
 * Owner: "the calculators would be a great lead magnet or added asset to the website." In memory, no DB, no network, no model.
 *
 *   §A THE ONE ENGINE, DRIVEN (lib/calculators/engine.ts): every calculator computes from a fixture and is byte-reproducible;
 *      EXTREMES — zero computes (a 0% rate amortizes linearly, exact), the supported maximum computes finite, a negative value is
 *      refused for EVERY numeric field of EVERY calculator (derived from the specs, not listed), a non-number and an over-range
 *      value are refused; ASSUMPTIONS + PERIOD — every result names its period, lists a basis for every entered value, says
 *      "not included" for a blank optional cost, marks an estimate, and carries its disclaimers (not-preapproval on the buyer
 *      calculators, legal/tax on the 1031 timeline, Equal Housing on every public result).
 *   §B NO GUESSED PERCENTAGE: DRIVEN — removing ANY required rate of ANY calculator refuses with "Enter a value" (derived), and a
 *      transfer tax in a jurisdiction with no cited statute refuses; a cited statute is applied with its URL and read date.
 *      SOURCE RULE (comment-stripped, strings blanked) — the engine and the artifact module carry no rate literal (every numeric
 *      literal is a bound, a unit or a count from an allowed set), with a POSITIVE CONTROL; every cited row has an https URL, a
 *      read date, a citation and caveats; the signed-in seller net sheet (app/actions/calculators.ts calculateSellerNet) multiplies
 *      no literal rate and no longer asks a model for appreciation (RED AT BASE: 0.007 / 0.015 / 0.02 / 0.001 and generateAIJSON).
 *   §C THE ARTIFACT, DRIVEN on the in-memory client with the REAL kernel (lib/kernel/lead-magnets.ts createLeadMagnet /
 *      publishLeadMagnet / captureFormSubmission / trackMagnetEvent, lib/kernel/manager-signals.ts publishManagerSignal,
 *      lib/kernel/action-ledger.ts withActionLedger) — only the QR minter (server-only) is a counted fake on the same client:
 *        · authoring: a draft calculator row (magnet_type calculator, settings.calculator, the tenant brand stored); invalid
 *          configurations refused (unknown kind / jurisdiction without a source / hiding a required field / a bad colour);
 *        · publication + QR: the existing publish door activates it and the ONE minter's label lead_magnet:<id> points at
 *          /lm/<slug> — the route that renders the calculator (source rule), also served inside the tenant website;
 *        · ANONYMOUS USE CREATES ZERO RECORDS: open + three computations → 0 contacts, 0 submissions, 0 capture calls, events only;
 *        · AN OPT-IN CREATES EXACTLY ONE ROUTED RECORD: 1 capture call, 1 contact (tenant A, the magnet's agent), 1 submission
 *          carrying the RECOMPUTED result, 1 handoff to the side's manager with the next legitimate step, 1 ledger receipt;
 *        · THE EVENT CHAIN IS ATTRIBUTABLE: qr_scan → calculator_open → calculation_completed → calculator_opt_in, every row on
 *          the form, stamped to the FORM's tenant, the opt-in naming the contact; the funnel reader counts them;
 *        · NO CROSS-TENANT DATA: tenant B's funnel read of A's calculator is refused; a draft / a non-calculator magnet refuses;
 *          a hidden field cannot be smuggled back in; the brand is the form's own tenant;
 *        · TENANT VOICE AT FIRST RENDER: the brand resolver (author first, then the tenant record, never a platform name) and the
 *          page computing it server-side before the component renders (source rule);
 *        · INTERNAL COMMISSION NEVER PUBLIC: the public engine refuses agreed terms; a public result never carries the basis
 *          "brokerage_agreement"; the internal net sheet runs for an agent seat with the brokerage's terms and refuses a vendor,
 *          a contact and a signed-out caller WITHOUT reading the terms (counted loader).
 *   §D THE DOORS (comment-stripped source): every export of app/actions/calculator-artifacts.ts is async; the authoring doors
 *      resolve the tenant from the session before the service client; the public doors take no tenant from the caller and never
 *      reach the internal net sheet; the page renders one component for web, mobile width and QR.
 *
 * RED AT BASE: CALC_GUARD_ROOT=<the pre-wave tree> loads that tree's modules (the "@/" alias is resolved under the root).
 * BLIND SPOTS (published): the in-memory client has no row security, CHECKs or triggers (m898's ready-deliverable trigger is not
 * run; a calculator magnet promises no asset, so it does not apply); the QR minter and the scan door are a fake on the same
 * client; the browser component is source-ruled, not rendered (no DOM here); the legacy public calculators calculateAffordability
 * / calculateRentVsBuy / estimateMovingCosts and lib/buyer-offers/affordability.ts AFFORDABILITY_DEFAULTS still carry labelled
 * default rates — they are COUNTED and printed in §B (a finding for the integrator), not asserted, because this lane did not move
 * their callers.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.CALC_GUARD_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const code = (f: string) => blankStrings(stripComments(raw(f)))

// ── module loading under ROOT ("@/" alias + server-only / next stubs) ───────────────────────────────────────────────────────
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (c: string) => `data:text/javascript,${encodeURIComponent(c)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    return aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
  },
})
async function load(p: string): Promise<any> {
  try { return await import(pathToFileURL(join(ROOT, p)).href) } catch (e) { console.log(`  (cannot load ${p}: ${(e as Error)?.message?.split("\n")[0]})`); return {} }
}
const quiet = async (fn: () => Promise<any>): Promise<any> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}

// ── fixtures: one valid input set per calculator (values, not rates the engine supplies) ──────────────────────────────────────
const FIXTURES: Record<string, Record<string, unknown>> = {
  seller_net_sheet: { salePrice: 500000, mortgagePayoff: 200000, listingCommissionPct: 2.5, titleEscrowFees: 3200, includeTransferTax: "no" },
  buyer_payment: { price: 400000, downPayment: 80000, ratePct: 6, termYears: 30, annualPropertyTax: 4800, annualInsurance: 1800 },
  affordability_range: { grossMonthlyIncome: 10000, monthlyDebts: 500, downPayment: 50000, ratePct: 6, termYears: 30, annualPropertyTax: 4000, annualInsurance: 1500, housingRatioPct: 28, totalDebtRatioPct: 36 },
  buy_vs_rent: { monthlyRent: 2000, rentIncreasePct: 3, homePrice: 400000, downPayment: 80000, ratePct: 6, termYears: 30, annualPropertyTax: 4000, annualInsurance: 1500, annualMaintenance: 3000, buyingClosingCosts: 10000, appreciationPct: 3, sellingCostPct: 6, years: 7 },
  refinance_break_even: { currentBalance: 300000, currentRatePct: 7, remainingMonths: 330, newRatePct: 6, newTermMonths: 360, refinanceCosts: 6000 },
  equity_proceeds: { estimatedValue: 450000, mortgageBalance: 250000, sellingCostAmount: 30000 },
  closing_cost_estimate: { side: "buyer", price: 400000, lenderFees: 2500, titleInsurance: 1800, includeTransferTax: "no" },
  exchange_1031_timeline: { relinquishedTransferDate: "2026-12-15" },
  investor_cash_flow: { purchasePrice: 300000, downPayment: 75000, ratePct: 7, termYears: 30, monthlyRent: 2600, vacancyPct: 5, annualPropertyTax: 3600, annualInsurance: 1400, maintenancePctOfRent: 8 },
  marketing_roi: { spend: 5000, leads: 100, closings: 2, revenuePerClosing: 9000 },
  relocation_budget: { movers: 4200, travel: 600 },
  carry_cost: { annualPropertyTax: 6000, annualInsurance: 2400, hoaMonthly: 150, months: 4 },
}

async function main() {
  console.log(`wave156-h-calculators-guard — root ${ROOT === WT ? "(worktree)" : ROOT}`)
  const E = await load("lib/calculators/engine.ts")
  const R = await load("lib/calculators/rate-sources.ts")
  const A = await load("lib/calculators/artifact.ts")
  const run = typeof E.runCalculator === "function" ? E.runCalculator as (k: string, i: Record<string, unknown>, c: any) => any : null
  const KINDS: string[] = Array.isArray(E.CALCULATOR_KINDS) ? [...E.CALCULATOR_KINDS] : []
  const SPECS: Record<string, { fields: Array<{ key: string; kind: string; required: unknown; group?: string }>; side: string }> = E.CALCULATOR_SPECS ?? {}
  const pub = { audience: "public" }

  // ═══ §A ═══
  section("§A · one engine — reproducible, extremes refused or computed, assumptions and period explicit")
  check("the engine exists and exports the calculator family (one spec per kind)", !!run && KINDS.length > 0 && KINDS.every((k) => !!SPECS[k]), KINDS)
  const priority = ["seller_net_sheet", "buyer_payment", "affordability_range", "buy_vs_rent", "refinance_break_even", "equity_proceeds", "closing_cost_estimate", "exchange_1031_timeline", "investor_cash_flow", "marketing_roi", "relocation_budget", "carry_cost"]
  check("every priority calculator of the directive is in the family", priority.every((k) => KINDS.includes(k)), priority.filter((k) => !KINDS.includes(k)))
  check("every calculator in the family has a proof fixture (none silently skipped)", KINDS.length > 0 && KINDS.every((k) => !!FIXTURES[k]), KINDS.filter((k) => !FIXTURES[k]))
  const results: Record<string, any> = {}
  for (const k of KINDS) results[k] = run ? run(k, FIXTURES[k] ?? {}, pub) : null
  check("POSITIVE: every calculator computes its fixture", KINDS.length > 0 && KINDS.every((k) => results[k]?.ok === true), KINDS.filter((k) => results[k]?.ok !== true).map((k) => [k, results[k]?.missing, results[k]?.refused]))
  check("REPRODUCIBLE: the same inputs give a byte-identical result for every calculator", !!run && KINDS.every((k) => JSON.stringify(run(k, FIXTURES[k] ?? {}, pub)) === JSON.stringify(results[k])))
  const z = run?.("buyer_payment", { price: 120000, downPayment: 0, ratePct: 0, termYears: 10, annualPropertyTax: 0, annualInsurance: 0 }, pub)
  check("ZERO: a 0% rate amortizes linearly and exactly ($120,000 over 120 months = $1,000.00; zero tax, zero insurance)", z?.ok === true && z.lines?.find((l: any) => l.key === "principalInterest")?.amount === 1000 && z.outputs?.monthlyTotal === 1000, z)
  const z0 = run?.("seller_net_sheet", { salePrice: 0, mortgagePayoff: 0, listingCommissionPct: 0, titleEscrowFees: 0, includeTransferTax: "no" }, pub)
  check("ZERO: a $0 sale nets exactly $0 (not NaN, not refused)", z0?.ok === true && z0.outputs?.estimatedNet === 0, z0)
  const M = E.LIMITS?.money ?? 0
  const big = run?.("buyer_payment", { price: M, downPayment: 0, ratePct: 100, termYears: 50, annualPropertyTax: M, annualInsurance: M }, pub)
  const finite = (r: any) => !!r?.ok && Object.values(r.outputs ?? {}).every((v) => typeof v !== "number" || Number.isFinite(v)) && (r.lines ?? []).every((l: any) => Number.isFinite(l.amount))
  check("VERY LARGE: the supported maximum (price, tax, insurance at the money limit, 100% over 50 years) computes, every output finite", M > 0 && finite(big), big)
  const bigAll = KINDS.filter((k) => { const f = { ...FIXTURES[k] }; for (const s of SPECS[k].fields) if (s.kind === "money" && typeof f[s.key] === "number") f[s.key] = M; const r = run!(k, f, pub); return !(r.ok ? finite(r) : r.refused?.length > 0 || r.missing?.length > 0) })
  check("VERY LARGE, every calculator: money inputs at the limit compute finite or are refused with a reason — never NaN / Infinity", !!run && bigAll.length === 0, bigAll)
  const negMiss: string[] = []
  let negCount = 0
  for (const k of KINDS) for (const f of SPECS[k].fields) {
    if (f.kind === "choice" || f.kind === "date") continue
    negCount++
    const r = run!(k, { ...FIXTURES[k], [f.key]: -1 }, pub)
    if (r.ok || !r.refused?.some((x: any) => x.key === f.key && /negative/.test(x.reason))) negMiss.push(`${k}.${f.key}`)
  }
  check(`NEGATIVE REFUSED: every numeric field of every calculator (${negCount}, derived from the specs) refuses -1 by name`, !!run && negCount > 0 && negMiss.length === 0, negMiss)
  const nan = run?.("buyer_payment", { ...FIXTURES.buyer_payment, price: "four hundred" }, pub)
  const over = run?.("buyer_payment", { ...FIXTURES.buyer_payment, ratePct: 101 }, pub)
  check("a non-number and an over-range rate are refused, not coerced", nan?.ok === false && nan.refused.some((x: any) => x.key === "price") && over?.ok === false && over.refused.some((x: any) => x.key === "ratePct"), { nan, over })
  const badDate = run?.("exchange_1031_timeline", { relinquishedTransferDate: "2026-02-30" }, pub)
  check("an impossible calendar date is refused", badDate?.ok === false && badDate.refused.some((x: any) => x.key === "relinquishedTransferDate"), badDate)
  const noPeriod = KINDS.filter((k) => !(results[k]?.ok && typeof results[k].period === "string" && results[k].period.length > 3))
  check("PERIOD EXPLICIT: every result names the time period it covers", !!run && noPeriod.length === 0, noPeriod)
  const noBasis = KINDS.filter((k) => { const r = results[k]; if (!r?.ok) return true; return Object.keys(FIXTURES[k]).some((key) => !r.assumptions.some((a: any) => a.key === key && ["you_entered", "you_entered_estimate"].includes(a.basis))) })
  check("ASSUMPTIONS EXPLICIT: every entered value appears under Assumptions with its basis", !!run && noBasis.length === 0, noBasis)
  const ni = results.seller_net_sheet?.assumptions?.find((a: any) => a.key === "sellerConcessions")
  check("a blank optional cost is listed as 'not included' — never silently zero", ni?.basis === "not_included" && ni.display === "not included", ni)
  const est = run?.("buyer_payment", FIXTURES.buyer_payment, { audience: "public", estimateKeys: ["annualInsurance"] })
  check("an input the person marks as an estimate says so", est?.assumptions?.find((a: any) => a.key === "annualInsurance")?.basis === "you_entered_estimate")
  const D = E.DISCLAIMERS ?? {}
  check("DISCLAIMERS: every result carries the general one; the buyer-side ones say NOT a preapproval; the 1031 timeline is educational, not legal/tax; every public result carries Equal Housing",
    KINDS.length > 0 && KINDS.every((k) => results[k]?.disclaimers?.includes(D.general) && results[k]?.disclaimers?.includes(D.equalHousing))
    && ["buyer_payment", "affordability_range", "buy_vs_rent", "refinance_break_even"].every((k) => results[k]?.disclaimers?.includes(D.notPreapproval))
    && results.exchange_1031_timeline?.disclaimers?.includes(D.legalTax) && /not a lender preapproval/i.test(String(D.notPreapproval)))
  const t1031 = results.exchange_1031_timeline
  check("1031 timeline: 45 and 180 calendar days from the transfer (2026-12-15 → 2027-01-29 / 2027-06-13), cited to 26 U.S.C. § 1031(a)(3)",
    t1031?.outputs?.identificationDeadline === "2027-01-29" && t1031?.outputs?.receiptDeadline === "2027-06-13" && t1031?.assumptions?.some((a: any) => a.basis === "cited_source" && /1031\(a\)\(3\)/.test(a.source?.citation ?? "")), t1031?.outputs)
  const earlier = run?.("exchange_1031_timeline", { relinquishedTransferDate: "2026-12-15", returnDueDate: "2027-04-15" }, pub)
  check("1031 timeline: a return due date before day 180 becomes the receipt deadline", earlier?.outputs?.receiptDeadline === "2027-04-15", earlier?.outputs)
  const aff = results.affordability_range
  check("affordability is a RANGE from the person's own limits (low ≤ high) and is labelled not-a-preapproval", aff?.ok && aff.outputs.rangeLow <= aff.outputs.rangeHigh && aff.outputs.rangeLow > 0)

  // ═══ §B ═══
  section("§B · no guessed percentage — driven refusals, cited sources, and the source rule (positive control)")
  const rateMiss: string[] = []
  let rateCount = 0
  for (const k of KINDS) for (const f of SPECS[k].fields) {
    if (f.kind !== "percent" || f.required !== true) continue
    rateCount++
    const inp = { ...FIXTURES[k] }; delete inp[f.key]
    const r = run!(k, inp, pub)
    if (r.ok || !r.missing?.some((m: any) => m.key === f.key && /^Enter a value/.test(m.message))) rateMiss.push(`${k}.${f.key}`)
  }
  check(`A MISSING RATE REFUSES: every required rate of every calculator (${rateCount}, derived) answers "Enter a value", never a default`, !!run && rateCount >= 8 && rateMiss.length === 0, rateMiss)
  const groupMiss: string[] = []
  for (const k of KINDS) {
    const groups = new Set(SPECS[k].fields.filter((f) => f.required === "group").map((f) => f.group!))
    for (const g of groups) {
      const inp = { ...FIXTURES[k] }
      for (const f of SPECS[k].fields) if (f.group === g) delete inp[f.key]
      const r = run!(k, inp, pub)
      if (r.ok || !r.missing?.some((m: any) => m.key === g)) groupMiss.push(`${k}.${g}`)
    }
  }
  check("an either/or input (property tax $ or rate, commission % or $, selling cost % or $ …) refuses when neither is entered", !!run && groupMiss.length === 0, groupMiss)
  const fl = run?.("seller_net_sheet", { ...FIXTURES.seller_net_sheet, includeTransferTax: "yes" }, { audience: "public", jurisdiction: "US-FL" })
  const flA = fl?.assumptions?.find((a: any) => a.key === "transferTax")
  check("a CITED statute is applied by jurisdiction: Florida documentary stamps on $500,000 = 5,000 × $0.70 = $3,500, with its URL and read date",
    fl?.ok && fl.lines.find((l: any) => l.key === "transferTax")?.amount === 3500 && flA?.basis === "cited_source" && /^https:\/\//.test(flA?.source?.url ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(flA?.source?.retrievedOn ?? ""), flA)
  const ca = run?.("seller_net_sheet", { ...FIXTURES.seller_net_sheet, salePrice: 500001, includeTransferTax: "yes" }, { audience: "public", jurisdiction: "US-CA" })
  check("the statute's 'or fractional part' is honoured (California: $500,001 → 1,001 units × $0.55 = $550.55)", ca?.lines?.find((l: any) => l.key === "transferTax")?.amount === 550.55, ca?.lines)
  const tx = run?.("seller_net_sheet", { ...FIXTURES.seller_net_sheet, includeTransferTax: "yes" }, { audience: "public", jurisdiction: "US-TX" })
  const none = run?.("seller_net_sheet", { ...FIXTURES.seller_net_sheet, includeTransferTax: "yes" }, pub)
  check("NO SOURCE → 'Enter a value': a jurisdiction with no cited statute (Texas) and no jurisdiction at all both refuse — no national fallback", tx?.ok === false && /Enter a value/.test(tx.missing?.[0]?.message ?? "") && none?.ok === false, { tx, none })
  const rows: any[] = Array.isArray(R.CITED_RATE_SOURCES) ? R.CITED_RATE_SOURCES : []
  check("every cited source row has an https primary-source URL, a citation, a read date and its caveats", rows.length > 0 && rows.every((s) => /^https:\/\//.test(s.url) && s.citation?.length > 10 && /^\d{4}-\d{2}-\d{2}$/.test(s.retrievedOn) && s.caveats?.length > 10), rows.map((s) => s.key))
  check("CONTROL: the source-row check fails a row with no URL", ![{ url: "", citation: "x".repeat(20), retrievedOn: "2026-11-25", caveats: "y".repeat(20) }].every((s) => /^https:\/\//.test(s.url)))
  /** PURE — the numeric literals of comment-stripped, string-blanked code. */
  const literals = (src: string): number[] => [...src.matchAll(/(?<![\w.$])(\d[\d_]*(?:\.\d+)?)(?![\w])/g)].map((m) => Number(m[1].replace(/_/g, "")))
  const ENGINE_ALLOWED = new Set([0, 1, 2, 3, 4, 5, 10, 12, 100, 50, 600, 86_400_000, 100_000_000_000, 1_000_000_000])
  const engLits = literals(code("lib/calculators/engine.ts"))
  const engBad = [...new Set(engLits.filter((n) => !ENGINE_ALLOWED.has(n)))]
  check("SOURCE RULE: the engine carries no rate literal — every numeric literal is a bound, a unit or a count (allowed set)", engLits.length > 0 && engBad.length === 0, engBad)
  check("CONTROL: the literal finder catches a planted rate (homeValue * 0.015) and a planted default (|| 0.0125)", literals(blankStrings(stripComments("const a = homeValue * 0.015; const b = x || 0.0125 // 7% in a comment"))).filter((n) => !ENGINE_ALLOWED.has(n)).length === 2)
  const ART_ALLOWED = new Set([0, 1, 6, 10, 12, 36, 40, 60, 80, 100, 120, 140, 200, 4000, 5000, 10_000]) // 6 / 36: hex-colour and uuid lengths; 4000: the inputs cap; 5000: the funnel read cap
  const artBad = [...new Set(literals(code("lib/calculators/artifact.ts")).filter((n) => !ART_ALLOWED.has(n)))]
  check("SOURCE RULE: the artifact module carries no rate literal either", raw("lib/calculators/artifact.ts").length > 0 && artBad.length === 0, artBad)
  const calc = stripComments(raw("app/actions/calculators.ts"))
  const sellerNet = (() => { const i = calc.indexOf("export async function calculateSellerNet("); const j = calc.indexOf("\nexport ", i + 10); return i < 0 ? "" : calc.slice(i, j < 0 ? undefined : j) })()
  const snRates = [...new Set(literals(blankStrings(sellerNet)).filter((n) => n > 0 && n < 1))]
  check("the signed-in seller net sheet multiplies no literal rate (base: 0.007 title, 0.015 escrow, 0.02 repairs) and no longer asks a model for appreciation", sellerNet.length > 0 && snRates.length === 0 && !/generateAIJSON\(/.test(sellerNet) && /computeInternalSellerNet\(/.test(sellerNet), { snRates, model: /generateAIJSON\(/.test(sellerNet) })
  check("the invented transfer-tax fallback (`|| homeValue * 0.001` — Texas's 0 fell through to it) is gone from the file", !/\|\|\s*homeValue\s*\*\s*0\.001/.test(calc) && calc.length > 0)
  // Published finding — counted, not asserted (blind spot in the header).
  const legacy = ["calculateAffordability", "calculateRentVsBuy", "estimateMovingCosts"].map((fn) => { const i = calc.indexOf(`export async function ${fn}(`); const j = calc.indexOf("\nexport ", i + 10); const body = i < 0 ? "" : blankStrings(calc.slice(i, j < 0 ? undefined : j)); return `${fn}: ${literals(body).filter((n) => n > 0 && n < 1).length} fractional literal(s)` })
  const affDefaults = /AFFORDABILITY_DEFAULTS\s*=/.test(stripComments(raw("lib/buyer-offers/affordability.ts")))
  console.log(`  · FINDING (not asserted — this lane did not move their callers): ${legacy.join("; ")}; lib/buyer-offers/affordability.ts AFFORDABILITY_DEFAULTS ${affDefaults ? "present" : "absent"}`)

  // ═══ §C ═══
  section("§C · the artifact on the real kernel — anonymous use, one opt-in, the event chain, tenancy, brand, commission")
  const K = await load("lib/kernel/lead-magnets.ts")
  const MS = await load("lib/kernel/manager-signals.ts")
  const AL = await load("lib/kernel/action-ledger.ts")
  const TA = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa", TB = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb"
  const AG_A = "aaaaaaaa-1111-4aaa-8aaa-00000000a001", US_A = "aaaaaaaa-1111-4aaa-8aaa-00000000a002"
  const AG_B = "bbbbbbbb-2222-4bbb-8bbb-00000000b001", US_B = "bbbbbbbb-2222-4bbb-8bbb-00000000b002"
  const ORIGIN = "https://proof.calculators.test"
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN
  const c: MemClient = memSupabase({
    brokerages: [{ id: TA, name: "Alpha Realty", slug: "alpha", logo_url: "https://cdn.alpha.test/logo.png", primary_color: "#123456", license_number: "A-1", license_state: "FL" }, { id: TB, name: "Beta Homes", slug: "beta", logo_url: null, primary_color: "#654321", license_number: "B-1", license_state: "TX" }],
    users: [{ id: US_A, brokerage_id: TA, first_name: "Ann", last_name: "Agent", email: "ann@alpha.test", user_type: "agent" }, { id: US_B, brokerage_id: TB, first_name: "Bob", last_name: "Broker", email: "bob@beta.test", user_type: "broker" }],
    agents: [{ id: AG_A, user_id: US_A, brokerage_id: TA, is_active: true }, { id: AG_B, user_id: US_B, brokerage_id: TB, is_active: true }],
    lead_capture_forms: [], form_submissions: [], contacts: [], contact_consent_events: [], marketing_campaigns: [], marketing_campaign_touchpoints: [],
    lifecycle_events: [], agent_action_ledger: [], qr_codes: [], qr_scan_events: [], manager_signals: [], notifications: [], campaign_sequences: [], sequence_enrollments: [],
    lead_magnet_deliverables: [], lead_magnet_funnel_items: [], remotion_composition_renders: [], activities: [], farm_territories: [], generated_documents: [],
  }, { uuidIds: true, stampCreatedAt: true })
  ;(c as any).rpc = async () => ({ data: null, error: null })
  const T = (t: string) => (c.tables[t] ?? []) as any[]
  let captureCalls = 0, qrMints = 0
  const deps = {
    client: c,
    trackMagnetEvent: K.trackMagnetEvent ? (i: any, o: any) => K.trackMagnetEvent(i, o) : undefined,
    captureFormSubmission: K.captureFormSubmission ? async (i: any, o: any) => { captureCalls++; return K.captureFormSubmission(i, o) } : undefined,
    publishManagerSignal: MS.publishManagerSignal,
    createLeadMagnet: K.createLeadMagnet,
    withActionLedger: AL.withActionLedger,
  }
  const mintTrackedQr = async (args: any, svc: any) => {
    qrMints++
    const slug = `qr-${qrMints}`
    const { data } = await svc.from("qr_codes").insert({ brokerage_id: args.brokerageId, agent_id: args.agentId, label: args.label, slug, target_url: args.targetUrl, destination_type: args.destinationType, purpose: args.purpose, is_active: true, scan_count: 0 }).select("id").single()
    return { qrCodeId: data.id, slug, scanUrl: `${ORIGIN}/api/qr/scan?slug=${slug}`, targetUrl: args.targetUrl, qrCodeDataUrl: "data:image/png;base64,AA==" }
  }
  const N = typeof A.normalizeCalculatorArtifactConfig === "function" ? A.normalizeCalculatorArtifactConfig : () => ({ ok: true })
  check("authoring refuses an unknown calculator, a jurisdiction with no verified source, hiding a REQUIRED field and a bad colour",
    !N({ kind: "nope" }).ok && !N({ kind: "seller_net_sheet", jurisdiction: "US-TX" }).ok && !N({ kind: "seller_net_sheet", hiddenFields: ["titleEscrowFees"] }).ok && !N({ kind: "seller_net_sheet", brand: { primaryColor: "red" } }).ok && N({ kind: "seller_net_sheet", jurisdiction: "US-FL", hiddenFields: ["otherLiens"] }).ok === true)

  const created = A.createCalculatorArtifact ? await quiet(() => A.createCalculatorArtifact({ brokerageId: TA, agentId: AG_A, createdBy: US_A, title: "What will I net when I sell?", config: { kind: "seller_net_sheet", jurisdiction: "US-FL", hiddenFields: ["otherLiens"], brand: { tagline: "Know your number before you list" }, qr: true } }, deps)) : { success: false }
  const row = T("lead_capture_forms").find((r) => r.id === created.magnetId)
  check("AUTHORING: a DRAFT calculator lead magnet (magnet_type calculator, inactive) carrying settings.calculator, the tagline as the page subhead, the seller persona",
    created.success && row?.magnet_type === "calculator" && row?.is_active === false && row?.settings?.calculator?.kind === "seller_net_sheet" && row?.landing_content?.subhead === "Know your number before you list" && row?.settings?.default_contact_type === "seller", { created, row: row && { ...row, fields: undefined } })
  const draftCompute = A.computeCalculatorArtifact ? await quiet(() => A.computeCalculatorArtifact({ formId: created.magnetId, inputs: FIXTURES.seller_net_sheet }, deps)) : { success: true }
  check("a DRAFT calculator is not served publicly (compute refused, nothing recorded)", draftCompute.success === false && T("lifecycle_events").filter((e) => /calculat/.test(e.event_type)).length === 0, draftCompute)
  const published = K.publishLeadMagnet && created.magnetId ? await quiet(() => K.publishLeadMagnet({ magnetId: created.magnetId, brokerageId: TA, channels: ["landing_page", "qr_code"], actorUserId: US_A, baseUrl: ORIGIN }, { client: c, mintTrackedQr })) : { success: false }
  const qr = T("qr_codes").find((q) => q.label === `lead_magnet:${created.magnetId}`)
  check("PUBLICATION + QR through the EXISTING door: the row goes live, one code minted by the one minter (label lead_magnet:<id>) pointing at /lm/<slug>",
    published.success === true && T("lead_capture_forms").find((r) => r.id === created.magnetId)?.is_active === true && qrMints === 1 && qr?.target_url === `${ORIGIN}/lm/${row?.slug}`, { published, qr })

  const before = { contacts: T("contacts").length, subs: T("form_submissions").length, sigs: T("manager_signals").length }
  if (K.trackMagnetEvent && created.magnetId) await quiet(() => K.trackMagnetEvent({ magnetId: created.magnetId, eventType: "qr_scan", userAgent: "Mozilla/5.0 (iPhone)" }, { client: c }))
  const att = { qr: qr?.slug ?? null }
  const opened = A.recordCalculatorOpen ? await quiet(() => A.recordCalculatorOpen({ formId: created.magnetId, attribution: att }, deps)) : { success: false }
  const computes: any[] = []
  for (const i of [0, 1, 2]) computes.push(A.computeCalculatorArtifact ? await quiet(() => A.computeCalculatorArtifact({ formId: created.magnetId, inputs: { ...FIXTURES.seller_net_sheet, salePrice: 500000 + i * 1000, includeTransferTax: "yes" }, attribution: att }, deps)) : null)
  check("ANONYMOUS USE CREATES ZERO RECORDS: a scan, an open and three calculations → 0 contacts, 0 submissions, 0 capture calls, 0 handoffs",
    opened.success && computes.every((x) => x?.success && x.outcome.ok) && T("contacts").length === before.contacts && T("form_submissions").length === before.subs && captureCalls === 0 && T("manager_signals").length === before.sigs, { opened, c0: computes[0] })
  const ev = (name: string) => T("lifecycle_events").filter((e) => e.event_type === `lead_magnet_${name}` && e.entity_id === created.magnetId)
  check("…and each step IS recorded as an event on the form: 1 qr_scan, 1 calculator_open, 3 calculation_completed (the scan also lands in qr_scan_events)",
    ev("qr_scan").length === 1 && ev("calculator_open").length === 1 && ev("calculation_completed").length === 3 && T("qr_scan_events").length === 1, T("lifecycle_events").map((e) => e.event_type))
  const viaArtifact = computes[0]?.outcome
  const direct = run?.("seller_net_sheet", { ...FIXTURES.seller_net_sheet, includeTransferTax: "yes" }, { audience: "public", jurisdiction: "US-FL" })
  check("SAME CALCULATOR EVERYWHERE: the page's server door and the engine called directly give the byte-identical result (the browser runs the same module)", !!viaArtifact && JSON.stringify(viaArtifact) === JSON.stringify(direct))
  const smuggled = A.computeCalculatorArtifact ? await quiet(() => A.computeCalculatorArtifact({ formId: created.magnetId, inputs: { ...FIXTURES.seller_net_sheet, otherLiens: 99999 } }, deps)) : null
  check("a field the author HID cannot be smuggled back in by a client (otherLiens hidden → not included)", smuggled?.outcome?.ok && smuggled.outcome.lines.find((l: any) => l.key === "otherLiens")?.amount === 0, smuggled?.outcome?.lines)
  const pubJson = JSON.stringify(computes.map((x) => x?.outcome))
  check("INTERNAL COMMISSION NEVER PUBLIC: no public result carries the basis 'brokerage_agreement'", computes.length === 3 && computes.every((x) => x?.outcome?.ok === true) && !/brokerage_agreement/.test(pubJson))
  const refusedAgreed = run?.("seller_net_sheet", FIXTURES.seller_net_sheet, { audience: "public", agreedCommission: { listingRatePct: 2.75, flatAmount: null, label: "x" } })
  check("…and the engine REFUSES agreed terms on a public estimate outright", refusedAgreed?.ok === false && refusedAgreed.refused.some((r: any) => r.key === "agreedCommission"), refusedAgreed)

  const noContact = A.optInCalculatorResult ? await quiet(() => A.optInCalculatorResult({ formId: created.magnetId, inputs: FIXTURES.seller_net_sheet, intent: "save_results", contact: { first_name: "" } }, deps)) : { success: true }
  check("an opt-in without a name and a way to reach the person is refused before the capture path (0 capture calls)", noContact.success === false && captureCalls === 0, noContact)
  const optIn = A.optInCalculatorResult ? await quiet(() => A.optInCalculatorResult({ formId: created.magnetId, inputs: { ...FIXTURES.seller_net_sheet, includeTransferTax: "yes" }, intent: "save_results", contact: { first_name: "Sam", last_name: "Seller", email: "sam@seller.test" }, consent: undefined, tcpaConsentGiven: true, attribution: att }, deps)) : { success: false }
  const newContacts = T("contacts").slice(before.contacts), newSubs = T("form_submissions").slice(before.subs), newSigs = T("manager_signals").slice(before.sigs).filter((s) => s.signal_type === "lead_magnet_handoff")
  check("AN OPT-IN CREATES EXACTLY ONE ROUTED RECORD: 1 capture call, 1 contact in tenant A assigned to the magnet's agent, 1 submission",
    optIn.success === true && captureCalls === 1 && newContacts.length === 1 && newContacts[0].brokerage_id === TA && newSubs.length === 1 && newSubs[0].brokerage_id === TA, { optIn, contact: newContacts[0] && { brokerage_id: newContacts[0].brokerage_id, agent_id: newContacts[0].agent_id, contact_type: newContacts[0].contact_type }, subs: newSubs.length })
  const sd = newSubs[0]?.submission_data ?? {}
  check("the submission carries the RECOMPUTED result (the server's, not the client's) and the inputs", sd.calculator_kind === "seller_net_sheet" && sd.calculator_result?.outputs?.estimatedNet === direct?.outputs?.estimatedNet && sd.calculator_inputs?.salePrice === 500000, sd)
  check("FOLLOW-ON: one lead_magnet_handoff to the seller side's manager (listing_concierge) whose next step is to EXPLAIN the estimate — not a pitch, not an agent task (the capture path's own consented-intake signal to the ISA is the existing path's, unchanged)",
    newSigs.length === 1 && newSigs[0].to_manager === "listing_concierge" && newSigs[0].from_manager === "campaign_orchestrator" && newSigs[0].payload?.nextStep === "explain_estimate" && newSigs[0].contact_id === optIn.contactId, newSigs)
  const optEv = ev("calculator_opt_in")
  check("THE EVENT CHAIN IS ATTRIBUTABLE: qr_scan → open → completed → opt_in all on this form, all stamped to the form's tenant; the opt-in names the contact and the scanned code",
    optEv.length === 1 && optEv[0].metadata?.contactId === optIn.contactId && optEv[0].metadata?.qr === qr?.slug && ["qr_scan", "calculator_open", "calculation_completed", "calculator_opt_in"].every((e) => ev(e).length > 0 && ev(e).every((r) => r.brokerage_id === TA)), optEv)
  check("LAW 5: the opt-in left one ledger receipt (marketing.calculator.opt_in, executed)", T("agent_action_ledger").filter((l) => l.action === "marketing.calculator.opt_in" && l.status === "executed").length === 1, T("agent_action_ledger").map((l) => [l.action, l.status]))
  const talk = A.optInCalculatorResult ? await quiet(() => A.optInCalculatorResult({ formId: created.magnetId, inputs: FIXTURES.seller_net_sheet, intent: "talk_to_agent", contact: { first_name: "Tia", email: "tia@seller.test" }, tcpaConsentGiven: true }, deps)) : { success: false }
  check("…an explicit request to talk is the one that earns an agent task", talk.success && T("manager_signals").some((s) => s.contact_id === talk.contactId && s.payload?.nextStep === "agent_task") && captureCalls === 2)
  const funnelA = A.getCalculatorFunnel ? await A.getCalculatorFunnel(c, { brokerageId: TA, formId: created.magnetId }) : { success: false }
  check("PERFORMANCE OBSERVABLE: the funnel reads back exactly what happened — scans 1 · opens 1 · calculations 4 (three + the hidden-field probe) · opt-ins 2 · submissions 2",
    funnelA.success && funnelA.funnel.qr_scan === 1 && funnelA.funnel.calculator_open === 1 && funnelA.funnel.calculation_completed === ev("calculation_completed").length && ev("calculation_completed").length === 4 && funnelA.funnel.calculator_opt_in === 2 && funnelA.funnel.submissions === 2, funnelA)
  const funnelB = A.getCalculatorFunnel ? await A.getCalculatorFunnel(c, { brokerageId: TB, formId: created.magnetId }) : { success: true }
  check("NO CROSS-TENANT DATA: tenant B reading tenant A's calculator funnel is refused", funnelB.success === false, funnelB)
  const other = K.createLeadMagnet ? await quiet(() => K.createLeadMagnet({ title: "Plain form", description: "", magnetType: "generic_form", brokerageId: TB, agentId: AG_B, createdBy: US_B }, { client: c })) : { magnetId: null }
  const notCalc = A.computeCalculatorArtifact ? await quiet(() => A.computeCalculatorArtifact({ formId: other.magnetId, inputs: FIXTURES.seller_net_sheet }, deps)) : { success: true }
  check("a magnet that is not a calculator (another tenant's plain form) is not served as one", notCalc.success === false, notCalc)
  const bA = A.resolveCalculatorBrand ? A.resolveCalculatorBrand(N({ kind: "carry_cost" }).config, { name: "Alpha Realty", logo_url: "https://cdn.alpha.test/logo.png", primary_color: "#123456" }) : null
  const bOverride = A.resolveCalculatorBrand ? A.resolveCalculatorBrand(N({ kind: "carry_cost", brand: { displayName: "The Ann Agent Team", primaryColor: "#00AA00" } }).config, { name: "Alpha Realty", primary_color: "#123456" }) : null
  const loaded = A.loadCalculatorBrand ? await A.loadCalculatorBrand(c, TA, N({ kind: "carry_cost" }).config) : null
  check("TENANT VOICE: a blank author brand takes the TENANT's name, colour and logo; the author's own (a team) wins; the page loads the form tenant's record",
    bA?.displayName === "Alpha Realty" && bA?.primaryColor === "#123456" && bA?.logoUrl === "https://cdn.alpha.test/logo.png" && bOverride?.displayName === "The Ann Agent Team" && bOverride?.primaryColor === "#00AA00" && loaded?.displayName === "Alpha Realty", { bA, bOverride, loaded })

  let loads = 0
  const loader = async () => { loads++; return { listingRatePct: 2.75, flatAmount: null, label: "2.75% — the brokerage's default commission structure" } }
  const inp = { inputs: { ...FIXTURES.seller_net_sheet, listingCommissionPct: undefined }, jurisdiction: "US-FL" }
  const agent = A.computeInternalSellerNet ? await A.computeInternalSellerNet(inp, { userId: US_A, brokerageId: TA, userType: "agent" }, { loadAgreedCommission: loader }) : { success: false }
  check("INTERNAL NET SHEET: an agent seat prices the listing commission from the brokerage's agreed terms (basis brokerage_agreement, 2.75% of $500,000 = $13,750)",
    agent.success && agent.outcome.ok && agent.outcome.lines.find((l: any) => l.key === "listingCommission")?.amount === 13750 && agent.outcome.assumptions.some((a: any) => a.basis === "brokerage_agreement") && loads === 1, agent)
  const seats = [{ userType: "vendor" }, { userType: "contact" }, { userType: "lender" }, { userType: "isa" }, { userType: "" }]
  const refusedSeats = A.computeInternalSellerNet ? await Promise.all(seats.map((s) => A.computeInternalSellerNet(inp, { userId: US_A, brokerageId: TA, ...s }, { loadAgreedCommission: loader }))) : []
  const anon = A.computeInternalSellerNet ? await A.computeInternalSellerNet(inp, { userId: null, brokerageId: null, userType: null }, { loadAgreedCommission: loader }) : { success: true }
  check("…a vendor, a contact, a lender-typed seat, an ISA, a seat with no type and a signed-out caller are refused WITHOUT the terms being read (loader count unchanged)",
    refusedSeats.length === seats.length && refusedSeats.every((r: any) => r.success === false) && anon.success === false && loads === 1, refusedSeats)

  // ═══ §D ═══
  section("§D · the doors and the page (comment-stripped source)")
  const doors = stripComments(raw("app/actions/calculator-artifacts.ts"))
  const exported = [...doors.matchAll(/^export\s+(async\s+)?function\s+(\w+)/gm)]
  check("every export of the \"use server\" door file is an async function", exported.length >= 7 && exported.every((m) => !!m[1]) && !/^export\s+(const|let|class)/m.test(doors), exported.map((m) => m[2]))
  const body = (name: string) => { const i = doors.indexOf(`export async function ${name}(`); const j = doors.indexOf("\nexport ", i + 10); return i < 0 ? "" : doors.slice(i, j < 0 ? undefined : j) }
  const authoring = ["createCalculatorArtifactAction", "listCalculatorArtifactsAction", "getCalculatorFunnelAction"]
  check("the authoring doors resolve the tenant from the SESSION (getAgentContext) before the service client, and pass ctx.brokerageId",
    authoring.every((n) => { const b = body(n); const g = b.indexOf("getAgentContext()"), s = b.indexOf("svc()"); return g > 0 && s > g && /ctx\.brokerageId/.test(b) }), authoring.map((n) => body(n).length))
  const publicDoors = ["recordCalculatorOpenAction", "computeCalculatorArtifactAction", "optInCalculatorArtifactAction"]
  check("the public doors take no tenant from the caller and never reach the internal net sheet or commission terms",
    publicDoors.every((n) => { const b = body(n); return b.length > 0 && !/brokerageId/.test(b) && !/computeInternalSellerNet|getDefaultCommissionStructure|agreedCommission/.test(b) }))
  check("CONTROL: the public-door rule fails a body that names a tenant", /brokerageId/.test("optInCalculatorResult({ brokerageId: input.brokerageId })"))
  const page = stripComments(raw("app/lm/[slug]/page.tsx"))
  check("ONE PAGE FOR WEB, MOBILE AND QR: /lm/[slug] renders <CalculatorArtifact> for a calculator, with the brand computed server-side BEFORE render (tenant voice on the first paint)",
    /calculatorArtifactOf\(/.test(page) && /await loadCalculatorBrand\(/.test(page) && /<CalculatorArtifact[\s\S]{0,400}brand=\{calculator\.brand\}/.test(page))
  const site = stripComments(raw("app/site/[slug]/lm/[formSlug]/page.tsx"))
  check("…and the tenant website's in-site landing route serves that same page (tenant proven in the predicate)", /resolveTenantLandingForm\(/.test(site) && /LeadMagnetLandingPage\(/.test(site))
  const comp = stripComments(raw("app/components/calculators/CalculatorArtifact.tsx"))
  check("the component computes through the engine's server door, needs NO contact to calculate, and reaches the capture only from the explicit opt-in (with the ONE consent component)",
    /computeCalculatorArtifactAction\(/.test(comp) && /optInCalculatorArtifactAction\(/.test(comp) && /<ConsentBoxes/.test(comp) && comp.indexOf("optInCalculatorArtifactAction(") > comp.indexOf("function submitOptIn") && !/captureFormSubmission/.test(comp))
  check("MOBILE WIDTH: a single column that widens at sm, full-width inputs, no fixed pixel width", /grid-cols-1 gap-4 sm:grid-cols-2/.test(comp) && /w-full/.test(comp) && !/(?<![-\w])w-\[\d{3,}px\]/.test(comp))
  const studio = stripComments(raw("app/dashboard/marketing/studio/marketing-studio-client.tsx"))
  check("AUTHORING lives in the existing Command Center (the Command tab of the Marketing Studio) and publishes through the existing publish door",
    /<TabsContent value="command"[\s\S]{0,300}<CalculatorStudio \/>/.test(studio) && /publishLeadMagnetAction\(c\.id, channels\)/.test(stripComments(raw("app/components/calculators/CalculatorStudio.tsx"))))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log("FAILED:\n  - " + fails.join("\n  - ")); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
