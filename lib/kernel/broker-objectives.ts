/**
 * BROKER OBJECTIVES + OBJECTIVE DELEGATION (wave 108, lane 108E) — a broker types an objective in
 * plain words on the Command Center's Missions card; the OS turns it into a MISSION on the existing
 * runtime. Three shapes, routed by a DETERMINISTIC pattern table (no model routes anything):
 *
 *   1. INVESTIGATION ("Find out why listing appointments dropped last month") → a mission OWNED BY THE
 *      MISSION CONTROLLER (cron_manager — MISSION_CONTROLLER_ACTOR) whose participating managers (data
 *      steward, AI ISA, campaign orchestrator, ads manager, listing concierge, finance manager) each
 *      run a PURE evidence check over the period-over-period facts, each requested and returned
 *      through a 105A manager_delegation. The mission returns an EVIDENCE REPORT: the observed move,
 *      the ranked contributing causes (numbers, delta, the reader that produced each), blind spots.
 *   2. DIRECTIVE with constraints ("Increase seller business in <territory> but don't increase spend
 *      more than $3,000/month") → a PROPOSAL: the twin scenario (107D simulateScenario) swept for the
 *      best lift that fits the cap, a recommended strategy (107E selectStrategies / the library), the
 *      budget ≤ the cap — the mission lands in APPROVAL_REQUIRED and NOTHING executes (no delegation,
 *      no activation, no campaign) until a human approves it on the card.
 *   3. OBJECTIVE DELEGATION ("Increase listing GCI 15%") → the twin decomposition (104B
 *      decomposeObjective) widened into the owner's chain — territory opportunities → marketing → ISA →
 *      capacity → recruiting → education → media → budget — as CHILD missions (parent_mission) per
 *      manager, PROPOSED, each with its sub-target and its budget share.
 *
 * SURVIVORS (extended, none replaced — LAW 1): lib/kernel/missions.ts (createMission, parent_mission,
 * attachEvidence, transitionMission — the ONE writer of missions), lib/kernel/manager-delegation.ts
 * (requestDelegation → accept → work → return — the ONE delegation service), lib/kernel/
 * mission-controller.ts (resolveOwnership — the parent's owner comes from the registry, never typed
 * here), lib/kernel/brokerage-twin.ts (readBrokerageTwin, decomposeObjective, recruitingNeeds,
 * readTwinMeasure), lib/kernel/twin-scenario.ts (simulateScenario — the only projection), lib/kernel/
 * strategy-engine.ts (selectStrategies / listStrategyLibrary — the only strategy picker), lib/kernel/
 * lead-intake-cockpit.ts (computeFunnel / groupBySource — the source-mix and intake math, reused PURE).
 *
 * TERRITORY: never hard-coded (tenants are nationwide). A place in the broker's text is matched
 * against THIS tenant's farm_territories (name / city), read by loadTerritoryCandidates; a place that
 * matches none is refused with the tenant's own territory names, never guessed.
 *
 * TENANT: every entry point takes the VERIFIED brokerageId (app/actions/missions.ts resolves it from
 * the SESSION through requireCallerTenant). Every read is pinned to it.
 *
 * No `import "server-only"`: scripts/broker-objectives-guard.ts drives it through an in-memory client.
 */
import { SELLER_SIDE_CONTACT_TYPES } from "@/lib/contact-types"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import type { AppCapability } from "@/lib/agentic-os/app-capability-registry"
import {
  attachEvidence, completeMission, createMission, transitionMission,
  type MissionActor, type MissionDeps, type MissionRow, type SuccessCriterion,
} from "@/lib/kernel/missions"
import { acceptDelegation, requestDelegation, returnDelegationResult, startDelegationWork, type DelegationDeps } from "@/lib/kernel/manager-delegation"
import { resolveOwnership } from "@/lib/kernel/mission-controller"
import { decomposeObjective, OBJECTIVE_MEASURES, readTwinMeasure, recruitingNeeds, type BrokerageTwin } from "@/lib/kernel/brokerage-twin"
import { simulateScenario, SATURATION_SWEEP_MAX, SATURATION_SWEEP_STEP, type ScenarioFacts, type ScenarioLevers, type ScenarioProjection } from "@/lib/kernel/twin-scenario"
import { computeFunnel, groupBySource, type FunnelCounts, type SourceConversion } from "@/lib/kernel/lead-intake-cockpit"
import type { AgentGoalType } from "@/lib/goals/goal-types"

type Client = { from: (table: string) => any }

// ─── 1. THE PARSER (deterministic pattern table — no model routes an objective) ──────────────────
export type ObjectiveKind = "investigation" | "directive" | "delegation"
export type ObjectiveMetric =
  | "listing_appointments" | "seller_conversion" | "listing_gci" | "gci" | "seller_business"
  | "seller_leads" | "closings" | "listings" | "leads"
  // wave 137E BREADTH — the goal measures the twin already carries beyond the seller funnel
  | "buyer_clients" | "pipeline_conversion" | "contacts"

/** Metric phrases, FIRST MATCH WINS (the more specific phrase sits above the general one).
 *  @proofSeam the proof asserts the table's order and every example against it */
export const OBJECTIVE_METRIC_PATTERNS: ReadonlyArray<{ metric: ObjectiveMetric; re: RegExp }> = [
  { metric: "listing_appointments", re: /\blisting (?:appointment|appt|presentation)s?\b/i },
  { metric: "seller_conversion", re: /\bseller(?: lead)? conversions?\b|\bconvert(?:ing)? sellers?\b/i },
  { metric: "listing_gci", re: /\blisting(?:[- ]side)? (?:gci|commission)\b/i },
  { metric: "gci", re: /\b(?:gci|gross commission)\b/i },
  { metric: "seller_business", re: /\bseller (?:business|side|demand)\b/i },
  { metric: "seller_leads", re: /\bseller leads?\b/i },
  // wave 137E: buyer representation, lead → contact conversion, the contact book (sphere / database)
  { metric: "buyer_clients", re: /\bbuyer (?:clients?|representations?|agreements?)\b|\bbuyers? under (?:representation|agreement)\b/i },
  { metric: "pipeline_conversion", re: /\b(?:lead )?conversion(?: rate)?s?\b|\bconvert(?:ing)? (?:more )?leads?\b/i },
  { metric: "contacts", re: /\b(?:contacts|sphere|database)\b/i },
  { metric: "closings", re: /\b(?:closings|closed deals|deals closed|sides)\b/i },
  { metric: "listings", re: /\blistings?\b/i },
  { metric: "leads", re: /\bleads?\b/i },
]
const INVESTIGATE_RE = /\b(?:why|find out|investigate|what happened|explain|root cause|diagnos\w*)\b/i
const DROP_RE = /\b(?:drop(?:ped|s)?|declin\w*|down|fell|fall(?:en|ing)?|decreas\w*|slump\w*|lower)\b/i
const RISE_RE = /\b(?:rose|rise|risen|spik\w*|jump\w*|increas\w*|up)\b/i
const GROW_RE = /\b(?:increase|grow|raise|boost|lift|get more|more)\b/i
const PCT_RE = /(\d+(?:\.\d+)?)\s?%/
const CAP_RE = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:\/|per|a|each)\s*(?:month|mo)\b/i
/** An objective with a % target on a GOAL measure is DELEGATED (decomposed into child missions). */
export const GOAL_OF_METRIC: Readonly<Partial<Record<ObjectiveMetric, AgentGoalType>>> = {
  listing_gci: "gross_commission", gci: "gross_commission", closings: "transactions_closed", listings: "listings_taken",
  buyer_clients: "buyer_clients", pipeline_conversion: "conversion_rate", contacts: "new_contacts",
}
const DIRECTIVE_METRICS: ReadonlySet<ObjectiveMetric> = new Set(["seller_business", "seller_leads", "listings", "listing_appointments", "leads"])
/** Words that end a "in <place>" phrase. */
const PLACE_STOP = /\s+(?:but|without|while|and|by|over|under|with|so|this|next|within|for|to)\b|[,.;!?]|$/i

export interface TerritoryCandidate { name: string; city: string | null; state: string | null }
export interface ParsedObjective {
  kind: ObjectiveKind
  metric: ObjectiveMetric
  direction: "down" | "up"
  windowDays: number
  /** The tenant's farm_territories.name the text matched (null = brokerage-wide). */
  territory: string | null
  spendCapUsdMonthly: number | null
  targetPct: number | null
  goalType: AgentGoalType | null
  /** The pattern ids that fired — the routing evidence. */
  matched: string[]
}
export type ParseResult = { ok: true; objective: ParsedObjective } | { ok: false; reason: string; examples: string[] }

export const OBJECTIVE_EXAMPLES = [
  "Find out why listing appointments dropped last month",
  "Increase seller business in <one of your farm territories> but don't increase spend more than $3,000/month",
  "Increase listing GCI 15%",
] as const

function windowOf(text: string): number {
  const n = /\b(?:last|past)\s+(\d{1,3})\s+days?\b/i.exec(text)
  if (n) return Math.max(1, Math.min(365, Number(n[1])))
  if (/\blast week\b/i.test(text)) return 7
  if (/\blast quarter\b/i.test(text)) return 90
  if (/\blast year\b/i.test(text)) return 365
  return 30 // "last month" and the unstated default
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
const wordIn = (hay: string, needle: string) => needle.length > 1 && new RegExp(`(?:^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(hay)

/** PURE: the territory the text names, judged ONLY against the tenant's own farm territories.
 *  @proofSeam the proof asserts match / refusal / ambiguity directly */
export function matchTerritory(text: string, candidates: readonly TerritoryCandidate[]): { territory: string | null; asked: string | null; refused: string | null } {
  const hay = norm(text)
  const inPhrase = /\b(?:in|around|across|near)\s+(.+)$/i.exec(text)
  let asked: string | null = null
  if (inPhrase) {
    const raw = inPhrase[1].split(PLACE_STOP)[0]?.trim() ?? ""
    if (raw && !/^(?:the\s+)?(?:last|past|q[1-4]|\d|this|next|our|my|general)\b/i.test(raw)) asked = raw
  }
  const hits = new Set<string>()
  for (const c of candidates) {
    const keys = [c.name, c.city].filter((x): x is string => !!x && !!x.trim()).map(norm)
    if (keys.some((k) => wordIn(hay, k))) hits.add(c.name)
  }
  if (hits.size > 1) return { territory: null, asked, refused: `the objective names more than one of your territories (${[...hits].join(", ")}) — name one` }
  if (hits.size === 1) return { territory: [...hits][0], asked, refused: null }
  if (asked) {
    const known = [...new Set(candidates.map((c) => c.name))]
    return { territory: null, asked, refused: known.length ? `"${asked}" is not one of your farm territories (${known.join(", ")})` : `"${asked}" is not a farm territory — this brokerage has no farm territories yet` }
  }
  return { territory: null, asked: null, refused: null }
}

/** PURE: route a broker's objective. Unrecognised text is REFUSED with examples — never guessed.
 *  @proofSeam the proof asserts every example and every refusal directly */
export function parseBrokerObjective(text: string, territories: readonly TerritoryCandidate[]): ParseResult {
  const t = String(text ?? "").trim()
  const examples = [...OBJECTIVE_EXAMPLES]
  if (!t) return { ok: false, reason: "An objective is required.", examples }
  const metricHit = OBJECTIVE_METRIC_PATTERNS.find((p) => p.re.test(t))
  if (!metricHit) return { ok: false, reason: "No measure the OS can read was named (listing appointments, seller conversion, seller business, leads, listings, closings, GCI, buyer clients, lead conversion, contacts).", examples }
  const matched = [`metric:${metricHit.metric}`]
  const pct = PCT_RE.exec(t); const cap = CAP_RE.exec(t)
  const capUsd = cap ? Number(cap[1].replace(/,/g, "")) * (cap[2] ? 1000 : 1) : null
  if (cap) matched.push("cap:usd_per_month")
  const base = { metric: metricHit.metric, windowDays: windowOf(t), spendCapUsdMonthly: capUsd, matched }

  if (INVESTIGATE_RE.test(t) && (DROP_RE.test(t) || RISE_RE.test(t))) {
    matched.push("kind:investigation")
    return { ok: true, objective: { ...base, kind: "investigation", direction: DROP_RE.test(t) ? "down" : "up", territory: null, targetPct: null, goalType: null } }
  }
  if (!GROW_RE.test(t)) return { ok: false, reason: "Ask WHY a measure moved (an investigation) or ask to INCREASE one (a proposal or a delegated goal).", examples }
  const place = matchTerritory(t, territories)
  if (place.refused) return { ok: false, reason: place.refused, examples }
  if (place.territory) matched.push("territory:farm_territories")
  const goal = GOAL_OF_METRIC[metricHit.metric] ?? null
  if (pct && goal) {
    matched.push("kind:delegation")
    return { ok: true, objective: { ...base, kind: "delegation", direction: "up", territory: place.territory, targetPct: Number(pct[1]), goalType: goal } }
  }
  if (DIRECTIVE_METRICS.has(metricHit.metric) || place.territory || capUsd !== null) {
    matched.push("kind:directive")
    return { ok: true, objective: { ...base, kind: "directive", direction: "up", territory: place.territory, targetPct: pct ? Number(pct[1]) : null, goalType: goal } }
  }
  return { ok: false, reason: `"${metricHit.metric}" can be increased only with a % target (e.g. "Increase listing GCI 15%").`, examples }
}

/** The tenant's own territories (active farm_territories) — the ONLY place vocabulary. A refused
 *  read is returned (the caller refuses the objective), never an empty list read as "no territories". */
async function loadTerritoryCandidates(svc: Client, brokerageId: string): Promise<{ territories: TerritoryCandidate[]; refused: string | null }> {
  const { data, error } = await svc.from("farm_territories").select("name, city, state, is_active").eq("brokerage_id", brokerageId).limit(500)
  if (error) return { territories: [], refused: error.message }
  const rows = ((data ?? []) as Array<{ name: string | null; city: string | null; state: string | null; is_active: boolean | null }>).filter((r) => r.is_active !== false && r.name)
  return { territories: rows.map((r) => ({ name: String(r.name), city: r.city, state: r.state })), refused: null }
}

// ─── 2. THE EVIDENCE FACTS (period over period, tenant-pinned, refusals named) ────────────────────
export interface Window2 { current: number; previous: number }
export interface ObjectiveEvidenceFacts {
  brokerageId: string
  at: string
  windowDays: number
  listingAppointments: Window2
  leads: Window2
  sellerLeads: Window2
  sellerLeadsConverted: Window2
  /** WAVE 137 — seller-side CONTACTS (contact_type seller | both) created per window: the listing
   *  appointment rate's denominator (one vocabulary with the twin; inbound sellers arrive as contacts). */
  sellerContacts: Window2
  /** Wave 137E: every lead linked to a contact (the lead → contact conversion), any lead type. */
  leadsConverted: Window2
  sourceMix: { current: SourceConversion[]; previous: SourceConversion[] }
  intake: { current: FunnelCounts; previous: FunnelCounts }
  ads: { spendCents: Window2; leads: Window2; conversions: Window2 }
  campaigns: { touches: Window2; executions: Window2; replied: Window2; converted: Window2 }
  closings: { count: Window2; gciCents: Window2 }
  /** The twin's capacity (present state) + its snapshot diff — null when no twin. */
  capacity: { activeAgents: number; overOrAt: number; headroom: number; headroomDelta: number | null; previousAt: string | null } | null
  /** Named limits: refused reads, row caps, present-state-only facts. */
  blindSpots: string[]
}

const ROW_CAP = 5000
const cents = (n: unknown) => Math.round((Number(n) || 0) * 100)

/** Read the two windows [at−2w, at−w) and [at−w, at) of every survivor table the checks judge. */
async function loadObjectiveEvidenceFacts(svc: Client, brokerageId: string, opts: { at: Date; windowDays: number; twin: BrokerageTwin | null }): Promise<ObjectiveEvidenceFacts> {
  const w = opts.windowDays * 86_400_000
  const atIso = opts.at.toISOString(), mid = new Date(opts.at.getTime() - w).toISOString(), start = new Date(opts.at.getTime() - 2 * w).toISOString()
  const blindSpots: string[] = []
  const rows = async <T,>(what: string, q: any): Promise<T[]> => {
    const { data, error } = await q
    if (error) { blindSpots.push(`${what}: refused — ${error.message ?? "unknown"}`); return [] }
    const list = (data ?? []) as T[]
    if (list.length >= ROW_CAP) blindSpots.push(`${what}: row cap ${ROW_CAP} hit — counts are a floor`)
    return list
  }
  const span = (q: any, col: string) => q.eq("brokerage_id", brokerageId).gte(col, start).lt(col, atIso).limit(ROW_CAP)
  const split = <T,>(list: T[], at: (r: T) => string | null | undefined) => {
    const cur: T[] = [], prev: T[] = []
    for (const r of list) { const v = at(r) ?? ""; if (v >= mid && v < atIso) cur.push(r); else if (v >= start && v < mid) prev.push(r) }
    return { cur, prev }
  }
  const n2 = <T,>(s: { cur: T[]; prev: T[] }, f: (r: T) => boolean = () => true): Window2 => ({ current: s.cur.filter(f).length, previous: s.prev.filter(f).length })
  const sum2 = <T,>(s: { cur: T[]; prev: T[] }, v: (r: T) => number): Window2 => ({ current: s.cur.reduce((a, r) => a + v(r), 0), previous: s.prev.reduce((a, r) => a + v(r), 0) })

  const [appts, leads, raw, ads, touches, execs, conv, closed, sellerContactRows] = await Promise.all([
    rows<{ appointment_at: string | null }>("listing_presentations", span(svc.from("listing_presentations").select("appointment_at"), "appointment_at")),
    rows<{ source: string | null; contact_id: string | null; lead_type: string | null; created_at: string }>("leads", span(svc.from("leads").select("source, contact_id, lead_type, created_at"), "created_at")),
    rows<{ source: string | null; processing_status: string | null; lead_id: string | null; created_at: string }>("raw_scraped_leads", span(svc.from("raw_scraped_leads").select("source, processing_status, lead_id, created_at"), "created_at")),
    rows<{ spend: number | null; leads: number | null; conversions: number | null; captured_at: string | null }>("ad_performance", span(svc.from("ad_performance").select("spend, leads, conversions, captured_at"), "captured_at")),
    rows<{ created_at: string }>("marketing_campaign_touchpoints", span(svc.from("marketing_campaign_touchpoints").select("created_at"), "created_at")),
    rows<{ created_at: string; replied_at: string | null }>("sequence_step_executions", span(svc.from("sequence_step_executions").select("created_at, replied_at"), "created_at")),
    rows<{ converted_at: string | null }>("sequence_enrollments", span(svc.from("sequence_enrollments").select("converted_at"), "converted_at")),
    rows<{ close_date: string | null; commission_amount: number | null }>("transactions(closed)", svc.from("transactions").select("close_date, commission_amount").eq("brokerage_id", brokerageId).is("deleted_at", null).in("status", ["closed", "funded"]).gte("close_date", start.slice(0, 10)).lt("close_date", atIso.slice(0, 10)).limit(ROW_CAP)),
    rows<{ created_at: string }>("contacts(seller)", span(svc.from("contacts").select("created_at").eq("brokerage_id", brokerageId).is("deleted_at", null).in("contact_type", [...SELLER_SIDE_CONTACT_TYPES]), "created_at")),
  ])
  const a = split(appts, (r) => r.appointment_at), l = split(leads, (r) => r.created_at), rw = split(raw, (r) => r.created_at)
  const ad = split(ads, (r) => r.captured_at), tp = split(touches, (r) => r.created_at), ex = split(execs, (r) => r.created_at)
  const cv = split(conv, (r) => r.converted_at), cl = split(closed, (r) => (r.close_date ? `${r.close_date.slice(0, 10)}T00:00:00.000Z` : null))
  const isSeller = (r: { lead_type: string | null }) => r.lead_type === "seller" || r.lead_type === "both"

  let capacity: ObjectiveEvidenceFacts["capacity"] = null
  if (opts.twin) {
    const c = opts.twin.capacity
    const hd = opts.twin.changed.changes.find((x) => x.field === "capacity.headroom")
    capacity = { activeAgents: c.activeAgents, overOrAt: (c.bands.over ?? 0) + (c.bands.at_capacity ?? 0), headroom: c.headroom, headroomDelta: hd ? hd.delta : opts.twin.changed.baseline ? null : 0, previousAt: opts.twin.changed.previousAt }
    blindSpots.push("capacity is the twin's PRESENT state (capacityFor) diffed against its last snapshot — not an as-of reading for the earlier window")
    for (const b of opts.twin.blindSpots) blindSpots.push(`twin: ${b}`)
  } else blindSpots.push("the brokerage twin could not be built — capacity is unmeasured")

  const lite = (r: { source: string | null; contact_id: string | null }) => ({ source: r.source, contact_id: r.contact_id, ai_isa_owner: null, lead_score: null, notes: null })
  const rawLite = (r: { source: string | null; processing_status: string | null; lead_id: string | null }) => ({ source: r.source, processing_status: r.processing_status, lead_id: r.lead_id })
  return {
    brokerageId, at: atIso, windowDays: opts.windowDays,
    listingAppointments: n2(a), leads: n2(l), sellerLeads: n2(l, isSeller), sellerLeadsConverted: n2(l, (r) => isSeller(r) && !!r.contact_id), leadsConverted: n2(l, (r) => !!r.contact_id),
    sellerContacts: n2(split(sellerContactRows, (r) => r.created_at)),
    sourceMix: { current: groupBySource(rw.cur.map(rawLite), l.cur.map(lite)), previous: groupBySource(rw.prev.map(rawLite), l.prev.map(lite)) },
    intake: { current: computeFunnel(rw.cur.map(rawLite)), previous: computeFunnel(rw.prev.map(rawLite)) },
    ads: { spendCents: sum2(ad, (r) => cents(r.spend)), leads: sum2(ad, (r) => Number(r.leads) || 0), conversions: sum2(ad, (r) => Number(r.conversions) || 0) },
    campaigns: { touches: n2(tp), executions: n2(ex), replied: n2(ex, (r) => !!r.replied_at), converted: n2(cv) },
    closings: { count: n2(cl), gciCents: sum2(cl, (r) => cents(r.commission_amount)) },
    capacity, blindSpots,
  }
}

// ─── 3. THE PURE EVIDENCE CHECKS (one per participating manager) ──────────────────────────────────
export interface EvidenceFinding {
  manager: ManagerKey
  key: string
  label: string
  previous: number
  current: number
  /** % change current vs previous; null when previous is 0 (a move from nothing has no %). */
  deltaPct: number | null
  /** The move is in the HARMFUL direction for this measure (down for volume / rates, up for cost). */
  adverse: boolean
  unit: "count" | "rate" | "cents"
  /** The survivor (table + writer) the numbers were read from. */
  reader: string
  lowSample: boolean
}
const MIN_SAMPLE = 5
const pct = (prev: number, cur: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10)
const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : 0)
function finding(manager: ManagerKey, key: string, label: string, w: Window2, o: { badWhen: "down" | "up"; unit?: EvidenceFinding["unit"]; reader: string; sample?: number }): EvidenceFinding {
  const d = w.current - w.previous
  return { manager, key, label, previous: w.previous, current: w.current, deltaPct: pct(w.previous, w.current), adverse: o.badWhen === "down" ? d < 0 : d > 0, unit: o.unit ?? "count", reader: o.reader, lowSample: (o.sample ?? Math.max(w.previous, w.current)) < MIN_SAMPLE }
}

export const INVESTIGATORS = ["data_steward", "ai_isa", "campaign_orchestrator", "ads_manager", "listing_concierge", "finance_manager"] as const satisfies readonly ManagerKey[]
export type Investigator = (typeof INVESTIGATORS)[number]

/** Each participant's capability (a catalogue key it OWNS — CAPABILITY_MANAGER; the 105A delegation
 *  refuses any other) and its pure check over the facts.
 *  @proofSeam the proof runs every check against fixtures and asserts each capability's owner */
export const EVIDENCE_CHECKS: Readonly<Record<Investigator, { capability: AppCapability; answers: string; check: (f: ObjectiveEvidenceFacts) => EvidenceFinding[] }>> = {
  data_steward: {
    capability: "connectivity_scan", answers: "is the data arriving — intake volume, rejection, source mix",
    check: (f) => {
      const out: EvidenceFinding[] = [
        finding("data_steward", "intake_raw", "raw intake rows", { current: f.intake.current.rawTotal, previous: f.intake.previous.rawTotal }, { badWhen: "down", reader: "raw_scraped_leads (lead-intake cockpit computeFunnel)" }),
        finding("data_steward", "intake_rejection_rate", "intake rejection rate", { current: rate(f.intake.current.rejected, f.intake.current.rawTotal), previous: rate(f.intake.previous.rejected, f.intake.previous.rawTotal) }, { badWhen: "up", unit: "rate", reader: "raw_scraped_leads.processing_status (computeFunnel)", sample: Math.min(f.intake.current.rawTotal, f.intake.previous.rawTotal) }),
      ]
      // SOURCE MIX: a source whose lead count fell is a named finding (largest falls first, bounded).
      const prev = new Map(f.sourceMix.previous.map((s) => [s.source, s.leadCount]))
      const cur = new Map(f.sourceMix.current.map((s) => [s.source, s.leadCount]))
      const sources = [...new Set([...prev.keys(), ...cur.keys()])].map((s) => ({ s, p: prev.get(s) ?? 0, c: cur.get(s) ?? 0 })).filter((x) => x.c < x.p).sort((x, y) => (y.p - y.c) - (x.p - x.c) || x.s.localeCompare(y.s)).slice(0, 3)
      for (const x of sources) out.push(finding("data_steward", `source_mix:${x.s}`, `leads from source "${x.s}"`, { current: x.c, previous: x.p }, { badWhen: "down", reader: "leads.source (lead-intake cockpit groupBySource)" }))
      return out
    },
  },
  ai_isa: {
    capability: "lead_search", answers: "did the funnel feed — lead volume, seller leads, seller lead → contact conversion",
    check: (f) => [
      finding("ai_isa", "leads", "new leads", f.leads, { badWhen: "down", reader: "leads.created_at (lead intake)" }),
      finding("ai_isa", "seller_leads", "new seller leads", f.sellerLeads, { badWhen: "down", reader: "leads.lead_type ∈ {seller, both}" }),
      finding("ai_isa", "seller_conversion_rate", "seller lead → contact conversion", { current: rate(f.sellerLeadsConverted.current, f.sellerLeads.current), previous: rate(f.sellerLeadsConverted.previous, f.sellerLeads.previous) }, { badWhen: "down", unit: "rate", reader: "leads.contact_id on seller leads (the conversion link)", sample: Math.min(f.sellerLeads.current, f.sellerLeads.previous) }),
      // wave 137E: the whole funnel, not only sellers (a floor — ads / forms / widgets convert DIRECTLY to contacts)
      finding("ai_isa", "lead_conversions", "leads converted to contacts", f.leadsConverted, { badWhen: "down", reader: "leads.contact_id (the conversion link; direct-to-contact captures are not leads)" }),
      finding("ai_isa", "lead_conversion_rate", "lead → contact conversion", { current: rate(f.leadsConverted.current, f.leads.current), previous: rate(f.leadsConverted.previous, f.leads.previous) }, { badWhen: "down", unit: "rate", reader: "leads.contact_id ÷ leads", sample: Math.min(f.leads.current, f.leads.previous) }),
    ],
  },
  campaign_orchestrator: {
    capability: "campaign_performance_report", answers: "did nurture keep working — touches, replies, conversions",
    check: (f) => [
      finding("campaign_orchestrator", "campaign_touches", "campaign touches sent", f.campaigns.touches, { badWhen: "down", reader: "marketing_campaign_touchpoints (campaign-sequences touch writers)" }),
      finding("campaign_orchestrator", "sequence_reply_rate", "sequence reply rate", { current: rate(f.campaigns.replied.current, f.campaigns.executions.current), previous: rate(f.campaigns.replied.previous, f.campaigns.executions.previous) }, { badWhen: "down", unit: "rate", reader: "sequence_step_executions.replied_at (provider-event fan-out)", sample: Math.min(f.campaigns.executions.current, f.campaigns.executions.previous) }),
      finding("campaign_orchestrator", "sequence_conversions", "sequence conversions", f.campaigns.converted, { badWhen: "down", reader: "sequence_enrollments.converted_at (sequence-conversion)" }),
    ],
  },
  ads_manager: {
    capability: "ads_performance_report", answers: "did paid acquisition hold — spend, leads, cost per lead",
    check: (f) => [
      finding("ads_manager", "ad_spend", "ad spend", f.ads.spendCents, { badWhen: "down", unit: "cents", reader: "ad_performance.spend (ad-performance ingest)", sample: Math.max(f.ads.leads.current, f.ads.leads.previous) }),
      finding("ads_manager", "ad_leads", "paid leads", f.ads.leads, { badWhen: "down", reader: "ad_performance.leads (ad-performance ingest)" }),
      finding("ads_manager", "cost_per_lead", "cost per paid lead", { current: f.ads.leads.current ? Math.round(f.ads.spendCents.current / f.ads.leads.current) : 0, previous: f.ads.leads.previous ? Math.round(f.ads.spendCents.previous / f.ads.leads.previous) : 0 }, { badWhen: "up", unit: "cents", reader: "ad_performance spend ÷ leads", sample: Math.min(f.ads.leads.current, f.ads.leads.previous) }),
    ],
  },
  listing_concierge: {
    capability: "listing_demand_report", answers: "did seller demand reach appointments — appointments, appointment rate, capacity",
    check: (f) => {
      const out = [
        finding("listing_concierge", "listing_appointments", "listing appointments", f.listingAppointments, { badWhen: "down", reader: "listing_presentations.appointment_at (the listing-appointment prep chain)" }),
        // WAVE 137 owner ruling: the rate is per seller CONTACT (contact_type seller | both) — inbound sellers
        // arrive as contacts and only a contact is presented to; seller LEADS stay the AI ISA's funnel finding.
        finding("listing_concierge", "appointment_rate", "listing appointments per seller contact", { current: rate(f.listingAppointments.current, f.sellerContacts.current), previous: rate(f.listingAppointments.previous, f.sellerContacts.previous) }, { badWhen: "down", unit: "rate", reader: "listing_presentations ÷ seller contacts (contacts.contact_type ∈ {seller, both})", sample: Math.min(f.sellerContacts.current, f.sellerContacts.previous) }),
      ]
      if (f.capacity && f.capacity.headroomDelta !== null) out.push(finding("listing_concierge", "agent_headroom", "agent headroom (capacityFor)", { current: f.capacity.headroom, previous: f.capacity.headroom - f.capacity.headroomDelta }, { badWhen: "down", reader: `brokerage twin capacity (capacityFor) vs snapshot ${f.capacity.previousAt ?? "?"}` }))
      return out
    },
  },
  finance_manager: {
    capability: "report_generate", answers: "what it cost and what closed — closings, GCI, cost per appointment",
    check: (f) => [
      finding("finance_manager", "closed_count", "closed deals", f.closings.count, { badWhen: "down", reader: "transactions.status ∈ {closed, funded} by close_date" }),
      finding("finance_manager", "closed_gci", "closed GCI", f.closings.gciCents, { badWhen: "down", unit: "cents", reader: "transactions.commission_amount (closed)", sample: Math.max(f.closings.count.current, f.closings.count.previous) }),
      finding("finance_manager", "cost_per_appointment", "paid spend per listing appointment", { current: f.listingAppointments.current ? Math.round(f.ads.spendCents.current / f.listingAppointments.current) : 0, previous: f.listingAppointments.previous ? Math.round(f.ads.spendCents.previous / f.listingAppointments.previous) : 0 }, { badWhen: "up", unit: "cents", reader: "ad_performance.spend ÷ listing_presentations", sample: Math.min(f.listingAppointments.current, f.listingAppointments.previous) }),
    ],
  },
}

/** The finding that IS the objective's measure (the premise the broker stated). */
export const OBSERVED_KEY: Readonly<Record<ObjectiveMetric, string>> = {
  listing_appointments: "listing_appointments", seller_conversion: "seller_conversion_rate", seller_leads: "seller_leads",
  seller_business: "seller_leads", leads: "leads", listing_gci: "closed_gci", gci: "closed_gci", closings: "closed_count", listings: "listing_appointments",
  // wave 137E: buyer representation has no period-over-period evidence reader yet → the premise reads "unmeasured"
  buyer_clients: "buyer_clients", pipeline_conversion: "lead_conversion_rate", contacts: "lead_conversions",
}
/** How strongly a finding can explain the objective's measure (0..1). Unlisted = 0.5. Source-mix keys
 *  match on their prefix. @proofSeam the proof asserts ranking against it */
export const CAUSE_RELEVANCE: Readonly<Partial<Record<ObjectiveMetric, Readonly<Record<string, number>>>>> = {
  listing_appointments: { seller_leads: 1, seller_conversion_rate: 0.9, appointment_rate: 0.9, ad_leads: 0.8, agent_headroom: 0.8, "source_mix": 0.7, intake_rejection_rate: 0.7, sequence_conversions: 0.7, sequence_reply_rate: 0.6, ad_spend: 0.6, cost_per_lead: 0.6, intake_raw: 0.6, leads: 0.6, campaign_touches: 0.5, closed_count: 0.1, closed_gci: 0.1, cost_per_appointment: 0.3 },
  seller_conversion: { sequence_reply_rate: 0.9, sequence_conversions: 0.9, agent_headroom: 0.8, campaign_touches: 0.7, "source_mix": 0.7, cost_per_lead: 0.5, intake_rejection_rate: 0.5, closed_count: 0.1, closed_gci: 0.1 },
}
const MIN_MOVE_PCT = 10
export interface RankedCause extends EvidenceFinding { rank: number; score: number; relevance: number }
export interface EvidenceReport {
  objective: string
  metric: ObjectiveMetric
  windowDays: number
  at: string
  observed: EvidenceFinding | null
  /** confirmed = the measure moved the way the broker said; not_observed = the readers do not show it. */
  premise: "confirmed" | "not_observed" | "unmeasured"
  causes: RankedCause[]
  findings: EvidenceFinding[]
  delegations: Array<{ manager: Investigator; capability: AppCapability; delegationId: string | null; status: string; refused: string | null }>
  blindSpots: string[]
  headline: string
}

/** PURE: rank the adverse moves that can explain the observed one (|Δ%| × relevance, a low sample
 *  halved), deterministic tie-break on key. @proofSeam the proof asserts the ranking directly */
export function rankContributingCauses(findings: readonly EvidenceFinding[], metric: ObjectiveMetric): RankedCause[] {
  const table = CAUSE_RELEVANCE[metric] ?? {}
  const observed = OBSERVED_KEY[metric]
  return findings
    .filter((f) => f.key !== observed && f.adverse && f.deltaPct !== null && Math.abs(f.deltaPct) >= MIN_MOVE_PCT)
    .map((f) => {
      const relevance = table[f.key] ?? table[f.key.split(":")[0]] ?? 0.5
      return { ...f, relevance, score: Math.round(Math.abs(f.deltaPct!) * relevance * (f.lowSample ? 0.5 : 1) * 10) / 10, rank: 0 }
    })
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .map((c, i) => ({ ...c, rank: i + 1 }))
}

const fmt = (f: Pick<EvidenceFinding, "unit">, v: number) => (f.unit === "cents" ? `$${(v / 100).toFixed(0)}` : f.unit === "rate" ? `${(v * 100).toFixed(1)}%` : String(v))
/** PURE: the deterministic headline (a model may re-phrase it for display; it never decides it). */
function evidenceHeadline(r: Pick<EvidenceReport, "observed" | "premise" | "causes" | "windowDays" | "metric">): string {
  const o = r.observed
  const what = o ? `${o.label}: ${fmt(o, o.previous)} → ${fmt(o, o.current)}${o.deltaPct !== null ? ` (${o.deltaPct > 0 ? "+" : ""}${o.deltaPct}%)` : ""} over ${r.windowDays}d vs the ${r.windowDays}d before` : `${r.metric}: unmeasured`
  const premise = r.premise === "not_observed" ? " — the readers do NOT show the move you described" : ""
  const top = r.causes.slice(0, 3).map((c) => `${c.label} ${c.deltaPct! > 0 ? "+" : ""}${c.deltaPct}% (${MANAGERS[c.manager]?.label ?? c.manager})`)
  return `${what}${premise}. ${top.length ? `Likely causes: ${top.join("; ")}.` : "No contributing cause moved ≥ " + MIN_MOVE_PCT + "% in the readers."}`
}

// ─── deps (test seams; every default is THE survivor) ────────────────────────────────────────────
export interface BrokerObjectiveDeps {
  now?: () => Date
  twin?: (svc: Client, brokerageId: string) => Promise<BrokerageTwin | null>
  scenarioFacts?: (svc: Client, brokerageId: string) => Promise<ScenarioFacts>
  strategy?: (svc: Client, brokerageId: string, capUsd: number | null) => Promise<RecommendedStrategy | null>
  mission?: MissionDeps
  delegation?: DelegationDeps
}
export interface RecommendedStrategy { key: string; title: string; source: "active" | "library"; why: string; averageCostUsd: number | null; activationNeeded: boolean }

const defaults: Required<Omit<BrokerObjectiveDeps, "mission" | "delegation">> = {
  now: () => new Date(),
  twin: async (svc, b) => {
    const { readBrokerageTwin } = await import("@/lib/kernel/brokerage-twin")
    return (await readBrokerageTwin(b, { svc, snapshot: {} })) ?? (await readBrokerageTwin(b, { svc }))
  },
  scenarioFacts: async (svc, b) => {
    const { loadScenarioFacts } = await import("@/lib/kernel/twin-scenario")
    const { GENERATION_COST_ESTIMATE_USD, MAX_MEDIA_VARIANTS } = await import("@/lib/kernel/media-intelligence")
    return { ...(await loadScenarioFacts(svc, b)), mediaCostUsd: GENERATION_COST_ESTIMATE_USD, mediaVariants: MAX_MEDIA_VARIANTS }
  },
  strategy: async (svc, b, capUsd) => {
    const { selectStrategies, listStrategyLibrary } = await import("@/lib/kernel/strategy-engine")
    const sel = await selectStrategies({ brokerageId: b, manager: "listing_concierge", facts: null }, svc)
    const top = sel.ranked[0]
    if (top) return { key: top.definition.key, title: top.definition.title, source: "active", why: top.why, averageCostUsd: null, activationNeeded: false }
    const lib = await listStrategyLibrary(b, svc)
    const fit = lib.entries.filter((e) => e.latest && e.managers.includes("listing_concierge") && (capUsd === null || e.averageCostUsd <= capUsd)).sort((x, y) => x.averageCostUsd - y.averageCostUsd || x.key.localeCompare(y.key))[0]
    return fit ? { key: fit.key, title: fit.label, source: "library", why: `platform library: ${fit.objective}`, averageCostUsd: fit.averageCostUsd, activationNeeded: true } : null
  },
}
async function svcOf(client?: Client): Promise<Client> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Client
}

export interface ObjectiveInput { brokerageId: string; text: string; objective: ParsedObjective; actorUserId: string }
type InvestigationResult = { ok: true; mission: MissionRow; report: EvidenceReport } | { ok: false; reason: string }

// ─── 4. INVESTIGATION → evidence report ──────────────────────────────────────────────────────────
async function runInvestigation(input: ObjectiveInput, client?: Client, deps: BrokerObjectiveDeps = {}): Promise<InvestigationResult> {
  const d = { ...defaults, ...deps }
  const svc = await svcOf(client)
  const actor: MissionActor = { type: "user", id: input.actorUserId }
  const created = await createMission({
    brokerageId: input.brokerageId, objective: input.text, missionType: "brokerage_objective", ownerManager: "cron_manager",
    participatingManagers: [...INVESTIGATORS], createdBy: input.actorUserId, actor, initialState: "ACTIVE",
  }, svc, deps.mission)
  if (!created.ok) return { ok: false, reason: created.reason }
  const mission = created.mission
  await attachEvidence({ brokerageId: input.brokerageId, missionId: mission.id, actor, evidence: { kind: "broker_objective", ref: `broker_objective:${mission.id}`, parsed: input.objective } }, svc, deps.mission)

  const twin = await d.twin(svc, input.brokerageId)
  const facts = await loadObjectiveEvidenceFacts(svc, input.brokerageId, { at: d.now(), windowDays: input.objective.windowDays, twin })
  const controller: MissionActor = { type: "manager", id: "cron_manager" }
  const findings: EvidenceFinding[] = []
  const delegations: EvidenceReport["delegations"] = []
  const blindSpots = [...facts.blindSpots]
  for (const manager of INVESTIGATORS) {
    const spec = EVIDENCE_CHECKS[manager]
    const own = spec.check(facts)
    findings.push(...own)
    // THE 105A DELEGATION: the controller asks, the manager accepts, works, and returns its evidence.
    const req = await requestDelegation({
      brokerageId: input.brokerageId, missionId: mission.id, requestingManager: "cron_manager", assignedManager: manager, capability: spec.capability,
      objective: `Evidence for "${input.text}": ${spec.answers}`, inputEntities: { objective_kind: "investigation", metric: input.objective.metric, window_days: facts.windowDays, at: facts.at },
      requiredOutput: { findings: "period-over-period measures with the reader that produced each" }, authority: 0, budget: {}, actor: controller,
    }, svc, deps.delegation)
    if (!req.ok) {
      delegations.push({ manager, capability: spec.capability, delegationId: null, status: "REFUSED", refused: req.reason })
      blindSpots.push(`${manager}: delegation refused (${req.reason}) — its check ran inside the controller and is reported, but it was NOT delegated`)
      continue
    }
    const who: MissionActor = { type: "manager", id: manager }
    const acc = await acceptDelegation({ brokerageId: input.brokerageId, delegationId: req.delegation.id, reason: "evidence check accepted", actor: who }, svc, deps.delegation)
    const work = acc.ok ? await startDelegationWork({ brokerageId: input.brokerageId, delegationId: req.delegation.id, reason: "evidence check running", actor: who }, svc, deps.delegation) : acc
    const ret = work.ok ? await returnDelegationResult({ brokerageId: input.brokerageId, delegationId: req.delegation.id, actor: who, reason: "evidence returned", costUsd: 0, tokens: 0, result: { findings: own } }, svc, deps.delegation) : work
    delegations.push({ manager, capability: spec.capability, delegationId: req.delegation.id, status: ret.ok ? ret.delegation.status : "STUCK", refused: ret.ok ? null : ret.reason })
    if (!ret.ok) blindSpots.push(`${manager}: delegation ${req.delegation.id} did not return (${ret.reason})`)
  }

  const observed = findings.find((f) => f.key === OBSERVED_KEY[input.objective.metric]) ?? null
  const moved = observed ? (input.objective.direction === "down" ? observed.current < observed.previous : observed.current > observed.previous) : false
  const premise: EvidenceReport["premise"] = !observed ? "unmeasured" : moved ? "confirmed" : "not_observed"
  const causes = rankContributingCauses(findings, input.objective.metric)
  const base = { objective: input.text, metric: input.objective.metric, windowDays: facts.windowDays, at: facts.at, observed, premise, causes, findings, delegations, blindSpots }
  const report: EvidenceReport = { ...base, headline: evidenceHeadline(base) }

  await attachEvidence({ brokerageId: input.brokerageId, missionId: mission.id, actor: controller, evidence: { kind: "evidence_report", ref: `evidence_report:${mission.id}`, report } }, svc, deps.mission)
  const done = await completeMission({ brokerageId: input.brokerageId, missionId: mission.id, reason: `evidence report returned: ${report.headline}`, actor: controller }, svc, deps.mission)
  return { ok: true, mission: done.ok ? done.mission : mission, report }
}

// ─── 5. DIRECTIVE → a PROPOSAL (APPROVAL_REQUIRED, never executed) ───────────────────────────────
export interface ObjectiveProposal {
  objective: string
  territory: string | null
  spendCapUsdMonthly: number | null
  levers: ScenarioLevers | null
  projection: { addedLeads30d: number; addedListings30d: number; addedCloses30d: number; addedRevenueCents: number; costCents: number; marginCents: number; firstSaturated: string | null } | null
  budgetUsdMonthly: number
  strategy: RecommendedStrategy | null
  /** Why no lift was proposed, when none fits. */
  reason: string | null
  assumptions: string[]
}

/** PURE: the seller lift the twin projects as best (largest margin) that fits the cap and saturates no
 *  stage. Cost is monotone in the lever, so the sweep stops at the first step over the cap.
 *  @proofSeam the proof asserts the cap is honoured and the choice directly */
export function fitLiftToCap(twin: BrokerageTwin, facts: ScenarioFacts, o: { territories: string[]; capCents: number | null; lever?: "seller_lead_acquisition_pct" }): { levers: ScenarioLevers; projection: ScenarioProjection } | null {
  let best: { levers: ScenarioLevers; projection: ScenarioProjection } | null = null
  for (let p = SATURATION_SWEEP_STEP; p <= SATURATION_SWEEP_MAX; p += SATURATION_SWEEP_STEP) {
    const levers: ScenarioLevers = { seller_lead_acquisition_pct: p, ...(o.territories.length ? { territory_activation: o.territories } : {}) }
    const pr = simulateScenario({ brokerageId: twin.brokerageId, levers }, twin, facts)
    if (o.capCents !== null && pr.marketingCost.totalCents > o.capCents) break
    if (pr.staffingConstraint.saturatedNow.length > 0) break
    if (!best || pr.expectedMarginCents > best.projection.expectedMarginCents) best = { levers, projection: pr }
  }
  return best
}

const projOf = (p: ScenarioProjection): NonNullable<ObjectiveProposal["projection"]> => ({ addedLeads30d: p.opportunityGain.addedLeads30d, addedListings30d: p.opportunityGain.addedListings30d, addedCloses30d: p.opportunityGain.addedCloses30d, addedRevenueCents: p.opportunityGain.addedRevenueCents, costCents: p.marketingCost.totalCents, marginCents: p.expectedMarginCents, firstSaturated: p.staffingConstraint.firstSaturated })

async function proposeDirective(input: ObjectiveInput, client?: Client, deps: BrokerObjectiveDeps = {}): Promise<{ ok: true; mission: MissionRow; proposal: ObjectiveProposal } | { ok: false; reason: string }> {
  const d = { ...defaults, ...deps }
  const svc = await svcOf(client)
  const twin = await d.twin(svc, input.brokerageId)
  if (!twin || twin.brokerageId !== input.brokerageId) return { ok: false, reason: "The brokerage twin could not be built — no proposal without it." }
  const facts = await d.scenarioFacts(svc, input.brokerageId)
  const cap = input.objective.spendCapUsdMonthly
  const fit = fitLiftToCap(twin, facts, { territories: input.objective.territory ? [input.objective.territory] : [], capCents: cap === null ? null : Math.round(cap * 100) })
  const strategy = await d.strategy(svc, input.brokerageId, cap)
  const proposal: ObjectiveProposal = {
    objective: input.text, territory: input.objective.territory, spendCapUsdMonthly: cap,
    levers: fit?.levers ?? null, projection: fit ? projOf(fit.projection) : null,
    budgetUsdMonthly: fit ? Math.round(fit.projection.marketingCost.totalCents) / 100 : 0, strategy,
    reason: fit ? null : cap !== null ? `no seller lift fits within $${cap}/month without saturating a stage` : "no seller lift projects without saturating a stage",
    assumptions: fit ? fit.projection.assumptions.map((a) => `${a.key}: ${a.source} (${a.confidence})`) : [],
  }
  const listings = readTwinMeasure(twin, "now.listings.active")
  const criteria: SuccessCriterion[] = fit && listings !== null && fit.projection.opportunityGain.addedListings30d > 0 ? [{ metric: "now.listings.active", op: ">=", target: listings + fit.projection.opportunityGain.addedListings30d }] : []
  const participants = fit ? [...new Set(fit.projection.chain.filter((s) => (s.demand ?? 0) > 0).map((s) => s.manager))].filter((k) => k !== "listing_concierge") : []
  const created = await createMission({
    brokerageId: input.brokerageId, objective: input.text, missionType: "brokerage_objective", ownerManager: "listing_concierge",
    participatingManagers: participants, successCriteria: criteria, budget: { usd: proposal.budgetUsdMonthly, on_exhausted: "APPROVAL_REQUIRED" },
    createdBy: input.actorUserId, actor: { type: "user", id: input.actorUserId }, initialState: "PLANNING",
  }, svc, deps.mission)
  if (!created.ok) return { ok: false, reason: created.reason }
  await attachEvidence({ brokerageId: input.brokerageId, missionId: created.mission.id, actor: { type: "manager", id: "cron_manager" }, evidence: { kind: "objective_proposal", ref: `objective_proposal:${created.mission.id}`, parsed: input.objective, proposal, scenario_digest: fit?.projection.digest ?? null } }, svc, deps.mission)
  // A PROPOSAL, never blind execution: the mission waits on the human who asked (the transition
  // notifies them and signals the owner). Nothing is delegated, activated or sent from here.
  const held = await transitionMission({ brokerageId: input.brokerageId, missionId: created.mission.id, to: "APPROVAL_REQUIRED", reason: `proposal: ${fit ? `seller lift +${fit.levers.seller_lead_acquisition_pct}%${input.objective.territory ? ` in ${input.objective.territory}` : ""} at $${proposal.budgetUsdMonthly}/month${cap !== null ? ` (cap $${cap})` : ""}` : proposal.reason} — approve to start`, actor: { type: "manager", id: "cron_manager" } }, svc, deps.mission)
  return { ok: true, mission: held.ok ? held.mission : created.mission, proposal }
}

// ─── 6. OBJECTIVE DELEGATION → parent + child missions per manager ───────────────────────────────
export const DELEGATION_CHAIN = ["territory_opportunities", "marketing", "isa", "capacity", "recruiting", "education", "media", "budget"] as const
export type DelegationStep = (typeof DELEGATION_CHAIN)[number]
export interface DelegationChild {
  manager: ManagerKey
  steps: DelegationStep[]
  subTarget: string
  criteria: SuccessCriterion[]
  budgetUsd: number
  evidence: Record<string, unknown>
}
export interface DelegationPlan {
  goalType: AgentGoalType
  current: number | null
  target: number | null
  neededPer30d: number | null
  levers: ScenarioLevers | null
  projection: ObjectiveProposal["projection"]
  totalBudgetUsd: number
  territories: string[]
  shortfall: string | null
  children: DelegationChild[]
}

/** PURE: goal → territory opportunities → marketing → ISA → capacity → recruiting → education →
 *  media → budget, one CHILD per manager (a manager owning several steps carries them together),
 *  every number from the twin or the scenario projection. @proofSeam the proof asserts the chain directly */
export function planObjectiveDelegation(twin: BrokerageTwin, facts: ScenarioFacts, o: { goalType: AgentGoalType; targetPct: number; capUsd: number | null; territory: string | null }): DelegationPlan {
  const measure = OBJECTIVE_MEASURES[o.goalType]
  const current = measure ? readTwinMeasure(twin, measure) : null
  const target = current !== null ? Math.ceil(current * (1 + o.targetPct / 100)) : null
  // the twin's goal measures are 90-day windows (GCI / closes) or present state (listings).
  // wave 137E: contacts and buyer representation are present-state measures too (now.*), conversions a 90d window.
  const presentState = o.goalType === "listings_taken" || o.goalType === "new_contacts" || o.goalType === "buyer_clients"
  const per30 = (n: number) => (presentState ? n : n / 3)
  const neededPer30d = current !== null && target !== null ? per30(target - current) : null
  const workforceTerritories = twin.workforce?.territories ?? []
  const territories = o.territory ? [o.territory] : [...workforceTerritories].filter((t) => t.territory !== "unassigned")
    .sort((a, b) => (a.trend === "up" ? 0 : 1) - (b.trend === "up" ? 0 : 1) || b.sellerContacts30d - a.sellerContacts30d || b.agentsWithHeadroom - a.agentsWithHeadroom || a.territory.localeCompare(b.territory)).slice(0, 3).map((t) => t.territory)
  const capCents = o.capUsd === null ? null : Math.round(o.capUsd * 100)
  // The scenario's only lever is seller acquisition: a goal it cannot move (buyer representation) is planned
  // WITHOUT a sweep — no spend is proposed for a lever that does not reach the measure (wave 137E).
  const gainOf = (p: ScenarioProjection): number | null =>
    o.goalType === "gross_commission" ? p.opportunityGain.addedRevenueCents
    : o.goalType === "transactions_closed" ? p.opportunityGain.addedCloses30d
    : o.goalType === "conversion_rate" || o.goalType === "new_contacts" ? p.opportunityGain.addedConversions30d
    : o.goalType === "buyer_clients" ? null
    : p.opportunityGain.addedListings30d
  const leverless = o.goalType === "buyer_clients"
  let chosen: ScenarioProjection | null = null, best: ScenarioProjection | null = null, shortfall: string | null = leverless ? "no scenario lever moves buyer representation yet — the target is delegated to the Shopping Agent with no planned spend" : null
  for (let p = SATURATION_SWEEP_STEP; p <= SATURATION_SWEEP_MAX && neededPer30d !== null && !leverless; p += SATURATION_SWEEP_STEP) {
    const pr = simulateScenario({ brokerageId: twin.brokerageId, levers: { seller_lead_acquisition_pct: p, ...(territories.length ? { territory_activation: territories } : {}) } }, twin, facts)
    if (capCents !== null && pr.marketingCost.totalCents > capCents) { shortfall = `the cap ($${o.capUsd}/month) is reached at +${p}% before the goal`; break }
    best = pr
    if ((gainOf(pr) ?? 0) >= neededPer30d) { chosen = pr; break }
  }
  const pr = chosen ?? best
  if (!chosen && !shortfall) shortfall = neededPer30d === null ? "the twin carries no measure for this goal" : `the sweep (to +${SATURATION_SWEEP_MAX}%) does not reach the goal — the best projected lift is planned`
  const stage = (s: string) => pr?.chain.find((x) => x.stage === s) ?? null
  const usd = (c: number) => Math.round(c) / 100
  const cost = pr?.marketingCost ?? { acquisitionCents: 0, adSpendCents: 0, campaignCents: 0, mediaCents: 0, aiCents: 0, totalCents: 0 }
  const gain = pr?.opportunityGain ?? { addedLeads30d: 0, addedConversions30d: 0, addedListings30d: 0, addedCloses30d: 0, addedRevenueCents: 0 }
  const reading = (path: string) => readTwinMeasure(twin, path)
  const crit = (metric: string, add: number): SuccessCriterion[] => { const v = reading(metric); return v !== null && add > 0 ? [{ metric, op: ">=", target: v + add }] : [] }
  const needs = twin.workforce ? recruitingNeeds(twin) : []
  const agentStage = stage("agent_capacity")
  const headroomGap = agentStage && agentStage.capacity !== null && agentStage.demand !== null ? Math.max(0, Math.ceil(agentStage.demand - agentStage.capacity)) : 0
  const inDev = twin.workforce?.totals?.in_development ?? 0
  if (leverless) {
    const add = current !== null && target !== null ? target - current : 0
    const only: DelegationChild[] = [{ manager: "shopping_agent", steps: ["isa"], subTarget: `+${add} buyer client(s) under representation (no scenario lever — qualified buyer contacts, tours, the lender handoff)`, criteria: measure ? crit(measure, add) : [], budgetUsd: 0, evidence: { measure, current, target } }]
    return { goalType: o.goalType, current, target, neededPer30d, levers: null, projection: null, totalBudgetUsd: 0, territories, shortfall, children: only }
  }
  const children: DelegationChild[] = [
    { manager: "listing_concierge", steps: ["territory_opportunities"], subTarget: `+${gain.addedListings30d} listings / 30d from ${territories.length ? territories.join(", ") : "brokerage-wide seller demand"}`, criteria: crit("now.listings.active", gain.addedListings30d), budgetUsd: 0, evidence: { territories: workforceTerritories.filter((t) => territories.includes(t.territory)).map((t) => ({ territory: t.territory, sellerContacts30d: t.sellerContacts30d, trend: t.trend, agentsWithHeadroom: t.agentsWithHeadroom })) } },
    { manager: "campaign_orchestrator", steps: ["marketing"], subTarget: `nurture the added seller leads into +${gain.addedConversions30d} conversions / 30d`, criteria: crit("slices.campaign_orchestrator.measures.converted30d", gain.addedConversions30d), budgetUsd: usd(cost.campaignCents), evidence: { campaignCents: cost.campaignCents } },
    { manager: "ads_manager", steps: ["marketing"], subTarget: `+${gain.addedLeads30d} seller leads / 30d from paid acquisition`, criteria: crit("slices.ads_manager.measures.leads30d", gain.addedLeads30d), budgetUsd: usd(cost.acquisitionCents + cost.adSpendCents), evidence: { acquisitionCents: cost.acquisitionCents, adSpendCents: cost.adSpendCents } },
    { manager: "ai_isa", steps: ["isa"], subTarget: `qualify the added contacts: +${gain.addedConversions30d} qualified contacts / 30d (ISA stage utilization ${stage("ai_isa_capacity")?.utilization ?? "unbounded"})`, criteria: crit("now.pipeline.converted90d", gain.addedConversions30d * 3), budgetUsd: usd(cost.aiCents), evidence: { stage: stage("ai_isa_capacity") } },
    { manager: "recruiting_manager", steps: ["capacity", "recruiting", "education"], subTarget: `close a ${headroomGap}-item agent headroom gap; ${needs.length} recruiting need(s); develop ${inDev} in-development agent(s) for listing presentations`, criteria: crit("capacity.headroom", headroomGap), budgetUsd: 0, evidence: { agentStage, recruitingNeeds: needs.map((n) => ({ territory: n.territory, specialization: n.specialization, count: n.count })), inDevelopment: inDev } },
    { manager: "asset_manager", steps: ["media"], subTarget: `listing launch creative for +${gain.addedListings30d} listings / 30d`, criteria: crit("slices.asset_manager.measures.approved30d", gain.addedListings30d), budgetUsd: usd(cost.mediaCents), evidence: { mediaCents: cost.mediaCents } },
    { manager: "finance_manager", steps: ["budget"], subTarget: `hold the plan to $${usd(cost.totalCents)} / 30d${o.capUsd !== null ? ` (cap $${o.capUsd})` : ""} and report the margin (${usd(pr?.expectedMarginCents ?? 0)})`, criteria: [], budgetUsd: 0, evidence: { totalCents: cost.totalCents, capUsd: o.capUsd } },
  ]
  return { goalType: o.goalType, current, target, neededPer30d, levers: pr?.levers ?? null, projection: pr ? projOf(pr) : null, totalBudgetUsd: usd(cost.totalCents), territories, shortfall, children }
}

async function delegateObjective(input: ObjectiveInput, client?: Client, deps: BrokerObjectiveDeps = {}): Promise<{ ok: true; parent: MissionRow; children: MissionRow[]; plan: DelegationPlan; refused: string[] } | { ok: false; reason: string }> {
  const d = { ...defaults, ...deps }
  const svc = await svcOf(client)
  const goalType = input.objective.goalType
  if (!goalType || input.objective.targetPct === null) return { ok: false, reason: "An objective delegation needs a goal measure and a % target." }
  const twin = await d.twin(svc, input.brokerageId)
  if (!twin || twin.brokerageId !== input.brokerageId) return { ok: false, reason: "The brokerage twin could not be built — no decomposition without it." }
  const facts = await d.scenarioFacts(svc, input.brokerageId)
  const plan = planObjectiveDelegation(twin, facts, { goalType, targetPct: input.objective.targetPct, capUsd: input.objective.spendCapUsdMonthly, territory: input.objective.territory })
  const spec = plan.current !== null && plan.target !== null ? { goalType, targetValue: plan.target, currentValue: plan.current } : null
  // The parent is judged on the ABSOLUTE target of its measure (current × (1 + pct)). The twin
  // decomposition's headline criterion carries the REMAINING delta as its target, which an absolute
  // twin reading meets at once — so it rides as evidence (sub-targets), never as the parent's criterion.
  const decomposition = spec ? decomposeObjective(spec, twin) : null
  const measure = OBJECTIVE_MEASURES[goalType]
  const criteria: SuccessCriterion[] = measure && plan.target !== null ? [{ metric: measure, op: ">=", target: plan.target }] : []
  // The PARENT's owner is the registry's answer for its headline measure (the controller's own rule).
  const owner = resolveOwnership({ mission_type: "brokerage_objective", success_criteria: criteria, subject_type: null, owner_manager: "cron_manager" }).expected ?? "cron_manager"
  const actor: MissionActor = { type: "user", id: input.actorUserId }
  const parent = await createMission({
    brokerageId: input.brokerageId, objective: input.text, missionType: "brokerage_objective", ownerManager: owner,
    participatingManagers: plan.children.map((c) => c.manager), successCriteria: criteria, budget: { usd: plan.totalBudgetUsd, on_exhausted: "APPROVAL_REQUIRED" },
    createdBy: input.actorUserId, actor, initialState: "PROPOSED",
  }, svc, deps.mission)
  if (!parent.ok) return { ok: false, reason: parent.reason }
  const children: MissionRow[] = []
  const refused: string[] = []
  for (const c of plan.children) {
    const r = await createMission({
      brokerageId: input.brokerageId, objective: `${c.steps.join(" + ")}: ${c.subTarget} — for "${input.text}"`,
      missionType: c.manager === "recruiting_manager" ? "recruiting" : "brokerage_objective", ownerManager: c.manager,
      successCriteria: c.criteria, budget: { usd: c.budgetUsd, on_exhausted: "APPROVAL_REQUIRED" }, parentMission: parent.mission.id,
      createdBy: input.actorUserId, actor, initialState: "PROPOSED",
    }, svc, deps.mission)
    if (r.ok) children.push(r.mission); else refused.push(`${c.manager}: ${r.reason}`)
  }
  await attachEvidence({ brokerageId: input.brokerageId, missionId: parent.mission.id, actor: { type: "manager", id: "cron_manager" }, evidence: { kind: "objective_delegation", ref: `objective_delegation:${parent.mission.id}`, parsed: input.objective, chain: DELEGATION_CHAIN, decomposition: decomposition ? { status: decomposition.status, remaining: decomposition.remaining, sub_targets: decomposition.subTargets, reason: decomposition.reason ?? null } : null, plan: { ...plan, children: plan.children.map((c) => ({ manager: c.manager, steps: c.steps, subTarget: c.subTarget, budgetUsd: c.budgetUsd })) }, child_mission_ids: children.map((m) => m.id), refused } }, svc, deps.mission)
  return { ok: true, parent: parent.mission, children, plan, refused }
}

// ─── 7. THE ONE ENTRY (the Missions card's door calls this) ──────────────────────────────────────
export type BrokerObjectiveOutcome =
  | { kind: "investigation"; mission: MissionRow; report: EvidenceReport }
  | { kind: "directive"; mission: MissionRow; proposal: ObjectiveProposal }
  | { kind: "delegation"; mission: MissionRow; children: MissionRow[]; plan: DelegationPlan; refused: string[] }

export async function submitBrokerObjective(input: { brokerageId: string; text: string; actorUserId: string }, client?: Client, deps: BrokerObjectiveDeps = {}): Promise<{ ok: true; outcome: BrokerObjectiveOutcome; parsed: ParsedObjective } | { ok: false; reason: string; examples?: string[] }> {
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  const svc = await svcOf(client)
  const t = await loadTerritoryCandidates(svc, input.brokerageId)
  if (t.refused) return { ok: false, reason: `Your territories could not be read (${t.refused}) — no objective is routed without them.` }
  const parsed = parseBrokerObjective(input.text, t.territories)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, examples: parsed.examples }
  const base: ObjectiveInput = { brokerageId: input.brokerageId, text: input.text.trim(), objective: parsed.objective, actorUserId: input.actorUserId }
  if (parsed.objective.kind === "investigation") {
    const r = await runInvestigation(base, svc, deps)
    return r.ok ? { ok: true, parsed: parsed.objective, outcome: { kind: "investigation", mission: r.mission, report: r.report } } : r
  }
  if (parsed.objective.kind === "directive") {
    const r = await proposeDirective(base, svc, deps)
    return r.ok ? { ok: true, parsed: parsed.objective, outcome: { kind: "directive", mission: r.mission, proposal: r.proposal } } : r
  }
  const r = await delegateObjective(base, svc, deps)
  return r.ok ? { ok: true, parsed: parsed.objective, outcome: { kind: "delegation", mission: r.parent, children: r.children, plan: r.plan, refused: r.refused } } : r
}
