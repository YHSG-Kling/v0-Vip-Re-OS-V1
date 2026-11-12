// lib/market-reports/validator.ts
// ─────────────────────────────────────────────────────────────────────────────
// NO GENERIC TEXT PASSES AS A MARKET REPORT (wave 147, lane 147E — owner ruling 6 + lane brief requirement 6: "a validator
// refuses a report without dated sourced data").
//
// PURE. The producer (lib/market-reports/producer.ts) runs it AFTER the narrative is composed and BEFORE anything is rendered
// or hosted; the lead-magnet deliverable (lib/lead-magnets/deliverable-asset.ts) is `ready` only on `ok: true`. A refusal says
// which rule, so the arbiter / a person can see why a report was not produced — never a silent fallback to filler.
//
// THE RULES (each a refusal unless marked warning):
//   V1  at least MIN_DATED_SOURCED_DATA data, each with a finite value, an ISO date and a named provider + dataset
//   V2  every datum is CURRENT: dated no later than the report and no older than MAX_DATUM_AGE_DAYS
//   V3  every narrative section is BUILT FROM DATA: it names ≥1 datum key that exists, and that datum's shown value is in it
//   V4  the report is TERRITORY-SPECIFIC: the territory label is named in the headline or the first section
//   V5  every figure in the narrative is SOURCED: a number that is not a datum's shown value, a comparable's figure, a year,
//       or part of the territory / a datum label is an invented figure
//   V6  no FORECAST AS FACT ("prices will rise", "guaranteed") — projections are not facts (realestate-market quality rule 6)
//   V7  boilerplate with no data behind it ("now is a great time to buy", "the market is hot") — refused when a section is
//       nothing else; a warning when a data-built section also carries one
//   V8  every unavailable item says EXACTLY "not available for <territory> as of <date>"
//   V9  one fact, one state: no datum both available and unavailable, no duplicate keys
//   V10 comparables are dated, sourced and declare their price basis (a recorded sale vs a last list price)
//   V11 unresolved `{{token}}` placeholders never reach the reader

import { formatDatumValue, isIsoDay, unavailableLabel, MARKET_DATUM_KEYS, type MarketReport, type MarketReportValidation } from "./contract"

export const MIN_DATED_SOURCED_DATA = 3
const MAX_DATUM_AGE_DAYS = 365

const DAY_MS = 86_400_000

/** Boilerplate a report can say about ANY place on ANY day — never a market report on its own. */
const GENERIC_PHRASES: readonly RegExp[] = [
  /\bnow is (a|the) (great|good|perfect|best) time to (buy|sell)\b/i,
  /\bthe market is (hot|on fire|crazy|changing)\b/i,
  /\bevery market is (different|unique)\b/i,
  /\b(contact|call) me today\b/i,
  /\bdon'?t miss out\b/i,
  /\bwon'?t last long\b/i,
  /\breal estate is (local|always a good investment)\b/i,
  /\bit'?s a (buyer'?s|seller'?s) market out there\b/i,
]

const FORECAST_AS_FACT: readonly RegExp[] = [
  /\b(prices|values|rates|inventory|the market)\s+(will|is going to|are going to)\s+(rise|fall|increase|decrease|climb|drop|soar|crash|go up|go down|keep rising|keep falling)\b/i,
  /\bguarantee[ds]?\b/i,
  /\b(certain|sure) to (rise|appreciate|increase|sell)\b/i,
]

/** Numbers in prose: $1,234 / 1,234 / 12.5% / 45 / +3.2%. */
const NUMBER_RE = /[+-]?\$?\d[\d,]*(?:\.\d+)?%?/g

function normalizeNumber(s: string): string {
  return s.replace(/[$,+%]/g, "").replace(/^-/, "-").replace(/\.0+$/, "")
}

function allowedNumbers(report: MarketReport): Set<string> {
  const ok = new Set<string>()
  const add = (s: string) => { for (const m of s.match(NUMBER_RE) ?? []) ok.add(normalizeNumber(m)) }
  for (const d of report.data) {
    add(formatDatumValue(d)); add(d.label); add(d.asOf)
    // "down 2.5%" quotes a signed percentage's magnitude — the same sourced figure.
    if (d.unit === "pct") add(formatDatumValue({ value: Math.abs(d.value), unit: "pct" }))
  }
  for (const c of report.comparables) { add(String(Math.round(c.price))); add(`$${Math.round(c.price).toLocaleString("en-US")}`); add(c.address); add(c.date); if (c.beds != null) add(String(c.beds)); if (c.baths != null) add(String(c.baths)); if (c.sqft != null) add(String(c.sqft)) }
  add(report.territory.label); add(report.asOf)
  if (report.territory.zip) add(report.territory.zip)
  if (report.territory.address) add(report.territory.address)
  ok.add(String(report.comparables.length))
  return ok
}

function isYear(n: string): boolean {
  return /^(19|20)\d{2}$/.test(n)
}

export function validateMarketReport(report: MarketReport, opts: { now?: Date } = {}): MarketReportValidation {
  const refusals: string[] = []
  const warnings: string[] = []
  const now = opts.now ?? new Date()
  const data = Array.isArray(report?.data) ? report.data : []
  const sections = Array.isArray(report?.narrative?.sections) ? report.narrative.sections : []
  const territoryLabel = String(report?.territory?.label ?? "").trim()
  const knownKeys = new Set<string>(MARKET_DATUM_KEYS)

  // V1 — dated, sourced data.
  const datedSourced = data.filter((d) =>
    knownKeys.has(d.key) && typeof d.value === "number" && Number.isFinite(d.value) && isIsoDay(d.asOf)
    && !!d.source?.provider && !!String(d.source?.dataset ?? "").trim())
  for (const d of data) if (!datedSourced.includes(d)) refusals.push(`V1 datum "${d?.key ?? "?"}" is not dated and sourced (value, ISO date, provider and dataset are all required)`)
  if (datedSourced.length < MIN_DATED_SOURCED_DATA) refusals.push(`V1 only ${datedSourced.length} dated, sourced data point(s) — a market report needs at least ${MIN_DATED_SOURCED_DATA}; generic text is not a market report`)

  // V2 — current.
  const reportDay = isIsoDay(report?.asOf) ? Date.parse(`${report.asOf}T00:00:00Z`) : now.getTime()
  for (const d of datedSourced) {
    const t = Date.parse(`${d.asOf}T00:00:00Z`)
    if (t > reportDay + DAY_MS) refusals.push(`V2 datum "${d.key}" is dated ${d.asOf}, after the report (${report.asOf})`)
    else if (reportDay - t > MAX_DATUM_AGE_DAYS * DAY_MS) refusals.push(`V2 datum "${d.key}" is dated ${d.asOf} — older than ${MAX_DATUM_AGE_DAYS} days is not current data`)
  }

  // V4 — territory-specific.
  if (!territoryLabel) refusals.push("V4 the report names no territory")
  else {
    const named = [report.narrative?.headline ?? "", sections[0]?.heading ?? "", sections[0]?.body ?? ""].join(" ").toLowerCase()
    if (!named.includes(territoryLabel.toLowerCase())) refusals.push(`V4 the headline / first section never names the territory "${territoryLabel}" — a report that could be about anywhere is generic`)
  }

  // V3 / V7 — every section built from data; boilerplate.
  if (sections.length === 0) refusals.push("V3 the report has no narrative sections")
  for (const [i, s] of sections.entries()) {
    const keys = (s.datumKeys ?? []).filter((k) => datedSourced.some((d) => d.key === k))
    const body = String(s.body ?? "")
    const shown = keys.filter((k) => { const d = datedSourced.find((x) => x.key === k)!; return body.includes(formatDatumValue(d)) })
    const boiler = GENERIC_PHRASES.filter((re) => re.test(body) || re.test(s.heading ?? ""))
    if (keys.length === 0 || shown.length === 0) {
      refusals.push(`V3 section ${i + 1} ("${s.heading}") is not built from the report's data — it names no available datum${keys.length && !shown.length ? " whose value appears in it" : ""}`)
      if (boiler.length) refusals.push(`V7 section ${i + 1} is boilerplate ("${boiler.map((r) => r.source).join('", "')}")`)
    } else if (boiler.length) warnings.push(`V7 section ${i + 1} carries boilerplate beside its data — consider cutting it`)
  }
  for (const line of [report.narrative?.headline ?? "", ...(report.narrative?.buyerTakeaways ?? []), ...(report.narrative?.sellerTakeaways ?? []), report.narrative?.callToAction ?? ""]) {
    if (GENERIC_PHRASES.some((re) => re.test(line))) warnings.push(`V7 boilerplate in "${line.slice(0, 80)}"`)
  }

  // V5 / V6 / V11 — every figure sourced, no forecast as fact, no unresolved token.
  const prose = [report.narrative?.headline ?? "", ...sections.flatMap((s) => [s.heading ?? "", s.body ?? ""]), ...(report.narrative?.buyerTakeaways ?? []), ...(report.narrative?.sellerTakeaways ?? []), report.narrative?.callToAction ?? ""]
  const allowed = allowedNumbers(report)
  let numbersChecked = 0
  for (const line of prose) {
    for (const m of line.match(NUMBER_RE) ?? []) {
      numbersChecked++
      const n = normalizeNumber(m)
      if (!allowed.has(n) && !isYear(n)) refusals.push(`V5 "${m}" in "${line.slice(0, 80)}" is not one of the report's sourced figures — an invented number`)
    }
    for (const re of FORECAST_AS_FACT) if (re.test(line)) refusals.push(`V6 "${line.slice(0, 80)}" states a forecast as fact — projections must be labelled as projections`)
    if (/\{\{\s*[a-z0-9_]+\s*\}\}/i.test(line)) refusals.push(`V11 an unresolved placeholder reached the reader: "${line.slice(0, 80)}"`)
  }

  // V8 — honest unavailable labels.
  const unavail = Array.isArray(report?.unavailable) ? report.unavailable : []
  const expected = unavailableLabel(territoryLabel, String(report?.asOf ?? ""))
  for (const u of unavail) if (u.text !== expected) refusals.push(`V8 unavailable "${u.key}" says "${u.text}" — it must say exactly "${expected}"`)

  // V9 — one fact, one state.
  const seen = new Set<string>()
  for (const d of data) { if (seen.has(d.key)) refusals.push(`V9 datum "${d.key}" appears twice`); seen.add(d.key) }
  for (const u of unavail) if (seen.has(u.key)) refusals.push(`V9 "${u.key}" is reported both as data and as unavailable`)

  // V10 — comparables.
  const comps = Array.isArray(report?.comparables) ? report.comparables : []
  for (const c of comps) {
    if (!isIsoDay(c.date) || !c.source?.provider || !String(c.source?.dataset ?? "").trim() || !(c.priceBasis === "recorded_sale" || c.priceBasis === "last_list_price") || !(c.price > 0)) {
      refusals.push(`V10 comparable "${c.address}" is not dated, sourced and price-basis-declared`)
    }
  }

  return {
    ok: refusals.length === 0,
    refusals: [...new Set(refusals)],
    warnings: [...new Set(warnings)],
    counts: { data: data.length, datedSourced: datedSourced.length, unavailable: unavail.length, comparables: comps.length, sections: sections.length, numbersChecked },
  }
}
