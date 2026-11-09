// lib/acquisition-plays/negative-evidence.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLAY — NEGATIVE-EVIDENCE COST SAVER (wave 151, lane 151D; directive play 10).
//
// "If a credible new property sale, already-active listing under another authorized agent, changed
// address, explicit consumer no-interest or newer contrary statement undermines an old lead theory,
// lower priority, verify, hold or stop acquisition instead of increasing outreach."
//
// RULES (the same chronology rule the moment model uses — lib/intent/moving-moments.ts rule 3): only
// evidence NEWER than the theory's latest positive contradicts it; an older fact is history and changes
// nothing. The verdict follows the evidence CLASS: a verified fact (a recorded sale, an MLS status) can
// stop; a reported one (the person's own words, a public page) holds or stops only when it is the
// person's explicit no-interest; an inferred one can never do more than ask for verification.
//
// ENDS IN EXISTING ACTIONS: lib/intent/movement-signals.ts recordMovementOutcome (the theory's outcome,
// ledgered once, grading its forecasts), leads.ai_outreach_paused (the existing hold column, tenant-pinned
// and counted), raw_scraped_leads.ttl_expires_at (the observation is no longer current), and the bus
// (data_steward → ai_isa negative_evidence_verdict). It REMOVES outreach and research; it never adds a
// touch, never ingests, never enriches.

import type { MovementOutcome } from "@/lib/intent/movement-signals"
import type { PlayAction, PlayResult } from "./contract"

const PLAY = "negative_evidence_saver" as const

export const NEGATIVE_EVIDENCE_KINDS = ["recorded_sale", "active_listing_other_agent", "changed_address", "explicit_no_interest", "newer_contrary_statement"] as const
export type NegativeEvidenceKind = (typeof NEGATIVE_EVIDENCE_KINDS)[number]

export interface NegativeEvidence {
  kind: NegativeEvidenceKind
  /** When the contrary fact happened / was said (ISO). */
  at: string
  confidence: "verified" | "reported" | "inferred"
  /** Which process / record / page produced it. */
  source: string
  detail?: string | null
  reference?: { kind: string; id: string; url?: string | null } | null
}

export interface LeadTheory {
  subject: { type: "contact" | "lead" | "raw_lead" | "property"; id: string }
  side: "buyer" | "seller" | "unknown"
  /** The newest POSITIVE sign of a move the theory rests on (ISO). */
  latestPositiveAt: string
  propertyAddress?: string | null
  movementSignalId?: string | null
  leadId?: string | null
  rawLeadId?: string | null
}

export type NegativeVerdict = "stop" | "hold" | "verify" | "lower_priority" | "none"
const VERDICT_RANK: Record<NegativeVerdict, number> = { stop: 4, hold: 3, verify: 2, lower_priority: 1, none: 0 }

export interface NegativeAssessment {
  verdict: NegativeVerdict
  /** What acquisition (research / paid pulls) should do about this theory. */
  acquisition: "stop" | "hold" | "continue"
  reasons: string[]
  decisive: NegativeEvidence | null
  ignored: Array<{ kind: NegativeEvidenceKind; why: string }>
  evidenceClass: "stale_contradicted" | null
  /** The movement outcome the decisive fact records (null = no outcome yet — hold / verify). */
  outcome: MovementOutcome | null
}

/** PURE — one contrary fact → its verdict for this theory (null = not applicable). */
function verdictFor(theory: LeadTheory, e: NegativeEvidence): { verdict: NegativeVerdict; outcome: MovementOutcome | null; why: string } | null {
  const seller = theory.side === "seller" || theory.side === "unknown"
  if (e.confidence === "inferred") return { verdict: "verify", outcome: null, why: `${e.kind} is only inferred — verify before acting; an inference never stops a theory by itself` }
  switch (e.kind) {
    case "explicit_no_interest": {
      const optedOut = /\b(stop|unsubscribe|opt(ed)?[- ]?out|do not contact|remove me)\b/i.test(e.detail ?? "")
      return { verdict: "stop", outcome: optedOut ? "opted_out" : "declined", why: `the person said no (${e.detail ?? "explicit no-interest"}) — stop; nothing is sent to someone who asked not to be` }
    }
    case "recorded_sale":
      if (e.confidence !== "verified") return { verdict: "verify", outcome: null, why: "a reported sale is checked against the record before the theory is closed" }
      return seller
        ? { verdict: "stop", outcome: "moved", why: "the home sold (recorded) — the seller theory is over; the move happened without us and is counted as a confirmed move, not an outcome of ours" }
        : { verdict: "verify", outcome: null, why: "the home sold (recorded) — a buyer theory may now be a next purchase; verify before any touch" }
    case "active_listing_other_agent":
      if (e.confidence !== "verified") return { verdict: "hold", outcome: null, why: `a public page shows the property listed with ${e.detail ?? "another brokerage"} — hold outreach and verify against the MLS before closing the theory` }
      return seller
        ? { verdict: "stop", outcome: "listed", why: `listed with ${e.detail ?? "another authorized agent"} (MLS) — stop; another licensee represents them` }
        : { verdict: "lower_priority", outcome: null, why: "the home a buyer theory rested on is now listed elsewhere — lower priority, nothing more" }
    case "changed_address":
      return { verdict: "verify", outcome: null, why: "the address changed — verify identity and territory before anything is sent; outreach holds meanwhile" }
    case "newer_contrary_statement":
      return { verdict: "hold", outcome: null, why: `a newer statement from the person contradicts the theory (${e.detail ?? "contrary statement"}) — hold; their latest words win` }
  }
}

/** PURE — the theory × contrary evidence → one verdict, its reasons, what was ignored and why. */
export function assessNegativeEvidence(theory: LeadTheory, evidence: readonly NegativeEvidence[], now: Date = new Date()): NegativeAssessment {
  const reasons: string[] = []
  const ignored: NegativeAssessment["ignored"] = []
  let best: { verdict: NegativeVerdict; outcome: MovementOutcome | null; e: NegativeEvidence } | null = null
  for (const e of evidence) {
    const t = Date.parse(e.at)
    if (!Number.isFinite(t)) { ignored.push({ kind: e.kind, why: "unreadable date" }); continue }
    if (t > now.getTime() + 86_400_000) { ignored.push({ kind: e.kind, why: "dated in the future" }); continue }
    if (t < Date.parse(theory.latestPositiveAt)) { ignored.push({ kind: e.kind, why: "older than the theory's newest positive sign — history, not a contradiction" }); continue }
    const v = verdictFor(theory, e)
    if (!v) { ignored.push({ kind: e.kind, why: "not applicable" }); continue }
    reasons.push(v.why)
    if (!best || VERDICT_RANK[v.verdict] > VERDICT_RANK[best.verdict]) best = { verdict: v.verdict, outcome: v.outcome, e }
  }
  if (!best) return { verdict: "none", acquisition: "continue", reasons: reasons.length ? reasons : ["no contrary evidence newer than the theory's latest positive sign"], decisive: null, ignored, evidenceClass: null, outcome: null }
  const acquisition: NegativeAssessment["acquisition"] = best.verdict === "stop" ? "stop" : best.verdict === "hold" || best.verdict === "verify" ? "hold" : "continue"
  return { verdict: best.verdict, acquisition, reasons, decisive: best.e, ignored, evidenceClass: "stale_contradicted", outcome: best.outcome }
}

type Svc = { from: (t: string) => any }

export interface NegativeEvidenceDeps {
  outcome?: typeof import("@/lib/intent/movement-signals").recordMovementOutcome
  signal?: typeof import("@/lib/kernel/manager-signals").publishManagerSignal
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
}

const defaultOutcome: NonNullable<NegativeEvidenceDeps["outcome"]> = async (svc, a, deps) => (await import("@/lib/intent/movement-signals")).recordMovementOutcome(svc, a, deps)
const defaultSignal: NonNullable<NegativeEvidenceDeps["signal"]> = async (input, client) => (await import("@/lib/kernel/manager-signals")).publishManagerSignal(input, client)

export const NEGATIVE_EVIDENCE_SIGNAL = "negative_evidence_verdict"

export interface NegativeEvidenceResult extends PlayResult { assessment: NegativeAssessment }

/**
 * Carry a verdict out through the EXISTING doors. A `none` verdict writes nothing. Every write is tenant-pinned and counted
 * (an UPDATE that matches nothing resolves — CLAUDE.md §3 — so zero rows is said, never "paused").
 */
export async function applyNegativeEvidence(
  svc: Svc,
  a: { brokerageId: string; theory: LeadTheory; assessment: NegativeAssessment; now?: Date },
  deps: NegativeEvidenceDeps = {},
): Promise<NegativeEvidenceResult> {
  const now = a.now ?? new Date()
  const base: NegativeEvidenceResult = { play: PLAY, status: "nothing_found", evidence: [], actions: [], refused: [], blindSpots: ["a public page's 'listed with another brokerage' is reported, not MLS-verified — it holds, never stops"], costUsd: 0, assessment: a.assessment }
  const { assessment: as, theory } = a
  if (as.verdict === "none") return base
  const actions: PlayAction[] = []
  const refused: PlayResult["refused"] = []

  if (as.outcome && theory.movementSignalId) {
    const r = await (deps.outcome ?? defaultOutcome)(svc, {
      brokerageId: a.brokerageId, signalId: theory.movementSignalId, outcome: as.outcome,
      evidence: { play: PLAY, verdict: as.verdict, evidence_class: as.evidenceClass, decisive: as.decisive, reasons: as.reasons, attribution: as.outcome === "moved" || as.outcome === "listed" ? "the move happened without us — a confirmed move, not our outcome" : null },
      actor: { type: "manager", managerKey: "data_steward" }, now,
    }, { ledger: deps.ledger })
    actions.push({ kind: "movement_outcome", target: "recordMovementOutcome", detail: { signalId: theory.movementSignalId, outcome: as.outcome, status: r.status, reason: r.reason } })
    if (r.status === "refused") refused.push({ what: "movement outcome", why: r.reason })
  }

  if ((as.verdict === "stop" || as.verdict === "hold") && theory.leadId) {
    const { data, error } = await svc.from("leads").update({ ai_outreach_paused: true, updated_at: now.toISOString() }).eq("id", theory.leadId).eq("brokerage_id", a.brokerageId).select("id")
    if (error) refused.push({ what: "lead outreach pause", why: error.message })
    else if ((data ?? []).length === 0) refused.push({ what: "lead outreach pause", why: "no lead matched in this brokerage (the tenant predicate refused or the lead is gone) — nothing paused" })
    else actions.push({ kind: "outreach_paused", target: "leads.ai_outreach_paused", detail: { leadId: theory.leadId, rows: (data as unknown[]).length, verdict: as.verdict } })
  }

  if (as.verdict !== "lower_priority" && theory.rawLeadId) {
    const { data, error } = await svc.from("raw_scraped_leads").update({ ttl_expires_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", theory.rawLeadId).eq("brokerage_id", a.brokerageId).select("id")
    if (error) refused.push({ what: "raw observation expiry", why: error.message })
    else if ((data ?? []).length === 0) refused.push({ what: "raw observation expiry", why: "no raw row matched in this brokerage — nothing expired" })
    else actions.push({ kind: "hold", target: "raw_scraped_leads.ttl_expires_at", detail: { rawLeadId: theory.rawLeadId, rows: (data as unknown[]).length } })
  }

  const entityId = theory.movementSignalId ?? theory.leadId ?? (theory.subject.type !== "property" ? theory.subject.id : null)
  if (entityId) {
    const sig = await (deps.signal ?? defaultSignal)({
      brokerageId: a.brokerageId, fromManager: "data_steward", toManager: "ai_isa", signalType: NEGATIVE_EVIDENCE_SIGNAL,
      message: `${as.verdict.toUpperCase()}: ${as.reasons[0] ?? "contrary evidence"} — acquisition ${as.acquisition}; outreach is not increased.`.slice(0, 900),
      entityType: theory.subject.type, entityId, contactId: theory.subject.type === "contact" ? theory.subject.id : null,
      payload: { play: PLAY, verdict: as.verdict, acquisition: as.acquisition, decisive: as.decisive, reasons: as.reasons, ignored: as.ignored, theory: { side: theory.side, latest_positive_at: theory.latestPositiveAt, property_address: theory.propertyAddress ?? null } },
    }, svc as never)
    actions.push({ kind: "manager_signal", target: "publishManagerSignal", detail: { signalType: NEGATIVE_EVIDENCE_SIGNAL, ok: sig.ok, reason: sig.reason ?? null, verdict: as.verdict } })
    if (!sig.ok) refused.push({ what: "verdict signal", why: sig.reason ?? "bus refused" })
  }

  return { ...base, status: actions.length ? "acted" : "refused", actions, refused }
}
