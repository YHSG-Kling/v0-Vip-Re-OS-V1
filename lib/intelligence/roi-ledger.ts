// lib/intelligence/roi-ledger.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ROI LEDGER — "what your AI team earned", live on the Command Center
// instead of buried in a monthly artifact. Every number traces to a ledger row
// in the trailing window (the SAME counting rules as the board packet — no
// second formula): marketing-attributed closed volume from the attribution
// engine, calls the AI answered, appointments it booked live, drafts agents
// actually sent, opt-outs honored. This is the renewal conversation and the
// anti-churn weapon in one tile: competitors show brokers their agents'
// numbers — we show brokers the SOFTWARE's numbers, measured, not claimed.

import { compactCentsMoney } from "@/lib/format/money"
// Wave 106 (106B): the ONE experience vocabulary (CLAUDE.md §6) — the ledger's detail.experience is read against it.
import { isExperienceKind } from "@/lib/ai-isa/lead-action-plan"

export interface RoiLedger {
  periodDays: number
  sinceIso: string
  /** Attribution-weighted closed volume credited to AI marketing (cents). */
  attributedGciCents: number
  /** Distinct closed transactions carrying attribution credits. */
  attributedDeals: number
  /** Inbound calls the AI answered. */
  callsAnswered: number
  /** Appointments booked live on AI calls. */
  appointmentsBooked: number
  /** AI reply drafts agents accepted/sent. */
  draftsSent: number
  /** Opt-outs honored immediately (compliance is a feature). */
  optOutsHonored: number
  /** The one-line headline for the tile (empty when there is nothing earned). */
  headline: string
  /** Wave 100A: decision → action → outcome → revenue, credited to agent_action_ledger rows
   *  (loadLedgerAttribution). null when it could not be read — never a silent zero. */
  ledgerAttribution?: LedgerAttributionSummary | null
}

// TOMBSTONE (§1.1, 2026-09-08): the local `money` (cents → "$1.2M"/"$45K"/"$900")
// lived here; survivor lib/format/money.ts:compactCentsMoney.

/** PURE: the headline sentence — earned lines only, silence when nothing earned. */
export function composeRoiHeadline(l: Omit<RoiLedger, "headline">): string {
  const parts: string[] = []
  if (l.attributedGciCents > 0) parts.push(`${compactCentsMoney(l.attributedGciCents)} closed volume attributed to AI marketing across ${l.attributedDeals} deal${l.attributedDeals === 1 ? "" : "s"}`)
  if (l.callsAnswered > 0) parts.push(`${l.callsAnswered} call${l.callsAnswered === 1 ? "" : "s"} answered${l.appointmentsBooked > 0 ? ` (${l.appointmentsBooked} booked live)` : ""}`)
  if (l.draftsSent > 0) parts.push(`${l.draftsSent} AI draft${l.draftsSent === 1 ? "" : "s"} your agents sent`)
  if (parts.length === 0) return ""
  return `Last ${l.periodDays} days: ${parts.join(" · ")} — measured by the attribution engine, not claimed.`
}

/** Trailing-window ROI from the live ledgers (board-packet counting rules). */
export async function generateRoiLedger(svc: any, brokerageId: string, periodDays = 90, opts: { attribution?: boolean } = {}): Promise<RoiLedger> {
  const sinceIso = new Date(Date.now() - periodDays * 86_400_000).toISOString()
  const cnt = async (q: any) => ((await q) as any)?.count ?? 0
  const [credits, calls, bookings, drafts, optOuts] = await Promise.all([
    svc.from("marketing_attribution_credits").select("credit_dollars, transaction_id")
      .eq("brokerage_id", brokerageId).gte("created_at", sinceIso).limit(2000),
    cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("direction", "inbound").gte("started_at", sinceIso)),
    cnt(svc.from("showings").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).ilike("notes", "%AI receptionist%").gte("created_at", sinceIso)),
    cnt(svc.from("ai_message_drafts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).in("status", ["accepted", "sent", "edited"]).gte("created_at", sinceIso)),
    cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("outcome", "opt_out").gte("started_at", sinceIso)),
  ])
  const rows = ((credits as any)?.data ?? []) as Array<{ credit_dollars: number | null; transaction_id: string | null }>
  const base = {
    periodDays, sinceIso,
    attributedGciCents: rows.reduce((a, c) => a + Math.round(Number(c.credit_dollars ?? 0) * 100), 0),
    attributedDeals: new Set(rows.map((c) => c.transaction_id).filter(Boolean)).size,
    callsAnswered: calls, appointmentsBooked: bookings, draftsSent: drafts, optOutsHonored: optOuts,
  }
  // Wave 100A: "which reason code / manager / playbook / campaign produced revenue" — the ledger half.
  // Asked for by the Command Center tile only (the pitch reel reads the headline numbers).
  if (!opts.attribution) return { ...base, headline: composeRoiHeadline(base) }
  const attr = await loadLedgerAttribution(svc, brokerageId, { sinceIso })
  if (!attr.ok) console.error("[roi-ledger] ledger attribution unavailable:", attr.error)
  return { ...base, headline: composeRoiHeadline(base), ledgerAttribution: attr.ok ? summarizeLedgerAttribution(attr.result, 5) : null }
}

// ═════════════════════════════════════════════════════════════════════════════
// DECISION → ACTION → OUTCOME → REVENUE ATTRIBUTION (wave 100A; gap map row 28)
// ─────────────────────────────────────────────────────────────────────────────
// EXTENDS this ledger rather than a new subsystem (OWNER LAW 1): the marketing engine
// (lib/marketing/attribution.ts) credits CAMPAIGN TOUCHPOINTS; this credits the ACTION LEDGER
// (agent_action_ledger — every send, dial, portal message, AI tool call and every NBA wait /
// do-nothing decision) with the same anchor rule (a deal is won at contract_date, else close_date)
// and the same GCI rule (commission_amount ?? estimated_commission). Read-time, no new table.
//
// THE DETERMINISTIC RULE (no model decides money):
//   · an outcome is a reply (communications inbound / isa_outreach_log.replied_at), an appointment
//     (showings booked), a contract (transactions.contract_date) or a closed deal (status
//     closed / funded, revenue = GCI);
//   · a ledger row is ELIGIBLE for an outcome when it is the SAME TENANT, it happened STRICTLY
//     BEFORE the outcome and inside that outcome kind's window (ATTRIBUTION_WINDOW_DAYS), and it is
//     about the outcome's person — its subject is the contact, a lead that became the contact, or
//     the deal — OR it shares a correlation_id (the kernel causation chain) with a row that is;
//   · it must have HAPPENED: status 'executed' (an action), or 'skipped' on a `*.decision.*` row
//     (an NBA wait / do-nothing decision). Failed / unknown / proposed rows never earn credit;
//   · LAST-TOUCH: 100% to the latest eligible executed action (a decision only when no action
//     preceded the outcome);
//   · ALL-TOUCH: an equal split across every eligible row, actions and decisions alike, in whole
//     cents, the remainder to the latest row so the split sums exactly to the revenue.

type LedgerOutcomeKind = "reply" | "appointment" | "contract" | "closed"

/** Days before an outcome in which a ledger row may earn credit for it. contract / closed match the
 *  marketing engine's LOOKBACK_DAYS (lib/marketing/attribution.ts) so the two never disagree. */
const ATTRIBUTION_WINDOW_DAYS: Readonly<Record<LedgerOutcomeKind, number>> = Object.freeze({
  reply: 30, appointment: 90, contract: 180, closed: 180,
})

interface AttributableOutcome {
  /** `<kind>:<source row id>` — stable, so a credit names what it credits. */
  ref: string
  kind: LedgerOutcomeKind
  brokerageId: string
  /** The person / deal ids a ledger row's subject_id must match (contact, its leads, the deal). */
  subjectIds: string[]
  /** When it happened (the anchor). */
  at: string
  /** Revenue in cents (closed deals only; 0 otherwise). */
  revenueCents: number
}

interface AttributableAction {
  id: string
  brokerage_id: string
  action: string
  status: string
  reason_code: string
  actor_type: string
  actor_manager_key?: string | null
  system_source?: string | null
  subject_type: string
  subject_id?: string | null
  created_at: string
  correlation_id?: string | null
  detail?: Record<string, unknown> | null
}

interface LedgerCredit {
  outcomeRef: string
  kind: LedgerOutcomeKind
  actionId: string
  model: "last_touch" | "all_touch"
  /** true when the credited row is an NBA decision (wait / do_nothing), not a sent action. */
  decision: boolean
  cents: number
}

interface AttributionRow {
  key: string
  lastTouchCents: number
  allTouchCents: number
  /** Outcomes this key held the LAST touch for, per kind. */
  lastTouchOutcomes: Record<LedgerOutcomeKind, number>
}

export interface LedgerAttribution {
  outcomes: AttributableOutcome[]
  credits: LedgerCredit[]
  /** Outcomes no eligible ledger row preceded (published, never hidden). */
  uncredited: string[]
  byReasonCode: AttributionRow[]
  byManager: AttributionRow[]
  byPlaybook: AttributionRow[]
  byCampaign: AttributionRow[]
  /** Wave 101 (101B): `<experiment key>=<arm>` from ledger detail.experiment (lib/kernel/experiments.ts). */
  byExperimentArm: AttributionRow[]
  /** Wave 106 (106B): the EXPERIENCE KIND (lib/ai-isa/lead-action-plan.ts EXPERIENCE_KINDS) from ledger
   *  detail.experience — so the outcome engine learns WHICH experience converts, not only which channel. */
  byExperience: AttributionRow[]
}

/** The attribution-eligible DECISION rows: wait / do_nothing only. Wave 102C ledgers the acting verdicts
 *  (`*.decision.send_touch` / `*.decision.convert`, status 'skipped') as decision rows for replay — they
 *  are deliberately NOT eligible here: the act they announce is its chokepoint's own 'executed' row, and
 *  counting the verdict too would credit one touch twice. The "executed" rule below is unchanged (owner, wave 102). */
const DECISION_ACTION = /\.decision\.(wait|do_nothing)$/
function isEligibleStatus(a: AttributableAction): boolean {
  return a.status === "executed" || (a.status === "skipped" && DECISION_ACTION.test(a.action))
}

/** The "which X produced revenue" keys of a ledger row. Campaign / experiment arm are null when the row names none. */
function attributionKeys(a: AttributableAction): { reason: string; manager: string; playbook: string; campaign: string | null; experimentArm: string | null; experience: string | null } {
  const d = a.detail ?? {}
  const campaign = (d.sequence_id ?? d.campaign_id ?? null) as string | null
  const exp = (d.experiment ?? null) as { key?: unknown; arm?: unknown } | null
  return {
    experimentArm: exp && typeof exp.key === "string" && typeof exp.arm === "string" ? `${exp.key}=${exp.arm}` : null,
    // 106B: only the planner's vocabulary counts — an arbitrary string in detail.experience is not an experience.
    experience: isExperienceKind(d.experience) ? d.experience : null,
    reason: a.reason_code || "UNSPECIFIED",
    manager: a.actor_manager_key ?? `${a.actor_type}`,
    playbook: a.system_source ?? a.action.split(".")[0],
    campaign: campaign ? String(campaign) : null,
  }
}

/**
 * PURE — credit every outcome to the ledger rows that preceded it (the rule above).
 * @proofSeam exported so scripts/outcome-attribution-simulator.ts asserts the credit rule (precedes, same tenant, last + all touch, decisions) on the pure function directly.
 */
export function attributeOutcomesToLedger(outcomes: AttributableOutcome[], actions: AttributableAction[]): LedgerAttribution {
  const credits: LedgerCredit[] = []
  const uncredited: string[] = []
  const byId = new Map(actions.map((a) => [a.id, a]))
  for (const o of outcomes) {
    const at = Date.parse(o.at)
    if (!Number.isFinite(at)) { uncredited.push(o.ref); continue }
    const from = at - ATTRIBUTION_WINDOW_DAYS[o.kind] * 86_400_000
    const subjects = new Set(o.subjectIds)
    const inWindow = actions.filter((a) => {
      const t = Date.parse(a.created_at)
      return a.brokerage_id === o.brokerageId && Number.isFinite(t) && t < at && t >= from && isEligibleStatus(a)
    })
    const direct = inWindow.filter((a) => !!a.subject_id && subjects.has(a.subject_id))
    const chains = new Set(direct.map((a) => a.correlation_id).filter((c): c is string => !!c))
    const eligible = inWindow.filter((a) => direct.includes(a) || (!!a.correlation_id && chains.has(a.correlation_id)))
      .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : 1))
    if (eligible.length === 0) { uncredited.push(o.ref); continue }
    const executed = eligible.filter((a) => a.status === "executed")
    const last = (executed.length > 0 ? executed : eligible)[(executed.length > 0 ? executed : eligible).length - 1]
    credits.push({ outcomeRef: o.ref, kind: o.kind, actionId: last.id, model: "last_touch", decision: last.status !== "executed", cents: o.revenueCents })
    const share = Math.floor(o.revenueCents / eligible.length)
    eligible.forEach((a, i) => {
      const cents = i === eligible.length - 1 ? o.revenueCents - share * (eligible.length - 1) : share
      credits.push({ outcomeRef: o.ref, kind: o.kind, actionId: a.id, model: "all_touch", decision: a.status !== "executed", cents })
    })
  }
  const roll = (dim: "reason" | "manager" | "playbook" | "campaign" | "experimentArm" | "experience"): AttributionRow[] => {
    const m = new Map<string, AttributionRow>()
    for (const c of credits) {
      const a = byId.get(c.actionId)
      if (!a) continue
      const key = attributionKeys(a)[dim]
      if (key == null) continue
      const row = m.get(key) ?? { key, lastTouchCents: 0, allTouchCents: 0, lastTouchOutcomes: { reply: 0, appointment: 0, contract: 0, closed: 0 } }
      if (c.model === "last_touch") { row.lastTouchCents += c.cents; row.lastTouchOutcomes[c.kind]++ }
      else row.allTouchCents += c.cents
      m.set(key, row)
    }
    return [...m.values()].sort((x, y) => y.lastTouchCents - x.lastTouchCents || y.allTouchCents - x.allTouchCents || x.key.localeCompare(y.key))
  }
  return { outcomes, credits, uncredited, byReasonCode: roll("reason"), byManager: roll("manager"), byPlaybook: roll("playbook"), byCampaign: roll("campaign"), byExperimentArm: roll("experimentArm"), byExperience: roll("experience") }
}

interface LedgerAttributionSummary {
  outcomes: number
  credited: number
  revenueCents: number
  byReasonCode: AttributionRow[]
  byManager: AttributionRow[]
  byPlaybook: AttributionRow[]
  byCampaign: AttributionRow[]
  byExperimentArm: AttributionRow[]
  byExperience: AttributionRow[]
}

/** The tile's cut: totals + the top `n` per dimension. */
function summarizeLedgerAttribution(r: LedgerAttribution, n: number): LedgerAttributionSummary {
  return {
    outcomes: r.outcomes.length,
    credited: r.outcomes.length - r.uncredited.length,
    revenueCents: r.outcomes.reduce((s, o) => s + o.revenueCents, 0),
    byReasonCode: r.byReasonCode.slice(0, n), byManager: r.byManager.slice(0, n),
    byPlaybook: r.byPlaybook.slice(0, n), byCampaign: r.byCampaign.slice(0, n),
    byExperimentArm: r.byExperimentArm.slice(0, n), byExperience: r.byExperience.slice(0, n),
  }
}

const ATTR_LIMIT = 2000
const LEDGER_ATTR_COLS = "id, brokerage_id, action, status, reason_code, actor_type, actor_manager_key, system_source, subject_type, subject_id, created_at, correlation_id, detail"
function absent(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204"
}
const toCents = (v: unknown): number => Math.max(0, Math.round(Number(v ?? 0) * 100) || 0)

/**
 * THE KERNEL QUERY. Every read is pinned to `brokerageId`, which callers take from the SESSION
 * (command-center / flight recorder) — never from a body. Scope: the trailing window from
 * `sinceIso`, or ONE contact / ONE deal (the flight recorder). Reads are refusal-checked; a missing
 * ledger table reports `ledgerAvailable: false` rather than "no revenue". Never throws.
 */
export async function loadLedgerAttribution(
  svc: any,
  brokerageId: string,
  scope: { sinceIso?: string; contactId?: string; transactionId?: string },
): Promise<{ ok: true; result: LedgerAttribution; ledgerAvailable: boolean } | { ok: false; error: string }> {
  try {
    const since = scope.sinceIso ?? new Date(Date.now() - 365 * 86_400_000).toISOString()
    const one = scope.contactId ?? null

    // 1. Deals (contract + closed outcomes).
    let txq = svc.from("transactions")
      .select("id, brokerage_id, status, buyer_contact_id, seller_contact_id, contact_id, contract_date, close_date, commission_amount, estimated_commission")
      .eq("brokerage_id", brokerageId).is("deleted_at", null)
    if (scope.transactionId) txq = txq.eq("id", scope.transactionId)
    else if (one) txq = txq.or(`buyer_contact_id.eq.${one},seller_contact_id.eq.${one},contact_id.eq.${one}`)
    else txq = txq.or(`contract_date.gte.${since.slice(0, 10)},close_date.gte.${since.slice(0, 10)}`)
    const tx = await txq.limit(ATTR_LIMIT)
    if (tx.error) return { ok: false, error: `transactions: ${tx.error.message}` }
    const deals = (tx.data ?? []) as Array<Record<string, any>>
    const contactIds = new Set<string>(one ? [one] : [])
    for (const d of deals) for (const k of ["buyer_contact_id", "seller_contact_id", "contact_id"]) if (d[k]) contactIds.add(d[k] as string)
    if (scope.transactionId && deals.length === 0) return { ok: true, result: attributeOutcomesToLedger([], []), ledgerAvailable: true }

    // 2. Appointments + replies (window mode reads the tenant's; person / deal mode reads only
    //    those people's — and nothing at all when the deal names no contact).
    const personMode = !!(one || scope.transactionId)
    const none = { data: [], error: null }
    const pin = (q: any, col: string, dateCol: string) => !personMode ? q.gte(dateCol, since).limit(ATTR_LIMIT)
      : contactIds.size > 0 ? q.in(col, [...contactIds].slice(0, 200)).limit(ATTR_LIMIT) : Promise.resolve(none)
    const [sh, comm, isa] = await Promise.all([
      pin(svc.from("showings").select("id, contact_id, created_at, status").eq("brokerage_id", brokerageId).not("contact_id", "is", null), "contact_id", "created_at"),
      pin(svc.from("communications").select("id, contact_id, created_at").eq("brokerage_id", brokerageId).eq("direction", "inbound").not("contact_id", "is", null), "contact_id", "created_at"),
      pin(svc.from("isa_outreach_log").select("id, contact_id, lead_id, replied_at").eq("brokerage_id", brokerageId).not("replied_at", "is", null), "contact_id", "replied_at"),
    ])
    for (const [label, r] of [["showings", sh], ["communications", comm], ["isa_outreach_log", isa]] as const) {
      if (r.error) return { ok: false, error: `${label}: ${r.error.message}` }
    }
    const showings = ((sh.data ?? []) as Array<Record<string, any>>).filter((s) => !/cancel/i.test(String(s.status ?? "")))
    for (const s of showings) contactIds.add(s.contact_id)
    for (const c of (comm.data ?? []) as Array<Record<string, any>>) contactIds.add(c.contact_id)
    for (const i of (isa.data ?? []) as Array<Record<string, any>>) if (i.contact_id) contactIds.add(i.contact_id)

    // 3. The leads that BECAME these contacts (a lead-stage action earns credit for the contact's outcome).
    const leadsByContact = new Map<string, string[]>()
    const contactList = [...contactIds]
    for (let i = 0; i < contactList.length; i += 200) {
      const lr = await svc.from("leads").select("id, contact_id").eq("brokerage_id", brokerageId).in("contact_id", contactList.slice(i, i + 200)).limit(ATTR_LIMIT)
      if (lr.error) return { ok: false, error: `leads: ${lr.error.message}` }
      for (const l of (lr.data ?? []) as Array<{ id: string; contact_id: string }>) leadsByContact.set(l.contact_id, [...(leadsByContact.get(l.contact_id) ?? []), l.id])
    }
    const personIds = (contactId: string | null | undefined, leadId?: string | null) =>
      [...(contactId ? [contactId, ...(leadsByContact.get(contactId) ?? [])] : []), ...(leadId ? [leadId] : [])]

    // 4. Outcomes.
    const outcomes: AttributableOutcome[] = []
    for (const d of deals) {
      const people = [d.buyer_contact_id, d.seller_contact_id, d.contact_id].filter(Boolean).flatMap((c: string) => personIds(c))
      const subjectIds = [...new Set([...people, d.id as string])]
      if (d.contract_date) outcomes.push({ ref: `contract:${d.id}`, kind: "contract", brokerageId, subjectIds, at: String(d.contract_date), revenueCents: 0 })
      if ((d.status === "closed" || d.status === "funded") && (d.contract_date || d.close_date)) {
        outcomes.push({ ref: `closed:${d.id}`, kind: "closed", brokerageId, subjectIds, at: String(d.contract_date ?? d.close_date), revenueCents: toCents(d.commission_amount ?? d.estimated_commission) })
      }
    }
    for (const s of showings) outcomes.push({ ref: `appointment:${s.id}`, kind: "appointment", brokerageId, subjectIds: personIds(s.contact_id), at: String(s.created_at), revenueCents: 0 })
    for (const c of (comm.data ?? []) as Array<Record<string, any>>) outcomes.push({ ref: `reply:${c.id}`, kind: "reply", brokerageId, subjectIds: personIds(c.contact_id), at: String(c.created_at), revenueCents: 0 })
    for (const i of (isa.data ?? []) as Array<Record<string, any>>) outcomes.push({ ref: `reply:isa:${i.id}`, kind: "reply", brokerageId, subjectIds: personIds(i.contact_id, i.lead_id), at: String(i.replied_at), revenueCents: 0 })
    if (outcomes.length === 0) return { ok: true, result: attributeOutcomesToLedger([], []), ledgerAvailable: true }

    // 5. The ledger rows about those people / deals, then one hop along their correlation chains.
    const earliest = Math.min(...outcomes.map((o) => Date.parse(o.at)).filter(Number.isFinite)) - 180 * 86_400_000
    const fromIso = new Date(Number.isFinite(earliest) ? earliest : Date.parse(since)).toISOString()
    const ids = [...new Set(outcomes.flatMap((o) => o.subjectIds))]
    const actions = new Map<string, AttributableAction>()
    for (let i = 0; i < ids.length && actions.size < ATTR_LIMIT; i += 200) {
      const r = await svc.from("agent_action_ledger").select(LEDGER_ATTR_COLS)
        .eq("brokerage_id", brokerageId).in("subject_type", ["contact", "lead", "transaction"]).in("subject_id", ids.slice(i, i + 200))
        .gte("created_at", fromIso).limit(ATTR_LIMIT)
      if (r.error) {
        if (absent(r.error.code)) return { ok: true, result: attributeOutcomesToLedger(outcomes, []), ledgerAvailable: false }
        return { ok: false, error: `agent_action_ledger: ${r.error.message}` }
      }
      for (const a of (r.data ?? []) as AttributableAction[]) actions.set(a.id, a)
    }
    const chains = [...new Set([...actions.values()].map((a) => a.correlation_id).filter((c): c is string => !!c))]
    for (let i = 0; i < chains.length && actions.size < ATTR_LIMIT; i += 200) {
      const r = await svc.from("agent_action_ledger").select(LEDGER_ATTR_COLS)
        .eq("brokerage_id", brokerageId).in("correlation_id", chains.slice(i, i + 200)).gte("created_at", fromIso).limit(ATTR_LIMIT)
      if (r.error) return { ok: false, error: `agent_action_ledger (chain): ${r.error.message}` }
      for (const a of (r.data ?? []) as AttributableAction[]) actions.set(a.id, a)
    }
    return { ok: true, result: attributeOutcomesToLedger(outcomes, [...actions.values()]), ledgerAvailable: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}

// ─── PER-ARM OUTCOMES → agent_outcome_evaluations (wave 102, lane 102D; 101B still-open) ────────

export interface ArmOutcomeRecording {
  /** Last-touch credits that landed on an action carrying detail.experiment. */
  armCredits: number
  written: number
  duplicates: number
  /** m700 part 2 not applied (evaluator / experiment columns absent) — nothing written, said here. */
  schemaLag: boolean
  errors: string[]
}

/**
 * PURE — the arm outcomes an attribution result holds: every LAST-TOUCH credit whose credited action
 * carries `detail.experiment = { key, arm }` (lib/kernel/experiments.ts experimentLedgerDetail).
 * Last touch only: an all-touch share would credit the same outcome to both arms of one test.
 * @proofSeam exported so scripts/replay-harness-guard.ts asserts the arm rule on the pure function directly.
 */
export function experimentArmOutcomes(r: LedgerAttribution, actions: Pick<AttributableAction, "id" | "detail">[]): Array<{
  ledgerActionId: string; experimentKey: string; experimentArm: string; outcomeRef: string; outcomeKind: LedgerOutcomeKind; outcomeAt: string
}> {
  const byId = new Map(actions.map((a) => [a.id, a]))
  const at = new Map(r.outcomes.map((o) => [o.ref, o.at]))
  const out: ReturnType<typeof experimentArmOutcomes> = []
  for (const c of r.credits) {
    if (c.model !== "last_touch") continue
    const exp = (byId.get(c.actionId)?.detail?.experiment ?? null) as { key?: unknown; arm?: unknown } | null
    if (!exp || typeof exp.key !== "string" || typeof exp.arm !== "string" || !exp.key || !exp.arm) continue
    out.push({ ledgerActionId: c.actionId, experimentKey: exp.key, experimentArm: exp.arm, outcomeRef: c.outcomeRef, outcomeKind: c.kind, outcomeAt: at.get(c.outcomeRef) ?? "" })
  }
  return out
}

/**
 * When an attributed outcome lands on an experiment-arm action, write the evaluation row through
 * THE ONE agent_outcome_evaluations writer (lib/agents/outcomes.ts recordOutcomeEvaluation,
 * evaluator 'ledger_attribution'). Idempotent on (ledger_action_id, outcome_ref). Pinned to
 * `brokerageId` (the cron's per-tenant loop); the window is the attribution's trailing window.
 * Readers: lib/campaign-sequences/copy-learning-conductor.ts loadExperimentArmResults (the winner gate).
 */
export async function recordExperimentArmOutcomes(
  svc: any,
  brokerageId: string,
  opts: { sinceIso?: string; windowDays?: number } = {},
): Promise<{ ok: true; recording: ArmOutcomeRecording } | { ok: false; error: string }> {
  const since = opts.sinceIso ?? new Date(Date.now() - (opts.windowDays ?? 90) * 86_400_000).toISOString()
  const attr = await loadLedgerAttribution(svc, brokerageId, { sinceIso: since })
  if (!attr.ok) return attr
  const recording: ArmOutcomeRecording = { armCredits: 0, written: 0, duplicates: 0, schemaLag: false, errors: [] }
  if (!attr.ledgerAvailable) return { ok: true, recording }
  // The credited actions' detail is not on the attribution result — re-read only the credited rows.
  const creditedIds = [...new Set(attr.result.credits.filter((c) => c.model === "last_touch").map((c) => c.actionId))]
  const actions: Pick<AttributableAction, "id" | "detail">[] = []
  for (let i = 0; i < creditedIds.length; i += 200) {
    const r = await svc.from("agent_action_ledger").select("id, detail").eq("brokerage_id", brokerageId).in("id", creditedIds.slice(i, i + 200)).limit(ATTR_LIMIT)
    if (r.error) return { ok: false, error: `agent_action_ledger (credited): ${r.error.message}` }
    for (const a of (r.data ?? []) as Pick<AttributableAction, "id" | "detail">[]) actions.push(a)
  }
  const arms = experimentArmOutcomes(attr.result, actions)
  recording.armCredits = arms.length
  if (arms.length === 0) return { ok: true, recording }
  const { recordOutcomeEvaluation, isOutcomeEvaluationSchemaLag } = await import("@/lib/agents/outcomes")
  for (const a of arms) {
    const w = await recordOutcomeEvaluation(svc, {
      evaluator: "ledger_attribution", brokerageId, ledgerActionId: a.ledgerActionId, experimentKey: a.experimentKey, experimentArm: a.experimentArm,
      outcomeRef: a.outcomeRef, outcomeKind: a.outcomeKind, outcomeAt: a.outcomeAt || new Date().toISOString(),
      explanation: `${a.outcomeKind} attributed (last touch) to ${a.experimentKey} arm ${a.experimentArm}`,
    })
    if (!w.ok) {
      if (isOutcomeEvaluationSchemaLag(w.code)) { recording.schemaLag = true; recording.errors.push(w.error); break }
      recording.errors.push(w.error)
      continue
    }
    if (w.duplicate) recording.duplicates++
    else recording.written++
  }
  return { ok: true, recording }
}

// ─── ATTRIBUTED OUTCOMES → THE MISSION THEY SERVED (lane 104F; wire of lib/kernel/missions.ts attachOutcome) ─
// The same attribution result, one more reader: a LAST-TOUCH credit whose credited action belongs to a
// mission (the action id is in missions.actions — attachAction's record — or the ledger row's
// detail.mission_id names one) attaches the outcome to that mission (outcome vocabulary reply /
// appointment / contract / closed, revenue in cents) and moves its `attributed_<kind>` progress.
// Last touch only (an all-touch share would credit one closing to several missions). Idempotent on
// the mission side (attachOutcome dedupes on kind + entity). Runs on the per-tenant learning cron
// right after recordExperimentArmOutcomes (app/api/cron/source-conversion-learning/route.ts).

export interface MissionOutcomeCredit {
  missionId: string
  ledgerActionId: string
  outcomeRef: string
  outcomeKind: LedgerOutcomeKind
  entityType: string
  entityId: string
  outcomeAt: string
  revenueCents: number
}

/** The survivor entity an outcome ref points at (`<kind>:<source row id>` / `reply:isa:<id>`). */
function outcomeEntity(ref: string, kind: LedgerOutcomeKind): { entityType: string; entityId: string } {
  if (ref.startsWith("reply:isa:")) return { entityType: "isa_outreach_log", entityId: ref.slice("reply:isa:".length) }
  const id = ref.slice(ref.indexOf(":") + 1)
  return { entityType: kind === "closed" || kind === "contract" ? "transaction" : kind === "appointment" ? "showing" : "communication", entityId: id }
}

/**
 * PURE — the mission outcomes an attribution result holds: every LAST-TOUCH credit whose credited
 * action `actionMission` maps to a mission. One credit per (mission, outcome).
 * @proofSeam exported so scripts/missions-guard.ts asserts the credit→mission rule on the pure function directly.
 */
export function missionOutcomeCredits(r: LedgerAttribution, actionMission: ReadonlyMap<string, string>): MissionOutcomeCredit[] {
  const at = new Map(r.outcomes.map((o) => [o.ref, o]))
  const seen = new Set<string>()
  const out: MissionOutcomeCredit[] = []
  for (const c of r.credits) {
    if (c.model !== "last_touch") continue
    const missionId = actionMission.get(c.actionId)
    if (!missionId || seen.has(`${missionId}:${c.outcomeRef}`)) continue
    seen.add(`${missionId}:${c.outcomeRef}`)
    const o = at.get(c.outcomeRef)
    const ent = outcomeEntity(c.outcomeRef, c.kind)
    out.push({ missionId, ledgerActionId: c.actionId, outcomeRef: c.outcomeRef, outcomeKind: c.kind, ...ent, outcomeAt: o?.at ?? "", revenueCents: o?.revenueCents ?? c.cents })
  }
  return out
}

export interface MissionOutcomeRecording {
  /** Last-touch credits that landed on an action a mission owns. */
  credits: number
  attached: number
  duplicates: number
  errors: string[]
}

/**
 * Attach every attributed outcome to the mission whose action earned it. Pinned to `brokerageId`
 * (the cron's per-tenant loop); the window is the attribution's trailing window. The mission index
 * is the tenant's NON-TERMINAL missions (activeMissionsFor — a completed mission's outcomes are
 * already on it) plus detail.mission_id on the credited ledger rows.
 */
export async function recordMissionOutcomes(
  svc: any,
  brokerageId: string,
  opts: { sinceIso?: string; windowDays?: number } = {},
): Promise<{ ok: true; recording: MissionOutcomeRecording } | { ok: false; error: string }> {
  const since = opts.sinceIso ?? new Date(Date.now() - (opts.windowDays ?? 90) * 86_400_000).toISOString()
  const attr = await loadLedgerAttribution(svc, brokerageId, { sinceIso: since })
  if (!attr.ok) return attr
  const recording: MissionOutcomeRecording = { credits: 0, attached: 0, duplicates: 0, errors: [] }
  if (!attr.ledgerAvailable || attr.result.credits.length === 0) return { ok: true, recording }
  const { activeMissionsFor, attachOutcome } = await import("@/lib/kernel/missions")
  const missions = await activeMissionsFor(brokerageId, { limit: 500 }, svc)
  if (missions.readRefused) return { ok: false, error: `missions: ${missions.readRefused}` }
  const actionMission = new Map<string, string>()
  for (const m of missions.active) for (const a of m.actions ?? []) actionMission.set(a, m.id)
  // The credited rows' detail is not on the attribution result — re-read only the credited rows.
  const creditedIds = [...new Set(attr.result.credits.filter((c) => c.model === "last_touch").map((c) => c.actionId))]
  for (let i = 0; i < creditedIds.length; i += 200) {
    const r = await svc.from("agent_action_ledger").select("id, detail").eq("brokerage_id", brokerageId).in("id", creditedIds.slice(i, i + 200)).limit(ATTR_LIMIT)
    if (r.error) return { ok: false, error: `agent_action_ledger (credited): ${r.error.message}` }
    for (const a of (r.data ?? []) as Array<{ id: string; detail?: Record<string, unknown> | null }>) {
      const mid = a.detail?.mission_id
      if (typeof mid === "string" && mid && !actionMission.has(a.id)) actionMission.set(a.id, mid)
    }
  }
  const credits = missionOutcomeCredits(attr.result, actionMission)
  recording.credits = credits.length
  for (const c of credits) {
    const w = await attachOutcome({
      brokerageId, missionId: c.missionId,
      outcome: { kind: c.outcomeKind, entityType: c.entityType, entityId: c.entityId, valueUsd: c.revenueCents > 0 ? c.revenueCents / 100 : null, occurredAt: c.outcomeAt || null, ledgerEntryId: c.ledgerActionId },
      progressMetric: c.outcomeKind === "closed" ? "attributed_closed_usd" : `attributed_${c.outcomeKind}`,
      actor: { type: "system", id: "roi_ledger_attribution" },
    }, svc)
    if (!w.ok) { recording.errors.push(`${c.missionId}: ${w.reason}`); continue }
    if (w.duplicate) recording.duplicates++
    else recording.attached++
  }
  return { ok: true, recording }
}
