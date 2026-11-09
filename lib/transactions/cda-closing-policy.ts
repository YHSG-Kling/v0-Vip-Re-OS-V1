// lib/transactions/cda-closing-policy.ts — THE CLOSING-MONEY POLICY, PURE (wave 142, lane 142C).
//
// Owner rulings this module holds as code (2026-10-18):
//   · CDA (owner): "available ONLY when brokerage settings say the brokerage uses CDA
//     (brokerages.offers_cda, cda_onboarding_at, non_cda_payout_default exist live)". Disabled → no
//     mandatory CDA, no auto-generation, NOTHING BLOCKS CLOSING; the brokerage-received-commission +
//     agent payout flow applies.
//   · PRELIMINARY HUD / CD: "the TITLE COMPANY supplies it … attach to the transaction with versioning
//     … discrepancies → documented correction request → revised official statement → version retained →
//     waterfall reconciled → broker reviews. AI may identify/explain discrepancies, never fabricate
//     values; never alter the title company's document." — and the broker cannot approve a CDA on
//     unresolved inaccurate figures.
//   · DEADLINE: "signed approved CDA reaches title before/at scheduled closing (tenant timezone;
//     earlier brokerage/title requirements win) — reminders + immediate escalation".
//   · DELIVERY: "title on the Deal Team → authorized title portal inbox with evidence; title outside →
//     existing configured outbound email … with tracked status; never duplicate delivery on retry."
//   · FILL: "the AGENT fills the CDA MANUALLY from the approved CDA form in platform Media; AI MUST NOT
//     FILL THE CDA (it may explain waterfall figures when asked)."
//
// SURVIVORS this sits beside (none replaced): lib/transactions/cda-signing-policy.ts (who may approve /
// broker-sign / send), cda-delivery-policy.ts (approved-but-unsent escalation), cda-template-fields.ts
// (the agent-filled form — money never pre-filled), lib/commission/cda-discrepancy.ts (contract vs CDA).
// This file is the PURE half the server actions (app/actions/cda-portal.ts), the deadline reaper
// (lib/transactions/cda-delivery-reaper.ts) and the proof (scripts/cda-closing-flow-guard.ts) share.
// No I/O, no model: every function here is deterministic over the inputs it is handed.

import { timeZoneForState } from "@/lib/fatigue/after-hours"

// ─── 1. CDA MODE — the brokerage setting is the ONE switch ──────────────────────────────────────

/** THE FILL RULE, as data the proof and the UI copy read: the agent types the money; AI only explains. */
export const CDA_FILL_RULE = { agentFills: true, aiFills: false, aiMayExplainFigures: true } as const

export interface CdaModeVerdict {
  mode: "cda" | "no_cda"
  /** A CDA is part of this brokerage's closing (offers_cda = true). */
  cdaRequired: boolean
  /** Never true: a missing CDA never blocks a closing — the no-CDA brokerage pays out after receipt. */
  blocksClosing: false
  /** The no-CDA payout default (brokerages.non_cda_payout_default); null in CDA mode. */
  payoutMethodDefault: "direct_deposit" | "check" | null
  reason: "offers_cda" | "no_cda_declared" | "cda_not_declared"
}

/**
 * PURE — does this brokerage use a CDA? `offers_cda` TRUE → CDA mode. FALSE → the no-CDA flow.
 * NULL (never answered at onboarding) → the no-CDA flow with reason `cda_not_declared`: the owner's
 * rule is "CDA exists ONLY when brokerage settings say so", so an undeclared setting never manufactures
 * a mandatory CDA. (At HEAD the CDA page defaulted `?? true` while finalizeCommissionAtClose defaulted
 * `?? false` — two answers to one question; this is the one answer both now read.)
 */
export function resolveCdaMode(input: { offersCda: boolean | null | undefined; nonCdaPayoutDefault?: string | null }): CdaModeVerdict {
  if (input.offersCda === true) {
    return { mode: "cda", cdaRequired: true, blocksClosing: false, payoutMethodDefault: null, reason: "offers_cda" }
  }
  const def = input.nonCdaPayoutDefault === "check" ? "check" : "direct_deposit"
  return {
    mode: "no_cda",
    cdaRequired: false,
    blocksClosing: false,
    payoutMethodDefault: def,
    reason: input.offersCda === false ? "no_cda_declared" : "cda_not_declared",
  }
}

// ─── 1b. THE PAYOUT GATE — a brokerage SETTING (wave 144, lane 144D; owner ruling 8) ─────────────────
//
// Owner (2026-10-25): "Payout gate is a brokerage SETTING: either pay out at closing (CDA authorizes the permitted
// closing-time distribution) or pay out when the brokerage receives the final commission and then pays the agent/team.
// Approval, payout initiation and verified receipt are separate states … no fabricated paid status."
// The setting is brokerages.commission_payout_timing (m850), beside offers_cda — the brokerage's other closing-money switch.
// UNDECLARED (NULL / pre-m850) IS "AFTER RECEIPT": the funds-received gate (lib/commission/ledger-sync.ts payoutFundsGate) is
// the fail-closed default, and a closing-time release is never inferred from offers_cda alone (a CDA brokerage may still
// have title pay the brokerage the whole commission). AT CLOSING needs a CDA brokerage: without offers_cda the setting is
// reported and the receipt gate applies.

export const COMMISSION_PAYOUT_TIMINGS = ["at_closing_per_cda", "after_brokerage_receipt"] as const
export type CommissionPayoutTiming = (typeof COMMISSION_PAYOUT_TIMINGS)[number]

export const COMMISSION_PAYOUT_TIMING_LABEL: Record<CommissionPayoutTiming, string> = {
  at_closing_per_cda: "At closing — title disburses the agent's share as the broker-signed CDA authorizes",
  after_brokerage_receipt: "After the brokerage receives the commission — then the brokerage pays the agent / team",
}

export interface PayoutTimingVerdict {
  timing: CommissionPayoutTiming
  declared: boolean
  finding: string | null
}

/** PURE — which payout gate this brokerage runs. */
export function resolvePayoutTiming(input: { offersCda: boolean | null | undefined; payoutTiming: unknown }): PayoutTimingVerdict {
  if (input.payoutTiming === "at_closing_per_cda") {
    if (input.offersCda === true) return { timing: "at_closing_per_cda", declared: true, finding: null }
    return {
      timing: "after_brokerage_receipt",
      declared: true,
      finding: "the brokerage chose closing-time payout but does not use a CDA (offers_cda is not true) — nothing authorizes a closing-time distribution, so the brokerage-receipt gate applies",
    }
  }
  if (input.payoutTiming === "after_brokerage_receipt") return { timing: "after_brokerage_receipt", declared: true, finding: null }
  return { timing: "after_brokerage_receipt", declared: false, finding: null }
}

// ─── 2. THE PRELIMINARY STATEMENT (HUD / ALTA / CD) — versions, comparison, review state ──────────

/**
 * The two doc_type spellings the live rows carry for the title company's preliminary statement:
 * app/actions/cda-portal.ts writes `preliminary_closing_disclosure`; the title portal
 * (app/portal/title/[transactionId]/document-upload.tsx "Preliminary HUD/ALTA") writes
 * `settlement_statement`. One artifact, two spellings (CLAUDE.md §6) — read as ONE family here;
 * the DB value is not renamed this wave (no column/data rename — reported in the lane notes).
 */
export const PRELIMINARY_STATEMENT_DOC_TYPES = ["preliminary_closing_disclosure", "settlement_statement"] as const

function isPreliminaryStatementDocType(docType: string | null | undefined): boolean {
  return !!docType && (PRELIMINARY_STATEMENT_DOC_TYPES as readonly string[]).includes(docType)
}

/** PURE — the version number the NEXT statement upload takes: one more than the statements on file. */
export function nextPreliminaryStatementVersion(existing: ReadonlyArray<{ doc_type?: string | null }>): number {
  return existing.filter((d) => isPreliminaryStatementDocType(d.doc_type)).length + 1
}

/** The figures a statement and the waterfall can both state. Null/undefined = not stated. */
export interface StatementFigures {
  sales_price?: number | null
  gross_commission?: number | null
  agent_net?: number | null
  brokerage_net?: number | null
  seller_credits?: number | null
  closing_costs?: number | null
}

const COMPARABLE_FIELDS = ["sales_price", "gross_commission", "agent_net", "brokerage_net", "seller_credits", "closing_costs"] as const
type ComparableField = (typeof COMPARABLE_FIELDS)[number]

export interface PreliminaryDiscrepancy {
  field: ComparableField
  statement: number
  expected: number
  /** statement − expected, in dollars. */
  delta: number
  deltaPct: number
  severity: "warning" | "blocker"
}

/**
 * PURE — IDENTIFY discrepancies between the title company's statement and the executed contract +
 * waterfall. Compares ONLY the fields both sides state; a figure either side lacks is listed as
 * `unverifiable`, never fabricated as $0. Thresholds mirror lib/commission/cda-discrepancy.ts
 * (≥ $50 and ≥ 1% is a discrepancy; ≥ 5% is a blocker).
 */
export function comparePreliminaryStatementFigures(
  statement: StatementFigures,
  expected: StatementFigures,
  opts?: { minDollar?: number; tolerancePct?: number; blockerPct?: number },
): { discrepancies: PreliminaryDiscrepancy[]; compared: ComparableField[]; unverifiable: ComparableField[] } {
  const minDollar = opts?.minDollar ?? 50
  const tolerancePct = opts?.tolerancePct ?? 1
  const blockerPct = opts?.blockerPct ?? 5
  const discrepancies: PreliminaryDiscrepancy[] = []
  const compared: ComparableField[] = []
  const unverifiable: ComparableField[] = []
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
  for (const field of COMPARABLE_FIELDS) {
    const s = statement?.[field]
    const e = expected?.[field]
    if (!finite(s) || !finite(e)) { unverifiable.push(field); continue }
    compared.push(field)
    const diff = Math.abs(s - e)
    if (diff < minDollar) continue
    const deltaPct = e === 0 ? 100 : Math.round((diff / Math.abs(e)) * 1000) / 10
    if (deltaPct < tolerancePct) continue
    discrepancies.push({ field, statement: Math.round(s), expected: Math.round(e), delta: Math.round(s - e), deltaPct, severity: deltaPct >= blockerPct ? "blocker" : "warning" })
  }
  return { discrepancies, compared, unverifiable }
}

/** PURE — a plain-language line per discrepancy (what to say to title). Numbers only; nothing invented. */
export function describePreliminaryDiscrepancies(items: ReadonlyArray<PreliminaryDiscrepancy>): string[] {
  const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US")}`
  return items.map((d) =>
    `${d.field.replace(/_/g, " ")}: the statement shows ${money(d.statement)}; the executed contract / waterfall expects ${money(d.expected)} (${d.delta >= 0 ? "+" : "−"}${money(d.delta)}, ${d.deltaPct}%${d.severity === "blocker" ? " — must be corrected before approval" : ""}).`,
  )
}

export type PreliminaryReviewStatus = "pending_review" | "correction_requested" | "reviewed"

/** The review state the CDA row carries in field_values.preliminary_statement (one spelling). */
export interface PreliminaryStatementReview {
  status: PreliminaryReviewStatus
  /** The statement version under review (1 = the first upload). */
  version: number
  document_id: string | null
  received_at: string | null
  /** The discrepancies documented at the last correction request (empty when none). */
  items: PreliminaryDiscrepancy[]
  requested_at: string | null
  requested_by: string | null
  /** How the correction request reached title (recorded, never assumed). */
  delivery: { route: "portal" | "email" | "none"; recipient: string | null; message_id: string | null; at: string } | null
  reviewed_at: string | null
  reviewed_by: string | null
  note: string | null
  /** Every prior version's terminal state, oldest first — a corrected statement never erases its history. */
  history: Array<{ version: number; document_id: string | null; status: PreliminaryReviewStatus; at: string }>
}

/** PURE — a (revised) statement arrived: a new version opens for review; the prior version is retained in history. */
export function reviewOnNewStatementVersion(
  prior: PreliminaryStatementReview | null | undefined,
  next: { version: number; documentId: string | null; at: string },
): PreliminaryStatementReview {
  const history = [...(prior?.history ?? [])]
  if (prior && prior.version !== next.version) {
    history.push({ version: prior.version, document_id: prior.document_id, status: prior.status, at: next.at })
  }
  return {
    status: "pending_review",
    version: next.version,
    document_id: next.documentId,
    received_at: next.at,
    items: [],
    requested_at: null,
    requested_by: null,
    delivery: null,
    reviewed_at: null,
    reviewed_by: null,
    note: null,
    history,
  }
}

/** PURE — the agent / TC documented discrepancies and asked title for a corrected statement. */
export function reviewOnCorrectionRequested(
  prior: PreliminaryStatementReview,
  req: { items: PreliminaryDiscrepancy[]; by: string; at: string; delivery: PreliminaryStatementReview["delivery"]; note?: string | null },
): PreliminaryStatementReview {
  return { ...prior, status: "correction_requested", items: req.items, requested_at: req.at, requested_by: req.by, delivery: req.delivery, note: req.note ?? prior.note }
}

/** PURE — the figures were reconciled against the executed contract + waterfall; the version is reviewed. */
export function reviewOnConfirmed(prior: PreliminaryStatementReview, by: string, at: string, note?: string | null): PreliminaryStatementReview {
  return { ...prior, status: "reviewed", reviewed_at: at, reviewed_by: by, note: note ?? prior.note }
}

/** PURE — THE APPROVAL GATE on the figures: a correction is outstanding → the broker cannot approve. */
export function cdaFigureGate(review: PreliminaryStatementReview | null | undefined): { ok: boolean; error?: "preliminary_statement_correction_pending" } {
  if (review && review.status === "correction_requested") return { ok: false, error: "preliminary_statement_correction_pending" }
  return { ok: true }
}

/** PURE — read the review object off a CDA's field_values (any shape; absent → null). */
export function preliminaryReviewOf(fieldValues: Record<string, unknown> | null | undefined): PreliminaryStatementReview | null {
  const v = fieldValues?.preliminary_statement
  if (!v || typeof v !== "object") return null
  const r = v as Partial<PreliminaryStatementReview>
  if (r.status !== "pending_review" && r.status !== "correction_requested" && r.status !== "reviewed") return null
  return {
    status: r.status,
    version: typeof r.version === "number" ? r.version : 1,
    document_id: r.document_id ?? null,
    received_at: r.received_at ?? null,
    items: Array.isArray(r.items) ? (r.items as PreliminaryDiscrepancy[]) : [],
    requested_at: r.requested_at ?? null,
    requested_by: r.requested_by ?? null,
    delivery: r.delivery ?? null,
    reviewed_at: r.reviewed_at ?? null,
    reviewed_by: r.reviewed_by ?? null,
    note: r.note ?? null,
    history: Array.isArray(r.history) ? (r.history as PreliminaryStatementReview["history"]) : [],
  }
}

// ─── 3. THE DEADLINE — signed approved CDA at title before/at the scheduled closing (tenant zone) ──

/** Reminders fire at these hours-before-deadline; escalation at CDA_DEADLINE_ESCALATE_HOURS or less. */
export const CDA_DEADLINE_REMINDER_HOURS = [48, 24] as const
export const CDA_DEADLINE_ESCALATE_HOURS = 12
/** A date-only closing date means "at the closing table" — the deadline is this local hour that day. */
export const CLOSING_DAY_DEADLINE_LOCAL_HOUR = 9
export const TIME_ZONE_FALLBACK = "UTC"

/**
 * PURE — the tenant's zone. brokerages carries no timezone column at HEAD (measured:
 * scripts/schema-snapshot.ts — timezone lives on calendar_events / contacts / global_settings /
 * open_house_events only), so the zone derives from the brokerage's STATE through the one existing
 * state→zone table (lib/fatigue/after-hours.ts timeZoneForState); unknown → UTC, SAID in `source`.
 */
export function resolveTenantTimeZone(input: { state?: string | null; explicitZone?: string | null }): { zone: string; source: "explicit" | "brokerage_state" | "fallback" } {
  if (input.explicitZone && isUsableZone(input.explicitZone)) return { zone: input.explicitZone, source: "explicit" }
  const byState = timeZoneForState(input.state)
  if (byState) return { zone: byState, source: "brokerage_state" }
  return { zone: TIME_ZONE_FALLBACK, source: "fallback" }
}

function isUsableZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true } catch { return false }
}

function localPartsAt(instantMs: number, zone: string): { y: number; m: number; d: number; h: number; min: number } | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    const parts: Record<string, string> = {}
    for (const p of f.formatToParts(new Date(instantMs))) parts[p.type] = p.value
    const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day), h = Number(parts.hour), min = Number(parts.minute)
    if (![y, m, d, h, min].every(Number.isFinite)) return null
    return { y, m, d, h: h === 24 ? 0 : h, min }
  } catch {
    return null
  }
}

/** The UTC instant at which the wall clock in `zone` reads y-m-d h:00 (two passes absorb a DST edge). */
function zonedInstant(y: number, m: number, d: number, h: number, zone: string): number | null {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0)
  const lp = localPartsAt(guess, zone)
  if (!lp) return null
  const offset = Date.UTC(lp.y, lp.m - 1, lp.d, lp.h, lp.min) - guess
  let result = guess - offset
  const lp2 = localPartsAt(result, zone)
  if (lp2) {
    const offset2 = Date.UTC(lp2.y, lp2.m - 1, lp2.d, lp2.h, lp2.min) - result
    if (offset2 !== offset) result = guess - offset2
  }
  return result
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * PURE — WHEN the signed approved CDA must be at title. The title company's scheduled closing wins,
 * then the transaction's close date, then its estimate. A DATE-ONLY value is read as the closing day
 * at CLOSING_DAY_DEADLINE_LOCAL_HOUR in the tenant's zone (the table opens in the morning; a CDA that
 * arrives that afternoon is late); a full timestamp is taken as given. An EARLIER brokerage / title
 * requirement (hours before closing) wins by subtraction. No source → no deadline, said.
 *
 * AN EARLIER ANTICIPATED CLOSING (wave 149, lane 149G — owner ruling 17 / C33): under "on or before" the deal may close
 * BEFORE the contract's date, and a proposed earlier day moves only `estimated_close_date` (lib/transactions/closing-dates.ts
 * — the contract's `close_date` is never overwritten by a proposal). Without a title appointment, the EARLIER of the two
 * therefore governs — the CDA must be at the table for the day the deal may actually close; a LATER estimate never pushes
 * the deadline past the contract's day (that needs an executed extension, which moves close_date itself).
 */
export function resolveClosingDeadline(input: {
  closingScheduledDate?: string | null
  closeDate?: string | null
  estimatedCloseDate?: string | null
  timeZone: string
  earlierCutoffHours?: number | null
}): { dueAt: string | null; basis: "closing_scheduled_date" | "close_date" | "estimated_close_date" | "none"; dateOnly: boolean } {
  const read = (raw: string | null | undefined): { ms: number; dateOnly: boolean } | null => {
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) return null
    if (DATE_ONLY_RE.test(value)) {
      const [y, m, d] = value.split("-").map(Number)
      const ms = zonedInstant(y, m, d, CLOSING_DAY_DEADLINE_LOCAL_HOUR, input.timeZone)
      return ms == null ? null : { ms, dateOnly: true }
    }
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : { ms: parsed, dateOnly: false }
  }
  const cutoff = typeof input.earlierCutoffHours === "number" && Number.isFinite(input.earlierCutoffHours) && input.earlierCutoffHours > 0 ? input.earlierCutoffHours : 0
  const out = (basis: "closing_scheduled_date" | "close_date" | "estimated_close_date", v: { ms: number; dateOnly: boolean }) =>
    ({ dueAt: new Date(v.ms - cutoff * 3_600_000).toISOString(), basis, dateOnly: v.dateOnly })
  const scheduled = read(input.closingScheduledDate)
  if (scheduled) return out("closing_scheduled_date", scheduled)
  const close = read(input.closeDate), estimate = read(input.estimatedCloseDate)
  if (close && estimate && estimate.ms < close.ms) return out("estimated_close_date", estimate)
  if (close) return out("close_date", close)
  if (estimate) return out("estimated_close_date", estimate)
  return { dueAt: null, basis: "none", dateOnly: false }
}

export type CdaDeadlineState = "not_applicable" | "delivered" | "no_deadline" | "ok" | "reminder_48h" | "reminder_24h" | "escalate" | "overdue"

/** The notification type each actionable state writes (idempotent per CDA + type); null = nothing to send. */
export const CDA_DEADLINE_NOTIFICATION: Record<CdaDeadlineState, string | null> = {
  not_applicable: null,
  delivered: null,
  no_deadline: null,
  ok: null,
  reminder_48h: "cda_deadline_48h",
  reminder_24h: "cda_deadline_24h",
  escalate: "cda_deadline_escalated",
  overdue: "cda_deadline_overdue",
}

/** PURE — where an open CDA stands against its deadline. */
export function cdaDeadlineVerdict(input: {
  dueAt: string | null
  now: Date
  sentToTitleAt?: string | null
  status?: string | null
  usesCda?: boolean | null
}): { state: CdaDeadlineState; hoursRemaining: number | null; escalates: boolean } {
  const status = (input.status ?? "").toLowerCase()
  if (input.usesCda === false || status === "cancelled" || status === "rejected") return { state: "not_applicable", hoursRemaining: null, escalates: false }
  if (input.sentToTitleAt) return { state: "delivered", hoursRemaining: null, escalates: false }
  if (!input.dueAt) return { state: "no_deadline", hoursRemaining: null, escalates: false }
  const due = Date.parse(input.dueAt)
  if (Number.isNaN(due)) return { state: "no_deadline", hoursRemaining: null, escalates: false }
  const hours = Math.round(((due - input.now.getTime()) / 3_600_000) * 10) / 10
  if (hours < 0) return { state: "overdue", hoursRemaining: hours, escalates: true }
  if (hours <= CDA_DEADLINE_ESCALATE_HOURS) return { state: "escalate", hoursRemaining: hours, escalates: true }
  if (hours <= CDA_DEADLINE_REMINDER_HOURS[1]) return { state: "reminder_24h", hoursRemaining: hours, escalates: false }
  if (hours <= CDA_DEADLINE_REMINDER_HOURS[0]) return { state: "reminder_48h", hoursRemaining: hours, escalates: false }
  return { state: "ok", hoursRemaining: hours, escalates: false }
}

// ─── 4. DELIVERY — the portal inbox when title is on the deal team, else the configured email ──────

/**
 * PURE — how the signed CDA (or a correction request) reaches title. "Title on the Deal Team" is a
 * title_company_users row for THIS transaction with a users account (the title portal's identity —
 * lib/kernel/portal-auth.ts requireTitleActor; deal_team_members holds no title rows at HEAD, see the
 * tombstone in lib/transactions/role-guard.ts). Outside → the verified title email through the existing
 * outbound email integration. A requested route the facts cannot honour is refused by name.
 */
export function cdaDeliveryRoute(input: {
  titlePortalUserId?: string | null
  titleEmail?: string | null
  requested?: "portal" | "email" | null
}): { route: "portal" | "email" | "none"; reason: string } {
  const hasPortal = !!input.titlePortalUserId
  const email = (input.titleEmail ?? "").trim()
  const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  if (input.requested === "portal") return hasPortal ? { route: "portal", reason: "title_on_deal_team" } : { route: "none", reason: "title_not_on_deal_team" }
  if (input.requested === "email") return hasEmail ? { route: "email", reason: "verified_title_email" } : { route: "none", reason: "title_email_missing_or_invalid" }
  if (hasPortal) return { route: "portal", reason: "title_on_deal_team" }
  if (hasEmail) return { route: "email", reason: "verified_title_email" }
  return { route: "none", reason: "no_title_recipient" }
}

/** PURE — a delivery already recorded is never repeated on retry; an explicit re-send needs a reason. */
export function deliveryIdempotency(input: {
  sentToTitleAt?: string | null
  sentRecipient?: string | null
  recipient: string
  resend?: boolean
  resendReason?: string | null
}): { ok: boolean; error?: "already_delivered"; resend: boolean } {
  if (!input.sentToTitleAt) return { ok: true, resend: false }
  if (input.resend === true && (input.resendReason ?? "").trim().length >= 5) return { ok: true, resend: true }
  return { ok: false, error: "already_delivered", resend: false }
}

// ─── 5. CLOSING WITHOUT A CDA — THE SMALLEST HONEST CLOSING PROOF (wave 151, lane 151K) ──────────────────────────────────────
//
// Owner (wave 151, binding): "L6 finish — if the brokerage doesn't use CDAs (their settings), then it can close without a CDA."
// Directive: "the smallest honest closing proof: final settlement/closing record plus authorized brokerage receipt/attestation and
// transaction compliance status, with the actual source actor and payment evidence. Do not force artificial CDA, pre-fill an agent
// form via AI, bypass approved disbursement or assert funds received solely because a Closing date exists. Keep CLOSED / PAYOUT
// PENDING and existing once-only payment holds intact."
//
// This is a READING of evidence that already exists on the survivors — it writes nothing and gates nothing:
//   · the final settlement / closing record: the title company's final statement on the document kernel
//     (closing_disclosure_agreement.final_cd_document_id / documents classified closing_disclosure — the same documents
//     lib/transactions/closing-compliance.ts loadSettlement compares) with who uploaded it;
//   · the authorized brokerage receipt: agent_commissions.deposit_received_at / deposit_received_by (lib/commission/
//     reconcile-tracking.ts recordCommissionDepositReceived — a finance admin's act) and the payment states the ledger derives
//     (lib/commission/ledger-sync.ts deriveCommissionPaymentState); NEVER status 'closed' or a closing date;
//   · the transaction compliance status: compliance_passed_at + the open blocking compliance rows;
//   · the payout holds as they stand: the funds-received gate (payoutFundsGate) and the lifetime hold (CLOSED / PAYOUT PENDING).
// `fundsReceived` is derived from the receipt evidence ALONE: a closed deal with a closing date and no recorded receipt reads
// "not received". A CDA row the no-CDA path created for the payout PREFERENCE (uses_cda false) is not a CDA and is never required.

export const NO_CDA_CLOSING_PROOF_RULE = {
  /** A CDA is never an unconditional closing requirement (resolveCdaMode.blocksClosing is `false` in both modes). */
  cdaNeverRequiredToClose: true,
  /** Funds are received when, and only when, a person recorded the brokerage's receipt — never because a closing date exists. */
  fundsReceivedOnlyFromReceiptEvidence: true,
  /** Nothing here fills a CDA, creates one, or releases a payout; the holds (payoutFundsGate, CLOSED / PAYOUT PENDING) stand. */
  writesNothing: true,
} as const

export interface NoCdaClosingProofInput {
  cdaMode: CdaModeVerdict
  transaction: { status: string | null | undefined; close_date?: string | null; actual_close_date?: string | null; compliance_passed_at?: string | null }
  /** The title company's final settlement / closing record on file, with the actor who put it there (null = none yet). */
  finalSettlement: { documentId: string; uploadedAt: string | null; uploadedBy: string | null; uploadedByType: string | null } | null
  /** The brokerage's receipt of the commission, as the ledger recorded it (one row per agent commission on the deal). */
  commissions: Array<{ id: string; status: string | null; deposit_received_at?: string | null; deposit_received_by?: string | null; paid_at?: string | null; payment_received_at?: string | null; reconciled_at?: string | null; payment_initiated_at?: string | null }>
  /** Open BLOCKING compliance rows (fail / pending / needs_review) on the deal. */
  openBlockingCompliance: number
  /** The lifetime hold activity ("CLOSED / PAYOUT PENDING") is open on the deal. */
  lifetimeHoldOpen: boolean
}

export interface NoCdaClosingProof {
  mode: "cda" | "no_cda"
  /** Never true: the proof is informational; it never blocks a close (the owner's ruling). */
  blocksClosing: false
  closed: boolean
  settlement: { status: "on_file" | "missing"; documentId: string | null; actor: string | null; at: string | null }
  receipt: { status: "recorded" | "not_recorded" | "no_commission_row"; by: string | null; at: string | null; basis: string }
  /** Derived from the receipt evidence ALONE (NO_CDA_CLOSING_PROOF_RULE). */
  fundsReceived: boolean
  compliance: { status: "passed" | "open_blocking" | "not_passed"; passedAt: string | null; openBlocking: number }
  payout: { state: "no_commission_row" | "held_funds_not_received" | "releasable_after_receipt" | "initiated" | "recorded" | "received" | "reconciled"; lifetimeHold: "open" | "none"; detail: string }
  /** What the proof still lacks, in words a TC or finance admin acts on. Empty = the smallest honest proof is complete. */
  missing: string[]
}

/** PURE — the no-CDA closing proof over the evidence that exists. In CDA mode it says so and reads the same facts (nothing is forced). */
export function noCdaClosingProof(input: NoCdaClosingProofInput): NoCdaClosingProof {
  const status = String(input.transaction.status ?? "").toLowerCase()
  const closed = status === "closed" || status === "funded"
  const missing: string[] = []
  const settlement: NoCdaClosingProof["settlement"] = input.finalSettlement
    ? { status: "on_file", documentId: input.finalSettlement.documentId, actor: input.finalSettlement.uploadedBy ? `${input.finalSettlement.uploadedByType ?? "user"}:${input.finalSettlement.uploadedBy}` : null, at: input.finalSettlement.uploadedAt }
    : { status: "missing", documentId: null, actor: null, at: null }
  if (settlement.status === "missing") missing.push("the title company's final settlement / closing record is not on file")

  const rows = input.commissions
  let receipt: NoCdaClosingProof["receipt"]
  if (rows.length === 0) receipt = { status: "no_commission_row", by: null, at: null, basis: "no agent commission is on the ledger for this deal yet" }
  else {
    const received = rows.filter((r) => !!r.deposit_received_at)
    if (received.length === rows.length) {
      const latest = [...received].sort((a, b) => String(a.deposit_received_at).localeCompare(String(b.deposit_received_at))).pop()!
      receipt = { status: "recorded", by: latest.deposit_received_by ?? null, at: latest.deposit_received_at ?? null, basis: "agent_commissions.deposit_received_at — recorded by a person (recordCommissionDepositReceived)" }
    } else receipt = { status: "not_recorded", by: null, at: null, basis: received.length ? `${received.length} of ${rows.length} commission rows carry a recorded receipt` : "no commission row carries deposit_received_at" }
  }
  const fundsReceived = receipt.status === "recorded"
  if (!fundsReceived) missing.push(receipt.status === "no_commission_row" ? "no commission row to receive against" : "the brokerage's receipt of the commission is not recorded (a finance admin records the deposit — a closing date is not a receipt)")

  const compliance: NoCdaClosingProof["compliance"] = input.openBlockingCompliance > 0
    ? { status: "open_blocking", passedAt: input.transaction.compliance_passed_at ?? null, openBlocking: input.openBlockingCompliance }
    : input.transaction.compliance_passed_at ? { status: "passed", passedAt: input.transaction.compliance_passed_at, openBlocking: 0 } : { status: "not_passed", passedAt: null, openBlocking: 0 }
  if (compliance.status !== "passed") missing.push(compliance.status === "open_blocking" ? `${input.openBlockingCompliance} blocking compliance item(s) are open` : "transaction compliance has not passed")

  let payoutState: NoCdaClosingProof["payout"]["state"] = "no_commission_row"
  if (rows.length > 0) {
    const any = (k: keyof NoCdaClosingProofInput["commissions"][number]) => rows.some((r) => !!r[k])
    if (any("reconciled_at")) payoutState = "reconciled"
    else if (any("payment_received_at")) payoutState = "received"
    else if (rows.some((r) => r.status === "paid" || !!r.paid_at)) payoutState = "recorded"
    else if (any("payment_initiated_at")) payoutState = "initiated"
    else payoutState = fundsReceived ? "releasable_after_receipt" : "held_funds_not_received"
  }
  const payout: NoCdaClosingProof["payout"] = {
    state: payoutState,
    lifetimeHold: input.lifetimeHoldOpen ? "open" : "none",
    detail: payoutState === "held_funds_not_received"
      ? "the funds-received gate holds the payout until the brokerage's receipt is recorded (an advance needs a finance admin's stated reason)"
      : payoutState === "releasable_after_receipt" ? "receipt recorded — the payout may be initiated under the brokerage's approved disbursement" : payoutState === "no_commission_row" ? "nothing to pay out yet" : `payout ${payoutState}`,
  }
  return {
    mode: input.cdaMode.mode, blocksClosing: false, closed, settlement, receipt, fundsReceived, compliance, payout,
    missing: input.cdaMode.mode === "cda" ? ["this brokerage uses a CDA — the CDA workflow is the closing proof; this reading is informational"] : missing,
  }
}
