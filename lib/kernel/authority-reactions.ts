import "server-only"
// lib/kernel/authority-reactions.ts — wave 154, lane 154A3 (directive A3 / A6 item 3 / A7.1; owner ruling R7)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE NON-MARKETING REACTIONS THE COVERAGE LEDGER FOUND MISSING. scripts/os-coverage-ledger.ts (lane 154A1) ranked these kernel
// events as emitted with NO consumer (or consumed with no decision and no evidence):
//   rows 1–2  SUBSCRIPTION_STATUS_CHANGED / _TRIAL_EXPIRED / _DOWNGRADED (+ _TRIAL_CONVERTED / _UPGRADED, the restorations) and
//             the SUBSCRIPTION_CANCELLED branch — a tenant that lost authority kept its outreach queue running;
//   row 3     USER_ROLE_CHANGED / USER_TEAM_ASSIGNED — a seat change never rechecked that user's queued work;
//   rows 4–6  COMMISSION_DISPUTED / COMMISSION_APPROVED / CDA_APPROVED with no consumer; COMMISSION_PAID with no decision/evidence.
// This module is NOT a new subsystem: each reaction is called from a NEW branch of lib/kernel/event-reactor.ts (dynamic import,
// so the reactor's module graph does not grow), DECIDES with the existing survivor that owns the question, ACTS only through
// the existing tables' own lifecycle values (live CHECKs), and records WHO / WHY / WHICH DECISION / WHAT HAPPENED on the one
// action ledger (withActionLedger, LAW 5). Nothing is deleted: a paused enrollment, a held post and a disputed commission all
// keep their rows (lawful history).
//
//   decision survivors:  lib/billing/billing-access.ts mayUseAndAfford ('app.access' — the account's authority, the same
//                        resolver the paywall and dispatch's billing gate ask);  lib/kernel/resolve-user-office.ts
//                        resolveViewerHierarchy (the seat's CURRENT scope in the tenant);  lib/kernel/financial.ts
//                        commissionPayoutStanding (Finance Manager's payout standing over the existing payout release gate);
//                        lib/transactions/closing-compliance.ts loadClosingReadiness (the ONE closing readiness recheck).
//   egress stays guarded where it always was: dispatch.ts refuses every send of a tenant mayUseAndAfford refuses ('comms.send'),
//   whatever this module did or did not pause. Pausing the queue stops it CHURNING (and stops a restored tenant from receiving
//   a burst of stale steps) — it is not the only wall.

import { withActionLedger, type NonActingClaim } from "@/lib/kernel/action-ledger"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = { from: (table: string) => any }

export interface AuthorityReactionEvent {
  event: string
  brokerageId: string
  entityType: string
  entityId: string
  metadata?: Record<string, unknown> | null
}

/** One page of queue rows per reaction (a larger queue is reported as truncated; the next event or the egress gate covers it). */
const QUEUE_PAGE = 500
/** The marks this module stamps into sequence_enrollments.trigger_metadata, so a restoration resumes ONLY what a lapse paused
 *  (never an enrollment an agent paused by hand). */
const SUBSCRIPTION_MARK = "subscription_authority"
const MEMBERSHIP_MARK = "membership_authority"

const day = (now: Date) => now.toISOString().slice(0, 10)
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v))

/** A non-acting ledger claim, said honestly: only an EXECUTED winner is a replay; a refusal acted on nothing. */
function notActed(claim: NonActingClaim): { recorded: false; claim: string; error: string | null } {
  if (claim.kind === "refused") console.error(`[authority-reactions] the action ledger refused the claim — nothing was changed: ${claim.error}`)
  return { recorded: false, claim: claim.kind, error: claim.kind === "refused" ? claim.error : null }
}

// ── QUEUE PRIMITIVES (sequence_enrollments: 'active' ⇄ 'paused', both in the live CHECK) ──────────────────────────────────────

async function pauseEnrollments(svc: Svc, brokerageId: string, filter: { enrolledBy?: string }, mark: string, reason: string, now: Date): Promise<{ paused: number; truncated: boolean }> {
  let q = svc.from("sequence_enrollments").select("id, trigger_metadata").eq("brokerage_id", brokerageId).eq("status", "active")
  if (filter.enrolledBy) q = q.eq("enrolled_by", filter.enrolledBy)
  const { data, error } = await q.limit(QUEUE_PAGE)
  if (error) throw new Error(`the active enrollments could not be read: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; trigger_metadata: Record<string, unknown> | null }>
  let paused = 0
  for (const r of rows) {
    const meta = { ...(r.trigger_metadata ?? {}), authority_paused_by: mark, authority_paused_at: now.toISOString(), authority_pause_reason: reason.slice(0, 200) }
    // CAS on the status we read: an enrollment that completed or was paused by hand in the meantime is left alone.
    const { data: upd, error: uErr } = await svc.from("sequence_enrollments").update({ status: "paused", trigger_metadata: meta })
      .eq("id", r.id).eq("brokerage_id", brokerageId).eq("status", "active").select("id")
    if (uErr) throw new Error(`enrollment ${r.id} could not be paused: ${uErr.message}`)
    paused += (upd ?? []).length
  }
  return { paused, truncated: rows.length === QUEUE_PAGE }
}

async function resumeEnrollments(svc: Svc, brokerageId: string, mark: string, now: Date): Promise<{ resumed: number; truncated: boolean }> {
  const { data, error } = await svc.from("sequence_enrollments").select("id, trigger_metadata")
    .eq("brokerage_id", brokerageId).eq("status", "paused").eq("trigger_metadata->>authority_paused_by", mark).limit(QUEUE_PAGE)
  if (error) throw new Error(`the paused enrollments could not be read: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; trigger_metadata: Record<string, unknown> | null }>
  let resumed = 0
  for (const r of rows) {
    const { authority_paused_by: _b, authority_paused_at: _a, authority_pause_reason: _r, ...rest } = (r.trigger_metadata ?? {}) as Record<string, unknown>
    const { data: upd, error: uErr } = await svc.from("sequence_enrollments").update({ status: "active", trigger_metadata: { ...rest, authority_resumed_at: now.toISOString() } })
      .eq("id", r.id).eq("brokerage_id", brokerageId).eq("status", "paused").select("id")
    if (uErr) throw new Error(`enrollment ${r.id} could not be resumed: ${uErr.message}`)
    resumed += (upd ?? []).length
  }
  return { resumed, truncated: rows.length === QUEUE_PAGE }
}

// ══ 1. SUBSCRIPTION AUTHORITY (gap rows 1–2) ═════════════════════════════════════════════════════════════════════════════

export interface SubscriptionAuthorityOutcome {
  /** current = the account still has authority · lost = it does not · unreadable = the entitlement could not be read (no change). */
  decision: "current" | "lost" | "unreadable"
  reason: string
  paused: number
  resumed: number
  truncated: boolean
  recorded: boolean
  claim?: string
  error?: string | null
}

/**
 * A subscription event → RE-READ the entitlement (never trust the event's own `to`) → pause the tenant's active outreach
 * enrollments when authority is lost, resume exactly the ones a lapse paused when it is current again. Finance Manager is the
 * decider (the subscription is its domain). An UNREADABLE entitlement changes nothing (the egress gate already fails closed
 * per send) — a transient read failure must not freeze a paying tenant's queue until the next billing event.
 */
export async function reactToSubscriptionAuthority(
  svc: Svc,
  p: AuthorityReactionEvent,
  deps: { decide?: (i: { brokerageId: string; capability: string; client: Svc; now: Date }) => Promise<{ allowed: boolean; reason: string; plan: { state: string } | null }>; now?: Date } = {},
): Promise<SubscriptionAuthorityOutcome> {
  const now = deps.now ?? new Date()
  const decide = deps.decide ?? (async (i: { brokerageId: string; capability: string; client: Svc; now: Date }) => {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    return mayUseAndAfford({ brokerageId: i.brokerageId, capability: i.capability, client: i.client, now: i.now })
  })
  let verdict: { allowed: boolean; reason: string; plan: { state: string } | null }
  try {
    verdict = await decide({ brokerageId: p.brokerageId, capability: "app.access", client: svc, now })
  } catch (e) {
    verdict = { allowed: false, reason: `access_check_threw: ${(e as Error)?.message ?? String(e)}`, plan: null }
  }
  const unreadable = !verdict.allowed && /^access_check_threw|read refused|refused/i.test(verdict.reason)
  const decision: SubscriptionAuthorityOutcome["decision"] = unreadable ? "unreadable" : verdict.allowed ? "current" : "lost"
  const m = p.metadata ?? {}
  const transition = `${str(m.from ?? m.previous_tier)}->${str(m.to ?? m.new_tier)}`
  return withActionLedger<SubscriptionAuthorityOutcome>(
    {
      brokerageId: p.brokerageId,
      action: "subscription.authority.recheck",
      actor: { type: "manager", managerKey: "finance_manager" },
      subject: { type: "brokerage", id: p.brokerageId, ref: p.entityId },
      reasonCode: "SUBSCRIPTION_LIFECYCLE",
      reasonDetail: `${p.event} (${transition}) → entitlement ${decision} (${verdict.reason})`.slice(0, 500),
      riskClass: "LOW_RISK_WRITE",
      systemSource: "subscription_authority_reactor",
      idempotencyKey: `subscription.authority:${p.brokerageId}:${p.event}:${p.entityId}:${transition}:${day(now)}`,
      detail: { event: p.event, decision, entitlement_reason: verdict.reason, plan_state: verdict.plan?.state ?? null, decided_by: "mayUseAndAfford(app.access)" },
    },
    async () => {
      if (decision === "unreadable") return { decision, reason: verdict.reason, paused: 0, resumed: 0, truncated: false, recorded: true }
      if (decision === "lost") {
        const r = await pauseEnrollments(svc, p.brokerageId, {}, SUBSCRIPTION_MARK, `${p.event}: ${verdict.reason}`, now)
        return { decision, reason: verdict.reason, paused: r.paused, resumed: 0, truncated: r.truncated, recorded: true }
      }
      const r = await resumeEnrollments(svc, p.brokerageId, SUBSCRIPTION_MARK, now)
      return { decision, reason: verdict.reason, paused: 0, resumed: r.resumed, truncated: r.truncated, recorded: true }
    },
    {
      settle: (r) => r.decision === "unreadable"
        ? { status: "skipped", outcome: "entitlement_unreadable", error: r.reason }
        : { status: "executed", outcome: r.decision === "lost" ? `outreach_paused:${r.paused}` : `outreach_resumed:${r.resumed}` },
      replay: (claim) => ({ decision, reason: verdict.reason, paused: 0, resumed: 0, truncated: false, ...notActed(claim) }),
    },
    { client: svc as never },
  )
}

// ══ 2. MEMBERSHIP / ROLE CHANGE (gap row 3) ══════════════════════════════════════════════════════════════════════════════

export interface MembershipRecheckOutcome {
  /** live = the seat still sits in this tenant · gone = it no longer does (suspended, removed, moved) · unreadable = no change. */
  decision: "live" | "gone" | "unreadable"
  basis: string
  postsHeld: number
  enrollmentsPaused: number
  recorded: boolean
  claim?: string
  error?: string | null
}

/**
 * A role / team change → re-resolve the seat's CURRENT standing in the tenant (users row + resolveViewerHierarchy) → when the
 * seat no longer sits in the tenant, HOLD its queued scheduled social posts (back to draft + pending approval; content kept)
 * and pause the outreach enrollments it started. A live seat keeps its queue: every consequential door re-reads the actor at
 * action time. Scope narrowing INSIDE the tenant is recorded (scope kind + basis) but changes no queued item — PARTIAL, named
 * in the lane notes.
 */
export async function reactToMembershipChange(svc: Svc, p: AuthorityReactionEvent, deps: { now?: Date } = {}): Promise<MembershipRecheckOutcome> {
  const now = deps.now ?? new Date()
  const userId = p.entityId
  let decision: MembershipRecheckOutcome["decision"] = "live"
  let basis = ""
  const { data: u, error: uErr } = await svc.from("users").select("id, brokerage_id, status, deleted_at").eq("id", userId).maybeSingle()
  const user = u as { brokerage_id?: string | null; status?: string | null; deleted_at?: string | null } | null
  if (uErr) { decision = "unreadable"; basis = `seat read refused: ${uErr.message}` }
  else if (!user || user.brokerage_id !== p.brokerageId) { decision = "gone"; basis = "the user no longer sits in this tenant" }
  else if (user.status === "suspended" || user.deleted_at) { decision = "gone"; basis = `the seat is ${user.deleted_at ? "removed" : "suspended"}` }
  else {
    const { resolveViewerHierarchy } = await import("@/lib/kernel/resolve-user-office")
    const h = await resolveViewerHierarchy(svc as never, { userId, brokerageId: p.brokerageId })
    if (h.ok) basis = `scope ${h.scope.kind}: ${h.scope.basis.join("; ")}`.slice(0, 300)
    else if (/not a member/.test(h.error)) { decision = "gone"; basis = h.error }
    else { decision = "unreadable"; basis = h.error }
  }
  const m = p.metadata ?? {}
  return withActionLedger<MembershipRecheckOutcome>(
    {
      brokerageId: p.brokerageId,
      action: "membership.queue.recheck",
      actor: { type: "manager", managerKey: "data_steward" },
      subject: { type: "user", id: userId },
      // The recheck is the direct consequence of an admin's seat change (assignRole / assignUserToTeam), so its WHY is that request.
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `follows ${p.event} (${str(m.newRole ?? m.teamId)}) → seat ${decision}: ${basis}`.slice(0, 500),
      riskClass: "LOW_RISK_WRITE",
      systemSource: "membership_recheck_reactor",
      idempotencyKey: `membership.recheck:${p.brokerageId}:${userId}:${p.event}:${str(m.newRole ?? m.teamId)}:${day(now)}`,
      detail: { event: p.event, decision, basis, decided_by: "users seat read + resolveViewerHierarchy" },
    },
    async () => {
      if (decision !== "gone") return { decision, basis, postsHeld: 0, enrollmentsPaused: 0, recorded: true }
      const { data: held, error: hErr } = await svc.from("social_posts")
        .update({ status: "draft", approval_status: "pending", error_message: "Held: the author's seat changed and no longer covers this account. Re-approve to publish.", updated_at: now.toISOString() })
        .eq("brokerage_id", p.brokerageId).eq("user_id", userId).eq("status", "scheduled").select("id")
      if (hErr) throw new Error(`the scheduled posts could not be held: ${hErr.message}`)
      const e = await pauseEnrollments(svc, p.brokerageId, { enrolledBy: userId }, MEMBERSHIP_MARK, `${p.event}: ${basis}`, now)
      return { decision, basis, postsHeld: (held ?? []).length, enrollmentsPaused: e.paused, recorded: true }
    },
    {
      settle: (r) => r.decision === "unreadable"
        ? { status: "skipped", outcome: "seat_unreadable", error: r.basis }
        : { status: "executed", outcome: r.decision === "gone" ? `queue_held:posts=${r.postsHeld},enrollments=${r.enrollmentsPaused}` : "seat_live_no_change" },
      replay: (claim) => ({ decision, basis, postsHeld: 0, enrollmentsPaused: 0, ...notActed(claim) }),
    },
    { client: svc as never },
  )
}

// ══ 3. COMMISSION (gap rows 4–5) — Finance Manager decides ══════════════════════════════════════════════════════════════

export interface CommissionReactionOutcome {
  decision: "held" | "releasable" | "paid_verified" | "stale" | "escalated" | "unreadable" | "not_applicable"
  detail: string
  taskOpened: boolean
  recorded: boolean
  claim?: string
  error?: string | null
}

/** Open ONE pending task on the deal for a category (a second identical reaction finds it and opens nothing). */
async function openDealTask(svc: Svc, brokerageId: string, transactionId: string, category: string, title: string, description: string, priority: "high" | "critical"): Promise<boolean> {
  const { data: have, error: hErr } = await svc.from("transaction_tasks").select("id").eq("brokerage_id", brokerageId).eq("transaction_id", transactionId)
    .eq("category", category).in("status", ["pending", "in_progress"]).limit(1)
  if (hErr) throw new Error(`the deal's open tasks could not be read: ${hErr.message}`)
  if ((have ?? []).length > 0) return false
  const { data: ins, error } = await svc.from("transaction_tasks").insert({
    transaction_id: transactionId, brokerage_id: brokerageId, title, description, priority, category, ai_generated: false, status: "pending",
  }).select("id")
  if (error) throw new Error(`the deal task was not written: ${error.message}`)
  return (ins ?? []).length === 1
}

/**
 * COMMISSION_DISPUTED / COMMISSION_APPROVED / COMMISSION_PAID on an agent_commissions row → Finance Manager re-reads the
 * payout standing (lib/kernel/financial.ts commissionPayoutStanding — the existing payout release gate). A dispute HOLDS the
 * payout: the payout writers already refuse anything but 'approved' (initiateCommissionPayout / markCommissionPaid), so the
 * reaction verifies the hold, opens ONE deal task so the dispute has an owner and a deadline, and ESCALATES (critical) when a
 * payout was already initiated before the dispute — money in flight is a person's call. An approval records whether the payout
 * is releasable now or what holds it; a payment is read back (status 'paid', paid_at). A commission_distribution (residual)
 * approval carries its own ledger row at the writer and is not re-handled here.
 */
export async function reactToCommissionDecision(
  svc: Svc,
  p: AuthorityReactionEvent,
  deps: { standing?: (svc: Svc, brokerageId: string, commissionId: string) => Promise<CommissionStanding>; now?: Date } = {},
): Promise<CommissionReactionOutcome> {
  if (p.entityType !== "agent_commission") return { decision: "not_applicable", detail: `${p.entityType} is not an agent commission`, taskOpened: false, recorded: false }
  const standingOf = deps.standing ?? (async (s: Svc, b: string, c: string) => {
    const { commissionPayoutStanding } = await import("@/lib/kernel/financial")
    return commissionPayoutStanding(s as never, b, c)
  })
  const st = await standingOf(svc, p.brokerageId, p.entityId)
  const now = deps.now ?? new Date()
  let decision: CommissionReactionOutcome["decision"]
  let detail: string
  if (!st.ok) { decision = "unreadable"; detail = st.error }
  else if (p.event === "commission_disputed") {
    if (st.status !== "disputed") { decision = "stale"; detail = `the dispute is no longer open (status ${st.status})` }
    else if (st.initiated) { decision = "escalated"; detail = "a payout was initiated BEFORE the dispute — stop it with the payment method on record; the ledger will not post it while disputed" }
    else { decision = "held"; detail = "payout held: the commission is disputed and the payout writers refuse a disputed commission until it is resolved" }
  } else if (p.event === "commission_approved") {
    if (st.status !== "approved") { decision = "stale"; detail = `approval superseded (status ${st.status})` }
    else if (st.releasable) { decision = "releasable"; detail = "approved and releasable under the brokerage's payout setting" }
    else { decision = "held"; detail = `approved, payout held: ${st.hold ?? "unknown"}` }
  } else {
    if (st.status === "paid" && st.paidAt) { decision = "paid_verified"; detail = `paid ${st.paidAt} (read back)` }
    else { decision = "stale"; detail = `the payment event does not match the row (status ${st.status}, paid_at ${st.paidAt ?? "none"})` }
  }
  return withActionLedger<CommissionReactionOutcome>(
    {
      brokerageId: p.brokerageId,
      action: `commission.${p.event.replace(/^commission_/, "")}.react`,
      actor: { type: "manager", managerKey: "finance_manager" },
      subject: { type: "agent_commission", id: p.entityId },
      reasonCode: "TRANSACTION_MILESTONE",
      reasonDetail: `${p.event} → ${decision}: ${detail}`.slice(0, 500),
      riskClass: "FINANCIAL",
      systemSource: "commission_reactor",
      idempotencyKey: `commission.react:${p.brokerageId}:${p.entityId}:${p.event}:${st.ok ? st.status : "unreadable"}:${day(now)}`,
      detail: { event: p.event, decision, standing: st.ok ? { status: st.status, initiated: st.initiated, releasable: st.releasable, hold: st.hold } : null, decided_by: "commissionPayoutStanding (payout release gate)" },
    },
    async () => {
      let taskOpened = false
      if (st.ok && st.transactionId && (decision === "held" || decision === "escalated") && p.event === "commission_disputed") {
        taskOpened = await openDealTask(svc, p.brokerageId, st.transactionId, "commission_dispute",
          decision === "escalated" ? "Commission disputed after payout was initiated" : "Commission disputed — payout held",
          `${detail}. Resolve the dispute (uphold, correct or reopen) from the commission record; the payout stays held until then.`,
          decision === "escalated" ? "critical" : "high")
      }
      // A dispute resolved to APPROVED closes the dispute task it opened (the task's reader is the deal's task list).
      if (st.ok && st.transactionId && p.event === "commission_approved" && (decision === "releasable" || decision === "held")) {
        const { error: cErr } = await svc.from("transaction_tasks").update({ status: "completed", completed_at: now.toISOString(), updated_at: now.toISOString() })
          .eq("brokerage_id", p.brokerageId).eq("transaction_id", st.transactionId).eq("category", "commission_dispute").in("status", ["pending", "in_progress"]).select("id")
        if (cErr) throw new Error(`the dispute task could not be closed: ${cErr.message}`)
      }
      if (decision === "escalated") {
        const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
        await notifyBrokerageAdmins(svc as never, p.brokerageId, { type: "commission_dispute_payout_in_flight", title: "Disputed commission already has a payout in progress", body: detail, entityType: "agent_commission", entityId: p.entityId, priority: "critical" })
      }
      return { decision, detail, taskOpened, recorded: true }
    },
    {
      settle: (r) => r.decision === "unreadable" ? { status: "skipped", outcome: "standing_unreadable", error: r.detail } : { status: "executed", outcome: `${r.decision}${r.taskOpened ? ":task_opened" : ""}` },
      replay: (claim) => ({ decision, detail, taskOpened: false, ...notActed(claim) }),
    },
    { client: svc as never },
  )
}

/** The shape lib/kernel/financial.ts commissionPayoutStanding returns (structural, so a proof can inject a fake). */
export type CommissionStanding =
  | { ok: true; status: string; transactionId: string | null; initiated: boolean; paidAt: string | null; releasable: boolean; hold: string | null }
  | { ok: false; error: string }

// ══ 4. CDA APPROVED (gap row 6) — the approval rechecks closing readiness ═══════════════════════════════════════════════

export interface CdaReactionOutcome {
  decision: "ready" | "not_ready" | "review_stale" | "unreadable"
  blocking: number
  taskOpened: boolean
  recorded: boolean
  claim?: string
  error?: string | null
}

/**
 * CDA_APPROVED (compliance cleared the disbursement authorization) → RECHECK the deal's closing readiness through the ONE
 * readiness loader (loadClosingReadiness: compliance log, TRID, CDA, settlement, closing review, flagged documents, applied
 * commission-term changes — the same fingerprint the closing review is pinned to). A CDA approval never releases a closing on
 * its own: if the list still blocks, or the reviewer's standing is stale against the current fingerprint, ONE deal task names
 * what holds it so the broker's signature does not race an unready file.
 */
export async function reactToCdaApproved(
  svc: Svc,
  p: AuthorityReactionEvent,
  deps: { load?: (svc: Svc, i: { brokerageId: string; transactionId: string }) => Promise<CdaReadinessRead>; now?: Date } = {},
): Promise<CdaReactionOutcome> {
  const transactionId = p.entityType === "transaction" ? p.entityId : str((p.metadata ?? {}).transaction_id)
  const load = deps.load ?? (async (s: Svc, i: { brokerageId: string; transactionId: string }) => {
    const { loadClosingReadiness } = await import("@/lib/transactions/closing-compliance")
    return loadClosingReadiness(s as never, i) as unknown as CdaReadinessRead
  })
  const r = transactionId ? await load(svc, { brokerageId: p.brokerageId, transactionId }) : { ok: false as const, error: "the CDA event names no transaction" }
  const now = deps.now ?? new Date()
  let decision: CdaReactionOutcome["decision"]
  let blocking = 0
  let why = ""
  if (!r.ok) { decision = "unreadable"; why = r.error }
  else {
    blocking = r.loaded.readiness.blocking
    if (blocking > 0) { decision = "not_ready"; why = `${blocking} blocking readiness item(s) remain` }
    else if (r.loaded.standing.blocker) { decision = "review_stale"; why = r.loaded.standing.blocker }
    else { decision = "ready"; why = "the readiness list is clear and the closing review standing holds" }
  }
  const cdaId = str((p.metadata ?? {}).cda_id)
  return withActionLedger<CdaReactionOutcome>(
    {
      brokerageId: p.brokerageId,
      action: "cda.approved.readiness_recheck",
      actor: { type: "manager", managerKey: "compliance_officer" },
      subject: { type: "transaction", id: transactionId || null, ref: cdaId || null },
      reasonCode: "COMPLIANCE_NOTICE",
      reasonDetail: `CDA approved → closing readiness ${decision}: ${why}`.slice(0, 500),
      riskClass: "LEGAL",
      systemSource: "cda_readiness_recheck",
      idempotencyKey: transactionId ? `cda.readiness:${p.brokerageId}:${transactionId}:${cdaId}:${r.ok ? r.loaded.readiness.fingerprint : "unreadable"}` : null,
      detail: { decision, blocking, fingerprint: r.ok ? r.loaded.readiness.fingerprint : null, decided_by: "loadClosingReadiness" },
    },
    async () => {
      let taskOpened = false
      if (transactionId && (decision === "not_ready" || decision === "review_stale")) {
        taskOpened = await openDealTask(svc, p.brokerageId, transactionId, "closing_readiness_after_cda",
          "CDA approved — closing readiness still open", `${why}. The CDA approval does not release the closing; clear the readiness list (and refresh the closing review) before the broker signs.`, "high")
      }
      return { decision, blocking, taskOpened, recorded: true }
    },
    {
      settle: (o) => o.decision === "unreadable" ? { status: "skipped", outcome: "readiness_unreadable", error: why } : { status: "executed", outcome: `${o.decision}${o.taskOpened ? ":task_opened" : ""}` },
      replay: (claim) => ({ decision, blocking, taskOpened: false, ...notActed(claim) }),
    },
    { client: svc as never },
  )
}

/** The subset of loadClosingReadiness's result this reaction reads (structural, so a proof can inject a fake). */
export type CdaReadinessRead =
  | { ok: true; loaded: { readiness: { blocking: number; fingerprint: string }; standing: { blocker: string | null } } }
  | { ok: false; error: string }
