#!/usr/bin/env tsx
/**
 * scripts/relocation-planner-guard.ts (test:relocation-planner) — THE PCS / RELOCATION TRANSITION PLANNER (wave 150, lane
 * 150KLMO; directive 150K).
 *
 *   A  OFFICIAL SOURCES by NAME and URL (DoD DTMO BAH lookup, Military OneSource installations + Plan My Move, VA home loans) on
 *      official domains — and the planner never fetches, scrapes or imports a network client (stripped source).
 *   B  CONSENT: the person mode REFUSES without a stated consent basis for the destination / timeline the person volunteered;
 *      no input field exists for orders or service history.
 *   C  WINDOW: a stated move date → the C37 reporting window (stated beats inferred); none / a past date → unknown.
 *   D  HANDOFFS: remote tours always; the lender (VA) handoff only when the person stated VA interest; a licence REFERRAL only
 *      when the destination is outside the agent's licensed states; spouse licensing goes to the board / installation office.
 *   E  SELL vs RENT: an illustration over stated inputs with every assumption labelled; a missing input is null WITH the reason;
 *      tax / lending belong to a CPA and a lender.
 *   F  TERRITORY GUIDE: price-to-rent over the market twin's verified LISTING medians; missing → not stated; the report topic
 *      pass carries it as relocation_context, which supports a topic but never carries one alone.
 *
 * BLIND SPOTS (published): BAH figures are never fetched (the person's own or a staff-imported DTMO rate file) so their accuracy
 * is the person's; the person mode has no product door yet (AI ISA / portal assistant wiring — lane notes, Registry entries
 * needed); the sell-vs-rent assumptions are national rules of thumb, not local quotes.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try { const so = _require.resolve("server-only"); _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as any } catch { /* not installed */ }

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const NOW = new Date("2026-11-06T12:00:00Z")
const B1 = "00000000-0000-4000-8000-0000000000b1"

async function main() {
  const { planRelocation, PCS_OFFICIAL_SOURCES } = await import("../lib/relocation/pcs-planner")
  const consent = { basis: "self_service_portal", ref: "msg-1", capturedAt: "2026-11-01T00:00:00Z" }
  const person = (o: Record<string, unknown> = {}) => planRelocation({ mode: "person", consent, destination: { label: "Norfolk, VA", installationName: "Naval Station Norfolk", state: "VA" }, now: NOW, ...o } as never)

  section("A. official sources by name and URL; never fetched")
  check("four official sources, each with a name, an https URL and a stated use", PCS_OFFICIAL_SOURCES.length === 4 && PCS_OFFICIAL_SOURCES.every((s) => s.name.length > 5 && /^https:\/\//.test(s.url) && s.use.length > 10))
  check("each URL is on an official .mil / .gov domain", PCS_OFFICIAL_SOURCES.every((s) => /^https:\/\/[^/]+\.(mil|gov)\//.test(s.url)), PCS_OFFICIAL_SOURCES.map((s) => s.url).join(" "))
  check("the DoD BAH source is the DTMO BAH Rate Lookup, used as the person's own figure", PCS_OFFICIAL_SOURCES.some((s) => s.key === "dtmo_bah_lookup" && /travel\.dod\.mil/.test(s.url) && /never fetched/.test(s.use)))
  const src = code("lib/relocation/pcs-planner.ts")
  check("the planner never fetches, scrapes or imports a network client (stripped source)", !/\bfetch\(|axios|exaSearch|zenrows|apify|firecrawl|import\([^)]*external/.test(src))
  check("POSITIVE CONTROL: the probe flags a planted fetch", /\bfetch\(/.test(`${src}\nawait fetch("https://www.travel.dod.mil/")`))

  section("B. consent — only what the person volunteered")
  const refused = planRelocation({ mode: "person", consent: null, destination: { label: "Norfolk, VA" }, now: NOW } as never)
  check("no stated consent basis → refused with the reason", !refused.ok && /no stated consent basis/.test(refused.reason))
  const blank = planRelocation({ mode: "person", consent: { basis: "  " }, destination: { label: "Norfolk, VA" }, now: NOW } as never)
  check("a blank basis is not a basis", !blank.ok)
  check("the input carries no orders / service-history field (stripped source)", !/\b(orders|serviceHistory|service_history|rank|payGrade|unit)\??\s*:/.test(src.slice(src.indexOf("type RelocationInput"), src.indexOf("interface PlanStep"))))
  const ok = person()
  check("POSITIVE CONTROL: with a stated basis the plan is made", ok.ok && ok.mode === "person")

  section("C. the window — a stated date beats any inferred range")
  const w = (d: string | null) => { const p = person({ statedMoveDate: d }); return p.ok && p.mode === "person" ? `${p.window}/${p.windowBasis}` : "x" }
  check("a report date 45 days out → 31_90 (stated_date)", w("2026-12-21") === "31_90/stated_date", w("2026-12-21"))
  check("200 days out → 181_365", w("2027-05-25").startsWith("181_365"), w("2027-05-25"))
  check("no date → unknown; a past date → unknown (never a guess)", w(null) === "unknown/unknown" && w("2026-01-01").startsWith("unknown"))

  section("D. handoffs — remote tours, finance, licence")
  const steps = (o: Record<string, unknown>) => { const p = person(o); return p.ok && p.mode === "person" ? p.steps.map((s) => s.key) : [] }
  check("remote tours and the official checklist are always planned", ["official_checklist", "remote_tours", "housing_budget"].every((k) => steps({}).includes(k)))
  check("the VA lender handoff appears ONLY when the person stated VA interest", steps({ vaInterestStated: true }).includes("finance_handoff") && !steps({}).includes("finance_handoff"))
  check("a destination outside the agent's licensed states → a licence REFERRAL; inside → none", steps({ agentLicensedStates: ["FL", "AL"] }).includes("licence_handoff") && !steps({ agentLicensedStates: ["fl", "va"] }).includes("licence_handoff"))
  check("spouse licensing goes to the destination board / installation office", steps({ spouseLicensedOccupation: "registered nurse" }).includes("spouse_licence"))
  const bah = person({ bahMonthly: { amount: 2385, source: "self_stated" } })
  check("a BAH figure is the person's own (\"as you told us\"), else the plan asks for their LES / DTMO lookup", bah.ok && bah.mode === "person" && /\$2,385\/month, as you told us/.test(bah.steps.find((s) => s.key === "housing_budget")?.what ?? "") && /LES or the DTMO lookup/.test((person() as any).steps.find((s: any) => s.key === "housing_budget")?.what ?? ""))

  section("E. sell vs rent — an illustration, labelled")
  const sv = person({ currentHome: { value: 400000, valueSource: "requestPropertyValuation (RentCast AVM)", mortgageBalance: 250000, monthlyPayment: 1800, expectedRent: 2500, rentSource: "market twin asking rent" } })
  const s = sv.ok && sv.mode === "person" ? sv.sellVsRent : null
  check("selling: $400,000 less 7% less the $250,000 balance = $122,000 net", s?.sell.netProceeds === 122000, JSON.stringify(s?.sell))
  check("renting out: $2,500 less 26% (management, vacancy, maintenance) less the $1,800 payment = $50 a month", s?.rentOut.monthlyNet === 50, JSON.stringify(s?.rentOut))
  check("every assumption is labelled and replaceable; tax / lending go to a CPA and a lender", (s?.assumptions.length ?? 0) === 4 && (s?.assumptions ?? []).every((a) => /assumed/.test(a)) && /CPA/.test(s?.boundary ?? "") && /lender/.test(s?.boundary ?? ""))
  const miss = person({ currentHome: { value: null, mortgageBalance: 250000, monthlyPayment: null, expectedRent: 2500 } })
  const m = miss.ok && miss.mode === "person" ? miss.sellVsRent : null
  check("a missing value / payment → null WITH the reason (the valuation door; the payment)", m?.sell.netProceeds === null && /requestPropertyValuation/.test(m.sell.why) && m?.rentOut.monthlyNet === null && /monthly payment/.test(m.rentOut.why))
  check("the plan boundary says it is not tax, legal or lending advice and that orders are never inferred", ok.ok && ok.mode === "person" && /not tax, legal or lending advice/.test(ok.boundary) && /never fetches, scrapes or infers orders/.test(ok.boundary))

  section("F. territory guide — verified listing medians; supports, never carries, a topic")
  const g = planRelocation({ mode: "territory_guide", territoryLabel: "32503", facts: { medianAskingPrice: 455000, medianRent: 2150, asOf: "2026-11-01", source: "RentCast /markets listing statistics" } })
  check("price-to-rent 17.6 and a gross yield of 5.7% from the LISTING medians, with the source and date", g.ok && g.mode === "territory_guide" && g.priceToRent === 17.6 && g.grossRentYieldPct === 5.7 && /listed homes ask \$455,000/.test(g.summary) && /2026-11-01/.test(g.summary), JSON.stringify(g))
  const gn = planRelocation({ mode: "territory_guide", territoryLabel: "32503", facts: { medianAskingPrice: 455000, medianRent: null, asOf: null, source: "x" } })
  check("no verified rent → no ratio, said", gn.ok && gn.mode === "territory_guide" && gn.priceToRent === null && /not stated/.test(gn.summary))
  const { suggestMarketReportTopics } = await import("../lib/market-reports/topics")
  const ZIP = { grain: "zip" as const, label: "32503", zip: "32503", city: null, state: null }
  const twin = async () => ({ brokerageId: B1, asOf: "2026-11-06", zips: [{ zip: "32503", asOf: "2026-11-01", period: "2026-11", listing: { medianAskingPrice: { value: 455000, label: "x", basis: "listing_asking", unit: "usd" } }, rental: { medianRent: { value: 2150, label: "x", basis: "listing_rent", unit: "usd" } }, sold: { medianSoldPrice: null, closedSales: 0, window: "x", caveat: "x" }, via: "provider_read", source: {}, reason: null }], marketGap: { monthsOfSupply: null, asOf: null, source: null, reason: "x" }, demandGap: { segments: [], suppressedSegments: 0, consentedBuyers: 0, staleInventoryExcluded: 0, freshInventory: 0 }, notes: [], blindSpots: [] })
  let prompt = ""
  const db = memSupabase({ market_data: [], market_trends: [], listings: [], market_dataset_verifications: [] })
  const r = await suggestMarketReportTopics(db as never, { brokerageId: B1, territory: ZIP }, { now: NOW, twin: twin as never, rank: async (a) => { prompt = a.prompt; return { suggestions: [{ title: "Own or rent near the base", angle: "x", format: "territory_snapshot", evidence_ids: ["relocation:32503"], why_now: "x" }] } } })
  check("the relocation context reaches the strategist with the official sources by name", /\(relocation_context\)/.test(prompt) && /Defense Travel Management Office/.test(prompt), prompt.slice(0, 300))
  check("…and never carries a topic alone (the relocation-only suggestion is dropped → the plain snapshot fallback)", r.suggestions.length === 1 && r.suggestions[0].by !== "ai", JSON.stringify(r.suggestions.map((x) => [x.title, x.by])))

  console.log(`\nRELOCATION PLANNER — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ RELOCATION_PLANNER_PASS" : "❌ RELOCATION_PLANNER_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
