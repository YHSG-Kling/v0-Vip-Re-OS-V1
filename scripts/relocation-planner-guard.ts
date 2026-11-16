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
 *   D  HANDOFFS: remote tours always; the lender (VA) handoff only when the person stated VA interest; a license REFERRAL only
 *      when the destination is outside the agent's licensed states; spouse licensing goes to the board / installation office.
 *   E  SELL vs RENT: an illustration over stated inputs with every assumption labelled; a missing input is null WITH the reason;
 *      tax / lending belong to a CPA and a lender.
 *   F  TERRITORY GUIDE: price-to-rent over the market twin's verified LISTING medians; missing → not stated; the report topic
 *      pass carries it as relocation_context, which supports a topic but never carries one alone.
 *
 * BLIND SPOTS (published): BAH figures are never fetched (the person's own or a staff-imported DTMO rate file) so their accuracy
 * is the person's; the sell-vs-rent assumptions are national rules of thumb, not local quotes. §G (wave 153, lane 153K — row 61)
 * drives the person-mode DOOR (lib/relocation/pcs-portal-door.ts) on the in-memory client with the stated-date writer as a seam
 * and once through the REAL reassessExistingContact (no model); the session gate itself (requireContactAccess) is read from the
 * action's stripped source, not driven; the portal-assistant chat tool is NOT a door (one door, the journey page).
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

  section("D. handoffs — remote tours, finance, license")
  const steps = (o: Record<string, unknown>) => { const p = person(o); return p.ok && p.mode === "person" ? p.steps.map((s) => s.key) : [] }
  check("remote tours and the official checklist are always planned", ["official_checklist", "remote_tours", "housing_budget"].every((k) => steps({}).includes(k)))
  check("the VA lender handoff appears ONLY when the person stated VA interest", steps({ vaInterestStated: true }).includes("finance_handoff") && !steps({}).includes("finance_handoff"))
  check("a destination outside the agent's licensed states → a license REFERRAL; inside → none", steps({ agentLicensedStates: ["FL", "AL"] }).includes("licence_handoff") && !steps({ agentLicensedStates: ["fl", "va"] }).includes("licence_handoff"))
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

  section("G. the person-mode DOOR (wave 153, lane 153K — convergence row 61): the portal journey, the person only, consent first, one canonical write")
  {
    const { planPcsMoveForPortalContact } = await import("../lib/relocation/pcs-portal-door")
    const C1 = "00000000-0000-4000-8000-0000000000c1", AG = "00000000-0000-4000-8000-0000000000a1", U1 = "00000000-0000-4000-8000-0000000000e1"
    const B2 = "00000000-0000-4000-8000-0000000000b2"
    const seed = (extra: Record<string, unknown[]> = {}) => memSupabase({
      contacts: [{ id: C1, brokerage_id: B1, agent_id: AG }],
      agent_licenses: [
        { agent_id: AG, brokerage_id: B1, license_state: "FL", license_status: "active" },
        { agent_id: AG, brokerage_id: B1, license_state: "VA", license_status: "expired" },
        { agent_id: AG, brokerage_id: B2, license_state: "VA", license_status: "active" },
      ],
      ...extra,
    } as never)
    const self = { brokerageId: B1, contactId: C1, userId: U1, isContactSelf: true }
    const calls: Array<Record<string, any>> = []
    const rec = async (_s: unknown, a: Record<string, any>) => { calls.push(a); return { status: "reassessed" as const, reason: "decided" } }
    const base = { consentGiven: true, destinationLabel: "Norfolk", installationName: "Naval Station Norfolk", destinationState: "VA", reportDate: "2027-01-15" }

    const staff = await planPcsMoveForPortalContact(seed(), { ...self, isContactSelf: false }, base, { now: NOW, recordStatedDate: rec as never })
    check("ADVERSE · a STAFF seat that may open the portal is refused — the consent is the person's own; nothing is written", !staff.ok && staff.code === "not_the_person" && calls.length === 0, JSON.stringify(staff))
    const noConsent = await planPcsMoveForPortalContact(seed(), self, { ...base, consentGiven: false }, { now: NOW, recordStatedDate: rec as never })
    check("ADVERSE · no consent → refused before any read or write (\"Nothing was saved\")", !noConsent.ok && noConsent.code === "no_consent" && /Nothing was saved/.test(noConsent.message) && calls.length === 0)
    const past = await planPcsMoveForPortalContact(seed(), self, { ...base, reportDate: "2026-01-01" }, { now: NOW, recordStatedDate: rec as never })
    const far = await planPcsMoveForPortalContact(seed(), self, { ...base, reportDate: "2029-06-01" }, { now: NOW, recordStatedDate: rec as never })
    const badBah = await planPcsMoveForPortalContact(seed(), self, { ...base, bahMonthly: -5 }, { now: NOW, recordStatedDate: rec as never })
    check("ADVERSE · a past report date, one more than two years out and a negative BAH are refused with the next step; nothing written", !past.ok && !far.ok && !badBah.ok && calls.length === 0)

    const ok1 = await planPcsMoveForPortalContact(seed(), self, base, { now: NOW, recordStatedDate: rec as never })
    const keys = ok1.ok ? ok1.plan.steps.map((s) => s.key) : []
    check("the person's plan: a report date 70 days out → the 31_90 window on the STATED date, with the official checklist and remote tours", ok1.ok && ok1.plan.windowBasis === "stated_date" && ok1.plan.window === "31_90" && keys.includes("official_checklist") && keys.includes("remote_tours"), JSON.stringify(ok1.ok ? [ok1.plan.window, keys] : ok1))
    check("LICENSE HONESTY · VA is outside the agent's ACTIVE licenses in THIS tenant (the expired VA row and another tenant's active VA row do not count) → a referral step", keys.includes("licence_handoff"), keys.join(","))
    check("ONE canonical write: the stated report date → reassessExistingContact(stated_date, relocation_start, captured by the PERSON, tenant from the gate, deterministic reference)",
      calls.length === 1 && calls[0].brokerageId === B1 && calls[0].contactId === C1 && calls[0].capturedBy === "person" && calls[0].change.kind === "stated_date" && calls[0].change.deadline.kind === "relocation_start" && calls[0].change.deadline.at === "2027-01-15T00:00:00.000Z" && calls[0].change.referenceId === `portal_pcs_plan:${C1}:2027-01-15` && calls[0].change.quote.length >= 5,
      JSON.stringify(calls[0]))
    check("…and says it: statedDate recorded", ok1.ok && ok1.statedDate.status === "recorded")
    const before = calls.length
    const noDate = await planPcsMoveForPortalContact(seed(), self, { ...base, reportDate: null, bahMonthly: 2385, vaInterest: true }, { now: NOW, recordStatedDate: rec as never })
    check("no report date → a plan with NO write (not_stated); the BAH is the person's own and the VA handoff appears only on stated interest", noDate.ok && noDate.statedDate.status === "not_stated" && calls.length === before && noDate.plan.steps.some((s) => s.key === "finance_handoff") && /as you told us/.test(noDate.plan.steps.find((s) => s.key === "housing_budget")?.what ?? ""))
    const dbNoWrites = seed()
    await planPcsMoveForPortalContact(dbNoWrites, self, { ...base, reportDate: null, bahMonthly: 2385, currentHome: { value: 400000, mortgageBalance: 250000 } }, { now: NOW, recordStatedDate: rec as never })
    check("the BAH and home numbers are NOT stored — measured: zero writes on the client when no date is stated (the door's only write is the stated date)", dbNoWrites.writes.length === 0, JSON.stringify(dbNoWrites.writes))

    const foreign = await planPcsMoveForPortalContact(seed(), { ...self, brokerageId: B2 }, base, { now: NOW, recordStatedDate: rec as never })
    check("ADVERSE · UNRELATED TENANT: a gate verdict for another tenant cannot read this contact (pinned to brokerage_id) → refused, nothing written", !foreign.ok && foreign.code === "read_refused" && calls.length === before)
    const refused = await planPcsMoveForPortalContact(memSupabase({ contacts: [{ id: C1, brokerage_id: B1, agent_id: AG }] } as never, { missingTables: ["agent_licenses"] }), self, base, { now: NOW, recordStatedDate: rec as never })
    check("an unreadable license roster makes NO referral judgment and says so (never a guessed referral either way)", refused.ok && !refused.plan.steps.some((s) => s.key === "licence_handoff") && refused.notes.some((n) => /no referral judgment/.test(n)))
    const contactRefused = await planPcsMoveForPortalContact(memSupabase({} as never, { missingTables: ["contacts"] }), self, base, { now: NOW, recordStatedDate: rec as never })
    check("a refused contact read fails CLOSED (read_refused, \"Nothing was saved\"), never a plan built on no record", !contactRefused.ok && contactRefused.code === "read_refused" && /Nothing was saved/.test(contactRefused.message))

    // THE REAL WRITER accepts the exact change the door builds (no model: decide throws, publish/respond stubbed).
    const mv = await import("../lib/intent/movement-signals")
    const mdeps = { now: NOW, windowDays: 180, decide: (async () => { throw new Error("no model in the proof") }) as never, publish: (async () => ({ ok: true })) as never, respond: (async () => ({ action: "recorded" })) as never, routeToAgent: (async () => true) as never, notifyAdmins: async () => 1 }
    const world = memSupabase({
      contacts: [{ id: C1, brokerage_id: B1, contact_type: "buyer", agent_id: AG, zip_code: "32503", deleted_at: null, opted_out_at: null, timeline: null, metadata: null, enrichment_profile: null }],
      agent_licenses: [{ agent_id: AG, brokerage_id: B1, license_state: "VA", license_status: "active" }],
      movement_signals: [], agent_action_ledger: [], ai_predictions: [], listings: [], transactions: [], leads: [], raw_scraped_leads: [], buyer_financial_profiles: [], ai_tool_usage: [], vendor_spend: [],
    } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } } as never)
    const realRec = (s: unknown, a: Record<string, any>) => mv.reassessExistingContact(s as never, a as never, mdeps as never)
    const quiet = async <T,>(fn: () => Promise<T>) => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn() } finally { console.warn = w; console.error = e } }
    const real = await quiet(() => planPcsMoveForPortalContact(world, self, base, { now: NOW, recordStatedDate: realRec as never }))
    const rows = ((world as any).tables.movement_signals ?? []) as Array<Record<string, any>>
    check("REAL WRITER · the canonical movement writer records the person's stated relocation date on THIS contact (captured_by person, the C37 deadline), no lead minted",
      real.ok && real.statedDate.status === "recorded" && rows.length === 1 && rows[0].contact_id === C1 && rows[0].brokerage_id === B1 && rows[0].captured_by === "person" && ((world as any).tables.leads ?? []).length === 0,
      JSON.stringify({ status: real.ok ? real.statedDate : real, row: rows[0] && { contact_id: rows[0].contact_id, captured_by: rows[0].captured_by, source_key: rows[0].source_key } }))
    const again = await quiet(() => planPcsMoveForPortalContact(world, self, base, { now: NOW, recordStatedDate: realRec as never }))
    check("REAL WRITER · a resubmit of the same date REPLAYS (one observation, one record)", again.ok && again.statedDate.status === "replayed" && ((world as any).tables.movement_signals ?? []).length === 1, JSON.stringify(again.ok ? again.statedDate : again))
    check("POSITIVE CONTROL · inside the agent's active license states (VA here) → NO referral step — the referral finder is not stuck on", real.ok && !real.plan.steps.some((s) => s.key === "licence_handoff"))

    // The door is placed on the EXISTING portal journey for the military persona, behind the session gate (stripped source).
    const page = code("app/portal/[contactId]/journey/page.tsx"), action = code("app/actions/portal-pcs-plan.ts")
    check("the journey page mounts the planner for the military persona (the existing \"PCS Planning\" stage), no new route or user type", /persona === "military_buyer" && <PcsMovePlanner contactId=\{contactId\} \/>/.test(page))
    check("the action gates FIRST (requireContactAccess) and passes the gate's tenant + isContactSelf, never a body tenant", action.indexOf("requireContactAccess(contactId)") > 0 && action.indexOf("requireContactAccess(contactId)") < action.indexOf("createServiceClient()") && /brokerageId: access\.brokerageId/.test(action) && /isContactSelf: access\.isContactSelf/.test(action) && !/input\.brokerageId|brokerageId: input/.test(action))
  }

  console.log(`\nRELOCATION PLANNER — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ RELOCATION_PLANNER_PASS" : "❌ RELOCATION_PLANNER_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
