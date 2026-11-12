// lib/intelligence/roi-ledger.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ROI LEDGER — "what your AI team earned", live on the Command Center
// instead of buried in a monthly artifact. Every number traces to a ledger row
// in the trailing window (the SAME counting rules as the board packet — no
// second formula): marketing-attributed closed commission from the attribution
// engine, calls the AI answered, appointments it booked live, drafts agents
// actually sent, opt-outs honored. This is the renewal conversation and the
// anti-churn weapon in one tile: competitors show brokers their agents'
// numbers — we show brokers the SOFTWARE's numbers, measured, not claimed.

import { compactCentsMoney } from "@/lib/format/money"
// Wave 106 (106B): the ONE experience vocabulary (CLAUDE.md §6) — the ledger's detail.experience is read against it.
import { isExperienceKind } from "@/lib/ai-isa/lead-action-plan"
// Wave 152 (lane 152B): the authorized ROI outcome reader below reads the ONE deal-status vocabulary and the ONE
// finance roster — both already in this module's graph (no module added to the CRM page budget). The model and
// manager vocabularies are TYPE-only (erased; the writer and the registry stay their one definition).
import { inPipelineColumn, isInEscrow, TRANSACTION_STATUSES, TRANSACTION_STATUSES_TERMINAL } from "@/lib/transactions/transaction-status"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import type { AttributionModel } from "@/lib/marketing/attribution"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
// Wave 152 (lane 152K presenter wiring): the reader's refusals compose through THE tenant presenter — lib/errors is
// already in this module's CRM-page graph (152A put the presenter there for that reason), so no module is added.
import { presentTenantMessage } from "@/lib/errors"

export interface RoiLedger {
  periodDays: number
  sinceIso: string
  /** Attribution-weighted COMMISSION (GCI — never sale price) on CLOSED / FUNDED deals credited to AI marketing,
   *  under ONE model (linear) so each deal's commission is counted once (cents). Wave 152 (152B): this summed every
   *  model's row — four models per deal, each summing to the deal's GCI — so a deal counted 4×, and it counted
   *  under-contract deals (the engine credits those at the ESTIMATE) as if earned. */
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
  if (l.attributedGciCents > 0) parts.push(`${compactCentsMoney(l.attributedGciCents)} closed commission attributed to AI marketing across ${l.attributedDeals} deal${l.attributedDeals === 1 ? "" : "s"}`)
  if (l.callsAnswered > 0) parts.push(`${l.callsAnswered} call${l.callsAnswered === 1 ? "" : "s"} answered${l.appointmentsBooked > 0 ? ` (${l.appointmentsBooked} booked live)` : ""}`)
  if (l.draftsSent > 0) parts.push(`${l.draftsSent} AI draft${l.draftsSent === 1 ? "" : "s"} your agents sent`)
  if (parts.length === 0) return ""
  return `Last ${l.periodDays} days: ${parts.join(" · ")} — measured by the attribution engine, not claimed.`
}

/**
 * THE realized attribution-credit read — the ONE place a caller turns `marketing_attribution_credits` into earned
 * commission. Two rules, both from wave 152 lane 152B, held here once (wave 152, lane 152K — the integrator queue's
 * 152B outside-lane 1–2, which found the same 4×/pending defect in four more readers):
 *   · ONE model (`ROI_SOURCED_MODEL`, linear). The engine writes a row per model per (campaign, deal) and every model's
 *     rows sum to the deal's GCI, so reading them all multiplied each deal by the number of models.
 *   · REALIZED only: a credit counts when its deal is CLOSED / FUNDED (`inPipelineColumn(status, "closed")`) and not
 *     deleted. The engine also credits in-escrow deals (at the estimate) and a deal can later fall through — both are
 *     pipeline, never earned.
 * Fail closed: a refused credit read OR a refused deal read returns `ok:false` (and no rows) — never a partial sum shown
 * as earned. `window.beforeIso` is exclusive, `window.throughIso` inclusive (each caller keeps its own window shape).
 * Callers: generateRoiLedger (below), lib/kernel/resource-allocation.ts, lib/kernel/board-packet.ts,
 * lib/kernel/intelligence-report.ts, lib/kernel/reporting-autonomy.ts.
 */
export async function loadRealizedAttributionCredits(
  svc: any, brokerageId: string, window: { sinceIso: string; beforeIso?: string; throughIso?: string }, limit = 2000,
): Promise<{ ok: true; rows: Array<{ campaign_id: string | null; credit_dollars: number | null; transaction_id: string }> } | { ok: false; error: string }> {
  let q = svc.from("marketing_attribution_credits").select("campaign_id, credit_dollars, transaction_id")
    .eq("brokerage_id", brokerageId).eq("attribution_model", ROI_SOURCED_MODEL).gte("created_at", window.sinceIso)
  if (window.beforeIso) q = q.lt("created_at", window.beforeIso)
  if (window.throughIso) q = q.lte("created_at", window.throughIso)
  const { data, error } = await q.limit(limit)
  if (error) return { ok: false, error: `attribution credits unreadable: ${error.message ?? String(error)}` }
  const creditRows = (data ?? []) as Array<{ campaign_id: string | null; credit_dollars: number | null; transaction_id: string | null }>
  const realized = new Set<string>()
  const creditTxIds = [...new Set(creditRows.map((c) => c.transaction_id).filter((t): t is string => !!t))]
  for (let i = 0; i < creditTxIds.length; i += 200) {
    const tx = await svc.from("transactions").select("id, status, deleted_at").eq("brokerage_id", brokerageId).in("id", creditTxIds.slice(i, i + 200))
    if (tx.error) return { ok: false, error: `credited deals unreadable — no commission is shown as earned: ${tx.error.message ?? String(tx.error)}` }
    for (const t of (tx.data ?? []) as Array<{ id: string; status: string | null; deleted_at: string | null }>) if (!t.deleted_at && inPipelineColumn(t.status, "closed")) realized.add(t.id)
  }
  return { ok: true, rows: creditRows.filter((c): c is { campaign_id: string | null; credit_dollars: number | null; transaction_id: string } => !!c.transaction_id && realized.has(c.transaction_id)) }
}

/** Trailing-window ROI from the live ledgers (board-packet counting rules). */
export async function generateRoiLedger(svc: any, brokerageId: string, periodDays = 90, opts: { attribution?: boolean } = {}): Promise<RoiLedger> {
  const sinceIso = new Date(Date.now() - periodDays * 86_400_000).toISOString()
  const cnt = async (q: any) => ((await q) as any)?.count ?? 0
  const [credits, calls, bookings, drafts, optOuts] = await Promise.all([
    // ONE model, CLOSED / FUNDED deals only — the shared realized-credit read above (wave 152, 152B → 152K).
    loadRealizedAttributionCredits(svc, brokerageId, { sinceIso }),
    cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("direction", "inbound").gte("started_at", sinceIso)),
    cnt(svc.from("showings").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).ilike("notes", "%AI receptionist%").gte("created_at", sinceIso)),
    cnt(svc.from("ai_message_drafts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).in("status", ["accepted", "sent", "edited"]).gte("created_at", sinceIso)),
    cnt(svc.from("voice_calls").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("outcome", "opt_out").gte("started_at", sinceIso)),
  ])
  if (!credits.ok) console.error("[roi-ledger]", credits.error)
  const rows = credits.ok ? credits.rows : []
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
//     (showings booked + seller listing appointments — listing_presentations.appointment_at, wave 137), a contract (transactions.contract_date) or a closed deal (status
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

export type LedgerOutcomeKind = "reply" | "appointment" | "contract" | "closed"
/** Wave 137: a seller LISTING appointment rides the one `appointment` kind under this ref prefix
 *  (listing_presentations.appointment_at); a buyer showing is `appointment:<showings.id>`. */
const LISTING_APPOINTMENT_REF = "appointment:listing:"
/** …and a booking on the listing row itself (listings.appointment_at). */
const LISTING_ROW_APPOINTMENT_REF = "appointment:listing-row:"

/** Days before an outcome in which a ledger row may earn credit for it. contract / closed match the
 *  marketing engine's LOOKBACK_DAYS (lib/marketing/attribution.ts) so the two never disagree. */
const ATTRIBUTION_WINDOW_DAYS: Readonly<Record<LedgerOutcomeKind, number>> = Object.freeze({
  reply: 30, appointment: 90, contract: 180, closed: 180,
})

/** The outcome kinds, in one place — wave 108F's experiment METRIC vocabulary reads this (never restates it). */
export const LEDGER_OUTCOME_KINDS: readonly LedgerOutcomeKind[] = Object.freeze(Object.keys(ATTRIBUTION_WINDOW_DAYS) as LedgerOutcomeKind[])

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
  /** Wave 107 (107F): the STRATEGY + VERSION (`<key>@v<version>`) from ledger detail.strategy — written by the
   *  strategy engine's activations (107E); read here the same way 106B reads detail.experience (lazy seam). */
  byStrategy: AttributionRow[]
}

/** The ONE spelling of a strategy key on the ledger (lowercase, `[a-z0-9_.-]`, ≤ 64) — never free text. */
const STRATEGY_KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/

/**
 * PURE — the strategy a ledger row served, from `detail.strategy` (wave 107F lazy seam onto 107E's activations).
 * Accepts `{ key, version }` (the activation shape) or a `"<key>@v<n>"` / `"<key>"` string; anything else is
 * not a strategy (an arbitrary string never becomes an attribution key). `ref` is `<key>@v<version>` when a
 * version is named, else `<key>`.
 * @proofSeam exported so scripts/network-intelligence-guard.ts asserts the strategy-attribution spelling directly.
 */
export function strategyRefOf(detail: Record<string, unknown> | null | undefined): { key: string; version: string | null; ref: string } | null {
  const s = (detail ?? {}).strategy as unknown
  let key: unknown = null, version: unknown = null
  if (s && typeof s === "object") { key = (s as Record<string, unknown>).key; version = (s as Record<string, unknown>).version ?? null }
  else if (typeof s === "string") { const at = s.indexOf("@"); key = at >= 0 ? s.slice(0, at) : s; version = at >= 0 ? s.slice(at + 1) : null }
  if (typeof key !== "string" || !STRATEGY_KEY_RE.test(key)) return null
  const v = version === null || version === undefined || version === "" ? null : String(version).replace(/^v/i, "")
  if (v !== null && !/^[0-9]{1,6}$/.test(v)) return null
  return { key, version: v, ref: v ? `${key}@v${v}` : key }
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
function attributionKeys(a: AttributableAction): { reason: string; manager: string; playbook: string; campaign: string | null; experimentArm: string | null; experience: string | null; strategy: string | null } {
  const d = a.detail ?? {}
  const campaign = (d.sequence_id ?? d.campaign_id ?? null) as string | null
  const exp = (d.experiment ?? null) as { key?: unknown; arm?: unknown } | null
  return {
    experimentArm: exp && typeof exp.key === "string" && typeof exp.arm === "string" ? `${exp.key}=${exp.arm}` : null,
    // 106B: only the planner's vocabulary counts — an arbitrary string in detail.experience is not an experience.
    experience: isExperienceKind(d.experience) ? d.experience : null,
    // 107F: only a well-formed strategy key (strategyRefOf) is a strategy.
    strategy: strategyRefOf(d)?.ref ?? null,
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
  const roll = (dim: "reason" | "manager" | "playbook" | "campaign" | "experimentArm" | "experience" | "strategy"): AttributionRow[] => {
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
  return { outcomes, credits, uncredited, byReasonCode: roll("reason"), byManager: roll("manager"), byPlaybook: roll("playbook"), byCampaign: roll("campaign"), byExperimentArm: roll("experimentArm"), byExperience: roll("experience"), byStrategy: roll("strategy") }
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
  byStrategy: AttributionRow[]
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
    byStrategy: r.byStrategy.slice(0, n),
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
    // WAVE 137 (owner "approve all"): the `appointment` kind is ONE vocabulary for buyer showings AND
    // seller LISTING appointments — listing_presentations.appointment_at (the listing-appointment prep
    // chain, the owner-named source) and listings.appointment_at (scheduleListingAppointmentService's
    // booking on the listing row; merged here from lib/kernel/experiment-pipeline.ts's side read). One
    // outcome per seller contact per appointment day (a booking that has a presentation counts once).
    const [sh, comm, isa, lp, la] = await Promise.all([
      pin(svc.from("showings").select("id, contact_id, created_at, status").eq("brokerage_id", brokerageId).not("contact_id", "is", null), "contact_id", "created_at"),
      pin(svc.from("communications").select("id, contact_id, created_at").eq("brokerage_id", brokerageId).eq("direction", "inbound").not("contact_id", "is", null), "contact_id", "created_at"),
      pin(svc.from("isa_outreach_log").select("id, contact_id, lead_id, replied_at").eq("brokerage_id", brokerageId).not("replied_at", "is", null), "contact_id", "replied_at"),
      pin(svc.from("listing_presentations").select("id, contact_id, appointment_at, status").eq("brokerage_id", brokerageId).not("contact_id", "is", null).not("appointment_at", "is", null), "contact_id", "appointment_at"),
      pin(svc.from("listings").select("id, seller_contact_id, contact_id, appointment_at").eq("brokerage_id", brokerageId).not("appointment_at", "is", null), "seller_contact_id", "appointment_at"),
    ])
    for (const [label, r] of [["showings", sh], ["communications", comm], ["isa_outreach_log", isa], ["listing_presentations", lp], ["listings", la]] as const) {
      if (r.error) return { ok: false, error: `${label}: ${r.error.message}` }
    }
    const showings = ((sh.data ?? []) as Array<Record<string, any>>).filter((s) => !/cancel/i.test(String(s.status ?? "")))
    for (const s of showings) contactIds.add(s.contact_id)
    const listingAppts: Array<{ ref: string; contactId: string; at: string }> = []
    const apptSeen = new Set<string>()
    const pushAppt = (ref: string, contactId: string | null | undefined, at: unknown) => {
      if (!contactId || !at) return
      const k = `${contactId}|${String(at).slice(0, 10)}`
      if (apptSeen.has(k)) return
      apptSeen.add(k); listingAppts.push({ ref, contactId, at: String(at) })
    }
    for (const p of (lp.data ?? []) as Array<Record<string, any>>) if (!/cancel/i.test(String(p.status ?? ""))) pushAppt(`${LISTING_APPOINTMENT_REF}${p.id}`, p.contact_id, p.appointment_at)
    for (const l of (la.data ?? []) as Array<Record<string, any>>) pushAppt(`${LISTING_ROW_APPOINTMENT_REF}${l.id}`, l.seller_contact_id ?? l.contact_id, l.appointment_at)
    for (const p of listingAppts) contactIds.add(p.contactId)
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
    for (const p of listingAppts) outcomes.push({ ref: p.ref, kind: "appointment", brokerageId, subjectIds: personIds(p.contactId), at: p.at, revenueCents: 0 })
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
  if (ref.startsWith(LISTING_APPOINTMENT_REF)) return { entityType: "listing_presentation", entityId: ref.slice(LISTING_APPOINTMENT_REF.length) }
  if (ref.startsWith(LISTING_ROW_APPOINTMENT_REF)) return { entityType: "listing", entityId: ref.slice(LISTING_ROW_APPOINTMENT_REF.length) }
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

// ═════════════════════════════════════════════════════════════════════════════
// THE AUTHORIZED ROI OUTCOME READER (wave 152, lane 152B — owner, verbatim: "build out or wire outcomes for the
// roi ledger reader.")
// ─────────────────────────────────────────────────────────────────────────────
// EXTENDS this ledger (LAW 1): no second ROI ledger, no new table, no new role. The writers stay the writers and
// are only READ here:
//   · WHO GETS CREDIT ... marketing_attribution_credits — per campaign × deal × model WEIGHTS from touchpoints
//                         (lib/marketing/attribution.ts, daily cron marketing-attribution-engine)
//   · MONEY ............. transactions (status, commission_amount, commission_finalized_at) and agent_commissions
//                         (gross / net, deposit_received_at = the business received the funds, paid_at = the agent
//                         was paid) — the finance kernel's ledger (lib/kernel/financial.ts). SALE PRICE IS NEVER READ.
//   · COST .............. ad_performance.spend (via ad_campaigns), direct_mail_campaigns per_piece_cost ×
//                         pieces_mailed, marketing_campaigns.budget_spent (tenant-typed), vendor_usage_tracking
//                         (coverage / price_state), raw_scraped_leads.cost_per_record, ai_tool_usage.cost_cents
//   · ACTIVITY .......... marketing_campaign_touchpoints, qr_codes → qr_scan_events (lane 152C's registry),
//                         direct_mail_campaigns → mail_response_tracking, showings
// THE RULES (directive 152B):
//   · metric families are never mixed: activity · acquisition · engagement · results · costs · revenue status ·
//     attribution are separate fields, each with its own denominator;
//   · money a deal EARNED comes from validated facts only: the commission ledger rows, else a FINALIZED
//     commission_amount; a closed deal with only an estimate is "not established" and every ratio over it is N/A;
//   · SOURCED revenue credits each closed deal ONCE, split by one model's weights so the split sums to the deal's
//     earned commission exactly (reconciliation published per deal); INFLUENCE is a count, labeled non-additive;
//   · cost is confirmed / partial / tenant-reported / unknown / none — unknown is never $0, a ratio over a partial
//     or unknown cost is N/A, and a $0 spend divides nothing;
//   · reversal / correction / reassignment propagate at READ time: a lost / archived / deleted deal earns nothing,
//     money is re-read from the current ledger (a late correction restates the window), scope follows the deal's
//     CURRENT agent columns; replays (re-run attribution, re-sent webhooks, re-scanned QR codes) cannot move money
//     — credits are unique per (campaign, deal, model), and scans / touchpoints never carry money.
// AUTHORITY: the tenant and the viewer come from the SESSION (callers pass the session's own ids — never a body or a
// parameter). Scope is the ONE hierarchy answer (resolveViewerHierarchy) and, for a team lead, the ONE team roster
// (resolveTeamLeadContactScope). Commission DOLLARS show only to the finance roster (isBrokerageFinanceAdmin), the
// books reader (compliance_officer, m467), the tenant principal (m526) / the lead of the teams in view (m473), and a
// solo-tier subscriber (their own broker — requireTenantAdminOrSoloOwner's parity rule); an agent sees counts, costs
// and closings with no commission amount (CLAUDE.md §5). A contact or vendor seat is refused. Platform staff read
// only the tenant their session sits in (an approved support impersonation IS that session); no parameter can name
// another tenant, and any row stamped with another tenant is dropped and counted.

type RoiSvc = any

/** The model the SOURCED view credits by — linear is the engine's reporting default (marketing_campaigns.attributed_gci_total). */
const ROI_SOURCED_MODEL: AttributionModel = "linear"
/** A comparison needs at least this many comparable campaigns (same channel, fully recorded spend) before it recommends anything. */
const ROI_MIN_COMPARABLE = 3
/** A campaign is an outlier at this multiple of its channel's median cost per contact. */
const ROI_OUTLIER_MULTIPLE = 2
const ROI_READ_LIMIT = 5000

type RoiCostStatus = "confirmed" | "partial" | "tenant_reported" | "unknown" | "none"
interface RoiRatio { value: number | null; na: string | null }
const naRatio = (why: string): RoiRatio => ({ value: null, na: why })

/**
 * PURE — THE formula (directive 152B), the ONE definition the ROI reader and the campaign_roi writer
 * (lib/campaigns/roi-calculator.ts) both use:
 *   realized_return_on_marketing_spend = (attributed_realized_contribution − attributable_known_spend) / attributable_known_spend
 * N/A — never Infinity, never 0, never a guess — when the spend is unknown or only partly recorded, when there is no
 * spend to divide by, or when the contribution is not established (a closed deal's commission is not finalized).
 * Contribution is EARNED commission (GCI); marketing spend is deducted once, here, and nowhere upstream.
 */
export function realizedReturnOnMarketingSpend(input: { contributionCents: number | null; spendCents: number | null; spendStatus: RoiCostStatus }): RoiRatio {
  if (input.spendStatus === "unknown") return naRatio("What this cost is not recorded, so a return cannot be calculated.")
  if (input.spendStatus === "partial") return naRatio("Only part of what this cost is recorded; a return over a partial cost would overstate it.")
  if (input.spendStatus === "none" || input.spendCents == null || input.spendCents <= 0) return naRatio("No spend is recorded against this, and a return on $0 is not a number.")
  if (input.contributionCents == null) return naRatio("A closed deal's commission is not finalized yet, so what was earned is not established.")
  return { value: (input.contributionCents - input.spendCents) / input.spendCents, na: null }
}

/** PURE — spend ÷ a measured count, only when both halves are complete and eligible. */
function costPer(spendCents: number, spendComplete: boolean, denominator: number, what: string): RoiRatio {
  if (!spendComplete) return naRatio(`Spend is not fully recorded for the campaigns in this view, so cost per ${what} is not calculated.`)
  if (spendCents <= 0) return naRatio(`No spend is recorded, so cost per ${what} is not a number.`)
  if (denominator <= 0) return naRatio(`No ${what} yet, so there is nothing to divide by.`)
  return { value: Math.round(spendCents / denominator), na: null }
}

const PLACEMENT_NOT_RECORDED = "placement not recorded"
/** Pure: per-placement QR measurement (exported for the guard through loadRoiOutcomeLedger; no I/O). */
function buildPlacementRows(
  qrCodes: Array<{ id: string; marketing_campaign_id: string; mint_context?: { placement?: string | null } | null }>,
  scans: Array<{ id: string; qr_code_id: string; contact_id: string | null; traffic_class?: string | null }>,
  campaignCost: ReadonlyMap<string, { status: RoiCostStatus; cents: number | null }>,
): RoiPlacementRow[] {
  const placementOf = (q: { mint_context?: { placement?: string | null } | null }) => {
    const raw = typeof q.mint_context?.placement === "string" ? q.mint_context.placement.trim() : ""
    return raw ? raw.toLowerCase() : PLACEMENT_NOT_RECORDED
  }
  const codePlacement = new Map(qrCodes.map((q) => [q.id, placementOf(q)]))
  const campaignPlacements = new Map<string, Set<string>>()
  for (const q of qrCodes) { const set = campaignPlacements.get(q.marketing_campaign_id) ?? new Set<string>(); set.add(placementOf(q)); campaignPlacements.set(q.marketing_campaign_id, set) }
  const groups = new Map<string, { codes: Set<string>; campaigns: Set<string>; scans: number; human: number; auto: number; unclassified: number; contacts: Set<string> }>()
  for (const q of qrCodes) {
    const key = placementOf(q)
    const g = groups.get(key) ?? { codes: new Set<string>(), campaigns: new Set<string>(), scans: 0, human: 0, auto: 0, unclassified: 0, contacts: new Set<string>() }
    g.codes.add(q.id); g.campaigns.add(q.marketing_campaign_id); groups.set(key, g)
  }
  for (const sc of scans) {
    const key = codePlacement.get(sc.qr_code_id); if (!key) continue
    const g = groups.get(key)!
    g.scans++
    if (sc.traffic_class === "human_likely") g.human++
    else if (sc.traffic_class === "bot" || sc.traffic_class === "repeat") g.auto++
    else g.unclassified++
    if (sc.contact_id) g.contacts.add(sc.contact_id)
  }
  return [...groups.entries()].map(([placement, g]) => {
    const camps = [...g.campaigns]
    const shared = camps.some((c) => (campaignPlacements.get(c)?.size ?? 0) > 1)
    const unknown = camps.some((c) => { const k = campaignCost.get(c); return !k || !(k.status === "confirmed" || k.status === "tenant_reported") })
    const cost: RoiPlacementRow["cost"] = placement === PLACEMENT_NOT_RECORDED
      ? { status: "unknown", cents: null, note: "these codes were created without a placement, so they are not compared" }
      : shared
        ? { status: "shared", cents: null, note: "a campaign printed codes on more than one placement, so its spend cannot be split without guessing" }
        : unknown
          ? { status: "unknown", cents: null, note: "at least one campaign carrying this placement has no recorded cost" }
          : { status: "attributable", cents: camps.reduce((s, c) => s + (campaignCost.get(c)?.cents ?? 0), 0), note: `the whole recorded spend of ${camps.length} campaign(s) that printed only this placement` }
    return {
      placement, codes: g.codes.size, campaigns: camps.length, scans: g.scans,
      humanLikelyScans: g.human, automatedOrRepeatScans: g.auto, unclassifiedScans: g.unclassified,
      contactsCaptured: g.contacts.size, cost,
      costPerContactCaptured: cost.status === "attributable" ? costPer(cost.cents ?? 0, true, g.contacts.size, "contact captured") : naRatio(cost.note),
      refs: [...g.codes].slice(0, 10).map((id) => `qr_codes:${id}`),
    }
  }).sort((a, b) => b.contactsCaptured - a.contactsCaptured || b.scans - a.scans)
}

interface RoiDealFact {
  id: string; brokerage_id: string; status: string | null; deleted_at: string | null; deal_name: string | null
  contract_date: string | null; close_date: string | null; actual_close_date: string | null
  commission_amount: number | null; estimated_commission: number | null; commission_finalized_at: string | null
  agent_id: string | null; buyer_agent_id: string | null; seller_agent_id: string | null
  buyer_contact_id: string | null; seller_contact_id: string | null; contact_id: string | null
}
interface RoiCommissionFact {
  id: string; transaction_id: string; status: string | null; gross_commission: number | null
  net_to_brokerage: number | null; brokerage_commission: number | null; net_to_agent: number | null; agent_commission: number | null
  deposit_received_at: string | null; paid_at: string | null
}
interface RoiCreditFact {
  id: string; campaign_id: string; transaction_id: string; attribution_model: string; attribution_weight: number | null
  contact_id: string | null; touchpoint_count: number | null; first_touchpoint_at: string | null; last_touchpoint_at: string | null
}

const cents = (v: unknown): number | null => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null }
const day = (iso: string | null | undefined): string | null => (iso ? String(iso).slice(0, 10) : null)

type DealState = "reversed" | "closed" | "in_escrow" | "open"
/** PURE — where a deal sits for money, from its CURRENT status (a cancel / fall-through is `lost` / `archived` — the live CHECK has no "cancelled"). */
function roiDealState(d: Pick<RoiDealFact, "status" | "deleted_at">): DealState {
  if (d.deleted_at) return "reversed"
  if (inPipelineColumn(d.status, "closed")) return "closed"
  if ((TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes(String(d.status ?? ""))) return "reversed"
  if (isInEscrow(d.status)) return "in_escrow"
  return "open"
}

interface DealMoney { earnedCents: number | null; basis: "commission_ledger" | "finalized" | "not_finalized" | "disputed"; receivedCents: number; disbursedCents: number; netBrokerageCents: number | null; refs: string[] }
/** PURE — what a CLOSED deal earned, from validated facts only (the commission ledger, else a finalized amount). */
function roiDealMoney(d: RoiDealFact, rows: RoiCommissionFact[]): DealMoney {
  const refs = rows.map((r) => `agent_commissions:${r.id}`)
  if (rows.length > 0) {
    if (rows.some((r) => r.status === "disputed")) return { earnedCents: null, basis: "disputed", receivedCents: 0, disbursedCents: 0, netBrokerageCents: null, refs }
    const gross = rows.map((r) => cents(r.gross_commission))
    if (gross.some((g) => g == null)) return { earnedCents: null, basis: "not_finalized", receivedCents: 0, disbursedCents: 0, netBrokerageCents: null, refs }
    const nets = rows.map((r) => cents(r.net_to_brokerage ?? r.brokerage_commission))
    return {
      earnedCents: gross.reduce((s: number, g) => s + (g ?? 0), 0), basis: "commission_ledger",
      receivedCents: rows.filter((r) => !!r.deposit_received_at).reduce((s, r) => s + (cents(r.gross_commission) ?? 0), 0),
      disbursedCents: rows.filter((r) => !!r.paid_at || r.status === "paid").reduce((s, r) => s + (cents(r.net_to_agent ?? r.agent_commission) ?? 0), 0),
      netBrokerageCents: nets.some((n) => n == null) ? null : nets.reduce((s: number, n) => s + (n ?? 0), 0), refs,
    }
  }
  const finalized = d.commission_finalized_at ? cents(d.commission_amount) : null
  if (finalized != null) return { earnedCents: finalized, basis: "finalized", receivedCents: 0, disbursedCents: 0, netBrokerageCents: null, refs: [`transactions:${d.id}`] }
  return { earnedCents: null, basis: "not_finalized", receivedCents: 0, disbursedCents: 0, netBrokerageCents: null, refs: [`transactions:${d.id}`] }
}

/** PURE — split one deal's earned cents across one model's credit rows by weight; whole cents, the remainder to the
 *  heaviest row (ties by campaign id), so the split sums to `earned` EXACTLY whenever any weight is positive. */
function allocateByWeight(earned: number, rows: RoiCreditFact[]): Map<string, number> {
  const out = new Map<string, number>()
  const w = rows.map((r) => Math.max(0, Number(r.attribution_weight ?? 0) || 0))
  const total = w.reduce((s, x) => s + x, 0)
  if (total <= 0 || earned <= 0) { for (const r of rows) out.set(r.campaign_id, (out.get(r.campaign_id) ?? 0)); return out }
  let given = 0
  rows.forEach((r, i) => { const c = Math.floor((earned * w[i]) / total); given += c; out.set(r.campaign_id, (out.get(r.campaign_id) ?? 0) + c) })
  const heaviest = rows.map((r, i) => ({ id: r.campaign_id, w: w[i] })).sort((a, b) => b.w - a.w || a.id.localeCompare(b.id))[0]
  out.set(heaviest.id, (out.get(heaviest.id) ?? 0) + (earned - given))
  return out
}

interface RoiViewer {
  userId: string; brokerageId: string; userType: string
  kind: "tenant" | "offices" | "teams" | "own"
  /** null = every agent of the tenant; otherwise the agents.id rows in view (agents.id ≠ users.id — CLAUDE.md §3). */
  agentIds: string[] | null
  /** users.id of the agents in view (campaigns key on marketing_campaigns.agent_user_id). */
  userIds: string[] | null
  teamIds: string[]
  moneyVisible: boolean
  moneyBasis: string
  basis: string[]
}

const ROI_MONEY_HIDDEN_NOTE =
  "Commission amounts are hidden in this view. Counts, costs and closings are complete; dollar amounts from deals show only to your account's finance administrators. To see them, ask an account administrator."

/** A reader refusal composed by THE tenant presenter (lib/errors/index.ts presentTenantMessage — wave 152, lane 152K
 *  presenter wiring): what happened · what it affects · who acts next · ONE action, through the ONE tenant-copy gate.
 *  A read refusal changes nothing, so no work clause is claimed. */
function roiRefusal(what: string, opts: { next?: "you" | "account_admin" | "platform_support"; action?: string | null; audience?: "account" | "contact" | "vendor" } = {}): { ok: false; error: string } {
  const next = opts.next ?? "platform_support"
  const action = opts.action === undefined ? "Try again in a moment" : opts.action
  return { ok: false, error: presentTenantMessage({ what, next, action: action ? { label: action } : null, audience: opts.audience }).sentence }
}

/** Resolve WHO is asking and WHAT they may see, from the session's own ids. Fails closed: any refused read refuses. */
async function resolveRoiViewer(svc: RoiSvc, session: { userId: string; brokerageId: string }): Promise<{ ok: true; viewer: RoiViewer } | { ok: false; error: string }> {
  if (!session.userId || !session.brokerageId) return roiRefusal("Your workspace could not be confirmed, so results are held", { next: "you", action: "Sign in again to see results" })
  const brokerageId = session.brokerageId
  const u = await svc.from("users").select("id, brokerage_id, user_type").eq("id", session.userId).eq("brokerage_id", brokerageId).maybeSingle()
  if (u.error) return roiRefusal("Your access could not be checked right now, so results are held")
  const userType = String(u.data?.user_type ?? "").toLowerCase()
  if (!u.data || u.data.brokerage_id !== session.brokerageId) return roiRefusal("This view belongs to a different workspace, so its results are not shown", { next: "you", action: "Sign in with an account in that workspace to see them" })
  if (userType === "contact" || userType === "vendor") return roiRefusal("Marketing results are available to the team that runs the campaigns, not to client or vendor accounts", { next: "account_admin", action: null, audience: userType === "contact" ? "contact" : "vendor" })
  const { resolveViewerHierarchy } = await import("@/lib/kernel/resolve-user-office")
  const h = await resolveViewerHierarchy(svc, session)
  if (!h.ok) return roiRefusal("Your office and team access could not be checked right now, so results are held")
  const financeRoster = isBrokerageFinanceAdmin({ user_type: userType }) || userType === "compliance_officer"
  const soloParity = h.tier === "solo_agent"
  const basis = [...h.scope.basis]
  const agentRows = async (build: (q: any) => any): Promise<{ ok: true; ids: string[]; userIds: string[] } | { ok: false }> => {
    const r = await build(svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId))
    if (r.error) return { ok: false }
    const rows = (r.data ?? []) as Array<{ id: string; user_id: string | null }>
    return { ok: true, ids: rows.map((a) => a.id), userIds: rows.map((a) => a.user_id).filter((x): x is string => !!x) }
  }
  const held = roiRefusal("The people in your view could not be read right now, so results are held")
  const base = { userId: session.userId, brokerageId: session.brokerageId, userType, basis }
  // THE TEAM LEAD (wave 151 ruling L4, the same composition as lib/search/scoped-record-search.ts): a team_lead seat —
  // or anyone the hierarchy knows leads a team — reads through the ONE team roster unless an explicit TENANT
  // LEADERSHIP GRANT widened them. The single-office roster rule never widens a team lead to the whole tenant here.
  // Their own team's books are theirs to read (m473 can_read_team_books); the tenant's only as its principal (m526).
  const leadershipGrant = h.scope.aggregate && h.scope.basis.includes("tenant leadership grant")
  const leadsATeam = userType === "team_lead" || h.scope.basis.some((b) => /^leads team /.test(b))
  if (leadsATeam && !leadershipGrant && !financeRoster) {
    const { resolveTeamLeadContactScope } = await import("@/lib/auth/lead-visibility")
    const t = await resolveTeamLeadContactScope(svc, session)
    if (!t.ok) return held
    if (t.scope.kind === "brokerage") return { ok: true, viewer: { ...base, kind: "tenant", agentIds: null, userIds: null, teamIds: [...h.scope.teamIds], moneyVisible: true, moneyBasis: "tenant principal (the team is the workspace)" } }
    const own = await agentRows((q) => q.eq("user_id", session.userId))
    if (!own.ok) return held
    if (t.scope.kind === "none") return { ok: true, viewer: { ...base, kind: "own", agentIds: own.ids, userIds: [session.userId], teamIds: [], moneyVisible: soloParity, moneyBasis: soloParity ? "solo subscriber" : "no team is anchored to your account" } }
    const roster = t.scope.agentIds.length ? await agentRows((q) => q.in("id", t.scope.kind === "team" ? t.scope.agentIds : [])) : { ok: true as const, ids: [], userIds: [] }
    if (!roster.ok) return held
    return { ok: true, viewer: { ...base, kind: "teams", agentIds: [...new Set([...own.ids, ...roster.ids])], userIds: [...new Set([...roster.userIds, session.userId])], teamIds: [...t.scope.teamIds], moneyVisible: true, moneyBasis: "leads the teams in view (team books)" } }
  }
  if (h.scope.kind === "tenant") {
    const money = financeRoster || soloParity
    return { ok: true, viewer: { ...base, kind: "tenant", agentIds: null, userIds: null, teamIds: [...h.scope.teamIds], moneyVisible: money, moneyBasis: money ? (financeRoster ? "finance roster" : "solo subscriber") : "not a finance administrator" } }
  }
  if (h.scope.kind === "offices") {
    const locs = h.scope.locationIds, teams = h.scope.teamIds
    const terms = [`location_id.in.(${locs.join(",")})`, ...(teams.length ? [`team_id.in.(${teams.join(",")})`] : [])]
    const a = await agentRows((q) => q.or(terms.join(",")))
    if (!a.ok) return held
    return { ok: true, viewer: { ...base, kind: "offices", agentIds: a.ids, userIds: [...new Set([...a.userIds, session.userId])], teamIds: [...teams], moneyVisible: financeRoster, moneyBasis: financeRoster ? "finance roster (offices in view)" : "not a finance administrator" } }
  }
  if (h.scope.kind === "teams") {
    // A team scope that is NOT leadership of those teams (a team grant): counts for the teams' agents, no team books.
    const byTeam = await agentRows((q) => q.in("team_id", h.scope.teamIds))
    if (!byTeam.ok) return held
    return { ok: true, viewer: { ...base, kind: "teams", agentIds: byTeam.ids, userIds: [...new Set([...byTeam.userIds, session.userId])], teamIds: [...h.scope.teamIds], moneyVisible: financeRoster, moneyBasis: financeRoster ? "finance roster" : "team access without team books" } }
  }
  const own = await agentRows((q) => q.eq("user_id", session.userId))
  if (!own.ok) return held
  const money = financeRoster || soloParity
  return { ok: true, viewer: { ...base, kind: "own", agentIds: own.ids, userIds: [session.userId], teamIds: [], moneyVisible: money, moneyBasis: money ? (soloParity ? "solo subscriber" : "finance roster") : "agent view (commission is off an agent's display)" } }
}

async function readByIds(svc: RoiSvc, table: string, cols: string, brokerageId: string, col: string, ids: string[], extra?: (q: any) => any): Promise<{ ok: true; rows: any[] } | { ok: false; error: string }> {
  const out: any[] = []
  for (let i = 0; i < ids.length; i += 200) {
    let q = svc.from(table).select(cols).eq("brokerage_id", brokerageId).in(col, ids.slice(i, i + 200))
    if (extra) q = extra(q)
    const r = await q.limit(ROI_READ_LIMIT)
    if (r.error) return { ok: false, error: `${table}: ${r.error.message}` }
    out.push(...(r.data ?? []))
  }
  return { ok: true, rows: out }
}

interface RoiCampaignRow {
  campaignId: string; name: string; type: string; agentUserId: string | null
  cost: { status: RoiCostStatus; cents: number | null; note: string; refs: string[] }
  activity: { touchpointsSent: number; qrScans: number; qrFirstScans: number; mailResponses: number }
  acquisition: { contactsReached: number }
  engagement: { appointments: number }
  results: { sourcedDealsClosed: number; influencedDealsClosed: number; dealsInEscrow: number; dealsOutsideView: number }
  revenue: { sourcedEarnedCents: number; creditCentsByModel: Record<string, number> } | null
  ratios: { realizedReturnOnMarketingSpend: RoiRatio; costPerContact: RoiRatio; costPerClosedTransaction: RoiRatio }
  why: string[]
}
interface RoiJourney {
  transactionId: string; dealName: string | null; state: DealState | "closed_outside_window"
  revenueStatus: "projected" | "contracted" | "earned" | "received" | "disbursed" | "reversed" | "not_established"
  earnedCents: number | null
  steps: Array<{ at: string | null; kind: "touchpoint" | "qr_scan" | "mail_response" | "appointment" | "contract" | "closed" | "reversed"; label: string; ref: string }>
  credits: Array<{ campaignId: string; weight: number; cents: number | null }>
}
/** WAVE 152 (integrator, closes lane 152J Outside-lane 4): where a printed QR code was placed, measured. The placement is the
 *  governed mint's own record (qr_codes.mint_context.placement, lane 152C); visits are split by the scan route's traffic class
 *  (lane 152C, m946). A placement's spend is counted ONLY when every campaign carrying it printed its codes on that one
 *  placement and recorded its cost — a campaign spread over several placements has no honest split, so it says "shared". */
interface RoiPlacementRow {
  placement: string
  codes: number
  campaigns: number
  scans: number
  humanLikelyScans: number
  automatedOrRepeatScans: number
  unclassifiedScans: number
  contactsCaptured: number
  cost: { status: "attributable" | "shared" | "unknown"; cents: number | null; note: string }
  costPerContactCaptured: RoiRatio
  refs: string[]
}
interface RoiRecommendation {
  manager: ManagerKey; kind: "review_reduce" | "record_spend" | "finalize_commission" | "repair_attribution" | "repeat_what_worked"
  campaignId: string | null; text: string; evidence: string[]; comparableSample: number | null
  /** Always true — the reader proposes, a person decides. Nothing here raises spend or moves another tenant's budget. */
  requiresApproval: true
}

/** The authorized ROI outcome ledger — every figure carries its family, its denominator and its reason when N/A. */
export interface RoiOutcomeLedger {
  generatedAt: string
  window: { sinceDay: string; untilDay: string }
  model: AttributionModel
  scope: { kind: RoiViewer["kind"]; basis: string[]; moneyVisible: boolean; moneyNote: string | null }
  activity: { touchpointsSent: number; qrScans: number; qrFirstScans: number; mailResponses: number }
  acquisition: { contactsReached: number; contactsWithDeals: number }
  engagement: { appointments: number }
  results: { dealsContracted: number; dealsClosed: number; dealsReversed: number; sourcedDealsClosed: number; influencedDealsClosed: number }
  costs: { knownCents: number; status: "complete" | "partial" | "unknown" | "none"; byStatus: Record<RoiCostStatus, number>; eligibleCampaigns: number }
  revenue: { projectedCents: number; contractedCents: number; earnedCents: number; receivedCents: number; disbursedCents: number; netBrokerageCents: number | null; closedNotEstablished: number } | null
  attribution: { sourcedEarnedCents: number; sourcedDeals: number; reconciled: boolean; reconciliation: Array<{ transactionId: string; earnedCents: number; creditedCents: number }>; influencedDeals: number; influenceIsAdditive: false } | null
  ratios: { realizedReturnOnMarketingSpend: RoiRatio; costPerContact: RoiRatio; costPerAppointment: RoiRatio; costPerClosedTransaction: RoiRatio }
  campaigns: RoiCampaignRow[]
  placements: RoiPlacementRow[]
  journeys: RoiJourney[]
  providerEconomics: {
    shownAtAccountLevel: boolean
    vendorPlatformCoveredCents: number; vendorTenantPaidCents: number; vendorUnpricedCalls: number
    aiPlatformFundedCents: number; aiTenantCents: number
    rawRecords: number; rawPromoted: number; costPerPromotedRecord: RoiRatio
    notMeasured: string[]
  }
  recommendations: RoiRecommendation[]
  completeness: { label: "complete" | "partial" | "incomplete"; notes: string[] }
  why: Record<string, string>
  /** Rows another tenant's id was stamped on, dropped before any figure was made (should be 0 — a non-zero count is a finding). */
  foreignRowsDropped: number
}

/**
 * THE AUTHORIZED ROI READ CONTRACT. `session` MUST be the caller's SESSION ids (requireCaller / auth.getUser +
 * users row) — never a body, a query string or a parameter a user typed. `svc` is the service client; this
 * function is the gate (scope + money visibility resolved here, every read pinned to the session tenant).
 * Never throws; a refused read refuses the whole ledger rather than rendering a partial one as complete.
 */
export async function loadRoiOutcomeLedger(
  svc: RoiSvc,
  session: { userId: string; brokerageId: string },
  window: { sinceDay: string; untilDay: string },
): Promise<{ ok: true; ledger: RoiOutcomeLedger } | { ok: false; error: string }> {
  try {
    const who = await resolveRoiViewer(svc, session)
    if (!who.ok) return who
    const v = who.viewer
    const brokerageId = v.brokerageId
    const { sinceDay, untilDay } = window
    const sinceIso = `${sinceDay}T00:00:00.000Z`, untilIso = `${untilDay}T23:59:59.999Z`
    const inWin = (d: string | null) => !!d && d >= sinceDay && d <= untilDay
    let foreign = 0
    const mine = <T extends { brokerage_id?: string | null }>(rows: T[]): T[] => rows.filter((r) => { const ok = r.brokerage_id == null || r.brokerage_id === brokerageId; if (!ok) foreign++; return ok })
    const refused = (what: string) => roiRefusal(`Marketing results could not be read right now (${what}), so nothing is shown rather than a partial picture`)

    // ── 1. Campaigns in view ──
    let cq = svc.from("marketing_campaigns").select("id, brokerage_id, campaign_name, campaign_type, agent_user_id, team_id, budget_spent").eq("brokerage_id", brokerageId)
    if (v.kind !== "tenant") {
      const terms = [`agent_user_id.in.(${(v.userIds ?? [v.userId]).join(",")})`, ...(v.teamIds.length ? [`team_id.in.(${v.teamIds.join(",")})`] : [])]
      cq = cq.or(terms.join(","))
    }
    const cr = await cq.limit(ROI_READ_LIMIT)
    if (cr.error) return refused("campaigns")
    const campaigns = mine((cr.data ?? []) as Array<{ id: string; brokerage_id: string; campaign_name: string | null; campaign_type: string | null; agent_user_id: string | null; team_id: string | null; budget_spent: number | null }>)
    const campaignIds = campaigns.map((c) => c.id)
    const inViewCampaign = new Set(campaignIds)

    // ── 2. Deals in view (current agent columns — a reassignment moves the deal with it) ──
    const dealCols = "id, brokerage_id, status, deleted_at, deal_name, contract_date, close_date, actual_close_date, commission_amount, estimated_commission, commission_finalized_at, agent_id, buyer_agent_id, seller_agent_id, buyer_contact_id, seller_contact_id, contact_id"
    // Every NOT-terminal status (the pipeline, as of now) — derived from the ONE vocabulary, never retyped — plus any deal
    // that contracted or closed inside the window.
    const openStatuses = TRANSACTION_STATUSES.filter((s) => !(TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes(s))
    const dq = svc.from("transactions").select(dealCols).eq("brokerage_id", brokerageId)
      .or(`status.in.(${openStatuses.join(",")}),contract_date.gte.${sinceDay},close_date.gte.${sinceDay},actual_close_date.gte.${sinceDay}`)
    const dr = await dq.limit(ROI_READ_LIMIT)
    if (dr.error) return refused("deals")
    const credR = await svc.from("marketing_attribution_credits").select("id, brokerage_id, campaign_id, transaction_id, attribution_model, attribution_weight, contact_id, touchpoint_count, first_touchpoint_at, last_touchpoint_at").eq("brokerage_id", brokerageId).limit(ROI_READ_LIMIT)
    if (credR.error) return refused("attribution credits")
    const allCredits = mine((credR.data ?? []) as Array<RoiCreditFact & { brokerage_id: string }>)
    const dealById = new Map<string, RoiDealFact>()
    for (const d of mine((dr.data ?? []) as RoiDealFact[])) dealById.set(d.id, d)
    const missingCredited = [...new Set(allCredits.map((c) => c.transaction_id))].filter((id) => !dealById.has(id))
    const extra = await readByIds(svc, "transactions", dealCols, brokerageId, "id", missingCredited)
    if (!extra.ok) return refused("credited deals")
    for (const d of mine(extra.rows as RoiDealFact[])) dealById.set(d.id, d)
    const agentSet = v.agentIds ? new Set(v.agentIds) : null
    const inViewDeal = (d: RoiDealFact) => !agentSet || [d.agent_id, d.buyer_agent_id, d.seller_agent_id].some((a) => !!a && agentSet.has(a))
    const deals = [...dealById.values()]
    const dealsInView = deals.filter(inViewDeal)

    // ── 3. Commission ledger rows for the deals in view ──
    const cm = await readByIds(svc, "agent_commissions", "id, brokerage_id, transaction_id, status, gross_commission, net_to_brokerage, brokerage_commission, net_to_agent, agent_commission, deposit_received_at, paid_at", brokerageId, "transaction_id", dealsInView.map((d) => d.id))
    if (!cm.ok) return refused("commission ledger")
    const commByDeal = new Map<string, RoiCommissionFact[]>()
    for (const r of mine(cm.rows as Array<RoiCommissionFact & { brokerage_id: string }>)) commByDeal.set(r.transaction_id, [...(commByDeal.get(r.transaction_id) ?? []), r])

    // ── 4. Activity, spend and reach per campaign ──
    const [tpR, qrR, dmR, adR] = await Promise.all([
      readByIds(svc, "marketing_campaign_touchpoints", "id, brokerage_id, campaign_id, contact_id, sent_at, status", brokerageId, "campaign_id", campaignIds, (q) => q.gte("sent_at", sinceIso).lte("sent_at", untilIso)),
      readByIds(svc, "qr_codes", "id, brokerage_id, marketing_campaign_id, mint_context", brokerageId, "marketing_campaign_id", campaignIds),
      readByIds(svc, "direct_mail_campaigns", "id, brokerage_id, marketing_campaign_id, per_piece_cost, pieces_mailed, mailing_date", brokerageId, "marketing_campaign_id", campaignIds),
      readByIds(svc, "ad_campaigns", "id, brokerage_id, marketing_campaign_id", brokerageId, "marketing_campaign_id", campaignIds),
    ])
    for (const [label, r] of [["touchpoints", tpR], ["QR codes", qrR], ["direct mail", dmR], ["ad campaigns", adR]] as const) if (!r.ok) return refused(label)
    const touchpoints = mine((tpR as any).rows as Array<{ id: string; brokerage_id: string; campaign_id: string; contact_id: string | null; sent_at: string; status: string | null }>).filter((t) => t.status !== "failed" && t.status !== "queued")
    const qrCodes = mine((qrR as any).rows as Array<{ id: string; brokerage_id: string; marketing_campaign_id: string; mint_context?: { placement?: string | null } | null }>)
    const mailCampaigns = mine((dmR as any).rows as Array<{ id: string; brokerage_id: string; marketing_campaign_id: string; per_piece_cost: number | null; pieces_mailed: number | null; mailing_date: string | null }>)
    const adCampaigns = mine((adR as any).rows as Array<{ id: string; brokerage_id: string; marketing_campaign_id: string }>)
    const [scanR, respR, perfR] = await Promise.all([
      readByIds(svc, "qr_scan_events", "id, brokerage_id, qr_code_id, contact_id, is_first_scan, scanned_at, traffic_class", brokerageId, "qr_code_id", qrCodes.map((q) => q.id), (q) => q.gte("scanned_at", sinceIso).lte("scanned_at", untilIso)),
      readByIds(svc, "mail_response_tracking", "id, brokerage_id, campaign_id, contact_id, lead_id, created_at", brokerageId, "campaign_id", mailCampaigns.map((m) => m.id), (q) => q.gte("created_at", sinceIso).lte("created_at", untilIso)),
      readByIds(svc, "ad_performance", "id, brokerage_id, ad_campaign_id, spend, captured_at", brokerageId, "ad_campaign_id", adCampaigns.map((a) => a.id), (q) => q.gte("captured_at", sinceDay).lte("captured_at", untilIso)),
    ])
    for (const [label, r] of [["QR scans", scanR], ["mail responses", respR], ["ad performance", perfR]] as const) if (!r.ok) return refused(label)
    // A replayed event is ONE event: rows dedupe on their own id before anything is counted.
    const uniq = <T extends { id: string }>(rows: T[]) => [...new Map(rows.map((r) => [r.id, r])).values()]
    const scans = uniq(mine((scanR as any).rows as Array<{ id: string; brokerage_id: string; qr_code_id: string; contact_id: string | null; is_first_scan: boolean | null; scanned_at: string; traffic_class?: string | null }>))
    const responses = uniq(mine((respR as any).rows as Array<{ id: string; brokerage_id: string; campaign_id: string; contact_id: string | null; lead_id: string | null; created_at: string }>))
    const perf = uniq(mine((perfR as any).rows as Array<{ id: string; brokerage_id: string; ad_campaign_id: string; spend: number | null; captured_at: string }>))
    const qrCampaign = new Map(qrCodes.map((q) => [q.id, q.marketing_campaign_id]))
    const mailCampaign = new Map(mailCampaigns.map((m) => [m.id, m.marketing_campaign_id]))
    const adCampaign = new Map(adCampaigns.map((a) => [a.id, a.marketing_campaign_id]))

    const reach = new Map<string, Set<string>>(campaignIds.map((id) => [id, new Set<string>()]))
    const act = new Map(campaignIds.map((id) => [id, { touchpointsSent: 0, qrScans: 0, qrFirstScans: 0, mailResponses: 0 }]))
    for (const t of uniq(touchpoints)) { act.get(t.campaign_id)!.touchpointsSent++; if (t.contact_id) reach.get(t.campaign_id)!.add(t.contact_id) }
    for (const s of scans) { const c = qrCampaign.get(s.qr_code_id); if (!c || !act.has(c)) continue; act.get(c)!.qrScans++; if (s.is_first_scan) act.get(c)!.qrFirstScans++; if (s.contact_id) reach.get(c)!.add(s.contact_id) }
    const responders = new Map<string, Set<string>>()
    for (const r of responses) { const c = mailCampaign.get(r.campaign_id); if (!c || !act.has(c)) continue; const who = r.contact_id ? `c:${r.contact_id}` : r.lead_id ? `l:${r.lead_id}` : `anon:${r.id}`; const set = responders.get(c) ?? new Set<string>(); set.add(who); responders.set(c, set); if (r.contact_id) reach.get(c)!.add(r.contact_id) }
    for (const [c, set] of responders) act.get(c)!.mailResponses = set.size

    // Appointments of the contacts the campaigns reached (engagement; a showing counts once however many campaigns reached its person).
    const reachedAll = [...new Set([...reach.values()].flatMap((s) => [...s]))]
    const shR = await readByIds(svc, "showings", "id, brokerage_id, contact_id, status, created_at", brokerageId, "contact_id", reachedAll, (q) => q.gte("created_at", sinceIso).lte("created_at", untilIso))
    if (!shR.ok) return refused("appointments")
    const showings = uniq(mine(shR.rows as Array<{ id: string; brokerage_id: string; contact_id: string; status: string | null; created_at: string }>)).filter((s) => !/cancel/i.test(String(s.status ?? "")))
    const apptByContact = new Map<string, string[]>()
    for (const s of showings) apptByContact.set(s.contact_id, [...(apptByContact.get(s.contact_id) ?? []), s.id])

    // ── 5. Spend per campaign: confirmed / partial / tenant-reported / unknown / none ──
    const spend = new Map<string, RoiCampaignRow["cost"]>()
    for (const c of campaigns) {
      const ads = adCampaigns.filter((a) => a.marketing_campaign_id === c.id)
      const mail = mailCampaigns.filter((m) => m.marketing_campaign_id === c.id)
      let known = 0, uncosted = 0, ledgers = 0
      const refs: string[] = [], notes: string[] = []
      if (ads.length) {
        ledgers++
        const rows = perf.filter((p) => adCampaign.get(p.ad_campaign_id) === c.id)
        for (const p of rows) { const s = cents(p.spend); if (s == null) uncosted++; else { known += s; refs.push(`ad_performance:${p.id}`) } }
        notes.push(`ad spend from ${rows.length} ad performance row(s) of ${ads.length} ad campaign(s) in the window`)
      }
      if (mail.length) {
        ledgers++
        for (const m of mail) {
          if (!m.mailing_date) { uncosted++; continue }
          if (!inWin(day(m.mailing_date))) continue
          const pp = cents(m.per_piece_cost), n = m.pieces_mailed == null ? null : Number(m.pieces_mailed)
          if (pp == null || n == null || !Number.isFinite(n)) { uncosted++; continue }
          known += Math.round(pp * n); refs.push(`direct_mail_campaigns:${m.id}`)
        }
        notes.push(`direct mail at per-piece cost × pieces mailed for ${mail.length} mailing(s)`)
      }
      let status: RoiCostStatus
      if (ledgers > 0) status = uncosted > 0 ? (known > 0 ? "partial" : "unknown") : known > 0 ? "confirmed" : "none"
      else if ((cents(c.budget_spent) ?? 0) > 0) { status = "tenant_reported"; known = cents(c.budget_spent)!; refs.push(`marketing_campaigns:${c.id}`); notes.push("the amount your team entered on the campaign (a lifetime figure, not windowed)") }
      else { status = "unknown"; notes.push("no spend source exists for this campaign and none was entered — unknown, not $0") }
      if (uncosted > 0) notes.push(`${uncosted} cost row(s) carry no amount`)
      spend.set(c.id, { status, cents: status === "unknown" ? null : known, note: notes.join("; "), refs })
    }

    // ── 6. Money, attribution and journeys ──
    const closedInWindow = (d: RoiDealFact) => roiDealState(d) === "closed" && inWin(day(d.actual_close_date ?? d.close_date))
    const creditsByDeal = new Map<string, RoiCreditFact[]>()
    for (const c of allCredits) creditsByDeal.set(c.transaction_id, [...(creditsByDeal.get(c.transaction_id) ?? []), c])
    const money = new Map<string, DealMoney>()
    for (const d of dealsInView) if (roiDealState(d) === "closed") money.set(d.id, roiDealMoney(d, commByDeal.get(d.id) ?? []))
    const camp = new Map(campaignIds.map((id) => [id, { sourced: new Set<string>(), influenced: new Set<string>(), escrow: new Set<string>(), outside: new Set<string>(), cents: 0, byModel: {} as Record<string, number> }]))
    const reconciliation: Array<{ transactionId: string; earnedCents: number; creditedCents: number }> = []
    let sourcedEarned = 0, notEstablishedClosed = 0
    const influencedDeals = new Set<string>(), sourcedDeals = new Set<string>()
    const contactsWithDeals = new Set<string>()
    for (const d of deals) {
      const cr = creditsByDeal.get(d.id) ?? []
      if (!cr.length) continue
      const view = inViewDeal(d)
      const state = roiDealState(d)
      for (const c of cr) {
        const k = camp.get(c.campaign_id)
        if (!k) continue
        if (!view) { if (state === "closed" && closedInWindow(d)) k.outside.add(d.id); continue }
        if (state === "in_escrow") k.escrow.add(d.id)
        if (closedInWindow(d)) k.influenced.add(d.id)
      }
      if (!view || !closedInWindow(d)) continue
      influencedDeals.add(d.id)
      for (const c of [d.buyer_contact_id, d.seller_contact_id, d.contact_id]) if (c) contactsWithDeals.add(c)
      const m = money.get(d.id)!
      if (m.earnedCents == null) { notEstablishedClosed++; continue }
      const byModel = new Map<string, RoiCreditFact[]>()
      for (const c of cr) byModel.set(c.attribution_model, [...(byModel.get(c.attribution_model) ?? []), c])
      for (const [model, rows] of byModel) {
        const split = allocateByWeight(m.earnedCents, rows)
        for (const [cid, amt] of split) { const k = camp.get(cid); if (k) k.byModel[model] = (k.byModel[model] ?? 0) + amt }
        if (model !== ROI_SOURCED_MODEL) continue
        const credited = [...split.values()].reduce((s, x) => s + x, 0)
        reconciliation.push({ transactionId: d.id, earnedCents: m.earnedCents, creditedCents: credited })
        sourcedEarned += m.earnedCents; sourcedDeals.add(d.id)
        for (const [cid, amt] of split) { const k = camp.get(cid); if (!k) continue; k.cents += amt; if (amt > 0) k.sourced.add(d.id) }
      }
    }

    // Revenue status ladder (deals in view). Pipeline is as of NOW; earned / received / disbursed are the window's closings.
    let projected = 0, contracted = 0, earned = 0, received = 0, disbursed = 0, reversed = 0, contractedCount = 0, closedCount = 0
    let netBrokerage: number | null = 0
    for (const d of dealsInView) {
      const s = roiDealState(d)
      const est = cents(d.commission_amount ?? d.estimated_commission) ?? 0
      if (inWin(day(d.contract_date)) && s !== "reversed") contractedCount++
      if (s === "reversed") { if (inWin(day(d.contract_date)) || inWin(day(d.close_date))) reversed++; continue }
      if (s === "open") projected += cents(d.estimated_commission) ?? 0
      else if (s === "in_escrow") contracted += est
      else if (closedInWindow(d)) {
        closedCount++
        const m = money.get(d.id)!
        if (m.earnedCents != null) { earned += m.earnedCents; received += m.receivedCents; disbursed += m.disbursedCents; netBrokerage = netBrokerage == null || m.netBrokerageCents == null ? null : netBrokerage + m.netBrokerageCents }
      }
    }
    if (closedCount === 0) netBrokerage = null

    // ── 7. Campaign rows, ratios ──
    const rows: RoiCampaignRow[] = campaigns.map((c) => {
      const k = camp.get(c.id)!, cost = spend.get(c.id)!, a = act.get(c.id)!
      const contacts = reach.get(c.id)!.size
      const appts = [...reach.get(c.id)!].reduce((s, ct) => s + (apptByContact.get(ct)?.length ?? 0), 0)
      const contributionKnown = [...k.influenced].every((id) => money.get(id)?.earnedCents != null)
      const complete = cost.status === "confirmed" || cost.status === "tenant_reported"
      const why = [
        `Cost: ${cost.status.replace("_", " ")} — ${cost.note}.`,
        `Contacts reached: distinct people touched, scanned a QR code or responded to mail in the window (${contacts}).`,
        `Sourced: ${k.sourced.size} closed deal(s) this campaign earned a ${ROI_SOURCED_MODEL} share of; each deal's commission is split once across every campaign that touched it.`,
        `Influenced: ${k.influenced.size} closed deal(s) it touched — a deal touched by two campaigns counts for both here, so influence never adds up across campaigns.`,
        ...(k.outside.size ? [`${k.outside.size} closed deal(s) it touched belong to agents outside your view and are not counted.`] : []),
      ]
      return {
        campaignId: c.id, name: c.campaign_name ?? "Untitled campaign", type: c.campaign_type ?? "other", agentUserId: c.agent_user_id,
        cost, activity: a, acquisition: { contactsReached: contacts }, engagement: { appointments: appts },
        results: { sourcedDealsClosed: k.sourced.size, influencedDealsClosed: k.influenced.size, dealsInEscrow: k.escrow.size, dealsOutsideView: k.outside.size },
        revenue: v.moneyVisible ? { sourcedEarnedCents: k.cents, creditCentsByModel: { ...k.byModel } } : null,
        ratios: {
          realizedReturnOnMarketingSpend: v.moneyVisible ? realizedReturnOnMarketingSpend({ contributionCents: contributionKnown ? k.cents : null, spendCents: cost.cents, spendStatus: cost.status }) : naRatio(ROI_MONEY_HIDDEN_NOTE),
          costPerContact: costPer(cost.cents ?? 0, complete, contacts, "contact"),
          costPerClosedTransaction: costPer(cost.cents ?? 0, complete, k.sourced.size, "closed deal"),
        },
        why,
      }
    })
    const byStatus: Record<RoiCostStatus, number> = { confirmed: 0, partial: 0, tenant_reported: 0, unknown: 0, none: 0 }
    for (const r of rows) byStatus[r.cost.status]++
    const eligible = rows.filter((r) => (r.cost.status === "confirmed" || r.cost.status === "tenant_reported") && (r.cost.cents ?? 0) > 0)
    const eligibleSpend = eligible.reduce((s, r) => s + (r.cost.cents ?? 0), 0)
    const eligibleContacts = new Set(eligible.flatMap((r) => [...reach.get(r.campaignId)!])).size
    const eligibleAppts = new Set(eligible.flatMap((r) => [...reach.get(r.campaignId)!].flatMap((ct) => apptByContact.get(ct) ?? []))).size
    const eligibleSourced = new Set(eligible.flatMap((r) => [...camp.get(r.campaignId)!.sourced])).size
    const eligibleContribution = eligible.every((r) => [...camp.get(r.campaignId)!.influenced].every((id) => money.get(id)?.earnedCents != null))
      ? eligible.reduce((s, r) => s + camp.get(r.campaignId)!.cents, 0) : null
    const knownSpend = rows.reduce((s, r) => s + (r.cost.cents ?? 0), 0)
    const costStatus: RoiOutcomeLedger["costs"]["status"] = rows.length === 0 ? "none"
      : byStatus.unknown === rows.length ? "unknown" : byStatus.unknown + byStatus.partial > 0 ? "partial" : knownSpend > 0 ? "complete" : "none"
    const allComplete = eligible.length > 0
    const scopeNote = eligible.length < rows.length ? ` Calculated over the ${eligible.length} of ${rows.length} campaign(s) whose spend is fully recorded.` : ""
    const roms = !v.moneyVisible ? naRatio(ROI_MONEY_HIDDEN_NOTE)
      : eligible.length === 0 ? naRatio(rows.length === 0 ? "No campaigns are in this view yet." : "No campaign in this view has its full spend recorded, so a return cannot be calculated.")
      : realizedReturnOnMarketingSpend({ contributionCents: eligibleContribution, spendCents: eligibleSpend, spendStatus: "confirmed" })

    // ── 8. Journeys: Contact → touch → scan / response → appointment → contract → close, with evidence ──
    const journeys: RoiJourney[] = []
    for (const d of dealsInView) {
      const cr = creditsByDeal.get(d.id) ?? []
      if (!cr.length) continue
      const s = roiDealState(d)
      if (!(s === "in_escrow" || closedInWindow(d) || (s === "reversed" && (inWin(day(d.contract_date)) || inWin(day(d.close_date)))))) continue
      const people = [d.buyer_contact_id, d.seller_contact_id, d.contact_id].filter((x): x is string => !!x)
      const m = money.get(d.id)
      const steps: RoiJourney["steps"] = []
      for (const c of cr.filter((x) => x.attribution_model === ROI_SOURCED_MODEL)) {
        const name = campaigns.find((k) => k.id === c.campaign_id)?.campaign_name ?? (inViewCampaign.has(c.campaign_id) ? "campaign" : "a campaign outside your view")
        steps.push({ at: c.first_touchpoint_at, kind: "touchpoint", label: `${name}: ${c.touchpoint_count ?? 0} touch(es) through ${day(c.last_touchpoint_at) ?? "—"}`, ref: `marketing_attribution_credits:${c.id}` })
      }
      for (const sc of scans) if (sc.contact_id && people.includes(sc.contact_id)) steps.push({ at: sc.scanned_at, kind: "qr_scan", label: "Scanned a QR code", ref: `qr_scan_events:${sc.id}` })
      for (const r of responses) if (r.contact_id && people.includes(r.contact_id)) steps.push({ at: r.created_at, kind: "mail_response", label: "Responded to mail", ref: `mail_response_tracking:${r.id}` })
      for (const p of people) for (const sid of apptByContact.get(p) ?? []) steps.push({ at: showings.find((x) => x.id === sid)?.created_at ?? null, kind: "appointment", label: "Appointment booked", ref: `showings:${sid}` })
      if (d.contract_date) steps.push({ at: d.contract_date, kind: "contract", label: "Under contract", ref: `transactions:${d.id}` })
      if (s === "closed") steps.push({ at: d.actual_close_date ?? d.close_date, kind: "closed", label: "Closed", ref: `transactions:${d.id}` })
      if (s === "reversed") steps.push({ at: d.close_date ?? d.contract_date, kind: "reversed", label: "Fell through — no revenue counted", ref: `transactions:${d.id}` })
      steps.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
      const split = m?.earnedCents != null ? allocateByWeight(m.earnedCents, cr.filter((x) => x.attribution_model === ROI_SOURCED_MODEL)) : null
      const revenueStatus: RoiJourney["revenueStatus"] = s === "reversed" ? "reversed" : s === "in_escrow" ? "contracted" : s === "open" ? "projected"
        : m?.earnedCents == null ? "not_established" : m.disbursedCents > 0 ? "disbursed" : m.receivedCents > 0 ? "received" : "earned"
      journeys.push({
        transactionId: d.id, dealName: d.deal_name, state: s, revenueStatus,
        earnedCents: v.moneyVisible ? (m?.earnedCents ?? null) : null, steps,
        credits: cr.filter((x) => x.attribution_model === ROI_SOURCED_MODEL).map((x) => ({ campaignId: x.campaign_id, weight: Number(x.attribution_weight ?? 0), cents: v.moneyVisible && split ? (split.get(x.campaign_id) ?? 0) : null })),
      })
    }

    // ── 9. Provider economics (account level: shown to a tenant-wide view; narrower views see the note) ──
    const accountLevel = v.kind === "tenant"
    let vendorPlatform = 0, vendorTenant = 0, vendorUnpriced = 0, aiPlatform = 0, aiTenant = 0, rawRecords = 0, rawPromoted = 0, rawKnown = 0, rawUnpriced = 0
    if (accountLevel) {
      const [vu, ai, raw] = await Promise.all([
        svc.from("vendor_usage_tracking").select("id, brokerage_id, total_cost, request_metadata").eq("brokerage_id", brokerageId).gte("created_at", sinceIso).lte("created_at", untilIso).limit(ROI_READ_LIMIT),
        svc.from("ai_tool_usage").select("id, brokerage_id, cost_cents, platform_paid").eq("brokerage_id", brokerageId).gte("created_at", sinceIso).lte("created_at", untilIso).limit(ROI_READ_LIMIT),
        svc.from("raw_scraped_leads").select("id, brokerage_id, cost_per_record, lead_id").eq("brokerage_id", brokerageId).gte("created_at", sinceIso).lte("created_at", untilIso).limit(ROI_READ_LIMIT),
      ])
      if (vu.error) return refused("provider spend")
      if (ai.error) return refused("AI usage")
      if (raw.error) return refused("acquired records")
      for (const r of mine((vu.data ?? []) as Array<{ brokerage_id: string; total_cost: number | null; request_metadata: Record<string, unknown> | null }>)) {
        const md = r.request_metadata ?? {}
        if (md.price_state === "unknown" || r.total_cost == null) { vendorUnpriced++; continue }
        if (md.coverage === "tenant_paid") vendorTenant += cents(r.total_cost) ?? 0
        else vendorPlatform += cents(r.total_cost) ?? 0
      }
      for (const r of mine((ai.data ?? []) as Array<{ brokerage_id: string; cost_cents: number | null; platform_paid: boolean | null }>)) {
        if (r.platform_paid === false) aiTenant += Math.round(Number(r.cost_cents ?? 0)); else aiPlatform += Math.round(Number(r.cost_cents ?? 0))
      }
      for (const r of mine((raw.data ?? []) as Array<{ brokerage_id: string; cost_per_record: number | null; lead_id: string | null }>)) {
        rawRecords++; if (r.lead_id) rawPromoted++
        const c = cents(r.cost_per_record); if (c == null) rawUnpriced++; else rawKnown += c
      }
    }

    // ── 10. Completeness, "why this number?", recommendations ──
    const notes: string[] = []
    if (notEstablishedClosed) notes.push(`${notEstablishedClosed} closed deal(s) have no finalized commission yet; they count as closings but add no earned dollars until finalized.`)
    if (byStatus.unknown) notes.push(`${byStatus.unknown} campaign(s) have no recorded spend; their cost is unknown, not $0.`)
    if (byStatus.partial) notes.push(`${byStatus.partial} campaign(s) have spend recorded for only part of their activity.`)
    if (reversed) notes.push(`${reversed} deal(s) fell through in this window; any credit they carried is excluded.`)
    const reconciled = reconciliation.every((r) => r.earnedCents === r.creditedCents)
    if (!reconciled) notes.push("At least one closed deal's attribution does not split exactly; its campaign shares are held for review.")
    if (foreign) notes.push(`${foreign} row(s) stamped with another workspace were excluded.`)
    notes.push("Figures are restated as of now: a commission corrected after the window closed changes this window's earned amount, and a deal reassigned to another agent moves with it.")
    const label: RoiOutcomeLedger["completeness"]["label"] = notEstablishedClosed || byStatus.unknown || byStatus.partial || !reconciled ? (eligible.length || sourcedDeals.size ? "partial" : "incomplete") : "complete"

    const recommendations: RoiRecommendation[] = []
    const byChannel = new Map<string, RoiCampaignRow[]>()
    for (const r of rows) if ((r.cost.status === "confirmed" || r.cost.status === "tenant_reported") && (r.cost.cents ?? 0) > 0 && r.acquisition.contactsReached > 0) byChannel.set(r.type, [...(byChannel.get(r.type) ?? []), r])
    for (const [channel, group] of byChannel) {
      if (group.length < ROI_MIN_COMPARABLE) continue
      const per = group.map((r) => (r.cost.cents ?? 0) / r.acquisition.contactsReached).sort((a, b) => a - b)
      const median = per[Math.floor(per.length / 2)]
      for (const r of group) {
        const own = (r.cost.cents ?? 0) / r.acquisition.contactsReached
        if (median > 0 && own >= ROI_OUTLIER_MULTIPLE * median && r.results.sourcedDealsClosed === 0) recommendations.push({
          manager: channel === "ad" ? "ads_manager" : "campaign_orchestrator", kind: "review_reduce", campaignId: r.campaignId,
          text: `"${r.name}" cost about ${(own / median).toFixed(1)}× the typical ${channel.replace("_", " ")} campaign per contact reached and has no closed deal yet. Consider reducing or pausing it after a review; nothing changes until someone on your team decides.`,
          evidence: [...r.cost.refs.slice(0, 5), `comparable ${channel} campaigns: ${group.length}`], comparableSample: group.length, requiresApproval: true,
        })
      }
    }
    for (const r of rows) if ((r.cost.status === "unknown" || r.cost.status === "partial") && (r.acquisition.contactsReached > 0 || r.results.influencedDealsClosed > 0)) recommendations.push({
      manager: "data_steward", kind: "record_spend", campaignId: r.campaignId,
      text: `"${r.name}" reached ${r.acquisition.contactsReached} contact(s) but what it cost is ${r.cost.status === "unknown" ? "not recorded" : "only partly recorded"}. Record its cost to see its return.`,
      evidence: r.cost.refs.slice(0, 5), comparableSample: null, requiresApproval: true,
    })
    // ── 8. QR placements — measured from the governed mint's placement and the scan route's traffic class ──
    const placements = buildPlacementRows(qrCodes, scans, new Map(rows.map((r) => [r.campaignId, r.cost])))
    const comparablePlacements = placements.filter((pl) => pl.cost.status === "attributable" && (pl.cost.cents ?? 0) > 0 && pl.contactsCaptured > 0)
    if (comparablePlacements.length >= ROI_MIN_COMPARABLE) {
      const perCapture = comparablePlacements.map((pl) => ({ pl, per: (pl.cost.cents as number) / pl.contactsCaptured })).sort((a, b) => a.per - b.per)
      const median = perCapture[Math.floor(perCapture.length / 2)].per
      const best = perCapture[0]
      if (best.per > 0 && median >= ROI_OUTLIER_MULTIPLE * best.per) recommendations.push({
        manager: "campaign_orchestrator", kind: "repeat_what_worked", campaignId: null,
        text: `QR codes placed on "${best.pl.placement}" captured a contact for about ${(median / best.per).toFixed(1)}× less than the typical placement. Consider using that placement on your next printed piece; nothing changes until someone on your team decides.`,
        evidence: [...best.pl.refs.slice(0, 5), `comparable placements: ${comparablePlacements.length}`], comparableSample: comparablePlacements.length, requiresApproval: true,
      })
    }
    if (notEstablishedClosed) recommendations.push({ manager: "finance_manager", kind: "finalize_commission", campaignId: null, text: `${notEstablishedClosed} closed deal(s) are waiting on a finalized commission. Finalizing them lets their marketing return be measured.`, evidence: [...money.entries()].filter(([, m]) => m.earnedCents == null).flatMap(([, m]) => m.refs).slice(0, 10), comparableSample: null, requiresApproval: true })
    if (!reconciled) recommendations.push({ manager: "data_steward", kind: "repair_attribution", campaignId: null, text: "A closed deal's campaign credit does not split exactly. Re-running attribution for it restores an exact split.", evidence: reconciliation.filter((r) => r.earnedCents !== r.creditedCents).map((r) => `transactions:${r.transactionId}`), comparableSample: null, requiresApproval: true })

    const ledger: RoiOutcomeLedger = {
      generatedAt: new Date().toISOString(), window: { sinceDay, untilDay }, model: ROI_SOURCED_MODEL,
      scope: { kind: v.kind, basis: [...v.basis, `money: ${v.moneyBasis}`], moneyVisible: v.moneyVisible, moneyNote: v.moneyVisible ? null : ROI_MONEY_HIDDEN_NOTE },
      activity: rows.reduce((s, r) => ({ touchpointsSent: s.touchpointsSent + r.activity.touchpointsSent, qrScans: s.qrScans + r.activity.qrScans, qrFirstScans: s.qrFirstScans + r.activity.qrFirstScans, mailResponses: s.mailResponses + r.activity.mailResponses }), { touchpointsSent: 0, qrScans: 0, qrFirstScans: 0, mailResponses: 0 }),
      acquisition: { contactsReached: reachedAll.length, contactsWithDeals: contactsWithDeals.size },
      engagement: { appointments: showings.length },
      results: { dealsContracted: contractedCount, dealsClosed: closedCount, dealsReversed: reversed, sourcedDealsClosed: sourcedDeals.size, influencedDealsClosed: influencedDeals.size },
      costs: { knownCents: knownSpend, status: costStatus, byStatus, eligibleCampaigns: eligible.length },
      revenue: v.moneyVisible ? { projectedCents: projected, contractedCents: contracted, earnedCents: earned, receivedCents: received, disbursedCents: disbursed, netBrokerageCents: netBrokerage, closedNotEstablished: notEstablishedClosed } : null,
      attribution: v.moneyVisible ? { sourcedEarnedCents: sourcedEarned, sourcedDeals: sourcedDeals.size, reconciled, reconciliation, influencedDeals: influencedDeals.size, influenceIsAdditive: false } : null,
      ratios: {
        realizedReturnOnMarketingSpend: roms,
        costPerContact: costPer(eligibleSpend, allComplete, eligibleContacts, "contact"),
        costPerAppointment: costPer(eligibleSpend, allComplete, eligibleAppts, "appointment"),
        costPerClosedTransaction: costPer(eligibleSpend, allComplete, eligibleSourced, "closed deal"),
      },
      campaigns: rows, placements, journeys,
      providerEconomics: {
        shownAtAccountLevel: accountLevel,
        vendorPlatformCoveredCents: vendorPlatform, vendorTenantPaidCents: vendorTenant, vendorUnpricedCalls: vendorUnpriced,
        aiPlatformFundedCents: aiPlatform, aiTenantCents: aiTenant,
        rawRecords, rawPromoted,
        costPerPromotedRecord: !accountLevel ? naRatio("Provider costs are shown on the account-wide view.") : rawUnpriced > 0 ? naRatio(`${rawUnpriced} acquired record(s) carry no price, so a cost per promoted record would understate it.`) : costPer(rawKnown, true, rawPromoted, "promoted record"),
        notMeasured: ["Duplicates avoided: the pre-pull duplicate check decides in memory and records no avoided pull, so there is nothing to count yet."],
      },
      recommendations, completeness: { label, notes },
      why: {
        realizedReturnOnMarketingSpend: `(earned commission credited to campaigns − their recorded spend) ÷ their recorded spend, over closed deals in ${sinceDay}…${untilDay}. Sale price is never used.${scopeNote}`,
        sourced: `Each closed deal's earned commission is split once across the campaigns that touched its people within 180 days before the contract, by the ${ROI_SOURCED_MODEL} model; the campaign shares add up to the deal exactly.`,
        influenced: "A deal any campaign touched. Counted once per deal here and once per campaign on each row — never added across campaigns.",
        earned: "Closed or funded deals in the window: the commission ledger's gross amount, or the finalized commission on the deal. An estimate is never counted as earned.",
        received: "Earned commission whose funds the business has recorded as received.",
        disbursed: "Agent payouts recorded as paid on those deals.",
        pipeline: "Projected (open, no contract) and contracted (under contract) amounts are estimates for deals that have not closed — never part of the return.",
        costs: "Confirmed costs come from ad spend and direct-mail piece costs; tenant-reported is the amount entered on a campaign; unknown means nothing is recorded.",
        placements: "Where each QR code was printed, as recorded when it was created. Visits are split into likely people, automated or repeat scans, and scans recorded before that split existed. A placement's cost is its campaigns' whole recorded spend, counted only when those campaigns printed every code on that one placement — otherwise the spend is shared and no per-placement cost is shown.",
      },
      foreignRowsDropped: foreign,
    }
    return { ok: true, ledger }
  } catch (e) {
    console.error("[roi-ledger] outcome ledger failed:", e)
    return { ok: false, error: presentTenantMessage({ what: "Marketing results could not be put together right now", work: { state: "unchanged" }, next: "platform_support", action: { label: "Try again in a moment" } }).sentence }
  }
}

/** The CSV of a ledger — built from the SAME object the page renders, so the export cannot disagree with the reader. */
export function roiOutcomeCsv(l: RoiOutcomeLedger): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const usd = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2))
  const ratio = (r: RoiRatio) => (r.value == null ? "N/A" : String(Math.round(r.value * 10000) / 10000))
  const out: string[][] = [["section", "metric", "value", "note"]]
  out.push(["scope", "view", l.scope.kind, l.scope.moneyNote ?? ""], ["scope", "window", `${l.window.sinceDay}..${l.window.untilDay}`, `attribution model ${l.model}`])
  for (const [k, n] of Object.entries(l.activity)) out.push(["activity", k, String(n), ""])
  for (const [k, n] of Object.entries(l.acquisition)) out.push(["acquisition", k, String(n), ""])
  out.push(["engagement", "appointments", String(l.engagement.appointments), ""])
  for (const [k, n] of Object.entries(l.results)) out.push(["results", k, String(n), k === "influencedDealsClosed" ? "non-additive" : ""])
  out.push(["costs", "knownUsd", usd(l.costs.knownCents), `status ${l.costs.status}`])
  if (l.revenue) for (const [k, n] of Object.entries(l.revenue)) out.push(["revenue", k.replace(/Cents$/, "Usd"), k.endsWith("Cents") ? usd(n as number | null) : String(n ?? ""), ""])
  if (l.attribution) out.push(["attribution", "sourcedEarnedUsd", usd(l.attribution.sourcedEarnedCents), `reconciled ${l.attribution.reconciled}`], ["attribution", "influencedDeals", String(l.attribution.influencedDeals), "non-additive"])
  for (const [k, r] of Object.entries(l.ratios)) out.push(["ratio", k, ratio(r), r.na ?? ""])
  out.push([], ["campaign", "type", "cost_status", "cost_usd", "contacts_reached", "appointments", "sourced_closed", "influenced_closed", "sourced_earned_usd", "realized_return", "cost_per_contact_usd", "note"])
  for (const c of l.campaigns) out.push([c.name, c.type, c.cost.status, usd(c.cost.cents), String(c.acquisition.contactsReached), String(c.engagement.appointments), String(c.results.sourcedDealsClosed), String(c.results.influencedDealsClosed), usd(c.revenue?.sourcedEarnedCents ?? null), ratio(c.ratios.realizedReturnOnMarketingSpend), c.ratios.costPerContact.value == null ? "N/A" : usd(c.ratios.costPerContact.value), c.ratios.realizedReturnOnMarketingSpend.na ?? ""])
  return out.map((r) => r.map(esc).join(",")).join("\n") + "\n"
}

/**
 * The realized revenue a set of campaigns SOURCED (one model, closed / funded, finalized money) — the campaign_roi
 * WRITER's revenue (lib/campaigns/roi-calculator.ts), so the cache row and this reader cannot disagree. Pinned to
 * `brokerageId` (the caller's own tenant). `established: false` when a credited closed deal's commission is not
 * finalized — the writer then stores NULL revenue and NULL return, never a guess.
 */
export async function loadRealizedCampaignRevenue(
  svc: RoiSvc, brokerageId: string, campaignIds: string[], window?: { sinceDay: string; untilDay: string },
): Promise<{ ok: true; byCampaign: Map<string, { earnedCents: number; established: boolean; closedDeals: number }> } | { ok: false; error: string }> {
  const byCampaign = new Map(campaignIds.map((id) => [id, { earnedCents: 0, established: true, closedDeals: 0 }]))
  const cr = await readByIds(svc, "marketing_attribution_credits", "id, brokerage_id, campaign_id, transaction_id, attribution_model, attribution_weight, contact_id, touchpoint_count, first_touchpoint_at, last_touchpoint_at", brokerageId, "campaign_id", campaignIds, (q) => q.eq("attribution_model", ROI_SOURCED_MODEL))
  if (!cr.ok) return cr
  const txIds = [...new Set((cr.rows as RoiCreditFact[]).map((c) => c.transaction_id))]
  const tx = await readByIds(svc, "transactions", "id, brokerage_id, status, deleted_at, deal_name, contract_date, close_date, actual_close_date, commission_amount, estimated_commission, commission_finalized_at, agent_id, buyer_agent_id, seller_agent_id, buyer_contact_id, seller_contact_id, contact_id", brokerageId, "id", txIds)
  if (!tx.ok) return tx
  const cm = await readByIds(svc, "agent_commissions", "id, brokerage_id, transaction_id, status, gross_commission, net_to_brokerage, brokerage_commission, net_to_agent, agent_commission, deposit_received_at, paid_at", brokerageId, "transaction_id", txIds)
  if (!cm.ok) return cm
  // Every credit row of each deal (all campaigns, this model) — a deal's split is computed over ALL its campaigns.
  const all = await readByIds(svc, "marketing_attribution_credits", "id, brokerage_id, campaign_id, transaction_id, attribution_model, attribution_weight, contact_id, touchpoint_count, first_touchpoint_at, last_touchpoint_at", brokerageId, "transaction_id", txIds, (q) => q.eq("attribution_model", ROI_SOURCED_MODEL))
  if (!all.ok) return all
  for (const d of tx.rows as RoiDealFact[]) {
    if (roiDealState(d) !== "closed") continue
    const at = day(d.actual_close_date ?? d.close_date)
    if (window && !(at && at >= window.sinceDay && at <= window.untilDay)) continue
    const rows = (all.rows as RoiCreditFact[]).filter((c) => c.transaction_id === d.id)
    const m = roiDealMoney(d, (cm.rows as RoiCommissionFact[]).filter((r) => r.transaction_id === d.id))
    for (const c of rows) { const k = byCampaign.get(c.campaign_id); if (k) k.closedDeals++ }
    if (m.earnedCents == null) { for (const c of rows) { const k = byCampaign.get(c.campaign_id); if (k) k.established = false }; continue }
    for (const [cid, amt] of allocateByWeight(m.earnedCents, rows)) { const k = byCampaign.get(cid); if (k) k.earnedCents += amt }
  }
  return { ok: true, byCampaign }
}
