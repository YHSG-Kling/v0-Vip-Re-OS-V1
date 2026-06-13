// lib/kernel/closing-war-room.ts
//
// CLOSING-DAY WAR ROOM — the Deal Coordinator's FINAL-MILE cockpit.
//
// The watchtower (lib/kernel/title-closing-watchtower.ts) watches the date CHAIN
// move; the financing-pit-stop works the RATE side. This is the LAST surface: for
// a deal inside the closing window (closing_date within N days), it assembles ONE
// calm cockpit answering "are we actually clear to close, and what is still open?"
//
// It is a READ-ONLY AGGREGATION — no new tables, no writes (the optional sweep
// escalates a stalled item onto the EXISTING manager-signals bus; the deal page
// surface writes nothing). Every datum comes from a REAL column on the live schema
// verified against the database:
//
//   · the DATE-CHAIN CRITICAL PATH — REUSED verbatim from the watchtower's
//     buildDateChain + computeCriticalPath (transaction_milestones rows).
//   · CLEAR-TO-CLOSE CONDITIONS, each mapped to a real signal:
//       inspection / appraisal / financing  → transaction_milestones.status (the chain).
//       lender_clear_to_close               → transaction_lenders.clear_to_close_date
//                                              (or underwriting_status 'clear_to_close'/'funded').
//       earnest_money                       → transaction_title_escrow.earnest_money_received_date.
//       wire_closing_scheduled              → transaction_title_escrow.closing_scheduled_date
//                                              (the same wire/closing-logistics proxy the
//                                               closing-orchestration cron uses — there is NO
//                                               dedicated wire column on the live schema).
//       signatures                          → contract_signatures.esign_status 'fully_signed'.
//       required_docs                       → the document-audit checklist present/missing
//                                              (passed in by the runner; the war room does not
//                                               re-run the audit engine).
//   · OPEN ITEMS — the Deal Coordinator's drive-to-done list, drawn from REAL
//     transaction_tasks (pending/in_progress) + transaction_pending_actions (open) +
//     every unmet condition, each carrying WHO owns it.
//
// HONESTY (the spine of this module): a signal we cannot read is 'unknown', NEVER a
// fabricated 'done'. A deal with no closing date has no war room (skipped). closingReadiness
// is ready ONLY when every required condition is genuinely met — a single missing CTC /
// signature / doc lists a blocker, and an 'unknown' condition is itself a blocker (we do not
// claim ready on data we could not verify). Pure helpers carry the logic; the runner does I/O.
//
// NOT server-only (simulator-driven). Pure helpers below; loadClosingWarRoom does the reads.

import type { createServiceClient } from "@/lib/supabase/service"
import {
  buildDateChain,
  computeCriticalPath,
  daysBetween,
  fmtChainDate,
  type ChainStep,
  type CriticalPath,
} from "@/lib/kernel/title-closing-watchtower"

type Svc = ReturnType<typeof createServiceClient>

// ─── Condition model ─────────────────────────────────────────────────────────

/** The clear-to-close conditions the war room tracks. Each maps to ONE real signal. */
export const WAR_ROOM_CONDITION_KEYS = [
  "inspection",
  "appraisal",
  "financing",
  "lender_clear_to_close",
  "earnest_money",
  "wire_closing_scheduled",
  "signatures",
  "required_docs",
] as const

export type WarRoomConditionKey = (typeof WAR_ROOM_CONDITION_KEYS)[number]

export const CONDITION_LABELS: Record<WarRoomConditionKey, string> = {
  inspection:             "Inspection cleared",
  appraisal:              "Appraisal cleared",
  financing:              "Financing cleared",
  lender_clear_to_close:  "Lender clear-to-close",
  earnest_money:          "Earnest money received",
  wire_closing_scheduled: "Closing / wire scheduled",
  signatures:             "Signatures complete",
  required_docs:          "Required documents on file",
}

/** Who the Deal Coordinator drives this condition through when it is not done. */
export const CONDITION_OWNER: Record<WarRoomConditionKey, string> = {
  inspection:             "buyer / inspector",
  appraisal:              "lender / appraiser",
  financing:              "lender",
  lender_clear_to_close:  "lender",
  earnest_money:          "buyer / title",
  wire_closing_scheduled: "title / escrow",
  signatures:             "all parties",
  required_docs:          "agent / coordinator",
}

/**
 * A condition's status. HONEST trichotomy:
 *   · done    — the real signal confirms it (a date on file / 'fully_signed' / all docs present).
 *   · open    — the signal exists but says not-yet (no date, status not clear-to-close, docs missing).
 *   · unknown — there is NO row / NO signal we can read. NEVER assumed done.
 */
export type ConditionStatus = "done" | "open" | "unknown"

export interface WarRoomCondition {
  key:      WarRoomConditionKey
  label:    string
  status:   ConditionStatus
  /** Whether this condition is required for clear-to-close (all are, today — kept explicit). */
  required: boolean
  /** Whether a missing/unknown state blocks readiness (required && status !== 'done'). */
  blocking: boolean
  owner:    string
  /** Earned one-line detail straight from the real signal (e.g. "Received Jun 3", "No date on file"). */
  detail:   string
}

// ─── Pure: condition status from a real signal ───────────────────────────────

/**
 * Reduce a raw signal to a {done|open|unknown} status. The caller passes the REAL
 * value it read (a date, a status string, a boolean, or null when no row exists).
 *
 *   · null / undefined          → 'unknown' (no row, no signal — never 'done').
 *   · a present date            → 'done'.
 *   · a recognized done-status  → 'done'.
 *   · anything else present     → 'open'.
 */
export function conditionStatus(signal: {
  /** A date string means the thing happened. */
  date?: string | null
  /** A status string compared against doneValues. */
  statusValue?: string | null
  doneValues?: readonly string[]
  /** A direct boolean (true=done, false=open). */
  done?: boolean | null
  /** True only when a row/source actually existed to read (distinguishes 'open' from 'unknown'). */
  present?: boolean
}): ConditionStatus {
  if (signal.done === true) return "done"
  if (signal.date != null && signal.date !== "") return "done"
  if (signal.statusValue != null && signal.statusValue !== "") {
    const done = (signal.doneValues ?? []).includes(signal.statusValue)
    return done ? "done" : "open"
  }
  if (signal.done === false) return "open"
  // No date, no status, no explicit boolean: open only if we KNOW a source existed.
  if (signal.present === true) return "open"
  return "unknown"
}

// ─── Pure: readiness verdict ─────────────────────────────────────────────────

export interface ReadinessBlocker {
  key:    WarRoomConditionKey
  label:  string
  status: ConditionStatus
  owner:  string
}

export interface ClosingReadiness {
  /** True ONLY when every required condition is genuinely 'done'. */
  ready:        boolean
  blockers:     ReadinessBlocker[]
  doneCount:    number
  requiredCount: number
  /** Required conditions whose status is 'unknown' — we could not verify, so we will not claim ready. */
  unknownCount: number
}

/**
 * The verdict. ready ⇔ every REQUIRED condition is 'done'. A required condition that
 * is 'open' OR 'unknown' is a blocker — an unverifiable signal is honestly treated as
 * not-ready, never silently passed.
 */
export function closingReadiness(conditions: WarRoomCondition[]): ClosingReadiness {
  const required = conditions.filter((c) => c.required)
  const blockers: ReadinessBlocker[] = required
    .filter((c) => c.status !== "done")
    .map((c) => ({ key: c.key, label: c.label, status: c.status, owner: c.owner }))
  const doneCount = required.filter((c) => c.status === "done").length
  const unknownCount = required.filter((c) => c.status === "unknown").length
  return {
    ready:         blockers.length === 0,
    blockers,
    doneCount,
    requiredCount: required.length,
    unknownCount,
  }
}

// ─── Pure: days to close ─────────────────────────────────────────────────────

/** Whole calendar days from `now` to the closing date (negative = closing date passed). */
export function daysToClose(closingDate: string | null, now: Date): number | null {
  if (!closingDate) return null
  return daysBetween(now.toISOString().slice(0, 10), closingDate)
}

/** The default closing window: a deal is "in the war room" when closing is within N days. */
export const DEFAULT_CLOSING_WINDOW_DAYS = 14

/** Pure: is this deal inside the closing window (and not already long past closing)? */
export function inClosingWindow(
  closingDate: string | null,
  now: Date,
  windowDays = DEFAULT_CLOSING_WINDOW_DAYS,
): boolean {
  const d = daysToClose(closingDate, now)
  if (d === null) return false
  // Within the forward window, or up to 3 days past (closings slip — keep the cockpit live).
  return d <= windowDays && d >= -3
}

// ─── Pure: open-item assembly ────────────────────────────────────────────────

export interface OpenItem {
  /** Stable source key so the UI/dedupe can group: 'condition' | 'task' | 'pending_action'. */
  source:   "condition" | "task" | "pending_action"
  id:       string
  headline: string
  owner:    string
  /** low | medium | high | urgent — drives ordering + badge. */
  severity: "low" | "medium" | "high" | "urgent"
  dueDate:  string | null
}

const SEVERITY_RANK: Record<OpenItem["severity"], number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/**
 * Assemble + ORDER the Deal Coordinator's drive-to-done list from the three real
 * sources: every unmet condition, every open transaction_task, every open
 * transaction_pending_action. Ordered by severity then due date.
 */
export function assembleOpenItems(args: {
  conditions:     WarRoomCondition[]
  tasks:          Array<{ id: string; title: string | null; status: string | null; priority: string | null; due_date: string | null; assigned_to: string | null }>
  pendingActions: Array<{ id: string; headline: string | null; severity: string | null; due_date: string | null; suggested_recipient: string | null; status: string | null }>
}): OpenItem[] {
  const items: OpenItem[] = []

  // 1. Unmet conditions become open items (the most important — they gate the close).
  for (const c of args.conditions) {
    if (c.status === "done" || !c.required) continue
    items.push({
      source:   "condition",
      id:       `condition:${c.key}`,
      headline: c.status === "unknown" ? `${c.label} — unconfirmed (no data on file)` : `${c.label} — not yet done`,
      owner:    c.owner,
      severity: c.status === "unknown" ? "high" : "urgent",
      dueDate:  null,
    })
  }

  // 2. Open transaction tasks.
  for (const t of args.tasks) {
    if (t.status && !["pending", "in_progress"].includes(t.status)) continue
    items.push({
      source:   "task",
      id:       `task:${t.id}`,
      headline: t.title ?? "Untitled task",
      owner:    t.assigned_to ?? "coordinator",
      severity: mapTaskPriority(t.priority),
      dueDate:  t.due_date ?? null,
    })
  }

  // 3. Open orchestration pending-actions.
  for (const p of args.pendingActions) {
    if (p.status && p.status !== "open") continue
    items.push({
      source:   "pending_action",
      id:       `pending_action:${p.id}`,
      headline: p.headline ?? "Open action",
      owner:    p.suggested_recipient ?? "agent",
      severity: mapActionSeverity(p.severity),
      dueDate:  p.due_date ?? null,
    })
  }

  return items.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (s !== 0) return s
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return 0
  })
}

function mapTaskPriority(p: string | null): OpenItem["severity"] {
  switch ((p ?? "").toLowerCase()) {
    case "urgent": return "urgent"
    case "high":   return "high"
    case "low":    return "low"
    default:       return "medium"
  }
}

function mapActionSeverity(s: string | null): OpenItem["severity"] {
  switch ((s ?? "").toLowerCase()) {
    case "urgent": return "urgent"
    case "high":   return "high"
    case "low":    return "low"
    default:       return "medium"
  }
}

// ─── Pure: build the condition set from real signals ─────────────────────────

export interface WarRoomSignals {
  /** transaction_milestones rows (the date chain + per-step status). */
  milestones: Array<{ milestone_name: string; target_date: string | null; status: string | null }>
  /** transaction_lenders row (clear_to_close_date / underwriting_status) or null. */
  lender: { clear_to_close_date: string | null; underwriting_status: string | null } | null
  /** transaction_title_escrow row (EM received + closing scheduled) or null. */
  titleEscrow: { earnest_money_received_date: string | null; closing_scheduled_date: string | null } | null
  /** contract_signatures rows for the deal's brokerage — esign_status. */
  signatures: Array<{ esign_status: string | null }>
  /** The document audit verdict (passed in by the runner; null when no checklist configured). */
  docAudit: { required_total: number; missing_blocking: string[]; missing_warning: string[] } | null
}

const CTC_DONE_STATUSES = ["clear_to_close", "funded", "cleared_to_close"] as const
const SIGNATURE_DONE_STATUSES = ["fully_signed"] as const

/** Find a chain milestone's status by its canonical name(s). */
function milestoneStatus(
  rows: WarRoomSignals["milestones"],
  ...names: string[]
): { status: string | null; present: boolean } {
  const row = rows.find((r) => names.includes(r.milestone_name))
  return { status: row?.status ?? null, present: !!row }
}

/**
 * Build the eight clear-to-close conditions from the real signals. Each condition's
 * status is computed by conditionStatus over exactly the column(s) documented above.
 */
export function buildConditions(signals: WarRoomSignals, chain: ChainStep[]): WarRoomCondition[] {
  const out: WarRoomCondition[] = []

  // Chain-driven milestone conditions (inspection / appraisal / financing) — a step is
  // 'done' when its milestone status is completed; 'open' when the row exists but isn't;
  // 'unknown' when no milestone row exists at all.
  const chainConditions: Array<{ key: WarRoomConditionKey; names: string[] }> = [
    { key: "inspection", names: ["inspection_deadline", "inspection_completed", "inspection"] },
    { key: "appraisal",  names: ["appraisal_deadline", "appraisal_completed", "appraisal"] },
    { key: "financing",  names: ["financing_deadline", "financing"] },
  ]
  for (const cc of chainConditions) {
    const m = milestoneStatus(signals.milestones, ...cc.names)
    const status = conditionStatus({ statusValue: m.status, doneValues: ["completed"], present: m.present })
    out.push(condition(cc.key, status, chainDetail(signals.milestones, cc.names, status)))
  }

  // Lender clear-to-close: a clear_to_close_date OR a done underwriting status.
  if (signals.lender) {
    const status = conditionStatus({
      date:        signals.lender.clear_to_close_date,
      statusValue: signals.lender.clear_to_close_date ? null : signals.lender.underwriting_status,
      doneValues:  CTC_DONE_STATUSES,
      present:     true,
    })
    out.push(condition("lender_clear_to_close", status,
      signals.lender.clear_to_close_date
        ? `Cleared ${fmtChainDate(signals.lender.clear_to_close_date)}`
        : status === "open"
          ? `Underwriting: ${signals.lender.underwriting_status ?? "in progress"}`
          : "No clear-to-close on file"))
  } else {
    out.push(condition("lender_clear_to_close", "unknown", "No lender on file"))
  }

  // Earnest money received.
  if (signals.titleEscrow) {
    const status = conditionStatus({ date: signals.titleEscrow.earnest_money_received_date, present: true })
    out.push(condition("earnest_money", status,
      signals.titleEscrow.earnest_money_received_date
        ? `Received ${fmtChainDate(signals.titleEscrow.earnest_money_received_date)}`
        : "Not yet received"))
  } else {
    out.push(condition("earnest_money", "unknown", "No title/escrow on file"))
  }

  // Closing / wire scheduled (the closing_scheduled_date proxy used across the codebase).
  if (signals.titleEscrow) {
    const status = conditionStatus({ date: signals.titleEscrow.closing_scheduled_date, present: true })
    out.push(condition("wire_closing_scheduled", status,
      signals.titleEscrow.closing_scheduled_date
        ? `Scheduled ${fmtChainDate(signals.titleEscrow.closing_scheduled_date)}`
        : "Closing time / wire not finalized"))
  } else {
    out.push(condition("wire_closing_scheduled", "unknown", "No title/escrow on file"))
  }

  // Signatures: done when at least one contract_signatures row is fully_signed and NONE are
  // still pending. Honest: no signature rows at all → unknown.
  if (signals.signatures.length > 0) {
    const anyFullySigned = signals.signatures.some((s) => SIGNATURE_DONE_STATUSES.includes((s.esign_status ?? "") as any))
    const allFullySigned = signals.signatures.every((s) => SIGNATURE_DONE_STATUSES.includes((s.esign_status ?? "") as any))
    const status: ConditionStatus = allFullySigned ? "done" : "open"
    out.push(condition("signatures", status,
      allFullySigned
        ? "All signatures complete"
        : `${signals.signatures.filter((s) => SIGNATURE_DONE_STATUSES.includes((s.esign_status ?? "") as any)).length}/${signals.signatures.length} fully signed`))
    void anyFullySigned
  } else {
    out.push(condition("signatures", "unknown", "No signature records on file"))
  }

  // Required documents: done when the audit has a checklist and nothing required is missing.
  if (signals.docAudit && signals.docAudit.required_total > 0) {
    const missing = signals.docAudit.missing_blocking.length + signals.docAudit.missing_warning.length
    const status: ConditionStatus = missing === 0 ? "done" : "open"
    out.push(condition("required_docs", status,
      missing === 0
        ? `All ${signals.docAudit.required_total} required docs on file`
        : `${missing} of ${signals.docAudit.required_total} required docs missing`))
  } else {
    // No checklist configured for this brokerage → we cannot assert docs are complete.
    out.push(condition("required_docs", "unknown", "No required-document checklist configured"))
  }

  return out
}

function condition(key: WarRoomConditionKey, status: ConditionStatus, detail: string): WarRoomCondition {
  const required = true
  return {
    key,
    label:    CONDITION_LABELS[key],
    status,
    required,
    blocking: required && status !== "done",
    owner:    CONDITION_OWNER[key],
    detail,
  }
}

function chainDetail(rows: WarRoomSignals["milestones"], names: string[], status: ConditionStatus): string {
  const row = rows.find((r) => names.includes(r.milestone_name))
  if (status === "done") return row?.target_date ? `Completed (was due ${fmtChainDate(row.target_date)})` : "Completed"
  if (status === "open") return row?.target_date ? `Due ${fmtChainDate(row.target_date)}` : "Pending"
  return "No milestone on file"
}

// ─── The cockpit ─────────────────────────────────────────────────────────────

export interface ClosingWarRoom {
  transactionId:  string
  brokerageId:    string
  dealName:       string
  propertyAddress: string | null
  closingDate:    string | null
  daysToClose:    number | null
  inWindow:       boolean
  /** REUSED watchtower critical path (null when no closing date). */
  criticalPath:   CriticalPath | null
  conditions:     WarRoomCondition[]
  readiness:      ClosingReadiness
  openItems:      OpenItem[]
}

// ─── Live loader ─────────────────────────────────────────────────────────────

const WAR_ROOM_STATUSES = ["active", "under_contract", "closing", "pending"]

/**
 * Assemble the war room for a single under-contract deal. READ-ONLY. Every read is a
 * real column on the live schema; nothing is written, no engine re-run. A deal with no
 * closing date returns a war room with inWindow=false + a null critical path (honest skip
 * at the surface), never fabricated dates.
 */
export async function loadClosingWarRoom(
  transactionId: string,
  opts: {
    now?: Date
    windowDays?: number
    /** Optional pre-computed document-audit verdict (the runner may pass it; the war room
     *  never re-runs the audit engine). Absent → the required_docs condition is 'unknown'. */
    docAudit?: WarRoomSignals["docAudit"]
  } = {},
  client?: Svc,
): Promise<ClosingWarRoom | null> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = opts.now ?? new Date()
  const windowDays = opts.windowDays ?? DEFAULT_CLOSING_WINDOW_DAYS

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, deal_name, property_address, status, deleted_at, close_date, deal_type")
    .eq("id", transactionId)
    .maybeSingle()
  if (!txn || (txn as any).deleted_at) return null

  const brokerageId = (txn as any).brokerage_id as string

  // Pull every real signal in parallel.
  const [milestonesRes, lenderRes, titleRes, sigRes, tasksRes, pendingRes] = await Promise.all([
    supabase.from("transaction_milestones")
      .select("milestone_name, target_date, status")
      .eq("transaction_id", transactionId).eq("brokerage_id", brokerageId),
    supabase.from("transaction_lenders")
      .select("clear_to_close_date, underwriting_status")
      .eq("transaction_id", transactionId).maybeSingle(),
    supabase.from("transaction_title_escrow")
      .select("earnest_money_received_date, closing_scheduled_date")
      .eq("transaction_id", transactionId).maybeSingle(),
    supabase.from("contract_signatures")
      .select("esign_status")
      .eq("brokerage_id", brokerageId),
    supabase.from("transaction_tasks")
      .select("id, title, status, priority, due_date, assigned_to")
      .eq("transaction_id", transactionId).in("status", ["pending", "in_progress"]),
    supabase.from("transaction_pending_actions")
      .select("id, headline, severity, due_date, suggested_recipient, status")
      .eq("transaction_id", transactionId).eq("status", "open"),
  ])

  const milestones = (milestonesRes.data ?? []) as WarRoomSignals["milestones"]
  const chain = buildDateChain(milestones)
  const criticalPath = computeCriticalPath(chain, now)

  const signals: WarRoomSignals = {
    milestones,
    lender:      (lenderRes.data as any) ?? null,
    titleEscrow: (titleRes.data as any) ?? null,
    signatures:  (sigRes.data ?? []) as any,
    docAudit:    opts.docAudit ?? null,
  }

  const conditions = buildConditions(signals, chain)
  const readiness = closingReadiness(conditions)
  const openItems = assembleOpenItems({
    conditions,
    tasks:          (tasksRes.data ?? []) as any,
    pendingActions: (pendingRes.data ?? []) as any,
  })

  const closingDate = criticalPath?.closingDate ?? ((txn as any).close_date ?? null)

  return {
    transactionId,
    brokerageId,
    dealName:        (txn as any).deal_name ?? (txn as any).property_address ?? "Untitled deal",
    propertyAddress: (txn as any).property_address ?? null,
    closingDate,
    daysToClose:     daysToClose(closingDate, now),
    inWindow:        inClosingWindow(closingDate, now, windowDays),
    criticalPath,
    conditions,
    readiness,
    openItems,
  }
}

export interface BrokerageWarRoomResult {
  warRooms: ClosingWarRoom[]
  scanned:  number
}

/**
 * Load the war room for EVERY deal in the brokerage's closing window (closing_date within
 * windowDays). Read-only fan-out over loadClosingWarRoom — the dashboard "all closings"
 * surface. Deals with no closing date are excluded (no honest cockpit to show).
 */
export async function loadBrokerageClosingWarRooms(
  brokerageId: string,
  opts: { now?: Date; windowDays?: number; limit?: number } = {},
  client?: Svc,
): Promise<BrokerageWarRoomResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = opts.now ?? new Date()
  const windowDays = opts.windowDays ?? DEFAULT_CLOSING_WINDOW_DAYS
  const horizon = new Date(now.getTime() + windowDays * 86_400_000).toISOString().slice(0, 10)
  const floor = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10)

  const { data: txns } = await supabase
    .from("transactions")
    .select("id, status, deleted_at, close_date")
    .eq("brokerage_id", brokerageId)
    .in("status", WAR_ROOM_STATUSES)
    .not("close_date", "is", null)
    .gte("close_date", floor)
    .lte("close_date", horizon)
    .order("close_date", { ascending: true })
    .limit(opts.limit ?? 50)

  const live = (txns ?? []).filter((t: any) => !t.deleted_at)
  const warRooms: ClosingWarRoom[] = []
  for (const t of live as any[]) {
    const wr = await loadClosingWarRoom(t.id, { now, windowDays }, supabase)
    if (wr) warRooms.push(wr)
  }
  return { warRooms, scanned: live.length }
}
