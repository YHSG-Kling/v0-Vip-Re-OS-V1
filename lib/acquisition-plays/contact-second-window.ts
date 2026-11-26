// lib/acquisition-plays/contact-second-window.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLAY — EXISTING-CONTACT SECOND-WINDOW RADAR (wave 151, lane 151D; directive play 9 + "Existing Contacts").
//
// SURVIVORS (LAW 1): the C9 record and its decision chain already exist — lib/intent/movement-signals.ts
// reassessExistingContact (lane 151E's ONE door for a known Contact's change; it maps the change to the C9 input and
// calls recordMovementSignal) → evaluateMovementSubject (the movement manager's decision) → the bus
// (online_intent_detected → THE ONE life-change responder → THE arbiter). lib/intent/
// movement-source-watcher.ts already polls calculators, home-dashboard views, content views and REPEATED
// criteria changes. What was MISSING is the SHIFT reading of a Contact's own saved homes against what they
// TOLD us (property_preferences: cities, price ceiling), the valuation request as a second-window event on
// a known Contact, and one radar that bundles the three into the existing chain with two guarantees proved
// by test:early-opportunity-plays: NO new Lead (never the RawData producer — a Contact we hold is not a
// stranger observed) and NO provider bill (this module imports no provider client; the chain reads tables).
//
// The arbiter decides what, if anything, follows (wait / research / offer_help / human); a person's stated
// communication preferences are honored there; unset preferences → the arbiter decides. No schedule here.

import type { ExistingContactChange, ExistingContactReassessment, MovementDeps } from "@/lib/intent/movement-signals"
import type { PlayAction, PlayResult } from "./contract"

const PLAY = "contact_second_window" as const
const DAY_MS = 86_400_000
export const SECOND_WINDOW_DEFAULT_DAYS = 30

type Svc = { from: (t: string) => any }

interface SavedHomeRow { id: string; city?: string | null; list_price?: number | null; bedrooms?: number | null; saved_at?: string | null; dismissed?: boolean | null }
interface ValuationRow { id: string; property_address?: string | null; submitted_at?: string | null }
interface CriteriaRow { id: string; field?: string | null; provenance?: string | null; status?: string | null; created_at?: string | null }
interface PreferenceRow { inferred_cities?: string[] | null; preferred_price_max?: number | null; inferred_max_price?: number | null; inferred_beds_min?: number | null; criteria_provenance?: string | null }

export type SecondWindowKind = "saved_home_shift" | "saved_home_activity" | "valuation_request" | "criteria_change"

export interface SecondWindowChange {
  kind: SecondWindowKind
  observedAt: string
  summary: string
  /** The first-party rows the change rests on (verified references). */
  rowIds: string[]
  side: "buyer" | "seller"
  /** criteria_change only — the stated fields that were revised (the door's summary names them). */
  fields?: string[]
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase()

/**
 * PURE — a Contact's first-party rows inside the window → the changes worth a second look. A SHIFT needs a baseline (what they
 * told us); without one, repeated saving is activity (still a verified first-party fact, still the manager's to weigh).
 */
function detectSecondWindow(a: { since: string; preferences: PreferenceRow | null; savedHomes: readonly SavedHomeRow[]; valuations: readonly ValuationRow[]; criteria: readonly CriteriaRow[] }): SecondWindowChange[] {
  const out: SecondWindowChange[] = []
  const saves = a.savedHomes.filter((s) => !s.dismissed && typeof s.saved_at === "string" && s.saved_at >= a.since)
  if (saves.length >= 2) {
    const prefCities = new Set((a.preferences?.inferred_cities ?? []).map(norm).filter(Boolean))
    const ceiling = a.preferences?.preferred_price_max ?? a.preferences?.inferred_max_price ?? null
    const outsideCities = prefCities.size ? saves.filter((s) => s.city && !prefCities.has(norm(s.city))) : []
    const abovePrice = ceiling ? saves.filter((s) => typeof s.list_price === "number" && s.list_price > ceiling * 1.15) : []
    const newest = saves.map((s) => s.saved_at as string).sort().pop() as string
    if (outsideCities.length >= 2 || abovePrice.length >= 2) {
      const parts: string[] = []
      if (outsideCities.length >= 2) parts.push(`${outsideCities.length} saved homes in ${[...new Set(outsideCities.map((s) => s.city))].join(" / ")} — outside the cities they told us (${[...prefCities].join(", ")})`)
      if (abovePrice.length >= 2) parts.push(`${abovePrice.length} saved homes more than 15% above the stated ceiling (${ceiling?.toLocaleString()})`)
      out.push({ kind: "saved_home_shift", observedAt: newest, summary: `their saved homes shifted: ${parts.join("; ")}`, rowIds: [...new Set([...outsideCities, ...abovePrice].map((s) => s.id))].sort(), side: "buyer" })
    } else {
      out.push({ kind: "saved_home_activity", observedAt: newest, summary: `saved ${saves.length} homes on our own surfaces inside the window${prefCities.size || ceiling ? " (inside what they told us)" : " (no stated preferences to compare against)"}`, rowIds: saves.map((s) => s.id).sort(), side: "buyer" })
    }
  }
  for (const v of a.valuations) {
    if (typeof v.submitted_at !== "string" || v.submitted_at < a.since) continue
    out.push({ kind: "valuation_request", observedAt: v.submitted_at, summary: `asked for a home valuation${v.property_address ? ` on ${v.property_address}` : ""} on our own surface`, rowIds: [v.id], side: "seller" })
  }
  const said = a.criteria.filter((c) => c.provenance === "said" && c.status !== "rejected" && typeof c.created_at === "string" && c.created_at >= a.since)
  if (said.length >= 2) {
    out.push({ kind: "criteria_change", observedAt: said.map((c) => c.created_at as string).sort().pop() as string, summary: `revised their stated search criteria ${said.length} times (${[...new Set(said.map((c) => c.field ?? "criteria"))].sort().join(", ")})`, rowIds: said.map((c) => c.id).sort(), side: "buyer", fields: [...new Set(said.map((c) => String(c.field ?? "")).filter(Boolean))].sort() })
  }
  return out
}

/**
 * PURE — a radar change → THE existing-contact door's change (lib/intent/movement-signals.ts reassessExistingContact, lane 151E).
 * The door owns the C9 mapping (source key, relevance, evidence reference, the repeated-change floor) — one spelling of
 * "a known Contact changed", never a second mapper here (CLAUDE.md §6).
 */
function toExistingContactChange(c: SecondWindowChange): ExistingContactChange {
  const ids = [...new Set(c.rowIds)].sort()
  switch (c.kind) {
    case "saved_home_shift": return { kind: "saved_home_shift", referenceId: ids.join("+"), summary: c.summary, at: c.observedAt }
    case "saved_home_activity": return { kind: "saved_home_activity", referenceIds: ids, summary: c.summary, at: c.observedAt }
    case "valuation_request": return { kind: "valuation_request", referenceId: ids[0] ?? "", summary: c.summary, at: c.observedAt }
    case "criteria_change": return { kind: "criteria_change", referenceIds: ids, fields: c.fields ?? [], at: c.observedAt }
  }
}

export interface SecondWindowDeps extends MovementDeps {
  /** THE existing-contact door (default lib/intent/movement-signals.ts reassessExistingContact — the ONE way a known Contact's change reaches the arbiter). */
  record?: (svc: Svc, a: { brokerageId: string; contactId: string; change: ExistingContactChange; capturedBy: "automation" }, deps: MovementDeps & { route?: boolean }) => Promise<ExistingContactReassessment>
}

const defaultRecord: NonNullable<SecondWindowDeps["record"]> = async (svc, a, deps) => (await import("@/lib/intent/movement-signals")).reassessExistingContact(svc as never, a, deps as never)

export interface SecondWindowResult extends PlayResult {
  contactId: string
  changes: SecondWindowChange[]
  recorded: ExistingContactReassessment[]
  /** Where the chain handed the decision (the manager's verdict and its route — the arbiter over the bus, a task, nothing). */
  decisions: Array<{ change: SecondWindowKind; status: string; action: string | null; via: string | null }>
}

/**
 * One Contact's second window. Tenant-pinned reads, every error read (a refused read refuses the radar for this contact — said).
 * Each change is ONE C9 record through the existing recorder with routing ON: the manager decides, the arbiter follows.
 */
export async function runContactSecondWindow(
  svc: Svc,
  a: { brokerageId: string; contactId: string; now?: Date; windowDays?: number },
  deps: SecondWindowDeps = {},
): Promise<SecondWindowResult> {
  const now = a.now ?? new Date()
  const since = new Date(now.getTime() - (a.windowDays ?? SECOND_WINDOW_DEFAULT_DAYS) * DAY_MS).toISOString()
  const base: SecondWindowResult = { play: PLAY, status: "refused", evidence: [], actions: [], refused: [], blindSpots: ["first-party rows only; nothing is bought; the arbiter's choice (including wait) is the decision"], costUsd: 0, contactId: a.contactId, changes: [], recorded: [], decisions: [] }
  const refuse = (what: string, why: string): SecondWindowResult => ({ ...base, refused: [{ what, why }] })
  if (!a.brokerageId || !a.contactId) return refuse("input", "missing tenant or contact")

  const { data: contact, error: cErr } = await svc.from("contacts").select("id").eq("id", a.contactId).eq("brokerage_id", a.brokerageId).maybeSingle()
  if (cErr) return refuse("contacts read", cErr.message)
  if (!contact) return refuse("contact", "contact not in this brokerage")

  const { data: prefRows, error: pErr } = await svc.from("property_preferences").select("inferred_cities, preferred_price_max, inferred_max_price, inferred_beds_min, criteria_provenance").eq("contact_id", a.contactId).eq("brokerage_id", a.brokerageId).limit(1)
  if (pErr) return refuse("property_preferences read", pErr.message)
  const { data: saved, error: sErr } = await svc.from("saved_properties").select("id, city, list_price, bedrooms, saved_at, dismissed").eq("contact_id", a.contactId).eq("brokerage_id", a.brokerageId).gte("saved_at", since).limit(200)
  if (sErr) return refuse("saved_properties read", sErr.message)
  const { data: vals, error: vErr } = await svc.from("valuation_requests").select("id, property_address, submitted_at").eq("contact_id", a.contactId).eq("brokerage_id", a.brokerageId).gte("submitted_at", since).limit(20)
  if (vErr) return refuse("valuation_requests read", vErr.message)
  const { data: crit, error: kErr } = await svc.from("buyer_criteria_changes").select("id, field, provenance, status, created_at").eq("contact_id", a.contactId).eq("brokerage_id", a.brokerageId).eq("provenance", "said").gte("created_at", since).limit(100)
  if (kErr) return refuse("buyer_criteria_changes read", kErr.message)

  const changes = detectSecondWindow({ since, preferences: ((prefRows ?? []) as PreferenceRow[])[0] ?? null, savedHomes: (saved ?? []) as SavedHomeRow[], valuations: (vals ?? []) as ValuationRow[], criteria: (crit ?? []) as CriteriaRow[] })
  if (changes.length === 0) return { ...base, status: "nothing_found", changes }

  const recorded: ExistingContactReassessment[] = []
  const decisions: SecondWindowResult["decisions"] = []
  const actions: PlayAction[] = []
  const record = deps.record ?? defaultRecord
  for (const c of changes) {
    const r = await record(svc, { brokerageId: a.brokerageId, contactId: a.contactId, change: toExistingContactChange(c), capturedBy: "automation" }, { ...deps, route: true, now })
    recorded.push(r)
    if (r.status === "reassessed" || r.status === "recorded_no_decision") {
      const ev = r.evaluation
      const action = ev?.status === "decided" ? ev.decision?.action ?? null : null
      const via = ev?.status === "decided" ? ev.routed?.via ?? null : null
      decisions.push({ change: c.kind, status: ev?.status ?? "not_evaluated", action, via })
      actions.push({ kind: "movement_signal", target: "reassessExistingContact", detail: { change: c.kind, signalId: r.recordId, summary: c.summary } })
      if (via === "bus" || via === "responder") actions.push({ kind: "arbiter", target: via === "bus" ? "publishManagerSignal:online_intent_detected → respondToLifeChangeSignal" : "respondToLifeChangeSignal", detail: { change: c.kind, action, via } })
    } else if (r.status === "replayed") {
      decisions.push({ change: c.kind, status: "replayed", action: null, via: null })
    } else {
      base.refused.push({ what: `record ${c.kind}`, why: r.reason })
    }
  }
  const status: PlayResult["status"] = actions.length ? "acted" : recorded.some((r) => r.status === "replayed") ? "nothing_found" : "refused"
  return { ...base, status, changes, recorded, decisions, actions }
}

/**
 * The territory sweep: every Contact of the tenant with a first-party change inside the window gets ONE radar run. Tenant-pinned;
 * a refused read is said and the sweep continues with what it could read.
 */
export async function sweepContactSecondWindows(
  svc: Svc,
  a: { brokerageId: string; now?: Date; windowDays?: number; limit?: number },
  deps: SecondWindowDeps = {},
): Promise<{ contacts: number; results: SecondWindowResult[]; errors: string[] }> {
  const now = a.now ?? new Date()
  const since = new Date(now.getTime() - (a.windowDays ?? SECOND_WINDOW_DEFAULT_DAYS) * DAY_MS).toISOString()
  const ids = new Set<string>()
  const errors: string[] = []
  const collect = async (table: string, tsCol: string, extra?: (q: any) => any) => {
    let q = svc.from(table).select("contact_id").eq("brokerage_id", a.brokerageId).gte(tsCol, since).not("contact_id", "is", null).limit(1000)
    if (extra) q = extra(q)
    const { data, error } = await q
    if (error) { errors.push(`${table} read refused: ${error.message}`); return }
    for (const r of (data ?? []) as Array<{ contact_id?: string | null }>) if (r.contact_id) ids.add(r.contact_id)
  }
  await collect("saved_properties", "saved_at")
  await collect("valuation_requests", "submitted_at")
  await collect("buyer_criteria_changes", "created_at", (q) => q.eq("provenance", "said"))
  const results: SecondWindowResult[] = []
  for (const contactId of [...ids].slice(0, a.limit ?? 200)) {
    results.push(await runContactSecondWindow(svc, { brokerageId: a.brokerageId, contactId, now, windowDays: a.windowDays }, deps))
  }
  return { contacts: ids.size, results, errors }
}
