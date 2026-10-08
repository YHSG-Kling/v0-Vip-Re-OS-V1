#!/usr/bin/env tsx
/**
 * scripts/scenario-engine-guard.ts   (npm run test:scenario-engine) — in-memory, no network, no DB.
 *
 * WAVE 107 (lane 107D) — THE SCENARIO / WHAT-IF ENGINE ON THE TWIN. "No production action yet.
 * Simulation first."
 *
 *   A  the lever propagation CHAIN is named, ordered, owned by registered managers, and a lever moves
 *      every downstream stage (seller +30% → ISA demand → conversions → closes → revenue)
 *   B  saturation point detection — the first stage to saturate and the lever value, verified one sweep
 *      step either side; a roomy brokerage saturates later (control)
 *   C  assumptions listed — every coefficient carries a source + confidence; a missing input is an
 *      ASSUMPTION (never a silent 0) and a measured input is not (positive control)
 *   D  deterministic — identical inputs give an identical projection + digest; a lever change moves it
 *   E  no-writer census (stripped source + a recording client) with a positive control
 *   F  tenant isolation — a foreign twin is refused; the facts loader pins brokerage_id and never counts
 *      a foreign row
 *   G  unsupported levers / territories are returned, never dropped
 *   H  wiring (stripped source) — the action gates + persists evidence + promotes PROPOSED; the
 *      Command Center renders the panel; the engine calls the 104B survivor scenario()
 *   I  registration — package.json, guard-chain membership, MAINTENANCE_DOMAINS, contributors keyed by MANAGERS
 *
 * Owner: data_steward (the twin is its derived representation). Co-owners named in prose:
 * recruiting_manager (agent capacity / competency / territory staffing), finance_manager (GCI per
 * close, close rate, AI cost, margin), ads_manager (marginal cost per lead, spend elasticity).
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import { composeBrokerageTwin, DEFAULT_WORKFORCE_THRESHOLDS, type TwinFacts, type TwinAgentCapacity, type BrokerageTwin } from "@/lib/kernel/brokerage-twin"
import {
  simulateScenario, loadScenarioFacts, scenarioHeadline,
  SCENARIO_PROPAGATION_CHAIN, SCENARIO_CONTRIBUTORS, SCENARIO_LEVER_KEYS, SATURATION_SWEEP_STEP, EMPTY_SCENARIO_FACTS,
  type ScenarioFacts,
} from "@/lib/kernel/twin-scenario"
import { MANAGERS, MAINTENANCE_DOMAINS } from "@/lib/kernel/manager-registry"
import type { BrokerageTwin as Twin } from "@/lib/kernel/brokerage-twin"

// The coefficients and the normalized levers are read THROUGH the projection (the one public door).
const scenarioCoefficients = (t: Twin, f: ScenarioFacts = EMPTY_SCENARIO_FACTS) => simulateScenario({ brokerageId: t.brokerageId, levers: {} }, t, f).coefficients
const normalizeLevers = (l: unknown) => ({ levers: simulateScenario({ brokerageId: twinA.brokerageId, levers: l }, twinA).levers })

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const code = (p: string) => blankStrings(stripComments(read(p)))
const codeKeepStrings = (p: string) => stripComments(read(p))

const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002"
const AT = "2026-10-06T12:00:00.000Z"
const day = (n: number) => new Date(new Date(AT).getTime() - n * 86_400_000).toISOString()

function facts(brokerageId: string, o: { agents?: number; headroomEach?: number; sellerLeads?: number; leads?: number } = {}): TwinFacts {
  const n = o.agents ?? 4
  const perAgent: TwinAgentCapacity[] = Array.from({ length: n }, (_, i) => ({ agentId: `ag-${i}`, band: "available", load: 10, headroom: o.headroomEach ?? 10, followUpDebt: 0, fatigueTier: null, reasons: [] }))
  const seller = o.sellerLeads ?? 12
  return {
    brokerageId, teamId: null, at: AT,
    leads: Array.from({ length: o.leads ?? 60 }, (_, i) => ({ id: `l-${i}`, lifecycle_state: "isa_qualifying" })),
    converted90d: 12, contactsActive: 200,
    listings: [{ id: "li-1", status: "active" }],
    transactions: [{ id: "tx-1", status: "pending", estimated_commission: 9000 }, { id: "tx-2", status: "pending", estimated_commission: 11000 }],
    closed90d: [{ id: "c1", commission_amount: 10000 }, { id: "c2", commission_amount: 12000 }, { id: "c3", commission_amount: 8000 }],
    dealHealth: [], listingHealth: [], stallSignals: [], fatigue: [{ contact_id: "k1", risk_level: "high" }, { contact_id: "k2", risk_level: "critical" }],
    retention: [], complianceOpen: [], goals: [], strategyPending: 0,
    capacity: { maxLoad: 40, perAgent, unscored: 0, activeAgents: n },
    forecast: [], aiCost30dCents: 4000, contributionMargin: { status: "unavailable", cents: null, source: "x" }, missions: { status: "none", active: 0, source: "x" },
    previous: null, previousReason: "no prior snapshot", blindSpots: [],
    workforce: {
      thresholds: DEFAULT_WORKFORCE_THRESHOLDS, thresholdsSource: "default",
      agents: perAgent.map((a, i) => ({ agentId: a.agentId, userId: null, languages: [], specializations: [], listings180d: i === 0 ? 5 : 0, luxuryListings180d: 0, offers180d: i === 1 ? 5 : 0, investorContacts: 0, competencyGaps: 0, competencyRefused: null })),
      farms: [{ name: "Farm A", zip_codes: ["32561"], agent_id: "ag-0" }, { name: "Farm B", zip_codes: ["32501"], agent_id: "ag-1" }],
      sellerContacts60d: Array.from({ length: seller }, (_, i) => ({ id: `s-${i}`, zip_code: i % 3 === 0 ? "32501" : "32561", home_value_estimate: 400000, created_at: day(5) })),
    },
  }
}
const twinA = composeBrokerageTwin(facts(A))
const marketFacts: ScenarioFacts = { marketing: { leads30d: 50, spendUsd30d: 2500, rows: 30 }, txDeskStaff: 1, mediaCostUsd: { image: 0.04, graphic: 0.04, ad_creative: 0.04, social_post: 0.02, video: 2.5 }, mediaVariants: 4, refused: [] }

console.log("A — the propagation chain")
{
  const p0 = simulateScenario({ brokerageId: A, levers: {} }, twinA, marketFacts)
  const p30 = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 30 } }, twinA, marketFacts)
  check("A1 the chain is the named order, every stage present", JSON.stringify(p30.chain.map((s) => s.stage)) === JSON.stringify(SCENARIO_PROPAGATION_CHAIN), p30.chain.map((s) => s.stage))
  check("A2 every stage is owned by a registered manager", p30.chain.every((s) => s.manager in MANAGERS))
  const st = (p: typeof p0, s: string) => p.chain.find((x) => x.stage === s)!
  check("A3 seller +30% raises seller demand", st(p30, "seller_demand").demand! > st(p0, "seller_demand").demand!)
  check("A4 …which reaches the AI ISA stage", st(p30, "ai_isa_capacity").demand! > st(p0, "ai_isa_capacity").demand!)
  check("A5 …conversions, listings, closes and revenue", p30.opportunityGain.addedConversions30d > 0 && p30.opportunityGain.addedListings30d > 0 && p30.opportunityGain.addedCloses30d > 0 && p30.opportunityGain.addedRevenueCents > 0, p30.opportunityGain)
  check("A6 …the agent-capacity stage and transaction desk load", st(p30, "agent_capacity").demand! > 0 && st(p30, "transaction_capacity").demand! > st(p0, "transaction_capacity").demand!)
  check("A7 …and costs (acquisition at the marginal CPL, media per new listing, AI per lead)", p30.marketingCost.acquisitionCents > 0 && p30.marketingCost.mediaCents > 0 && p30.marketingCost.aiCents > 0, p30.marketingCost)
  check("A8 margin = revenue − total cost", p30.expectedMarginCents === p30.opportunityGain.addedRevenueCents - p30.marketingCost.totalCents)
  check("A9 (control) no lever → no gain, no cost", p0.opportunityGain.addedLeads30d === 0 && p0.marketingCost.totalCents === 0)
  check("A10 the 104B scenario() output rides the agent stage (one capacity model)", p30.staffingConstraint.capacityScenario?.predictor.includes("computeCapacity") === true)
  // WAVE 137 owner ruling: the AI ISA's capacity counts CONTACTS; its raw-lead work queue stays LEADS.
  const isa = st(p30, "ai_isa_capacity")
  check("A11 the AI ISA stage is counted in CONTACTS: unit contacts/30d, demand = seller + buyer CONTACT demand, inputs isa_capacity_contacts_30d + contact_qualification_rate", isa.unit === "contacts/30d" && Math.abs(isa.demand! - (st(p30, "seller_demand").demand! + st(p30, "buyer_demand").demand!)) < 1e-6 && isa.inputs.includes("isa_capacity_contacts_30d") && isa.inputs.includes("contact_qualification_rate"), isa)
  const withFlow = (leads: number) => { const f = facts(A, { leads }); f.flow = { contact: 90 }; return composeBrokerageTwin(f) }
  const q60 = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 30 } }, withFlow(60), marketFacts)
  const q600 = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 30 } }, withFlow(600), marketFacts)
  check("A12 the raw-lead work queue is NOT contact demand: 60 vs 600 active leads → the same ISA demand and capacity (contact inflow measured)", st(q60, "ai_isa_capacity").demand === st(q600, "ai_isa_capacity").demand && st(q60, "ai_isa_capacity").capacity === st(q600, "ai_isa_capacity").capacity, [st(q60, "ai_isa_capacity"), st(q600, "ai_isa_capacity")])
  check("A13 POSITIVE CONTROL: the split is reported, not lost — the lead queue (60 → 600 leads) moves isa_lead_queue_30d and the stage note", q60.coefficients.find((c) => c.key === "isa_lead_queue_30d")?.value === 20 && q600.coefficients.find((c) => c.key === "isa_lead_queue_30d")?.value === 200 && /stays LEADS/.test(st(q600, "ai_isa_capacity").note ?? "") && st(q600, "ai_isa_capacity").note !== st(q60, "ai_isa_capacity").note)
  check("A14 no retired lead-denominated ISA key remains (isa_capacity_leads_30d / lead_conversion_rate)", !q60.coefficients.some((c) => c.key === "isa_capacity_leads_30d" || c.key === "lead_conversion_rate"))
  check("A11 headline names gain, cost and constraint", /closes/.test(scenarioHeadline(p30)) && /cost/.test(scenarioHeadline(p30)))
}

console.log("B — saturation point detection")
{
  const p = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 30 } }, twinA, marketFacts)
  const sc = p.staffingConstraint
  check("B1 a first-saturating stage is named with a lever value", sc.firstSaturated !== null && sc.atLeverValue !== null && sc.lever === "seller_lead_acquisition_pct", sc)
  if (sc.firstSaturated && sc.atLeverValue !== null) {
    const at = (x: number) => simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: x } }, twinA, marketFacts).chain.find((s) => s.stage === sc.firstSaturated)!
    check("B2 saturated AT the reported value", at(sc.atLeverValue).saturated)
    check("B3 not saturated one sweep step below (or saturated from baseline at 0)", sc.atLeverValue === 0 || !at(sc.atLeverValue - SATURATION_SWEEP_STEP).saturated)
    const others = Object.entries(sc.saturationPoints).filter(([, v]) => v !== null) as Array<[string, number]>
    check("B4 no other stage saturates earlier", others.every(([, v]) => v >= sc.atLeverValue!), others)
  }
  const roomy = composeBrokerageTwin(facts(A, { agents: 12, headroomEach: 40 }))
  const pr = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 30, isa_capacity_pct: 300, agent_headcount: { listing: 6 } } }, roomy, { ...marketFacts, txDeskStaff: 10 })
  check("B5 (control) a roomier brokerage saturates later or never", pr.staffingConstraint.atLeverValue === null || pr.staffingConstraint.atLeverValue > (sc.atLeverValue ?? -1), { tight: sc.atLeverValue, roomy: pr.staffingConstraint.atLeverValue })
  const hires = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 30, agent_headcount: { listing: 3 } } }, twinA, marketFacts)
  const cov = (q: typeof p) => q.chain.find((s) => s.stage === "competency_coverage")!.utilization!
  check("B6 listing hires lower competency-coverage utilization", cov(hires) < cov(p), { before: cov(p), after: cov(hires) })
  const saturatedRisk = p.risks.some((r) => /first stage to saturate/.test(r))
  check("B7 the saturation is a named risk", saturatedRisk, p.risks)
}

console.log("C — assumptions listed")
{
  const all = scenarioCoefficients(twinA, marketFacts)
  check("C1 every coefficient names a source, unit, confidence and manager", all.every((k) => k.source.length > 0 && k.unit.length > 0 && !!k.confidence && k.manager in MANAGERS), all.filter((k) => !k.source))
  check("C2 every value is finite (never NaN)", all.every((k) => Number.isFinite(k.value)))
  check("C3 every assumption says so in its source", all.filter((k) => k.assumption).every((k) => k.source.startsWith("assumption:") && k.confidence === "assumed"))
  const bare = scenarioCoefficients(twinA, EMPTY_SCENARIO_FACTS)
  const cpl = (xs: typeof all) => xs.find((k) => k.key === "marginal_cost_per_lead_usd")!
  check("C4 no marketing ledger → CPL is an ASSUMPTION (not 0)", cpl(bare).assumption && cpl(bare).value > 0)
  check("C5 (positive control) a measured ledger → CPL is measured", !cpl(all).assumption && cpl(all).value === 50 && /territory_metrics/.test(cpl(all).source))
  const noTerr = composeBrokerageTwin({ ...facts(A), workforce: { ...facts(A).workforce, farms: [], sellerContacts60d: [] } })
  const seller = scenarioCoefficients(noTerr).find((k) => k.key === "base_seller_contacts_30d")!
  check("C6 no territory reading → base seller demand is an assumption", seller.assumption && seller.value > 0, seller)
  // WAVE 108 owner ruling — demand is CONTACTS (buyer contacts for the Shopping Agent, seller contacts for
  // the Listing Concierge); the buyer flow is the twin's CONTACT-stage inflow when it is measured.
  const withFlow = composeBrokerageTwin({ ...facts(A), flow: { contact: 90 }, flowEntries: { leadFromRaw: null, contactDirect: 60 } })
  const buyerK = scenarioCoefficients(withFlow).find((k) => k.key === "base_buyer_contacts_30d")!
  const sellerK = scenarioCoefficients(twinA).find((k) => k.key === "base_seller_contacts_30d")!
  check("C6b buyer demand is MEASURED from the twin's contact stage (90 contacts / 90d → 30/mo, less the seller-contact reading), in contacts — never a lead count", !buyerK.assumption && /contact stage/.test(buyerK.source) && buyerK.unit === "contacts/30d" && buyerK.value === Math.max(0, 30 - sellerK.value), JSON.stringify(buyerK))
  check("C6c (control) without a contact-stage reading the buyer base is an ASSUMPTION, still in contacts", (() => { const k = scenarioCoefficients(twinA).find((x) => x.key === "base_buyer_contacts_30d")!; return k.assumption && k.unit === "contacts/30d" })())
  check("C6d seller demand reads the seller CONTACTS of the territories (contact_type seller|both)", !sellerK.assumption && /contacts contact_type∈\{seller,both\}/.test(sellerK.source) && sellerK.unit === "contacts/30d", JSON.stringify(sellerK))
  const noLeadKeys = scenarioCoefficients(twinA).filter((k) => /_(seller|buyer)_leads_|seller_leads_per_listing/.test(k.key))
  check("C6e no demand coefficient is spelled as LEADS any more (one vocabulary — the demand is contacts)", noLeadKeys.length === 0, noLeadKeys.map((k) => k.key).join(","))
  const p = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 30 } }, twinA, EMPTY_SCENARIO_FACTS)
  check("C7 the projection publishes its assumptions", p.assumptions.length > 0 && p.assumptions.every((k) => k.assumption || k.confidence === "low"))
  check("C8 …and names the assumption load as a risk", p.risks.some((r) => /assumptions or low-confidence/.test(r)))
  const keys = all.map((k) => k.key)
  check("C9 one value per coefficient key", new Set(keys).size === keys.length)
}

console.log("D — deterministic")
{
  const l = { seller_lead_acquisition_pct: 30, agent_headcount: { listing: 2 }, territory_activation: ["Farm B"] }
  const a = simulateScenario({ brokerageId: A, levers: l }, twinA, marketFacts)
  const b = simulateScenario({ brokerageId: A, levers: JSON.parse(JSON.stringify(l)) }, twinA, marketFacts)
  check("D1 identical inputs → identical projection", JSON.stringify(a) === JSON.stringify(b))
  check("D2 identical inputs → identical digest", a.digest === b.digest)
  const c = simulateScenario({ brokerageId: A, levers: { ...l, seller_lead_acquisition_pct: 31 } }, twinA, marketFacts)
  check("D3 (control) a lever change moves the digest", c.digest !== a.digest)
  const t1 = normalizeLevers({ territory_activation: ["B", "A", "A"] }).levers.territory_activation
  check("D4 territory order / duplicates do not change the levers", JSON.stringify(t1) === JSON.stringify(["A", "B"]))
}

console.log("E — no-writer census")
{
  const WRITE = /\.(insert|update|upsert|delete|rpc)\s*\(/
  const WRITER_MODULES = /from\s+["'](@\/lib\/supabase\/service|@\/lib\/supabase\/server|@\/lib\/kernel\/action-ledger|@\/lib\/kernel\/missions|@\/lib\/kernel\/events?|@\/lib\/kernel\/kernel-events)["']|import\(\s*["']@\/lib\/(supabase|kernel\/action-ledger|kernel\/missions)/
  const src = code("lib/kernel/twin-scenario.ts")
  const srcWithStrings = codeKeepStrings("lib/kernel/twin-scenario.ts")
  check("E1 the scenario module names no write verb", !WRITE.test(src))
  check("E2 the scenario module imports no writer module", !WRITER_MODULES.test(srcWithStrings))
  const imports = [...srcWithStrings.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)].map((m) => ({ type: !!m[1], names: m[2].split(",").map((x) => x.trim()).filter(Boolean), from: m[3] }))
  check("E3 static imports are only the twin and the manager registry", imports.every((i) => i.from === "@/lib/kernel/brokerage-twin" || i.from === "@/lib/kernel/manager-registry"), imports.map((i) => i.from))
  const PURE_TWIN = new Set(["scenario", "twinDigest", "type BrokerageTwin", "type ScenarioOutput"])
  const twinNames = imports.filter((i) => i.from === "@/lib/kernel/brokerage-twin").flatMap((i) => i.names.map((n) => (i.type ? `type ${n}` : n)))
  check("E4 from the twin only its PURE exports (never buildBrokerageTwin / the snapshot writer)", twinNames.every((n) => PURE_TWIN.has(n)), twinNames)
  check("E5 (positive control) the census flags a specimen writer", WRITE.test(`svc.from("missions").insert({})`) && WRITER_MODULES.test(`import { x } from "@/lib/kernel/action-ledger"`))
  // A recording client: the loader calls only select / filters.
  const calls: string[] = []
  const rec = (table: string) => {
    const b: any = new Proxy({}, { get: (_t, m: string) => m === "then" ? (res: any) => res({ data: [], error: null, count: 0 }) : (...args: unknown[]) => { calls.push(`${table}.${m}(${JSON.stringify(args[0] ?? "")})`); return b } })
    return b
  }
  void loadScenarioFacts({ from: (t: string) => rec(t) }, A, new Date(AT)).then(() => {
    check("E6 the facts loader writes nothing (recording client)", calls.length > 0 && !calls.some((c) => /\.(insert|update|upsert|delete|rpc)\(/.test(c)), calls)
  })
}

console.log("F — tenant isolation")
{
  let threw = false
  try { simulateScenario({ brokerageId: B, levers: { seller_lead_acquisition_pct: 30 } }, twinA, marketFacts) } catch { threw = true }
  check("F1 a foreign twin is refused (never projected)", threw)
  let threwEmpty = false
  try { simulateScenario({ brokerageId: "", levers: {} }, twinA) } catch { threwEmpty = true }
  check("F2 no tenant → refused", threwEmpty)
  check("F3 (control) the tenant's own twin projects", simulateScenario({ brokerageId: A, levers: {} }, twinA).brokerageId === A)
  // In-memory client with rows of two tenants: the loader must count only A's.
  const rows: Record<string, Array<Record<string, unknown>>> = {
    territory_metrics: [{ brokerage_id: A, lead_count: 10, total_cost: 500, metric_date: "2026-10-01" }, { brokerage_id: B, lead_count: 999, total_cost: 99999, metric_date: "2026-10-01" }],
    users: [{ brokerage_id: A, user_type: "tc", id: "u1" }, { brokerage_id: B, user_type: "tc", id: "u2" }, { brokerage_id: B, user_type: "tc", id: "u3" }],
  }
  const pinned: string[] = []
  const mem = (table: string) => {
    const filters: Array<[string, unknown, string]> = []
    let head = false
    const b: any = {
      select: (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return b },
      eq: (k: string, v: unknown) => { filters.push([k, v, "eq"]); if (k === "brokerage_id") pinned.push(table); return b },
      gte: (k: string, v: unknown) => { filters.push([k, v, "gte"]); return b },
      limit: () => b,
      then: (res: any) => {
        const out = (rows[table] ?? []).filter((r) => filters.every(([k, v, op]) => op === "eq" ? r[k] === v : String(r[k]) >= String(v)))
        return res(head ? { data: null, error: null, count: out.length } : { data: out, error: null })
      },
    }
    return b
  }
  void loadScenarioFacts({ from: mem }, A, new Date(AT)).then((f) => {
    check("F4 the loader pins brokerage_id on every read", pinned.includes("territory_metrics") && pinned.includes("users"), pinned)
    check("F5 a foreign tenant's spend / leads are never counted", f.marketing?.spendUsd30d === 500 && f.marketing?.leads30d === 10, f.marketing)
    check("F6 a foreign tenant's coordinators are never counted", f.txDeskStaff === 1, f.txDeskStaff)
  })
  // A refused read is NAMED and its coefficient becomes an assumption.
  void loadScenarioFacts({ from: (t: string) => ({ select: () => ({ eq: () => ({ gte: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "permission denied" } }) }), eq: () => Promise.resolve({ count: null, error: { message: "permission denied" } }) }) }) }) }, A, new Date(AT)).then((f) => {
    check("F7 a refused read is named, never a silent zero", f.refused.length === 2 && f.marketing === null && f.txDeskStaff === null, f.refused)
    const k = scenarioCoefficients(twinA, f).find((x) => x.key === "marginal_cost_per_lead_usd")!
    check("F8 …and the CPL it fed is an assumption that says the read refused", k.assumption && /refused/.test(k.source), k.source)
  })
}

console.log("G — unsupported levers")
{
  const p = simulateScenario({ brokerageId: A, levers: { market_appreciation_pct: 5, territory_activation: ["Atlantis"], agent_headcount: { wizard: 2 } } }, twinA, marketFacts)
  check("G1 an unknown lever key is returned", p.unsupported.includes("market_appreciation_pct"), p.unsupported)
  check("G2 an unknown territory is returned", p.unsupported.includes("territory_activation:Atlantis"), p.unsupported)
  check("G3 an unknown specialization is returned", p.unsupported.includes("agent_headcount.wizard"), p.unsupported)
  check("G4 the published lever vocabulary", SCENARIO_LEVER_KEYS.length === 7)
  const aimed = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 50, territory_activation: ["Farm B"] } }, twinA, marketFacts)
  const broad = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: 50 } }, twinA, marketFacts)
  check("G5 territory activation narrows the lift to the named territory", aimed.opportunityGain.addedLeads30d < broad.opportunityGain.addedLeads30d && aimed.opportunityGain.addedLeads30d > 0, { aimed: aimed.opportunityGain.addedLeads30d, broad: broad.opportunityGain.addedLeads30d })
}

console.log("H — wiring (stripped source)")
{
  const act = code("app/actions/twin-scenario.ts"), actS = codeKeepStrings("app/actions/twin-scenario.ts")
  check("H1 the action is a server module", read("app/actions/twin-scenario.ts").trimStart().startsWith(`"use server"`))
  check("H2 every export is async", !/export\s+(const|function(?!\s*\*)|let)\s/.test(act.replace(/export\s+async\s+function/g, "")))
  check("H3 tenant from the session + the tenant-admin roster (never retyped)", /auth\.getUser\(\)/.test(act) && /resolveTenantAdmin\(/.test(act) && !/\[\s*["']admin["']/.test(actS))
  check("H4 entitlement fails closed", /mayUseAndAfford\(/.test(act) && /!afford\.allowed/.test(act))
  check("H5 the projection calls the engine", /simulateScenario\(/.test(act))
  check("H6 every run is ledgered as evidence, settled 'skipped' (not attribution-eligible)", /withActionLedger</.test(act) && /twin\.scenario\.simulate/.test(actS) && /status:\s*"skipped"/.test(actS))
  check("H7 promote creates a PROPOSED mission with the projection as evidence", /createMission\(/.test(act) && /initialState:\s*"PROPOSED"/.test(actS) && /recordMissionEvidence\(/.test(act))
  check("H8 the Command Center renders the panel", /<TwinScenarioPanel\b/.test(code("app/dashboard/admin/command-center/command-center-client.tsx")))
  const panel = code("app/dashboard/admin/command-center/twin-scenario-panel.tsx")
  check("H9 the panel calls simulate and promote", /simulateTwinScenario\(/.test(panel) && /promoteTwinScenarioToMission\(/.test(panel))
  check("H10 the engine calls the 104B survivor scenario()", /\bscenario\(twin,/.test(code("lib/kernel/twin-scenario.ts")))
  const specimen = `// scenario(twin, {})  — a tombstone naming the survivor\nconst x = 1`
  check("H11 (positive control) a comment naming scenario() is NOT read as a call site", !/\bscenario\(twin,/.test(blankStrings(stripComments(specimen))))
}

console.log("I — registration")
{
  const pkg = JSON.parse(read("package.json"))
  check("I1 package.json registers test:scenario-engine", pkg.scripts["test:scenario-engine"] === "tsx scripts/scenario-engine-guard.ts")
  check("I2 the guard chain runs it", new RegExp("npm run test:scenario-engine(\\s|&|$)").test(pkg.scripts.guard ?? ""))
  const d = (MAINTENANCE_DOMAINS as Record<string, { manager: string; proof: string; coOwners?: string[]; what: string }>).twin_scenario_engine
  check("I3 a MAINTENANCE_DOMAINS entry owns the proof", d?.proof === "test:scenario-engine" && d.manager === "data_steward")
  check("I4 co-owners are named in the entry's prose", !!d && (d.coOwners ?? []).length > 0 && (d.coOwners ?? []).every((c) => d.what.includes(c)))
  const keys = Object.keys(SCENARIO_CONTRIBUTORS)
  check("I5 contributors are keyed by MANAGERS, one per domain, key = manager", keys.length >= 8 && keys.every((k) => k in MANAGERS && SCENARIO_CONTRIBUTORS[k as keyof typeof SCENARIO_CONTRIBUTORS]!.manager === k))
  check("I6 every chain stage has a contributing domain", SCENARIO_PROPAGATION_CHAIN.every((s) => Object.values(SCENARIO_CONTRIBUTORS).some((c) => c!.stages.includes(s))))
}

setTimeout(() => {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}, 50)
