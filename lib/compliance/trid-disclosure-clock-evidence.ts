// lib/compliance/trid-disclosure-clock-evidence.ts
//
// THE CLOSING DISCLOSURE RECEIPT LEDGER — the I/O half of the TRID clock (wave 153, lane 153C; directive §153C C2).
//
// Owner (verbatim, 2026-11-14): "trid is determined from the lender because the lender sends the final cd to the buyer to sign and
// should mark when trid starts and if lender isn't on the platform, the agent needs to find out from the lender and then mark the
// timeline (a good coaching moment)".
//
// ONE WRITER — recordTridReceiptEvidence — appends a row to public.trid_disclosure_receipts (m905, insert-only). Who may write what
// is decided HERE from the actor's KIND, never from the request:
//   · the deal's ASSIGNED LENDER vendor (on the platform)  → source lender_portal,      lender_confirmed  (starts the clock)
//   · the agent / the deal's TC (lender off the platform)    → source agent/tc_reported, pending_lender_confirmation (starts NOTHING)
//   · compliance / a broker with the lender's WRITTEN confirmation filed as a document, superseding a pending report
//                                                            → source compliance_verified, lender_confirmed
// A draft CD upload writes nothing here and therefore starts nothing; a signature is stored as acknowledgment_signed_at and is
// never read as receipt (lib/compliance/trid-disclosure-clock.ts effectiveReceiptDate).
//
// After every write (and on the daily sweep) syncTridSummary keeps the readers that already exist honest:
//   · trid_timeline.closing_disclosure_delivered_date ← the lender-verified EFFECTIVE RECEIPT of the governing CD, or NULL while a
//     revision is pending / escalated — so the existing close gate (lib/transactions/stage-progression.ts step 10) and the post-hoc
//     monitor read a verified date or none, never a guess;
//   · the seeded blocking compliance row `trid_timing` ("TRID Timing Verified", app/actions/transaction-compliance.ts) ← pass only
//     when the ledger proves it (or the closing is cash), held with the reason otherwise — the existing closing gate
//     (canProceedToClosingPrep) reads it; a person's hand-pass that the ledger contradicts is re-held (no false TRID-ready);
//   · the agent / TC COACHING task when the lender is off the platform, settled exactly when the lender-confirmed receipt lands.
// Every read destructures its error and a refused read FAILS CLOSED (CLAUDE.md §3–§4).

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  assessTridReadiness,
  closingDisclosureDueBy,
  earliestConsummationDate,
  effectiveReceiptDate,
  localReceiptDay,
  TRID_DELIVERY_METHODS,
  TRID_LENDER_COACHING,
  TRID_NEW_WAIT_DETERMINATIONS,
  TRID_RECEIPT_EVIDENCE,
  TRID_RECEIPT_SOURCES,
  TRID_REVISION_CHANGES,
  TRID_SENDER_ROLES,
  TRID_TRANSACTION_REGULARITY,
  TRID_VERIFICATION_STATUSES,
  type TridReadiness,
  type TridReceiptRecord,
} from "./trid-disclosure-clock"

type Svc = SupabaseClient<any, any, any>

/** WHO is writing — resolved by the governed door from the SESSION, never a request field. */
type TridEvidenceActorKind = "lender" | "agent" | "tc" | "compliance"

const RECEIPT_COLS =
  "id, disclosure_version, supersedes_id, issuer_name, sender_role, delivery_method, delivered_at, received_at, receipt_timezone, receipt_evidence, acknowledgment_signed_at, source, verification_status, revision_changes, apr_previous, apr_current, transaction_regularity, lender_new_wait_determination, lender_contact_name, created_at"

/** The coaching task's category on transaction_tasks (no category CHECK — one constant, read by the writer and the settle). */
const COACHING_CATEGORY = "trid_lender_coaching"
const COACHING_TITLE = "Confirm the Closing Disclosure receipt with the lender"
/** The seeded blocking compliance row this ledger settles (app/actions/transaction-compliance.ts TRANSACTION_COMPLIANCE_CHECKS). */
const TRID_TIMING_CHECK = { type: "trid_timing", label: "TRID Timing Verified" } as const

const todayIso = () => new Date().toISOString().slice(0, 10)

/** FNV-1a over a canonical string — a stable idempotency key, no crypto dependency. */
function fnv(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

// ── reading ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface LenderPresence { vendorId: string | null; name: string | null; onPlatform: boolean }

/** The deal's assigned LENDER vendor and whether it holds a platform seat (user_role_assignments.vendor_id). Errors are READ.
 *  Also read by the lender insurance checkpoint (lib/transactions/lender-insurance-checkpoint.ts) — one lender-presence rule. */
export async function lenderPresence(svc: Svc, brokerageId: string, transactionId: string): Promise<{ ok: true; lender: LenderPresence } | { ok: false; error: string }> {
  const { data: assigns, error: aErr } = await svc
    .from("vendor_assignments").select("vendor_id, status")
    .eq("brokerage_id", brokerageId).eq("transaction_id", transactionId)
  if (aErr) return { ok: false, error: `the deal's vendor assignments could not be read: ${aErr.message}` }
  const ids = [...new Set(((assigns ?? []) as Array<{ vendor_id: string | null; status: string | null }>)
    .filter((a) => a.vendor_id && a.status !== "cancelled").map((a) => a.vendor_id as string))]
  if (ids.length === 0) return { ok: true, lender: { vendorId: null, name: null, onPlatform: false } }
  const { data: vendors, error: vErr } = await svc.from("vendors").select("id, name, category, brokerage_id").in("id", ids)
  if (vErr) return { ok: false, error: `the assigned vendors could not be read: ${vErr.message}` }
  const { isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
  const lender = ((vendors ?? []) as Array<{ id: string; name: string | null; category: string | null; brokerage_id: string | null }>)
    .find((v) => isLenderVendorCategory(v.category) && v.brokerage_id === brokerageId)
  if (!lender) return { ok: true, lender: { vendorId: null, name: null, onPlatform: false } }
  const { data: seats, error: sErr } = await svc.from("user_role_assignments").select("user_id").eq("vendor_id", lender.id).limit(1)
  if (sErr) return { ok: false, error: `the lender's platform seats could not be read: ${sErr.message}` }
  return { ok: true, lender: { vendorId: lender.id, name: lender.name ?? null, onPlatform: (seats ?? []).length > 0 } }
}

interface TridDealSnapshot {
  transaction: { id: string; brokerageId: string; financing: "cash" | "financed" | null; closeDate: string | null; status: string | null }
  timeline: { id: string; scheduledCloseDate: string | null; mirroredReceiptDate: string | null } | null
  receipts: TridReceiptRecord[]
  lender: LenderPresence
  readiness: TridReadiness
}

/**
 * Everything the TRID readiness rule needs for ONE deal, tenant-pinned, every error read. A refused read returns ok:false — the
 * caller holds (a gate that cannot see the ledger never reports TRID-ready).
 */
export async function loadTridDealSnapshot(svc: Svc, input: { brokerageId: string; transactionId: string; today?: string }): Promise<{ ok: true; snapshot: TridDealSnapshot } | { ok: false; error: string }> {
  const B = input.brokerageId, T = input.transactionId
  if (!B || !T) return { ok: false, error: "the deal and its tenant are required" }
  const { data: tx, error: txErr } = await svc.from("transactions").select("id, brokerage_id, financing_type, close_date, status").eq("id", T).eq("brokerage_id", B).maybeSingle()
  if (txErr) return { ok: false, error: `the deal could not be read: ${txErr.message}` }
  if (!tx) return { ok: false, error: "the deal was not found in this account" }
  const [tlRes, rcRes, docRes, lp] = await Promise.all([
    svc.from("trid_timeline").select("id, scheduled_close_date, closing_disclosure_delivered_date").eq("brokerage_id", B).eq("transaction_id", T).maybeSingle(),
    svc.from("trid_disclosure_receipts").select(RECEIPT_COLS).eq("brokerage_id", B).eq("transaction_id", T).order("created_at", { ascending: true }),
    svc.from("transaction_documents").select("id").eq("brokerage_id", B).eq("transaction_id", T).eq("doc_type", "closing_disclosure").limit(1),
    lenderPresence(svc, B, T),
  ])
  if (tlRes.error) return { ok: false, error: `the TRID timeline could not be read: ${tlRes.error.message}` }
  if (rcRes.error) return { ok: false, error: `the Closing Disclosure receipt ledger could not be read: ${rcRes.error.message}` }
  if (docRes.error) return { ok: false, error: `the deal's documents could not be read: ${docRes.error.message}` }
  if (!lp.ok) return { ok: false, error: lp.error }

  const { financingKindFor } = await import("@/lib/compliance/checklist-dimensions")
  const t = tx as { id: string; brokerage_id: string; financing_type: string | null; close_date: string | null; status: string | null }
  const financing = financingKindFor(t.financing_type) ?? null
  const tl = (tlRes.data ?? null) as { id: string; scheduled_close_date: string | null; closing_disclosure_delivered_date: string | null } | null
  const receipts: TridReceiptRecord[] = ((rcRes.data ?? []) as Array<Record<string, any>>).map((r) => ({
    id: String(r.id),
    version: Number(r.disclosure_version),
    supersedesId: (r.supersedes_id as string | null) ?? null,
    verification: String(r.verification_status),
    source: String(r.source),
    deliveryMethod: (r.delivery_method as string | null) ?? null,
    deliveredOn: r.delivered_at ? localReceiptDay(String(r.delivered_at), String(r.receipt_timezone)) : null,
    receivedOn: r.received_at ? localReceiptDay(String(r.received_at), String(r.receipt_timezone)) : null,
    evidence: (r.receipt_evidence as string | null) ?? null,
    revisionChanges: Array.isArray(r.revision_changes) ? (r.revision_changes as string[]) : [],
    aprPrevious: r.apr_previous == null ? null : Number(r.apr_previous),
    aprCurrent: r.apr_current == null ? null : Number(r.apr_current),
    regularity: (r.transaction_regularity as string | null) ?? null,
    lenderNewWaitDetermination: (r.lender_new_wait_determination as string | null) ?? null,
    issuerName: (r.issuer_name as string | null) ?? null,
    createdAt: String(r.created_at ?? ""),
  }))
  const scheduledCloseDate = (tl?.scheduled_close_date ?? t.close_date ?? null)
  const readiness = assessTridReadiness({
    financing, tridTracked: !!tl, today: input.today ?? todayIso(), scheduledCloseDate: scheduledCloseDate ? String(scheduledCloseDate).slice(0, 10) : null,
    receipts, draftOnFile: (docRes.data ?? []).length > 0, lenderOnPlatform: lp.lender.onPlatform,
  })
  return {
    ok: true,
    snapshot: {
      transaction: { id: t.id, brokerageId: t.brokerage_id, financing, closeDate: t.close_date, status: t.status },
      timeline: tl ? { id: tl.id, scheduledCloseDate: tl.scheduled_close_date, mirroredReceiptDate: tl.closing_disclosure_delivered_date } : null,
      receipts, lender: lp.lender, readiness,
    },
  }
}

/**
 * THE TRID ITEM a closing readiness list shows (lane 153D's closing list reads it — Outside-lane request in the 153C notes), and
 * the status panel's headline. A refused read is `unavailable` and HOLDS — never "ready".
 */
export async function tridClosingReadinessItem(svc: Svc, input: { brokerageId: string; transactionId: string; today?: string }): Promise<{
  key: "trid_closing_disclosure"; label: string; status: "ready" | "not_applicable" | "waiting" | "blocked" | "unavailable"; blocking: boolean; detail: string; nextAction: string
}> {
  const label = "Closing Disclosure receipt (TRID)"
  const snap = await loadTridDealSnapshot(svc, input)
  if (!snap.ok) return { key: "trid_closing_disclosure", label, status: "unavailable", blocking: true, detail: "The Closing Disclosure record could not be checked, so closing stays on hold.", nextAction: "Try again in a moment." }
  const r = snap.snapshot.readiness
  const status = r.state === "not_applicable" ? "not_applicable" : r.state === "ready" ? "ready" : r.state === "waiting_period_running" ? "waiting" : "blocked"
  return { key: "trid_closing_disclosure", label, status, blocking: !r.readyToConsummateToday, detail: r.reasons.join(" "), nextAction: r.nextAction }
}

// ── the computed compliance row (shared with the lender insurance checkpoint) ───────────────────────────────────────────────

/**
 * Settle ONE computed row on transaction_compliance_log — the table the existing closing gate (canProceedToClosingPrep) reads
 * by is_blocking + status. `pass` clears it with a note; `hold` = needs_review + blocking; `warn` = needs_review, not blocking;
 * `leave` writes nothing. A person's WAIVER stands (an authorized override with a reason is never reverted here). An unchanged
 * row is not rewritten; every write is `.select()`-counted (an UPDATE matching nothing resolves too — CLAUDE.md §3).
 */
export async function settleLenderComplianceRow(svc: Svc, input: {
  brokerageId: string; transactionId: string; checkType: string; checkLabel: string
  verdict: "pass" | "hold" | "warn" | "leave"; reason: string; createIfMissing?: boolean
}): Promise<{ ok: boolean; changed: boolean; error?: string }> {
  if (input.verdict === "leave") return { ok: true, changed: false }
  const { data: rows, error } = await svc.from("transaction_compliance_log")
    .select("id, status, is_blocking, failure_reason")
    .eq("brokerage_id", input.brokerageId).eq("transaction_id", input.transactionId).eq("check_type", input.checkType)
  if (error) return { ok: false, changed: false, error: `the compliance log could not be read: ${error.message}` }
  const existing = ((rows ?? []) as Array<{ id: string; status: string; is_blocking: boolean | null; failure_reason: string | null }>)[0] ?? null
  if (existing?.status === "waived") return { ok: true, changed: false }
  const now = new Date().toISOString()
  const status = input.verdict === "pass" ? "pass" : "needs_review"
  const isBlocking = input.verdict === "warn" ? false : true
  const failureReason = input.verdict === "pass" ? null : input.reason.slice(0, 1000)
  if (existing) {
    if (existing.status === status && !!existing.is_blocking === isBlocking && (existing.failure_reason ?? null) === failureReason) return { ok: true, changed: false }
    const patch: Record<string, unknown> = { status, is_blocking: isBlocking, failure_reason: failureReason, checked_at: now, updated_at: now }
    if (status === "pass") { patch.resolved_at = now; patch.resolution_notes = `Settled from the evidence on file: ${input.reason}`.slice(0, 1000) }
    else patch.resolved_at = null
    const { data: upd, error: uErr } = await svc.from("transaction_compliance_log").update(patch).eq("id", existing.id).eq("brokerage_id", input.brokerageId).select("id")
    if (uErr) return { ok: false, changed: false, error: `the compliance row could not be updated: ${uErr.message}` }
    if (!upd || upd.length === 0) return { ok: false, changed: false, error: "the compliance row was not updated — it no longer exists in this account" }
    return { ok: true, changed: true }
  }
  if (!input.createIfMissing) return { ok: true, changed: false }
  const { data: ins, error: iErr } = await svc.from("transaction_compliance_log").insert({
    transaction_id: input.transactionId, brokerage_id: input.brokerageId, check_type: input.checkType, check_label: input.checkLabel,
    status, is_blocking: isBlocking, failure_reason: failureReason, checked_at: now, created_at: now,
    ...(status === "pass" ? { resolved_at: now, resolution_notes: `Settled from the evidence on file: ${input.reason}`.slice(0, 1000) } : {}),
  }).select("id")
  if (iErr) return { ok: false, changed: false, error: `the compliance row could not be written: ${iErr.message}` }
  return { ok: (ins ?? []).length === 1, changed: (ins ?? []).length === 1 }
}

// ── the summary every reader already reads ──────────────────────────────────────────────────────────────────────────────

/** Open / refresh / settle the agent + TC coaching task. Ledgered on open; idempotent per (deal, state, pending version). */
async function syncCoachingTask(svc: Svc, snap: TridDealSnapshot): Promise<{ opened: number; settled: number; error: string | null }> {
  const B = snap.transaction.brokerageId, T = snap.transaction.id, r = snap.readiness
  const needs = !!r.coaching && ["awaiting_disclosure", "draft_only", "pending_lender_confirmation", "escalated_to_lender"].includes(r.state)
  const { data: open, error } = await svc.from("transaction_tasks").select("id").eq("brokerage_id", B).eq("transaction_id", T)
    .eq("category", COACHING_CATEGORY).in("status", ["pending", "in_progress"])
  if (error) return { opened: 0, settled: 0, error: `the coaching tasks could not be read: ${error.message}` }
  const openRows = (open ?? []) as Array<{ id: string }>
  if (!needs) {
    if (openRows.length === 0) return { opened: 0, settled: 0, error: null }
    const now = new Date().toISOString()
    const { data: done, error: dErr } = await svc.from("transaction_tasks").update({ status: "completed", completed_at: now, updated_at: now })
      .eq("brokerage_id", B).eq("transaction_id", T).eq("category", COACHING_CATEGORY).in("status", ["pending", "in_progress"]).select("id")
    if (dErr) return { opened: 0, settled: 0, error: `the coaching task could not be settled: ${dErr.message}` }
    return { opened: 0, settled: (done ?? []).length, error: null }
  }
  if (openRows.length > 0) return { opened: 0, settled: 0, error: null }
  const { resolveTransactionTeamUsers } = await import("@/lib/kernel/deal-save-huddle")
  const team = await resolveTransactionTeamUsers(svc as any, T, B)
  const assignee = team.agentUserId ?? team.coordinatorUserId ?? null
  const close = snap.timeline?.scheduledCloseDate ?? snap.transaction.closeDate
  const dueBy = close ? closingDisclosureDueBy(String(close).slice(0, 10)) : null
  const description = `${TRID_LENDER_COACHING}\n\nRecord what the lender tells you (who you spoke with, how, the date and time the buyer received it). Your entry stays "reported — waiting for the lender's confirmation" and does not start the three-business-day waiting period until the lender confirms it in writing.${dueBy ? `\nTo keep the ${String(close).slice(0, 10)} closing, the buyer must receive the Closing Disclosure by ${dueBy}.` : ""}`
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const made = await withActionLedger<{ inserted: number }>(
    {
      brokerageId: B, action: "compliance.trid_coaching.open",
      actor: { type: "manager", managerKey: "deal_coordinator" },
      subject: { type: "transaction", id: T, ref: r.state },
      reasonCode: "TRANSACTION_DEADLINE", reasonDetail: `TRID coaching: ${r.state}`, riskClass: "LOW_RISK_WRITE", systemSource: "trid_receipt_ledger",
      idempotencyKey: `trid-coaching:${B}:${T}:${r.state}:${r.reportedPending?.version ?? 0}:${r.governing?.version ?? 0}`,
      detail: { state: r.state, assigned_user_id: assignee, due_by: dueBy },
    },
    async () => {
      const { data: ins, error: iErr } = await svc.from("transaction_tasks").insert({
        transaction_id: T, brokerage_id: B, title: COACHING_TITLE, description: description.slice(0, 2000), category: COACHING_CATEGORY,
        priority: "high", status: "pending", ai_generated: false, assigned_user_id: assignee, ...(dueBy ? { due_date: dueBy } : {}),
      }).select("id")
      if (iErr) throw new Error(`the coaching task was not written: ${iErr.message}`)
      return { inserted: (ins ?? []).length }
    },
    {
      settle: (x) => x.inserted === 1 ? { status: "executed", outcome: "coaching_task_opened" } : { status: "failed", outcome: "no_row", error: "the coaching task insert matched no row" },
      // Claim-aware (integrator, wave 153): a REFUSED claim opened nothing and is said; a replay is the same coaching task already open.
      replay: (claim) => { if (claim.kind === "refused") console.error(`[trid-receipt] coaching task for ${T} not opened — the action ledger refused the claim: ${claim.error}`); return { inserted: 0 } },
    },
    { client: svc as never },
  )
  return { opened: made.inserted, settled: 0, error: null }
}

/**
 * Bring the readers that already exist in line with the ledger: the trid_timeline mirror, the seeded `trid_timing` compliance row
 * and the coaching task. Idempotent; called after every ledger write and by the daily TRID sweep. Never invents a receipt.
 */
export async function syncTridSummary(svc: Svc, input: { brokerageId: string; transactionId: string; today?: string }): Promise<{ ok: true; readiness: TridReadiness; mirrored: string | null; complianceChanged: boolean; coachingOpened: number; coachingSettled: number; notes: string[] } | { ok: false; error: string }> {
  const loaded = await loadTridDealSnapshot(svc, input)
  if (!loaded.ok) return loaded
  const snap = loaded.snapshot
  const r = snap.readiness
  const notes: string[] = []
  const B = snap.transaction.brokerageId, T = snap.transaction.id

  // 1. the mirror: the verified effective receipt of the governing CD, or NULL while a revision is unconfirmed / escalated
  const hold = r.state === "pending_lender_confirmation" || r.state === "escalated_to_lender"
  const mirrored = !hold && r.governing ? r.governing.effectiveReceiptDate : null
  let timelineId = snap.timeline?.id ?? null
  if (!timelineId && snap.receipts.length > 0) {
    const { data: made, error: mErr } = await svc.from("trid_timeline").insert({
      transaction_id: T, brokerage_id: B, compliance_status: "in_progress",
      ...(snap.transaction.closeDate ? { scheduled_close_date: String(snap.transaction.closeDate).slice(0, 10) } : {}),
    }).select("id")
    if (mErr && String((mErr as { code?: string }).code ?? "") !== "23505") return { ok: false, error: `the TRID timeline could not be started: ${mErr.message}` }
    timelineId = ((made ?? []) as Array<{ id: string }>)[0]?.id ?? null
    if (!timelineId) {
      const { data: again, error: aErr } = await svc.from("trid_timeline").select("id").eq("brokerage_id", B).eq("transaction_id", T).maybeSingle()
      if (aErr || !again) return { ok: false, error: `the TRID timeline could not be read back${aErr ? `: ${aErr.message}` : ""}` }
      timelineId = (again as { id: string }).id
    }
  }
  if (timelineId && (snap.timeline?.mirroredReceiptDate ?? null) !== mirrored) {
    const { data: upd, error: uErr } = await svc.from("trid_timeline").update({ closing_disclosure_delivered_date: mirrored, updated_at: new Date().toISOString() })
      .eq("id", timelineId).eq("brokerage_id", B).select("id")
    if (uErr) return { ok: false, error: `the TRID timeline could not be updated: ${uErr.message}` }
    if (!upd || upd.length === 0) return { ok: false, error: "the TRID timeline was not updated — it no longer exists in this account" }
    notes.push(mirrored ? `timeline receipt date set to ${mirrored}` : "timeline receipt date cleared (unverified revision)")
  }

  // 2. the seeded `trid_timing` row the closing gate reads
  const verdict: "pass" | "hold" | "leave" =
    r.state === "ready" || r.state === "waiting_period_running" || r.state === "not_applicable" ? "pass"
    : r.state === "undetermined" ? "leave"
    : "hold"
  const settle = await settleLenderComplianceRow(svc, {
    brokerageId: B, transactionId: T, checkType: TRID_TIMING_CHECK.type, checkLabel: TRID_TIMING_CHECK.label, verdict,
    reason: [...r.reasons, r.nextAction].join(" "),
    // a hold richer than "nothing yet" is written even before the stage seeder ran; "awaiting" waits for the seeded row
    createIfMissing: verdict === "pass" ? snap.receipts.length > 0 : ["pending_lender_confirmation", "escalated_to_lender", "closing_before_earliest_date"].includes(r.state),
  })
  if (!settle.ok) return { ok: false, error: settle.error ?? "the TRID compliance row could not be settled" }

  // 3. the coaching task
  const coach = await syncCoachingTask(svc, snap)
  if (coach.error) notes.push(coach.error)
  return { ok: true, readiness: r, mirrored, complianceChanged: settle.changed, coachingOpened: coach.opened, coachingSettled: coach.settled, notes }
}

// ── the ONE writer ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface TridReceiptEvidenceInput {
  brokerageId: string
  transactionId: string
  actor: { userId: string; kind: TridEvidenceActorKind; lenderVendorId?: string | null }
  version: number
  supersedesId?: string | null
  issuerName: string
  senderRole: string
  senderName?: string | null
  deliveryMethod: string
  deliveredAt?: string | null
  receivedAt?: string | null
  receiptTimezone: string
  receiptEvidence: string
  acknowledgmentSignedAt?: string | null
  documentId?: string | null
  lenderContactName?: string | null
  lenderContactMethod?: string | null
  revisionChanges?: string[] | null
  aprPrevious?: number | null
  aprCurrent?: number | null
  regularity?: string | null
  newWaitDetermination?: string | null
  notes?: string | null
  today?: string
}

type RecordResult =
  | { ok: true; receiptId: string | null; replayed: boolean; readiness: TridReadiness; verification: string }
  | { ok: false; code: "invalid" | "forbidden" | "not_found" | "unavailable"; error: string }

const inSet = (set: readonly string[], v: unknown): v is string => typeof v === "string" && set.includes(v)
const instant = (v: string | null | undefined): string | null => {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/**
 * THE ONE WRITER of the Closing Disclosure receipt ledger. The actor's KIND (resolved by the governed door from the session)
 * decides source and verification; the request never does. Insert-only, idempotent on the evidence (a double submit records one
 * row), ledgered under withActionLedger, then syncTridSummary keeps the existing readers in line.
 */
export async function recordTridReceiptEvidence(svc: Svc, input: TridReceiptEvidenceInput): Promise<RecordResult> {
  const B = input.brokerageId, T = input.transactionId
  if (!B || !T || !input.actor?.userId) return { ok: false, code: "forbidden", error: "Sign in to record a Closing Disclosure receipt." }

  // ── validate the evidence (vocabularies are the m905 CHECKs' one source) ──
  const version = Math.trunc(Number(input.version))
  if (!Number.isFinite(version) || version < 1 || version > 50) return { ok: false, code: "invalid", error: "Choose which Closing Disclosure this is (1 for the initial one)." }
  const issuer = (input.issuerName ?? "").trim()
  if (!issuer) return { ok: false, code: "invalid", error: "Enter the lender that issued the Closing Disclosure." }
  if (!inSet(TRID_SENDER_ROLES, input.senderRole)) return { ok: false, code: "invalid", error: "Say whether the lender or its settlement agent sent it." }
  if (!inSet(TRID_DELIVERY_METHODS, input.deliveryMethod)) return { ok: false, code: "invalid", error: "Choose how the Closing Disclosure reached the buyer." }
  if (!inSet(TRID_RECEIPT_EVIDENCE, input.receiptEvidence)) return { ok: false, code: "invalid", error: "Choose what shows the buyer received it." }
  const tz = (input.receiptTimezone ?? "").trim()
  if (!tz || localReceiptDay(new Date().toISOString(), tz) == null) return { ok: false, code: "invalid", error: "Choose the buyer's time zone." }
  const deliveredAt = instant(input.deliveredAt), receivedAt = instant(input.receivedAt)
  if (input.deliveredAt && !deliveredAt) return { ok: false, code: "invalid", error: "The delivery date and time could not be read." }
  if (input.receivedAt && !receivedAt) return { ok: false, code: "invalid", error: "The receipt date and time could not be read." }
  if (!deliveredAt && !receivedAt) return { ok: false, code: "invalid", error: "Enter when the Closing Disclosure was delivered or when the buyer received it." }
  const future = Date.now() + 5 * 60_000
  if ((deliveredAt && Date.parse(deliveredAt) > future) || (receivedAt && Date.parse(receivedAt) > future)) return { ok: false, code: "invalid", error: "A delivery or receipt cannot be in the future." }
  if (input.receiptEvidence === "mailbox_rule" && !deliveredAt) return { ok: false, code: "invalid", error: "Without proof of when the buyer received it, enter when it was delivered or mailed — receipt is then counted three business days later." }
  const actualEvidence = ["consumer_acknowledged_receipt", "lender_esign_receipt", "lender_statement"]
  if (actualEvidence.includes(input.receiptEvidence) && !receivedAt) return { ok: false, code: "invalid", error: "Enter the date and time the buyer received it." }
  const changes = [...new Set((input.revisionChanges ?? []).filter(Boolean))]
  if (!changes.every((c) => inSet(TRID_REVISION_CHANGES, c))) return { ok: false, code: "invalid", error: "One of the listed changes is not recognized." }
  if (version === 1 && changes.length > 0) return { ok: false, code: "invalid", error: "The initial Closing Disclosure has no revision changes — record a revision as the next version." }
  if (version > 1 && changes.length === 0) return { ok: false, code: "invalid", error: "Say what the revised Closing Disclosure changed (or choose other terms only)." }
  const aprPrev = input.aprPrevious == null ? null : Number(input.aprPrevious)
  const aprCur = input.aprCurrent == null ? null : Number(input.aprCurrent)
  for (const a of [aprPrev, aprCur]) if (a != null && (!Number.isFinite(a) || a < 0 || a >= 100)) return { ok: false, code: "invalid", error: "Enter the APR as a percentage, for example 6.875." }
  if (input.regularity != null && !inSet(TRID_TRANSACTION_REGULARITY, input.regularity)) return { ok: false, code: "invalid", error: "Choose regular or irregular as the lender stated it." }
  if (input.newWaitDetermination != null && !inSet(TRID_NEW_WAIT_DETERMINATIONS, input.newWaitDetermination)) return { ok: false, code: "invalid", error: "Choose the lender's determination about a new waiting period." }

  // ── who may write what (decided from the actor kind, never the request) ──
  const kind = input.actor.kind
  let source: string, verification: string
  if (kind === "lender") { source = "lender_portal"; verification = "lender_confirmed" }
  else if (kind === "compliance") { source = "compliance_verified"; verification = "lender_confirmed" }
  else if (kind === "agent" || kind === "tc") { source = kind === "agent" ? "agent_reported" : "tc_reported"; verification = "pending_lender_confirmation" }
  else return { ok: false, code: "forbidden", error: "Only the lender, the deal's agent or coordinator, or compliance can record a Closing Disclosure receipt." }
  // The derived values must be in the ONE vocabulary the m905 CHECKs mirror (a drifted literal is refused here, never by PostgREST).
  if (!inSet(TRID_RECEIPT_SOURCES, source) || !inSet(TRID_VERIFICATION_STATUSES, verification)) return { ok: false, code: "invalid", error: "This receipt could not be classified. Nothing was saved." }
  if ((kind === "agent" || kind === "tc") && (input.regularity || input.newWaitDetermination)) {
    return { ok: false, code: "invalid", error: "The loan's classification and any new waiting period are the lender's determinations — record what the lender confirms in writing." }
  }
  if ((kind === "agent" || kind === "tc") && !(input.lenderContactName ?? "").trim()) {
    return { ok: false, code: "invalid", error: "Enter who at the lender gave you this information." }
  }

  // ── tenant pin: the deal is this tenant's ──
  const { data: tx, error: txErr } = await svc.from("transactions").select("id, brokerage_id").eq("id", T).eq("brokerage_id", B).maybeSingle()
  if (txErr) return { ok: false, code: "unavailable", error: "The deal could not be checked right now. Nothing was saved." }
  if (!tx) return { ok: false, code: "not_found", error: "This deal was not found in your account." }

  // ── a lender writes only on a deal it is ASSIGNED to, as a LENDER-category vendor of this tenant ──
  if (kind === "lender") {
    const vendorId = input.actor.lenderVendorId ?? null
    if (!vendorId) return { ok: false, code: "forbidden", error: "Only the lender assigned to this deal can record its Closing Disclosure." }
    const lp = await lenderPresence(svc, B, T)
    if (!lp.ok) return { ok: false, code: "unavailable", error: "The deal's lender could not be checked right now. Nothing was saved." }
    if (lp.lender.vendorId !== vendorId) return { ok: false, code: "forbidden", error: "Only the lender assigned to this deal can record its Closing Disclosure." }
  }

  // ── a superseded row and a document must belong to THIS deal ──
  type PriorRow = { id: string; verification_status: string; source: string; disclosure_version: number }
  let supersedes: PriorRow | null = null
  if (input.supersedesId) {
    const { data: prev, error: pErr } = await svc.from("trid_disclosure_receipts").select("id, verification_status, source, disclosure_version")
      .eq("id", input.supersedesId).eq("brokerage_id", B).eq("transaction_id", T).maybeSingle()
    if (pErr) return { ok: false, code: "unavailable", error: "The earlier entry could not be checked right now. Nothing was saved." }
    if (!prev) return { ok: false, code: "not_found", error: "The entry being corrected was not found on this deal." }
    supersedes = prev as unknown as PriorRow
  }
  if (kind === "compliance") {
    // compliance VERIFIES a report with the lender's written confirmation — it never originates a receipt on its own word
    if (!supersedes || supersedes.verification_status !== "pending_lender_confirmation") return { ok: false, code: "invalid", error: "Verification confirms a reported receipt — choose the reported entry being verified." }
    if (!input.documentId) return { ok: false, code: "invalid", error: "Attach the lender's written confirmation to verify the reported receipt." }
  }
  if (input.documentId) {
    const { data: doc, error: dErr } = await svc.from("transaction_documents").select("id").eq("id", input.documentId).eq("brokerage_id", B).eq("transaction_id", T).maybeSingle()
    if (dErr) return { ok: false, code: "unavailable", error: "The attached document could not be checked right now. Nothing was saved." }
    if (!doc) return { ok: false, code: "not_found", error: "The attached document is not on this deal." }
  }

  // ── what this evidence decides (recorded; the reader recomputes) ──
  const deliveredOn = deliveredAt ? localReceiptDay(deliveredAt, tz) : null
  const receivedOn = receivedAt ? localReceiptDay(receivedAt, tz) : null
  const eff = effectiveReceiptDate({ deliveryMethod: input.deliveryMethod, deliveredOn, receivedOn, evidence: input.receiptEvidence })
  const earliest = eff.date ? earliestConsummationDate(eff.date) : null
  const canonical = JSON.stringify([version, supersedes?.id ?? null, source, issuer.toLowerCase(), input.deliveryMethod, deliveredAt, receivedAt, tz, input.receiptEvidence, changes.sort(), aprPrev, aprCur, input.regularity ?? null, input.newWaitDetermination ?? null, input.documentId ?? null])
  const idem = `trid-receipt:${fnv(canonical)}`
  const row = {
    brokerage_id: B, transaction_id: T, disclosure_version: version, supersedes_id: supersedes?.id ?? null,
    issuer_name: issuer.slice(0, 200), sender_role: input.senderRole, sender_name: input.senderName?.trim().slice(0, 200) || null,
    delivery_method: input.deliveryMethod, delivered_at: deliveredAt, received_at: receivedAt, receipt_timezone: tz,
    receipt_evidence: input.receiptEvidence, acknowledgment_signed_at: instant(input.acknowledgmentSignedAt),
    document_id: input.documentId ?? null, source, reported_by: input.actor.userId,
    lender_contact_name: input.lenderContactName?.trim().slice(0, 200) || null, lender_contact_method: input.lenderContactMethod?.trim().slice(0, 200) || null,
    verification_status: verification, revision_changes: changes, apr_previous: aprPrev, apr_current: aprCur,
    transaction_regularity: input.regularity ?? null, lender_new_wait_determination: input.newWaitDetermination ?? null,
    effective_receipt_date: eff.date, earliest_consummation_date: earliest, receipt_basis: eff.basis,
    notes: input.notes?.trim().slice(0, 2000) || null, idempotency_key: idem,
  }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const written = await withActionLedger<{ id: string | null; replayed: boolean; error: string | null }>(
    {
      brokerageId: B, action: "compliance.trid_receipt.record",
      actor: { type: "user", userId: input.actor.userId },
      subject: { type: "transaction", id: T, ref: `cd_v${version}` },
      reasonCode: "COMPLIANCE_NOTICE", reasonDetail: `Closing Disclosure v${version} receipt — ${source} (${verification})`, riskClass: "LEGAL", systemSource: "trid_receipt_ledger",
      idempotencyKey: `${B}:${T}:${idem}`,
      detail: { version, source, verification, effective_receipt_date: eff.date, earliest_consummation_date: earliest, receipt_basis: eff.basis, supersedes_id: supersedes?.id ?? null },
    },
    async () => {
      const { data: ins, error } = await svc.from("trid_disclosure_receipts").insert(row).select("id")
      if (error) {
        if (String((error as { code?: string }).code ?? "") === "23505") return { id: null, replayed: true, error: null }
        return { id: null, replayed: false, error: error.message }
      }
      return { id: ((ins ?? []) as Array<{ id: string }>)[0]?.id ?? null, replayed: false, error: null }
    },
    {
      settle: (x) => x.error ? { status: "failed", outcome: "refused", error: x.error } : x.replayed ? { status: "skipped", outcome: "already_recorded" } : { status: "executed", outcome: verification },
      // Claim-aware (integrator, wave 153): a REFUSED claim saved nothing — never reported as "already recorded".
      replay: (claim) => (claim.kind === "refused" ? { id: null, replayed: false, error: `the action ledger refused the receipt claim: ${claim.error}` } : { id: null, replayed: true, error: null }),
    },
    { client: svc as never },
  )
  if (written.error) return { ok: false, code: "unavailable", error: "The receipt could not be saved right now. Nothing was saved." }

  const synced = await syncTridSummary(svc, { brokerageId: B, transactionId: T, today: input.today })
  if (!synced.ok) return { ok: false, code: "unavailable", error: "The receipt was saved, but the closing timeline could not be refreshed yet — it refreshes on the next check." }
  return { ok: true, receiptId: written.id, replayed: written.replayed, readiness: synced.readiness, verification }
}
