/**
 * scripts/reverse-skip-trace-guard.ts — `npm run test:reverse-skip-trace` (wave 82 lane A)
 *
 * Owner verbatim (wave 82): "build a reverse skip trace wrapper." + "osint is supposed to be a
 * free provider for intent behavior acquisition and a free search enrichment. exa can also be
 * used for these".
 *
 * ZERO network — every provider injected. Layers:
 *   1 — the transport's response reader correlates by requestId, positionally only on an equal
 *       count, and fails a drifted response CLOSED (positive control: the same rows at the right
 *       count DO match).
 *   2 — selectReversePerson: a shared phone/email is not the same person — last name must agree.
 *   3 — the wrapper: route → ONE gate → BatchData reverse ($0.07/match) → PeopleData ONLY on a
 *       miss; refusals; platform-paid bookings (vendor ledger), drain mode (peopleData: null).
 *   4 — the drain wires it for PERSON-keyed rows only, between the gate and PeopleData.
 *   5 — 81B's frozen pipeline-processor literals now read the transport constants.
 *   6 — OSINT/Exa: free $0 intent lanes run BEFORE the budget gate and every paid lane; Exa is
 *       booked as `exa`; the search-enrichment rung keeps an event only when the NAME and the
 *       event share a result (positive control: the keyword-anywhere shape it replaced).
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))
const code = (p: string) => blankStrings(stripped(p))

const bd = await import("../lib/external/batchdata-client")
const pdlMod = await import("../lib/external/peopledata-client")
const rail = await import("../lib/ai-isa/property-lookup-rail")
const { reverseSkipTracePerson, selectReversePerson } = await import("../lib/enrichment/reverse-skip-trace")
const { classifyMentionEvents, buildPersonMentionQueries, searchPersonMentions } = await import("../lib/enrichment/web-mention-search")
type Person = import("../lib/external/batchdata-client").BatchDataReversePerson
type Access = import("../lib/ai-isa/property-lookup-rail").BatchDataAccess

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · reverse response reader — correlate, never guess]")
const inputs = [{ ref: "lead-1", phone: "6025551234" }, { ref: "lead-2", email: "jo@example.com" }]
const rowA = { name: { first: "Maria", last: "Lopez", full: "Maria Lopez" }, phones: [{ number: "6025551234", dnc: false }], emails: [{ email: "maria@example.com" }], property: { address: { street: "12 Oak St", city: "Phoenix", state: "AZ", zip: "85001" } } }
const rowB = { name: { first: "Jo", last: "Park" }, emails: [{ email: "jo@example.com" }], phones: [] }
const byId = bd.readReverseSkipTraceResponse({ results: { persons: [{ ...rowB, requestId: "lead-2" }, { ...rowA, requestId: "lead-1" }] } }, inputs)
check("requestId correlation survives a re-ordered response", byId[0].persons[0]?.lastName === "Lopez" && byId[1].persons[0]?.lastName === "Park", JSON.stringify(byId))
check("the person carries name, phones, emails and the linked property", byId[0].persons[0]?.phones[0] === "6025551234"
  && byId[0].persons[0]?.emails[0] === "maria@example.com" && byId[0].persons[0]?.propertyAddress?.street === "12 Oak St")
const drift = bd.readReverseSkipTraceResponse({ results: [rowA] }, inputs)
check("a DRIFTED response (1 row for 2 inputs, no ids) fails every ref closed", drift.every((m) => !m.matched))
const pos = bd.readReverseSkipTraceResponse({ results: [rowA, rowB] }, inputs)
check("POSITIVE CONTROL: the same rows at the right count DO match positionally", pos[0].matched && pos[1].matched)
check("an empty person object is not a match", !bd.readReverseSkipTraceResponse({ results: [{}, {}] }, inputs).some((m) => m.matched))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · a shared phone is not the same person]")
const p = (first: string, last: string, state = "AZ", city = "Phoenix"): Person => ({
  firstName: first, lastName: last, fullName: `${first} ${last}`, phones: ["6025551234"], emails: [],
  addresses: [{ street: "1 A St", city, state, zip: null }], propertyAddress: null,
})
check("last name agrees → that person", selectReversePerson([p("Ana", "Diaz"), p("Maria", "Lopez")], { lastName: "Lopez" }).person?.firstName === "Maria")
check("last name disagrees → NO person (a spouse's / stranger's line is never written)",
  selectReversePerson([p("Carl", "Nguyen")], { firstName: "Maria", lastName: "Lopez" }).person === null)
check("first name breaks a surname tie", selectReversePerson([p("Luis", "Lopez"), p("Maria", "Lopez")], { firstName: "maria", lastName: "LOPEZ" }).person?.firstName === "Maria")
check("no name on the input → the city/state match wins", selectReversePerson([p("A", "B", "TX", "Austin"), p("C", "D", "AZ", "Phoenix")], { state: "AZ", city: "Phoenix" }).person?.firstName === "C")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · the wrapper: route → gate → BatchData → PeopleData on a miss; platform-paid]")
const ALLOW: Access = { allowed: true, purpose: "skip_trace", reason: "fixture allow" }
const DENY: Access = { allowed: false, purpose: "skip_trace", reason: "BatchData tier is off" }
function harness(persons: Person[], pdlHit: boolean) {
  const log: string[] = []
  const booked: Array<{ vendorName: string; cost: number }> = []
  return {
    log, booked,
    deps: {
      reverse: async (ask: readonly { ref: string }[]) => { log.push("batchdata"); const matched = persons.length > 0; return { matches: [{ ref: ask[0].ref, matched, persons }], cost: matched ? bd.BATCHDATA_SKIP_TRACE_COST_USD : 0 } },
      peopleData: async () => { log.push("peopledata"); return pdlHit ? { data: { fullName: "Maria Lopez", firstName: "Maria", lastName: "Lopez", emails: ["m@x.com"], phones: ["6025559999"] } as any, cost: pdlMod.PEOPLEDATA_MATCH_COST_USD } : { data: null, cost: pdlMod.PEOPLEDATA_NO_MATCH_COST_USD } },
      meter: async (m: { vendorName: string; cost: number }) => { booked.push({ vendorName: m.vendorName, cost: m.cost }); return true },
    },
  }
}
const IN = { brokerageId: "b-1", ref: "lead-1", firstName: "Maria", lastName: "Lopez", phone: "(602) 555-1234", city: "Phoenix", state: "AZ" }
{
  const h = harness([p("Maria", "Lopez")], true)
  const r = await reverseSkipTracePerson(IN, { ...h.deps, access: ALLOW })
  check("BatchData matches the named person → provider batchdata, PeopleData NEVER asked", r.status === "matched" && r.provider === "batchdata" && h.log.join(",") === "batchdata", h.log.join(","))
  check("route is reverse_contact (BatchData first, PeopleData fallback)", r.route.capability === "reverse_contact" && r.route.providers.join(",") === "batchdata,peopledata")
  check("booked ONCE to the platform vendor ledger as batchdata at the $0.07 constant", h.booked.length === 1 && h.booked[0].vendorName === "batchdata" && h.booked[0].cost === bd.BATCHDATA_SKIP_TRACE_COST_USD && r.costUsd === 0.07, JSON.stringify(h.booked))
}
{
  const h = harness([p("Carl", "Nguyen")], true)
  const r = await reverseSkipTracePerson(IN, { ...h.deps, access: ALLOW })
  check("BatchData resolves the line to SOMEONE ELSE → treated as a miss (still billed), PeopleData asked, PeopleData's match returned",
    r.provider === "peopledata" && h.log.join(",") === "batchdata,peopledata" && h.booked.map((b) => b.vendorName).join(",") === "batchdata,peopledata"
    && Math.abs(r.costUsd - (0.07 + pdlMod.PEOPLEDATA_MATCH_COST_USD)) < 1e-9, `${h.log} ${JSON.stringify(h.booked)} ${r.costUsd}`)
}
{
  const h = harness([p("Maria", "Lopez")], false)
  const r = await reverseSkipTracePerson(IN, { ...h.deps, access: DENY })
  check("the ONE gate refuses → BatchData NOT called, PeopleData asked; a PDL no-match books nothing ($0)",
    h.log.join(",") === "peopledata" && r.status === "no_match" && h.booked.length === 0 && /tier is off/.test(r.reason), `${h.log} ${r.reason}`)
}
{
  const h = harness([], true)
  const r = await reverseSkipTracePerson(IN, { ...h.deps, access: ALLOW, peopleData: null })
  check("drain mode (peopleData: null): a BatchData miss returns no_match WITHOUT calling PeopleData (the drain's own step does)",
    r.status === "no_match" && h.log.join(",") === "batchdata" && h.booked.length === 0)
}
{
  const h = harness([p("Maria", "Lopez")], true)
  const r1 = await reverseSkipTracePerson({ brokerageId: "b-1", ref: "x", firstName: "Maria", lastName: "Lopez" }, { ...h.deps, access: ALLOW })
  const r2 = await reverseSkipTracePerson({ ...IN, brokerageId: null }, { ...h.deps, access: ALLOW })
  check("no phone/email → refused before any provider; no tenant → refused (§4)", r1.status === "refused" && r2.status === "refused" && h.log.length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · the drain wires it for person-keyed rows]")
const orch = stripped("lib/lead-pipeline/enrichment-orchestrator.ts")
const iGate = orch.indexOf("resolveBatchDataAccess({ brokerageId, purpose: 'skip_trace' })")
const iRev = orch.indexOf("reverseSkipTracePerson(")
const iV3 = orch.indexOf("skipTraceBatchDataV3Batch(")
const iPdl = orch.indexOf("skipTraceWithPeopleData(")
check("gate → reverse wrapper → (else) V3 → PeopleData, in source order", iGate > 0 && iRev > iGate && iV3 > iRev && iPdl > iV3, `gate@${iGate} rev@${iRev} v3@${iV3} pdl@${iPdl}`)
check("the reverse leg runs only for route.capability === 'reverse_contact', reuses the gate verdict, and leaves PeopleData to Step 5b",
  /skipTraceAccess\?\.allowed && route\.capability === 'reverse_contact'/.test(orch) && /access: skipTraceAccess, peopleData: null/.test(orch))
check("a reverse match is written with its own provider label and never replaces the row's own email",
  /'batchdata_reverse_skip_trace'/.test(orch) && /!\(batchDataFallback\.via === 'reverse' && entity\.email\)/.test(orch))
const wrap = code("lib/enrichment/reverse-skip-trace.ts")
const wrapStr = stripped("lib/enrichment/reverse-skip-trace.ts")
check("wrapper order: resolveContactProviderRoute → resolveBatchDataAccess → reverseSkipTraceBatchData → skipTraceWithPeopleData",
  wrapStr.indexOf("resolveContactProviderRoute(") < wrapStr.indexOf("resolveBatchDataAccess(")
  && wrapStr.indexOf("resolveBatchDataAccess(") < wrapStr.indexOf("reverseSkipTraceBatchData(")
  && wrapStr.indexOf("reverseSkipTraceBatchData(") < wrapStr.indexOf("skipTraceWithPeopleData"))
check("the wrapper books through meterVendorSpend (platform ledger) and touches no tenant meter",
  /meterVendorSpend/.test(wrapStr) && !/usage_events|usage_counters|meter_readings|increment_ai_usage/.test(wrap))
const tx = stripped("lib/external/batchdata-client.ts")
check("the transport asks the MCP `reverse_skip_trace` tool FIRST (REST fallback) and bills per MATCHED input",
  /batchDataPreferMcp<unknown>\(\s*"reverse_skip_trace"/.test(tx) && /filter\(\(m\) => m\.matched\)\.length \* BATCHDATA_SKIP_TRACE_COST_USD/.test(tx))
check("the price table carries reverse_contact at the SAME constant (no second spelling of $0.07)",
  rail.CONTACT_PROVIDER_ROUTES.reverse_contact[0].unitCostUsd === bd.BATCHDATA_SKIP_TRACE_COST_USD)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · 81B open item: pipeline-processor reads the provider constants]")
const pp = code("lib/lead-pipeline/pipeline-processor.ts")
const FROZEN = /cost:\s*matched\s*\?\s*0\.25\s*:\s*0\.10/
check("POSITIVE CONTROL: the finder flags the old literal shape", FROZEN.test("cost: matched ? 0.25 : 0.10,"))
check("no `0.25 : 0.10` literal remains; the booking reads PEOPLEDATA_MATCH_COST_USD / PEOPLEDATA_NO_MATCH_COST_USD",
  !FROZEN.test(pp) && /cost: matched \? PEOPLEDATA_MATCH_COST_USD : PEOPLEDATA_NO_MATCH_COST_USD/.test(pp))
check("a PDL miss books $0 (the constant), which meterVendorSpend skips — no invented $0.10 row", pdlMod.PEOPLEDATA_NO_MATCH_COST_USD === 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · OSINT free first; Exa as the search/intent rung, booked]")
const cron = stripped("app/api/cron/lead-scraping/route.ts")
const loop = cron.slice(cron.indexOf("for (const market of markets)"))
const iFree = [loop.indexOf("sourceSiteVisitorIntent("), loop.indexOf("sourceEmailEngagementIntent("), loop.indexOf("sourceRentalToBuyerGraduation(")]
const iBudget = loop.indexOf("monthly budget reached")
const iPaid = Math.min(...["zillow_behavior", "sourceExaBuyerIntent(", "sourceOsintRecords(", "fetchMotivatedSellers("].map((t) => loop.indexOf(t)).filter((i) => i >= 0))
check("the three $0 intent lanes run BEFORE the territory budget gate and BEFORE the first paid lane",
  iFree.every((i) => i > 0 && i < iBudget) && iBudget < iPaid, `free@${iFree} budget@${iBudget} paid@${iPaid}`)
check("POSITIVE CONTROL: the ordering predicate rejects the pre-82 shape (free lanes after the gate)",
  (() => { const fx = "monthly budget reached ... zillow_behavior ... sourceSiteVisitorIntent("; return !(fx.indexOf("sourceSiteVisitorIntent(") < fx.indexOf("monthly budget reached")) })())
// Wave 82 integration: 82A (per-call meter) and 82B (per-source ledger) both fixed Exa being
// filed under Apify; the per-source ledger survives (SOURCE_VENDOR maps both Exa lanes → exa),
// so the RULE is: both Exa lanes reach the ledger under the Exa vendor and never the composite row.
check("Exa lane spend is booked under its OWN vendor (per-source ledger: insertSocial → bookSourceSpend, SOURCE_VENDOR → exa), never the composite apify row, and never booked twice",
  /insertSocial\(records, "exa"/.test(cron) && /insertSocial\(routed\.toMint, "permit_prelisting_intent"/.test(cron)
  && /exa_buyer_intent:\s*'exa'/.test(read("lib/lead-pipeline/source-intent-map.ts"))
  && !/scraperTypeToVendor\(/.test(cron) && !/vendorName: "exa"/.test(cron)
  && !/sourceExaBuyerIntent\(socialMarket\)\s*\n\s*sourceCostUsd \+= cost/.test(cron))
const disp = stripped("lib/providers/dispatch.ts")
const dws = disp.slice(disp.indexOf("export async function dispatchWebSearch"))
check("dispatchWebSearch: tenant refused first, then Exa, then the spend booked as vendor exa",
  dws.indexOf("if (!params.brokerageId)") >= 0 && dws.indexOf("if (!params.brokerageId)") < dws.indexOf("exaSearch(")
  && dws.indexOf("exaSearch(") < dws.indexOf("meterVendorSpend(") && /vendorName: "exa"/.test(dws))
const who = { firstName: "Maria", lastName: "Lopez", city: "Phoenix", state: "AZ" }
const res = (title: string, text: string) => ({ id: title, url: `https://example.com/${encodeURIComponent(title)}`, title, text, author: null, publishedDate: "2026-08-01" })
const events = classifyMentionEvents([
  res("Obituary: Robert Lopez", "Robert Lopez passed away peacefully. He is survived by his wife Maria Lopez of Phoenix."),
  res("Community news", "Maria Lopez is relocating to Denver for a new role at the hospital."),
], who)
check("name + event in ONE result → events with the URL and the evidence sentence (death_in_family, relocation)",
  events.some((e) => e.event === "death_in_family" && /survived by/.test(e.evidence) && !!e.url) && events.some((e) => e.event === "relocation"), JSON.stringify(events))
const noise = classifyMentionEvents([res("Divorce attorneys in Phoenix", "Top divorce and bankruptcy lawyers. Call today.")], who)
check("POSITIVE CONTROL vs the replaced OSINT scrape: a page that merely contains 'divorce'/'bankruptcy' WITHOUT the person yields nothing", noise.length === 0)
check("a first+last name is required (no query, no spend, for a nameless contact)", buildPersonMentionQueries({ firstName: "Maria", lastName: "" }).length === 0 && buildPersonMentionQueries(who).length === 2)
{
  const seen: string[] = []
  const out = await searchPersonMentions({ ...who, brokerageId: "b-1" }, { search: async (q) => { seen.push(q.purpose); return { ok: false, provider: "none", results: [], costUsd: 0, reason: "Exa not configured" } } })
  check("unconfigured Exa → ran:false after ONE attempt (the life-change check then falls back to the ZenRows scrape)", !out.ran && seen.length === 1 && seen[0] === "search_enrichment")
}
const core = stripped("lib/enrichment/contact-enrichment-core.ts")
const lcc = core.slice(core.indexOf("export async function runLifeChangeCheck"))
check("runLifeChangeCheck: pre-flight → Exa mention rung → ZenRows OSINT scrape ONLY when the rung did not run",
  lcc.indexOf("await preflight(") < lcc.indexOf("searchPersonMentions(") && /if \(mentions\.ran\)[\s\S]{0,400}\} else \{[\s\S]{0,200}osint\.searchPerson\(/.test(lcc))

console.log("\n" + "─".repeat(60))
console.log(" blind spots: BatchData's live reverse payload shape (read defensively across documented fields; the REST path is UNRESOLVED, MCP is the confirmed leg) and Exa's live ranking are not exercised — no network.")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" FAILURES:")
  for (const x of failures) console.log(`   · ${x}`)
  process.exit(1)
}
