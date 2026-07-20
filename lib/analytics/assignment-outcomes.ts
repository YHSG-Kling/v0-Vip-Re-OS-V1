// lib/analytics/assignment-outcomes.ts
//
// ASSIGNMENT-POLICY OUTCOMES (owner round 38, rec 2) — the grading loop for the
// admin's assignment_rules. The admin declares routing POLICY (round_robin /
// load_balance / geo_based / specialization); Engine 2 consumes it at conversion
// and RECORDS which rule matched (assignment_log.rule_id + assignment_method,
// written at assignment time by handleLeadAssigned — the attribution has existed
// since Engine 2 shipped, nothing is reconstructed in hindsight). This module
// grades each policy against a REAL downstream outcome: did the assigned contact
// reach a FIRST APPOINTMENT within the declared horizon?
//
// HONESTY CONTRACT (the prediction-accuracy rail rules, inherited verbatim):
//   • The 30-day horizon is a DECLARED grading constant — the source system
//     defines no horizon, so the label names it instead of implying one.
//   • Outcomes join ONLY where appointment data genuinely joins: calendar_events
//     appointment rows on the contact/lead entity (isa_appointment /
//     listing_appointment — real writers: scheduleISAAppointment,
//     bookSellerListingAppointment) and showings.contact_id (voice booking /
//     ShowingTime ingest). No joinable event ledger → the row grades on the
//     elapsed window, never on an assumed outcome.
//   • An assignment whose contact already had an appointment BEFORE assignment
//     is REFUSED (the appointment wasn't the routing policy's doing).
//   • Open windows are PENDING, never graded early; a fully-elapsed window with
//     no appointment is an observed miss.
//   • Track-B (form/import) contact assignments only began recording their
//     matched rule with this build (captureContact stamps the CONTACT_CAPTURED
//     event's metadata.assignment) — those cohorts join the rail as their
//     windows elapse. Honest not-yet, no retroactive fabrication.
//
// THE DELIBERATION FEED: when two ACTIVE rules' measured outcome rates diverge
// materially (both at/above the observation floor), the AI ISA (assignment_log
// steward — the conversion-evidence seat) raises a governed cross_manager_referral
// INTO the Data Steward's domain (assignment_rules / appointments / contacts
// steward — the config seat) on the deliberative 'assignment_policy_outcomes'
// collaboration edge, recency-deduped over the bus ledger itself. The managers
// then ARGUE which policy the evidence favors (lib/managers/deliberation.ts).

import type { SupabaseClient } from "@supabase/supabase-js"
import type { RailAccuracy, RailBreakdownRow } from "@/lib/analytics/prediction-accuracy"
import { KernelEvent } from "@/lib/kernel/events"
import {
  raiseReferralDeduped,
  type SlaReferralSweepResult,
} from "@/lib/managers/cross-referral"

type Svc = SupabaseClient<any, any, any>

// ─── Declared grading constants (named in the labels — never implied) ────────

/** Days after assignment inside which a first appointment counts as the policy's hit. */
export const ASSIGNMENT_OUTCOME_HORIZON_DAYS = 30
/** Both rules need at least this many fully-graded observations before divergence is argued. */
export const ASSIGNMENT_POLICY_MIN_OBSERVATIONS = 8
/** Material divergence: the measured outcome-rate gap (0..1) that triggers the referral. */
export const ASSIGNMENT_POLICY_DIVERGENCE = 0.2

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** One attributed assignment (lead-path assignment_log row, or a Track-B
 *  CONTACT_CAPTURED event carrying metadata.assignment). */
export interface AssignedCohortRow {
  /** Stable identity for first-assignment dedupe (e.g. "lead:<id>" / "contact:<id>"). */
  key: string
  brokerageId: string | null
  contactId: string | null
  leadId: string | null
  /** The matched assignment_rules.id — null for non-rule policies (fallbacks). */
  ruleId: string | null
  /** The recorded assignment method ('round_robin', 'load_balance', 'owner', …). */
  method: string
  assignedAt: string | null
}

export interface AssignmentRuleInfo {
  id: string
  name: string | null
  ruleType: string | null
  isActive: boolean
}

/** One appointment-outcome event, joined by contact and/or lead identity. */
export interface FirstAppointmentEvent {
  contactId: string | null
  leadId: string | null
  at: string | null
}

export interface PolicyOutcomeStat {
  /** "rule:<assignment_rules.id>" or "method:<assignment_method>". */
  policyKey: string
  ruleId: string | null
  /** True only for a rule-backed policy whose rule is currently active. */
  isActiveRule: boolean
  label: string
  /** Fully graded observations (hits + elapsed misses). */
  observations: number
  hits: number
  /** hits / observations — null when nothing is graded yet. */
  rate: number | null
  /** Assignments still inside the open window — never graded early. */
  pending: number
}

export interface PolicyOutcomeReport {
  stats: PolicyOutcomeStat[]
  gradedTotal: number
  hitsTotal: number
  pendingTotal: number
  refusedPreexisting: number
  gradedDates: string[]
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100

const METHOD_LABELS: Record<string, string> = {
  load_balance: "Load-balance fallback (no rule matched)",
  owner: "Owner-tagged capture (rules bypassed)",
  solo_agent: "Solo-agent shortcut",
  team_load_balance: "Team load-balance fallback",
  team_lead: "Team-lead fallback",
}

/** PURE: human label for a policy key. Rule-backed policies name the rule (a
 *  deleted rule is named honestly, never guessed); methods get their fallback label. */
export function policyLabel(row: { ruleId: string | null; method: string }, rules: AssignmentRuleInfo[]): string {
  if (row.ruleId) {
    const rule = rules.find((r) => r.id === row.ruleId)
    if (!rule) return `deleted rule ${row.ruleId.slice(0, 8)}`
    const name = rule.name?.trim() || `rule ${rule.id.slice(0, 8)}`
    return `${name} · ${rule.ruleType ?? "rule"}${rule.isActive ? "" : " (retired)"}`
  }
  return METHOD_LABELS[row.method] ?? row.method
}

/**
 * PURE: grade every attributed assignment against the appointment ledger.
 *   • earliest assignment per identity key wins (a re-assignment never double-counts)
 *   • an appointment at/before assignment ⇒ REFUSED (not the policy's outcome)
 *   • first appointment within the horizon ⇒ hit; after it (or window fully
 *     elapsed with none) ⇒ miss; open window with none ⇒ pending, ungraded.
 */
export function computePolicyOutcomes(
  cohort: AssignedCohortRow[],
  rules: AssignmentRuleInfo[],
  events: FirstAppointmentEvent[],
  nowIso: string,
): PolicyOutcomeReport {
  const horizonMs = ASSIGNMENT_OUTCOME_HORIZON_DAYS * 86_400_000
  const now = new Date(nowIso).getTime()

  // Earliest assignment per identity (rows sorted oldest-first).
  const sorted = [...cohort].sort((a, b) => String(a.assignedAt ?? "").localeCompare(String(b.assignedAt ?? "")))
  const firstByKey = new Map<string, AssignedCohortRow>()
  for (const r of sorted) {
    if (!r.assignedAt) continue
    if (!firstByKey.has(r.key)) firstByKey.set(r.key, r)
  }

  // Appointment times indexed by contact and by lead.
  const byContact = new Map<string, number[]>()
  const byLead = new Map<string, number[]>()
  for (const e of events) {
    if (!e.at) continue
    const t = new Date(e.at).getTime()
    if (!Number.isFinite(t)) continue
    if (e.contactId) byContact.set(e.contactId, [...(byContact.get(e.contactId) ?? []), t])
    if (e.leadId) byLead.set(e.leadId, [...(byLead.get(e.leadId) ?? []), t])
  }

  const acc = new Map<string, { ruleId: string | null; method: string; hits: number; misses: number; pending: number }>()
  let refusedPreexisting = 0
  const gradedDates: string[] = []

  for (const row of firstByKey.values()) {
    const t0 = new Date(row.assignedAt as string).getTime()
    if (!Number.isFinite(t0)) continue
    const ts = [
      ...(row.contactId ? byContact.get(row.contactId) ?? [] : []),
      ...(row.leadId ? byLead.get(row.leadId) ?? [] : []),
    ].sort((a, b) => a - b)

    if (ts.some((t) => t <= t0)) { refusedPreexisting += 1; continue } // pre-existing appointment — not the policy's doing

    const policyKey = row.ruleId ? `rule:${row.ruleId}` : `method:${row.method}`
    const bucket = acc.get(policyKey) ?? { ruleId: row.ruleId, method: row.method, hits: 0, misses: 0, pending: 0 }

    const firstAfter = ts.find((t) => t > t0)
    if (firstAfter != null) {
      if (firstAfter - t0 <= horizonMs) bucket.hits += 1
      else bucket.misses += 1
      gradedDates.push(row.assignedAt as string)
    } else if (now >= t0 + horizonMs) {
      bucket.misses += 1 // full window elapsed, no appointment — an observed non-event
      gradedDates.push(row.assignedAt as string)
    } else {
      bucket.pending += 1 // window still open — never graded early
    }
    acc.set(policyKey, bucket)
  }

  const stats: PolicyOutcomeStat[] = [...acc.entries()]
    .map(([policyKey, b]) => {
      const graded = b.hits + b.misses
      const rule = b.ruleId ? rules.find((r) => r.id === b.ruleId) : undefined
      return {
        policyKey,
        ruleId: b.ruleId,
        isActiveRule: !!rule?.isActive,
        label: policyLabel({ ruleId: b.ruleId, method: b.method }, rules),
        observations: graded,
        hits: b.hits,
        rate: graded > 0 ? round2(b.hits / graded) : null,
        pending: b.pending,
      }
    })
    .sort((a, b) => b.observations - a.observations || a.label.localeCompare(b.label))

  return {
    stats,
    gradedTotal: stats.reduce((s, x) => s + x.observations, 0),
    hitsTotal: stats.reduce((s, x) => s + x.hits, 0),
    pendingTotal: stats.reduce((s, x) => s + x.pending, 0),
    refusedPreexisting,
    gradedDates,
  }
}

// ─── The rail shape (prediction-accuracy adapter contract) ───────────────────

export const ASSIGNMENT_POLICY_BASE = {
  rail: "assignment_policy" as const,
  label: "Assignment-policy outcomes",
  honestNotes: [
    `The ${ASSIGNMENT_OUTCOME_HORIZON_DAYS}-day first-appointment window is a declared grading constant — the routing engine defines no horizon, so the label names it instead of implying one.`,
    "Attribution is the assignment_log row written AT assignment time (rule_id + method) — which policy routed each lead is recorded, never reconstructed in hindsight.",
    "Outcomes are real booked appointments (ISA/listing calendar events on the contact or lead, plus showings) — assignments whose contact had an appointment before assignment are refused.",
    "Form/import (Track-B) contact assignments began recording their matched rule with this build — they join the rail as those windows elapse; nothing earlier is retro-attributed.",
  ],
  predictionSource: "Admin assignment policies (assignment_rules), recorded per assignment (assignment_log.rule_id / assignment_method)",
  outcomeSource: "First booked appointment for the assigned contact (calendar_events isa/listing appointments + showings)",
  detailHref: "/dashboard/admin/assignment-rules",
}

function unavailableRail(why: string): RailAccuracy {
  return { ...ASSIGNMENT_POLICY_BASE, available: false, why, observations: 0, medianError: null, withinRate: null, period: null }
}

function periodOf(isoDates: string[]): { from: string; to: string } | null {
  const ds = isoDates.filter((d) => d.length > 0).sort()
  if (ds.length === 0) return null
  return { from: ds[0], to: ds[ds.length - 1] }
}

/** PURE: the assignment-policy rail from attributed assignments + appointment events. */
export function summarizeAssignmentPolicyRows(
  cohort: AssignedCohortRow[],
  rules: AssignmentRuleInfo[],
  events: FirstAppointmentEvent[],
  nowIso: string,
): RailAccuracy {
  const rep = computePolicyOutcomes(cohort, rules, events, nowIso)
  if (rep.gradedTotal === 0) {
    return unavailableRail(
      rep.pendingTotal > 0
        ? `${rep.pendingTotal} attributed assignment${rep.pendingTotal === 1 ? "" : "s"} still inside the open ${ASSIGNMENT_OUTCOME_HORIZON_DAYS}-day window — nothing is graded early.`
        : "No attributed assignment has been recorded yet — assignment_log rows accrue as Engine 2 assigns qualified leads.",
    )
  }
  const breakdown: RailBreakdownRow[] = rep.stats
    .filter((s) => s.observations > 0)
    .map((s) => ({ group: s.label, observations: s.observations, withinRate: s.rate, medianError: null }))
  return {
    ...ASSIGNMENT_POLICY_BASE,
    available: true,
    why: null,
    observations: rep.gradedTotal,
    medianError: null, // an outcome RATE rail — no error metric is minted
    withinRate: {
      rate: round2(rep.hitsTotal / rep.gradedTotal),
      label: `assigned contacts who reached a first appointment within ${ASSIGNMENT_OUTCOME_HORIZON_DAYS} days of assignment`,
    },
    period: periodOf(rep.gradedDates),
    breakdown,
    honestNotes: [
      ...ASSIGNMENT_POLICY_BASE.honestNotes,
      ...(rep.pendingTotal > 0 ? [`${rep.pendingTotal} assignment${rep.pendingTotal === 1 ? "" : "s"} still inside the window and not graded.`] : []),
      ...(rep.refusedPreexisting > 0 ? [`${rep.refusedPreexisting} assignment${rep.refusedPreexisting === 1 ? "" : "s"} refused — the contact already had an appointment before assignment.`] : []),
    ],
  }
}

/**
 * PURE: the material-divergence detector — two RULE-backed policies (both rules
 * currently active, both at/above the observation floor) whose measured outcome
 * rates differ by at least the declared gap. Fallback/method policies never
 * argue (there is no admin knob to defend). Null = no dispute — the sweep never
 * manufactures an argument.
 */
export function findDivergentRulePair(
  stats: PolicyOutcomeStat[],
  opts?: { minObservations?: number; minGap?: number },
): { top: PolicyOutcomeStat; laggard: PolicyOutcomeStat; gap: number } | null {
  const minObs = opts?.minObservations ?? ASSIGNMENT_POLICY_MIN_OBSERVATIONS
  const minGap = opts?.minGap ?? ASSIGNMENT_POLICY_DIVERGENCE
  const eligible = stats.filter((s) => s.ruleId && s.isActiveRule && s.observations >= minObs && s.rate != null)
  if (eligible.length < 2) return null
  const byRate = [...eligible].sort((a, b) => (b.rate as number) - (a.rate as number))
  const top = byRate[0]
  const laggard = byRate[byRate.length - 1]
  const gap = round2((top.rate as number) - (laggard.rate as number))
  return gap >= minGap ? { top, laggard, gap } : null
}

// ─── IO: load the cohort + outcome ledgers (read-only, bounded) ──────────────

const IN_CHUNK = 200
const APPOINTMENT_EVENT_TYPES = ["isa_appointment", "listing_appointment"]
const DEAD_APPOINTMENT_STATUSES = new Set(["cancelled", "canceled", "declined"])

async function chunkedIn<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[] | { error: string }> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await fetchChunk(ids.slice(i, i + IN_CHUNK))
    if (error) return { error: error.message }
    out.push(...(data ?? []))
  }
  return out
}

interface PolicyOutcomeInputs {
  cohort: AssignedCohortRow[]
  rules: AssignmentRuleInfo[]
  events: FirstAppointmentEvent[]
}

async function loadPolicyOutcomeInputs(svc: Svc, brokerageId?: string): Promise<PolicyOutcomeInputs | { error: string }> {
  // 1) Lead-path attribution — assignment_log, the ledger written at assignment time.
  let aq = svc.from("assignment_log")
    .select("lead_id, brokerage_id, rule_id, assignment_method, created_at")
    .order("created_at", { ascending: false })
    .limit(500)
  if (brokerageId) aq = aq.eq("brokerage_id", brokerageId)
  const { data: logRows, error: aErr } = await aq
  if (aErr) return { error: aErr.message }
  const logs = (logRows ?? []) as Array<{ lead_id: string; brokerage_id: string | null; rule_id: string | null; assignment_method: string | null; created_at: string | null }>

  // 2) The lead → contact join (leads.contact_id lands at conversion).
  const leadIds = [...new Set(logs.map((l) => l.lead_id).filter(Boolean))]
  const leadRows = await chunkedIn(leadIds, (chunk) =>
    svc.from("leads").select("id, contact_id").in("id", chunk).limit(IN_CHUNK) as any)
  if (!Array.isArray(leadRows)) return { error: leadRows.error }
  const contactByLead = new Map<string, string | null>()
  for (const l of leadRows as Array<{ id: string; contact_id: string | null }>) contactByLead.set(l.id, l.contact_id ?? null)

  const cohort: AssignedCohortRow[] = logs.map((l) => ({
    key: `lead:${l.lead_id}`,
    brokerageId: l.brokerage_id ?? null,
    contactId: contactByLead.get(l.lead_id) ?? null,
    leadId: l.lead_id,
    ruleId: l.rule_id ?? null,
    method: l.assignment_method ?? "unknown",
    assignedAt: l.created_at ?? null,
  }))

  // 3) Track-B attribution — CONTACT_CAPTURED events stamped with
  //    metadata.assignment (recording starts with this build; honest not-yet).
  let tq = svc.from("lifecycle_events")
    .select("entity_id, brokerage_id, metadata, created_at")
    .eq("event_type", KernelEvent.CONTACT_CAPTURED)
    .eq("entity_type", "contact")
    .not("metadata->assignment->>rule_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(500)
  if (brokerageId) tq = tq.eq("brokerage_id", brokerageId)
  const { data: trackB, error: tErr } = await tq
  if (tErr) return { error: tErr.message }
  const leadPathContacts = new Set(cohort.map((c) => c.contactId).filter(Boolean) as string[])
  for (const e of (trackB ?? []) as Array<{ entity_id: string; brokerage_id: string | null; metadata: Record<string, any> | null; created_at: string | null }>) {
    if (!e.entity_id || leadPathContacts.has(e.entity_id)) continue // never double-count a converted lead
    const assignment = e.metadata?.assignment as { method?: string; rule_id?: string | null } | undefined
    if (!assignment?.rule_id) continue
    cohort.push({
      key: `contact:${e.entity_id}`,
      brokerageId: e.brokerage_id ?? null,
      contactId: e.entity_id,
      leadId: null,
      ruleId: assignment.rule_id,
      method: assignment.method ?? "rule",
      assignedAt: e.created_at ?? null,
    })
  }

  // 4) The rule catalog (names + active flags — retired rules are named honestly).
  let rq = svc.from("assignment_rules").select("id, name, rule_type, is_active").limit(500)
  if (brokerageId) rq = rq.eq("brokerage_id", brokerageId)
  const { data: ruleRows, error: rErr } = await rq
  if (rErr) return { error: rErr.message }
  const rules: AssignmentRuleInfo[] = ((ruleRows ?? []) as any[]).map((r) => ({
    id: r.id, name: r.name ?? null, ruleType: r.rule_type ?? null, isActive: r.is_active === true,
  }))

  // 5) Outcome events — appointment-typed calendar events on the contact/lead
  //    entity, plus showings by contact. Dead statuses are excluded.
  const contactIds = [...new Set(cohort.map((c) => c.contactId).filter(Boolean) as string[])]
  const cohortLeadIds = [...new Set(cohort.map((c) => c.leadId).filter(Boolean) as string[])]
  const events: FirstAppointmentEvent[] = []

  const contactCal = await chunkedIn(contactIds, (chunk) =>
    svc.from("calendar_events").select("entity_id, start_at, status")
      .eq("entity_type", "contact").in("event_type", APPOINTMENT_EVENT_TYPES)
      .in("entity_id", chunk).limit(IN_CHUNK * 4) as any)
  if (!Array.isArray(contactCal)) return { error: contactCal.error }
  for (const e of contactCal as Array<{ entity_id: string; start_at: string | null; status: string | null }>) {
    if (DEAD_APPOINTMENT_STATUSES.has(String(e.status ?? "").toLowerCase())) continue
    events.push({ contactId: e.entity_id, leadId: null, at: e.start_at })
  }

  const leadCal = await chunkedIn(cohortLeadIds, (chunk) =>
    svc.from("calendar_events").select("entity_id, start_at, status")
      .eq("entity_type", "lead").in("event_type", APPOINTMENT_EVENT_TYPES)
      .in("entity_id", chunk).limit(IN_CHUNK * 4) as any)
  if (!Array.isArray(leadCal)) return { error: leadCal.error }
  for (const e of leadCal as Array<{ entity_id: string; start_at: string | null; status: string | null }>) {
    if (DEAD_APPOINTMENT_STATUSES.has(String(e.status ?? "").toLowerCase())) continue
    events.push({ contactId: null, leadId: e.entity_id, at: e.start_at })
  }

  const showingRows = await chunkedIn(contactIds, (chunk) =>
    svc.from("showings").select("contact_id, scheduled_at, scheduled_date, status")
      .in("contact_id", chunk).limit(IN_CHUNK * 4) as any)
  if (!Array.isArray(showingRows)) return { error: showingRows.error }
  for (const s of showingRows as Array<{ contact_id: string; scheduled_at: string | null; scheduled_date: string | null; status: string | null }>) {
    if (DEAD_APPOINTMENT_STATUSES.has(String(s.status ?? "").toLowerCase())) continue
    events.push({ contactId: s.contact_id, leadId: null, at: s.scheduled_at ?? s.scheduled_date })
  }

  return { cohort, rules, events }
}

/** The prediction-accuracy adapter — read-only; failures degrade to an honest
 *  unavailable rail (never a fabricated number). */
export async function assignmentPolicyAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  const inputs = await loadPolicyOutcomeInputs(svc, brokerageId)
  if ("error" in inputs) return unavailableRail(`ledger unreadable: ${inputs.error}`)
  return summarizeAssignmentPolicyRows(inputs.cohort, inputs.rules, inputs.events, new Date().toISOString())
}

// ─── THE DELIBERATION FEED — the live raiser for 'assignment_policy_outcomes' ─

/** Bound per sweep — mirrors the cross-referral sweep idiom. */
const MAX_BROKERAGES_PER_SWEEP = 25

/**
 * THE ASSIGNMENT-POLICY SWEEP (assignment_policy_outcomes, deliberative):
 * for every tenant running at least two ACTIVE assignment rules, grade each
 * policy's measured 30-day first-appointment outcome; when two active rules
 * diverge materially (both ≥ the observation floor) the AI ISA raises the
 * dispute INTO the Data Steward's domain so the config is argued against the
 * evidence. One referral per (rule pair) per renag window, deduped over the bus
 * ledger itself. No dispute → no referral — never a manufactured argument.
 * Registered in REFERRAL_EMITTERS (lib/managers/cross-referral.ts) and run from
 * the manager-signals cron via runReferralSweeps.
 */
export async function publishAssignmentPolicyReferrals(client?: Svc): Promise<SlaReferralSweepResult> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = client ?? (createServiceClient() as unknown as Svc)
  const result: SlaReferralSweepResult = { candidates: 0, published: 0, skippedRecent: 0, errors: [] }
  const pct = (s: PolicyOutcomeStat) => `${Math.round((s.rate ?? 0) * 100)}%`
  try {
    // Candidate tenants: at least two ACTIVE rules (one rule has nothing to argue against).
    const { data: ruleRows, error } = await svc.from("assignment_rules")
      .select("brokerage_id")
      .eq("is_active", true)
      .limit(2000)
    if (error) { result.errors.push(`assignment_rules: ${error.message}`); return result }
    const activeCount = new Map<string, number>()
    for (const r of (ruleRows ?? []) as Array<{ brokerage_id: string | null }>) {
      if (!r.brokerage_id) continue
      activeCount.set(r.brokerage_id, (activeCount.get(r.brokerage_id) ?? 0) + 1)
    }
    const candidates = [...activeCount.entries()].filter(([, n]) => n >= 2).map(([b]) => b).slice(0, MAX_BROKERAGES_PER_SWEEP)
    result.candidates = candidates.length

    for (const brokerageId of candidates) {
      try {
        const inputs = await loadPolicyOutcomeInputs(svc, brokerageId)
        if ("error" in inputs) { result.errors.push(`${brokerageId}: ${inputs.error}`); continue }
        const rep = computePolicyOutcomes(inputs.cohort, inputs.rules, inputs.events, new Date().toISOString())
        const pair = findDivergentRulePair(rep.stats)
        if (!pair) continue // no material divergence — nothing to argue
        const res = await raiseReferralDeduped({
          brokerageId,
          fromManager: "ai_isa",
          toManager: "data_steward",
          collabDomain: "assignment_policy_outcomes",
          entityType: "assignment_rule",
          entityId: pair.laggard.ruleId,
          ask:
            `The assignment policies are producing materially different measured outcomes: "${pair.top.label}" reached a ` +
            `first appointment within ${ASSIGNMENT_OUTCOME_HORIZON_DAYS} days for ${pct(pair.top)} of ${pair.top.observations} assigned contacts, while ` +
            `"${pair.laggard.label}" managed ${pct(pair.laggard)} of ${pair.laggard.observations} (gap ${Math.round(pair.gap * 100)} pts). ` +
            `Argue the policy: rebalance or retire the lagging rule, or defend the split the routing config intends.`,
          payload: {
            horizon_days: ASSIGNMENT_OUTCOME_HORIZON_DAYS,
            top_rule_id: pair.top.ruleId, top_rate: pair.top.rate, top_observations: pair.top.observations,
            laggard_rule_id: pair.laggard.ruleId, laggard_rate: pair.laggard.rate, laggard_observations: pair.laggard.observations,
          },
          dedupe: {
            sweep: "assignment_policy",
            rule_pair: [pair.top.ruleId, pair.laggard.ruleId].sort().join("|"),
          },
        }, svc as any)
        if (res.skippedRecent) result.skippedRecent += 1
        else if (res.ok) result.published += 1
        else if (res.reason) result.errors.push(`${brokerageId}: ${res.reason}`)
      } catch (e) {
        result.errors.push(`${brokerageId}: ${e instanceof Error ? e.message : "sweep failed"}`)
      }
    }
  } catch (e) {
    result.errors.push(`assignment-policy: ${e instanceof Error ? e.message : "sweep failed"}`)
  }
  return result
}
