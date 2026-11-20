"use server"

import { isValidUUID } from "@/lib/validations"
import { DEADLINE_STATUSES, isDeadlineStatus } from "@/lib/transactions/coordination-status"
import * as TransactionService from "@/lib/application/transactions"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker, isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { createContactManually } from "@/lib/kernel/crm"
import { revalidatePath } from "next/cache"

// ============================================
// TRANSACTION CRUD
// ============================================

/**
 * ABSORBED (wave 16) from the retired /api/dashboard/data `transactions` branch:
 * the SESSION-DERIVED tenant scope and the session-pinned agent scope.
 *
 * Both used to be optional caller-supplied arguments and neither was applied by
 * default, so `getTransactions()` read every deal on the platform and
 * `getTransactions({ agent_id })` read any agent's book by id. A caller-supplied
 * agent id may now only NARROW, only inside the caller's own tenant, and only
 * for a broker/admin; everyone else is pinned to their own agents.id.
 *
 * It also returned a bare `[]` for a rejected argument, which the caller could
 * not tell from an empty pipeline. Every exit is now the discriminated shape.
 */
export async function getTransactions(filters?: {
  status?: string
  agent_id?: string
  agentId?: string
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false as const, error: "Not authenticated", data: [] as unknown[] }
  }
  if (!ctx.brokerageId) {
    return {
      success: false as const,
      error: "Your account is not linked to a brokerage yet.",
      data: [] as unknown[],
    }
  }

  const requestedAgentId = filters?.agent_id || filters?.agentId
  if (requestedAgentId && !isValidUUID(requestedAgentId)) {
    return { success: false as const, error: "Invalid agent ID", data: [] as unknown[] }
  }

  // agents.id — resolved from the session, never a users.id substituted with `??`.
  let agentFilter: string | undefined
  if (isAdminOrBroker({ user_type: ctx.userType })) {
    // A broker/admin may narrow to one agent; the tenant filter below is what
    // keeps that id inside their own brokerage.
    agentFilter = requestedAgentId
  } else {
    if (!ctx.agentId) {
      return { success: false as const, error: "Agent profile not found", data: [] as unknown[] }
    }
    agentFilter = ctx.agentId
  }

  // Use application service for now - kernel doesn't have direct list function
  // TODO: Migrate to kernel when loadTransactionWorkspace is refactored for listing
  return TransactionService.getTransactions({
    status: filters?.status,
    agent_id: agentFilter,
    brokerage_id: ctx.brokerageId,
  })
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getTransactionById → SURVIVOR app/dashboard/transactions/[id]/page.tsx:71 transactions · CALLED BY app/dashboard/transactions/[id]/page.tsx:71 transactions
//   The deal page reads the deal (and each child table it shows) itself, tenant-checked. This door read a deal and eleven child
//   tables by bare id on the caller's client — nothing in the product asked for it (the tc-settings name is a local lookup).

export async function createTransaction(transactionData: {
  property_address: string
  property_city?: string
  property_state?: string  // 2-letter US state code, e.g. "FL", "CA", "TX"
  property_zip?: string
  transaction_type: "purchase" | "sale" | "lease" | "dual"
  status?: string
  contract_price?: number
  listing_price?: number
  client_name?: string
  client_email?: string
  client_phone?: string
  agent_id?: string
  close_date?: string
  notes?: string
  commissionPercentage?: number
}) {
  if (!transactionData.property_address?.trim()) return { success: false, error: "Property address is required" }

  // Resolve session ownership — the manual sheet doesn't pass these, so without
  // this the row was created unscoped (no brokerage_id/agent_id). agentId is
  // agents.id (null for non-agent users).
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }

  // The client is a person → hangs off a contact, not free text on the
  // transaction. Create/dedupe a contact and link it (when we have a client
  // name and an agent to own it). contact_type follows the deal side.
  let contactId: string | undefined
  if (transactionData.client_name?.trim() && ctx.agentId) {
    const parts = transactionData.client_name.trim().split(/\s+/)
    const res = await createContactManually({
      first_name:   parts[0],
      last_name:    parts.slice(1).join(" ") || parts[0],
      email:        transactionData.client_email ?? null,
      phone:        transactionData.client_phone ?? null,
      city:         transactionData.property_city ?? null,
      state:        transactionData.property_state ?? null,
      zip_code:     transactionData.property_zip ?? null,
      contact_type: transactionData.transaction_type === "sale" ? "seller" : "buyer",
      agent_id:     ctx.agentId,
      brokerage_id: ctx.brokerageId,
      source_label: "manual_transaction",
    })
    if (res.success) contactId = res.contactId ?? res.mergedIntoId
  }

  return TransactionService.createTransaction({
    ...transactionData,
    brokerage_id: ctx.brokerageId,
    agent_id:     ctx.agentId ?? undefined,
    contact_id:   contactId,
  })
}

/**
 * @uncalledDoor case 3 (wave 155, lane 155R28) — owner question: wire "correct deal details" (property address, client name) on
 * the deal page header, or retire this door? Status, closing date, commission, contract date and the agent each have their own
 * governed door and are refused here.
 */
export async function updateTransaction(
  transactionId: string,
  updates: Partial<{
    property_address: string
    property_city: string
    property_state: string
    property_zip: string
    transaction_type: string
    status: string
    contract_price: number
    listing_price: number
    client_name: string
    client_email: string
    client_phone: string
    agent_id: string
    contract_date: string
    close_date: string
    notes: string
    commissionPercentage: number
  }>,
) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  // C23 + the closing-date model (wave 148, lane 148I — owner rulings 13 + 21). This public endpoint wrote `status` and
  // `close_date` as free text: a deal could be marked closed with no reason, no proof and none of its gates (compliance,
  // TRID, CDA), and the closing date — the CONTRACT's deadline — could be overwritten as if an amendment had been executed.
  // Both now have their one door each:
  //   status     → app/actions/transaction-stage-machine.ts advanceTransactionStage (the gate, or the C23 override);
  //   close_date → recordClosingDateChange below (anticipated vs an EXECUTED amendment, with proof).
  if (updates.status !== undefined) return { success: false, error: "A deal's status moves through its stage (advanceTransactionStage) — with the gate, or an override that carries its reason." }
  if (updates.close_date !== undefined) return { success: false, error: "The closing date is the contract's term — record an anticipated date or an executed amendment through recordClosingDateChange." }
  // WAVE 153 (lane 153B, owner ruling 4: "… can change commission terms but not after a transaction has closed"). This public
  // endpoint wrote transactions.commission_percentage — the rate the commission engine prices the deal at — with no check that
  // the caller is on the deal, no freeze at close (a closed / payout-pending deal could be silently re-priced), no reason, no
  // evidence and no approval. The commission rate has ONE door: requestCommissionTermChangeAction below
  // (lib/commission/commission-term-change.ts — attached seat or finance admin, frozen at close, evidence where an executed
  // agreement governs, the broker's decision where policy requires it, the waterfall re-run, the deal team told).
  if (updates.commissionPercentage !== undefined) return { success: false, error: "A deal's commission rate changes through its commission terms (requestCommissionTermChangeAction) — with the reason, the evidence where an agreement governs it, and the broker's decision where your brokerage requires one. A closed deal's commission is never changed here." }
  // WAVE 155 (lane 155R28 — CLAUDE.md §1 case 3, §3, §4): NOTHING IN THE PRODUCT CALLS THIS DOOR, and no other door corrects a
  // deal's own details, so it is KEPT and made safe (owner question in the lane notes). It wrote on the caller's RLS client with no
  // session check of its own, and half of what it accepted is not a column (contract_price, listing_price, client_email,
  // client_phone, notes, transaction_type — PGRST204 refuses the WHOLE update) or belongs to a governed door (agent_id is a
  // reassignment; contract_date drives every contingency deadline and carries its own override reason). Only the deal's own
  // descriptive fields pass; the agent on the deal or a tenant admin (requireTransactionActor — the tenant from the SESSION) may
  // change them; the write is counted (the service's `.single()` refuses zero rows) and leaves one receipt.
  const refusedFields = Object.keys(updates ?? {}).filter((k) => !DEAL_DETAIL_FIELDS.has(k))
  if (refusedFields.length > 0) return { success: false, error: `Only the deal's property address and client name are corrected here — not ${refusedFields.join(", ")}.` }
  const gate = await requireTransactionActor(transactionId)
  if (!gate.ok) return { success: false, error: gate.error }
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: gate.brokerageId, action: "transaction.details.update", actor: { type: "user", userId: gate.userId }, subject: { type: "transaction", id: transactionId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { fields: Object.keys(updates ?? {}) } }, async () => {
  return TransactionService.updateTransaction(transactionId, updates)
  }))
}

/** The deal's own descriptive fields — the only ones updateTransaction may correct (live columns, scripts/schema-snapshot.ts). */
const DEAL_DETAIL_FIELDS: ReadonlySet<string> = new Set(["property_address", "property_city", "property_state", "property_zip", "client_name"])

// ============================================
// MILESTONES
// ============================================

// ── WAVE 155, LANE 155R28 — THE UNCALLED DEAL DOORS (CLAUDE.md §1, §4) ───────────────────────────────────────────────────────
// Every export of this "use server" file is a public endpoint. Thirty-three of them had NO caller anywhere in the product; each
// was retired below with a tombstone naming the survivor the product calls TODAY (case 1: a duplicate, merged onto first; case 2:
// the functionality lives elsewhere). Seven with no survivor were KEPT and gated (marked "@uncalledDoor"); lane 155R30 then BUILT
// the missing UI half (§1 case 2 "build") for five of them on the deal page — addTitleEscrow, updateTitleEscrow,
// updateParticipant, removeParticipant, updateDeadline — whose marks are gone because they are called now. Two stay marked:
// updateTransaction (the deal header has no edit affordance) and generateCostBreakdown (model-authored money). The format of
// every line below is held by scripts/wave155-uncalled-deal-doors-guard.ts (the survivor file must still carry the symbol it names).
//
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED generateMilestones → SURVIVOR lib/application/transactions.ts:354 generateMilestones · CALLED BY lib/application/transactions.ts:262 generateMilestones
//   The journey is seeded ONCE, from the one catalog (milestoneJourneyFor), when the deal is created (this file's createTransaction ←
//   app/dashboard/transactions/components/create-transaction-sheet.tsx). A public re-seed duplicated the whole journey on a live deal.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 1) RETIRED completeMilestone → SURVIVOR lib/transactions/milestone-service.ts:309 completeMilestone · CALLED BY app/actions/transaction-milestones.ts:64 completeMilestone
//   The deal page completes a milestone through completeMilestoneAction (app/actions/transaction-milestones.ts:48 ←
//   app/dashboard/transactions/[id]/transaction-detail-client.tsx:830). MERGED FIRST: the optional completion `notes` (both
//   files). NOT merged, deliberately: a body-supplied `completedBy` (a legal attestation — the survivor stamps the SESSION user),
//   and keying on a bare milestone id with no tenant predicate (the survivor pins brokerage + deal, and mirrors the deadline,
//   writes the lifecycle row and fans out to the portals).
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getTransactionMilestones → SURVIVOR app/dashboard/transactions/[id]/page.tsx:261 transaction_milestones · CALLED BY app/dashboard/transactions/[id]/page.tsx:261 transaction_milestones
//   The deal page reads its milestones itself, inside the deal's tenant check.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED updateMilestone → SURVIVOR app/actions/transaction-milestones.ts:90 overrideMilestoneAction · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:32 overrideMilestoneAction
//   A free patch of a milestone row. Its verbs live on the deal page: complete (completeMilestoneAction), override with a reason
//   (overrideMilestoneAction), dates (markAppraisalOrderedAction & co. → milestone-service setMilestoneDate) and client visibility
//   (setMilestoneClientVisibility below — the one caller of the service's updateMilestone and its receipt). Its `due_date` is not
//   a column (target_date is), so a date edit through it was refused whole (PGRST204).

/**
 * Set whether a milestone is visible to the client in the portal.
 * Writes to transaction_milestones.is_client_visible (live schema column).
 */
export async function setMilestoneClientVisibility(
  milestoneId: string,
  isVisible: boolean,
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(milestoneId)) return { success: false, error: "Invalid milestone ID" }
  return TransactionService.updateMilestone(milestoneId, { is_client_visible: isVisible } as any)
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 1) RETIRED getClosingChecklist → SURVIVOR app/actions/ai-closing-workflow.ts:233 getClosingChecklist · CALLED BY app/crm/components/closing-workflow-tab.tsx:167 getClosingChecklist
//   The same closing_checklist_items read; the survivor is the one the closing-workflow tab imports (closing-workflow-tab.tsx:25).
//   Nothing to merge: this twin was a bare id read on the caller's client with no tenant check.

// ============================================
// TRANSACTION LIFECYCLE — CLOSE / REOPEN / CLOSE PREP
// ============================================

/**
 * THE SESSION GATE for the lifecycle commands below (lane 91D, CLAUDE.md §4).
 *
 * closeTransaction / reopenTransactionIfAuthorized / recalculateCommissionState /
 * emitClientFriendlyUpdate are exports of a "use server" file — public HTTP
 * endpoints — and each handed a BODY-SUPPLIED brokerageId (and, for reopen, a
 * body-supplied ROLE) straight to a kernel command that runs on the service
 * client. Anyone holding a transaction id could close it (firing commission and
 * lifetime-touch writes), reopen it by claiming role "broker", or send the client
 * a portal update. The tenant now comes from the session; the transaction must
 * be in it; and the caller must be a tenant admin (the one roster,
 * isAdminOrBroker) or the agent on the deal. `requireFinance` narrows to the
 * brokerage's books tier (isBrokerageFinanceAdmin) for reopening a closed deal.
 * Fail closed: an unreadable transaction refuses. Not exported (a "use server"
 * export would itself be a public endpoint).
 */
async function requireTransactionActor(
  transactionId: string,
  opts: { requireFinance?: boolean } = {},
): Promise<{ ok: true; brokerageId: string; userId: string; userType: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not linked to a brokerage yet." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: tx, error } = await svc
    .from("transactions")
    .select("id, agent_id, buyer_agent_id, seller_agent_id")
    .eq("id", transactionId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not verify the transaction: ${error.message}` }
  if (!tx) return { ok: false, error: "Transaction not found" }
  if (opts.requireFinance) {
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) {
      return { ok: false, error: "Only the brokerage's broker or admin can do this." }
    }
  } else {
    const onDeal = !!ctx.agentId && [tx.agent_id, tx.buyer_agent_id, tx.seller_agent_id].includes(ctx.agentId)
    if (!onDeal && !isAdminOrBroker({ user_type: ctx.userType })) {
      return { ok: false, error: "Only the agent on this transaction or a brokerage admin can do this." }
    }
  }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, userType: ctx.userType }
}

/**
 * THE SAME GATE FOR A DEAL'S CHILD ROW (wave 155, lane 155R28). The kept doors below are keyed on a row id (a participant, the
 * title / escrow record, a deadline). The row's deal is read first — after the session is known — and then the deal must pass
 * requireTransactionActor: in the SESSION's tenant, and the caller the agent on it or a tenant admin. The row's own brokerage_id
 * is not trusted for this (older writers never stamped it); the deal's is. Fail closed: an unreadable row refuses. Not exported.
 */
async function requireDealRowActor(
  table: "transaction_participants" | "transaction_title_escrow" | "transaction_deadlines",
  rowId: string,
): Promise<{ ok: true; brokerageId: string; userId: string; userType: string; transactionId: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not linked to a brokerage yet." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data: row, error } = await createServiceClient().from(table).select("transaction_id").eq("id", rowId).maybeSingle()
  if (error) return { ok: false, error: `Could not verify the record: ${error.message}` }
  const transactionId = (row as { transaction_id?: string | null } | null)?.transaction_id
  if (!transactionId) return { ok: false, error: "Record not found" }
  const gate = await requireTransactionActor(transactionId)
  if (!gate.ok) return gate
  return { ...gate, transactionId }
}

// ============================================
// CLOSING DATES — contractual (on / on or before) vs anticipated vs actual (wave 148, lane 148I — owner ruling 21)
// ============================================

/**
 * The deal's three closing facts (lib/transactions/closing-dates.ts resolveClosingDates) with the state note — the
 * agent on the deal or a tenant admin (requireTransactionActor). Read on the service client after the session gate.
 */
export async function getClosingDates(transactionId: string): Promise<
  { ok: true; dates: import("@/lib/transactions/closing-dates").ClosingDates } | { ok: false; error: string }
> {
  if (!isValidUUID(transactionId)) return { ok: false, error: "Invalid transaction ID" }
  const gate = await requireTransactionActor(transactionId)
  if (!gate.ok) return gate
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { resolveClosingDates } = await import("@/lib/transactions/closing-dates")
  // m927 columns may not be applied yet: read them, and on a refusal fall back to the survivors' columns (said, not hidden).
  const svc = createServiceClient()
  const full = await svc.from("transactions")
    .select("status, close_date, estimated_close_date, property_state, financing_type, contract_closing_date, contract_closing_terms, contract_closing_source, contract_closing_amendment_ref, actual_close_date")
    .eq("id", transactionId).eq("brokerage_id", gate.brokerageId).maybeSingle()
  let row = full.data as Record<string, string | null> | null
  if (full.error) {
    const base = await svc.from("transactions").select("status, close_date, estimated_close_date, property_state, financing_type").eq("id", transactionId).eq("brokerage_id", gate.brokerageId).maybeSingle()
    if (base.error) return { ok: false, error: base.error.message }
    row = base.data as Record<string, string | null> | null
  }
  if (!row) return { ok: false, error: "Transaction not found" }
  // The title / escrow appointment is the ANTICIPATED day's best basis (resolveClosingDates' `title_schedule`) — wave 148
  // modelled it but this door never read it (wave 149, lane 149G). Tenant-pinned; a refused read is said, not hidden.
  const sched = await svc.from("transaction_title_escrow").select("closing_scheduled_date")
    .eq("transaction_id", transactionId).eq("brokerage_id", gate.brokerageId).not("closing_scheduled_date", "is", null)
    .order("closing_scheduled_date", { ascending: true }).limit(1)
  const scheduled = !sched.error ? ((sched.data ?? []) as Array<{ closing_scheduled_date: string | null }>)[0]?.closing_scheduled_date ?? null : null
  const dates = resolveClosingDates({ ...row, scheduled_closing_date: scheduled })
  if (full.error) dates.notes.push(`The closing-date model columns are not readable yet (${full.error.message}) — showing the dates the deal already carries.`)
  if (sched.error) dates.notes.push(`The title / escrow appointment could not be read (${sched.error.message}) — the expected day shown does not include it.`)
  return { ok: true, dates }
}

/**
 * Record a closing-date change under its rule (lib/transactions/closing-dates.ts applyClosingDateChange): a PROPOSED day
 * moves the anticipated date only — never the contract; an EXECUTED amendment changes the contractual deadline and needs
 * its reference; the contract's wording (on / on or before) is read off the executed contract with its reference; on a
 * closed deal the actual day is confirmed from the settlement statement (wave 149, lane 149G — C33). An earlier day under
 * "on or before" needs NO amendment (owner ruling 17) — the assessment says so. Reason always. Tenant and actor from the
 * session (requireTransactionActor) — never the body.
 */
export async function recordClosingDateChange(params: {
  transactionId: string
  kind: import("@/lib/transactions/closing-dates").ClosingDateChangeKind
  date?: string | null
  terms?: "on" | "on_or_before" | null
  reason: string
  evidenceRef?: string | null
}): Promise<
  | { ok: true; assessment: import("@/lib/transactions/closing-dates").ClosingDateChangeAssessment | null; dates: import("@/lib/transactions/closing-dates").ClosingDates }
  | { ok: false; error: string; assessment?: import("@/lib/transactions/closing-dates").ClosingDateChangeAssessment }
> {
  if (!isValidUUID(params.transactionId)) return { ok: false, error: "Invalid transaction ID" }
  const gate = await requireTransactionActor(params.transactionId)
  if (!gate.ok) return gate
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { applyClosingDateChange } = await import("@/lib/transactions/closing-dates")
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const r = await applyClosingDateChange(createServiceClient(), {
    brokerageId: gate.brokerageId, transactionId: params.transactionId, actorUserId: gate.userId,
    kind: params.kind, date: params.date ?? null, terms: params.terms ?? null, reason: params.reason, evidenceRef: params.evidenceRef ?? null,
  }, { ledger: withActionLedger })
  if (r.ok) revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return r
}

/**
 * Close a transaction. Sets status=closed, stage=CLOSED, close_date to today if not set.
 * Writes a timeline entry and emits lifecycle_events record.
 */
export async function closeTransaction(params: {
  transactionId: string
  brokerageId: string
  agentId: string
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  // brokerageId / agentId are IGNORED on input — the session supplies both (see requireTransactionActor).
  const gate = await requireTransactionActor(params.transactionId)
  if (!gate.ok) return { success: false, error: gate.error }

  const { closeTransactionCommand } = await import("@/lib/kernel/transactions")
  return closeTransactionCommand({ transactionId: params.transactionId, brokerageId: gate.brokerageId, agentId: gate.userId, reason: params.reason })
}

/**
 * Reopen a closed transaction. Requires broker/admin role.
 * Sets status=active, stage=CLOSING_PREP, writes audit trail.
 */
export async function reopenTransactionIfAuthorized(params: {
  transactionId: string
  brokerageId: string
  requestingUserId: string
  requestingUserRole: string
  reason: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  // The role used to be read from the BODY (requestingUserRole) — a self-asserted
  // "broker" passed. Tenant, user and role now all come from the session.
  const gate = await requireTransactionActor(params.transactionId, { requireFinance: true })
  if (!gate.ok) return { success: false, error: gate.error }

  const { reopenTransactionCommand } = await import("@/lib/kernel/transactions")
  return reopenTransactionCommand({
    transactionId: params.transactionId, brokerageId: gate.brokerageId,
    requestingUserId: gate.userId, requestingUserRole: gate.userType, reason: params.reason,
  })
}

// ============================================
// COMMISSIONS
// ============================================

// TOMBSTONE (wave 155, lane 155B2 — CLAUDE.md §1/§4/§6; wave 154 gap row 20): `recalculateCommissionState(params)` LIVED HERE — a
// public "use server" door (session gate requireTransactionActor, tenant re-keyed from the gate) with NO caller anywhere. It was
// NOT a twin of lib/kernel/financial.ts recalculateCommissionState (that one is the brokerage-wide CAP-STATE refresh behind
// app/actions/financial-kernel.ts recalculateCommissionStateAction — a different function under the same name, §6). This door
// re-ran the per-deal waterfall, lib/kernel/transactions.ts recalculateCommissionStateCommand, which is already run by its real
// triggers. SURVIVORS: lib/commission/commission-term-change.ts (the gated commission-terms door re-runs it after a rate moves,
// :363) and lib/kernel/transactions.ts (:1445, its own stage path). A manual "recalculate this deal" button, if wanted, belongs on
// the commission-terms screen through that same writer — not a second door.

// ============================================
// COMMISSION TERMS — pre-close changes (wave 153, lane 153B; owner ruling 4)
// ============================================
//
// "Anyone attached to the offer/listing/transaction that holds a seat or admin can change commission terms but not after a
// transaction has closed." Every export below is a public endpoint (CLAUDE.md §4): async, tenant + actor from the SESSION
// (lib/agreements/session-actor.ts — the tenant-principal fact resolved fail-closed), ids shape-checked, then the ONE writer
// (lib/commission/commission-term-change.ts) on the service client, which runs its own gate (attachment / finance roster,
// freeze, evidence, approval, conflict, idempotency). Nothing here decides who may act or computes money.

/** The writer's refusal as the person reads it: its machine code dropped, the sentence kept (the code stays in the ledger). */
function termSentence(error: string): string {
  const s = String(error ?? "").replace(/^[a-z0-9_]+: /, "").trim()
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : "The commission terms could not be changed right now. Nothing was changed; try again in a moment."
}

/** One listing / offer / deal id, shape-checked — exactly one. */
function termAnchor(input: { transactionId?: string | null; offerId?: string | null; listingId?: string | null }):
  { ok: true; anchor: import("@/lib/commission/commission-term-change").TermChangeAnchor } | { ok: false; error: string } {
  const named = [input?.transactionId, input?.offerId, input?.listingId].filter((v) => !!v)
  if (named.length !== 1) return { ok: false, error: "Name the listing, the offer or the deal — exactly one." }
  if (!named.every((v) => isValidUUID(String(v)))) return { ok: false, error: "That listing, offer or deal id is not valid." }
  return { ok: true, anchor: { transactionId: input.transactionId ?? null, offerId: input.offerId ?? null, listingId: input.listingId ?? null } }
}

/** The commission terms of a listing / offer / deal as they stand: the governing agreement, the freeze, who decides, the history. */
export async function getCommissionTermsAction(input: { transactionId?: string | null; offerId?: string | null; listingId?: string | null }) {
  const a = termAnchor(input)
  if (!a.ok) return { success: false as const, error: a.error }
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false as const, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { loadCommissionTermsForChange } = await import("@/lib/commission/commission-term-change")
  const r = await loadCommissionTermsForChange(createServiceClient() as never, s.actor, a.anchor)
  return r.ok ? { success: true as const, view: r.view } : { success: false as const, error: termSentence(r.error) }
}

/** Submit a change to the commission terms (applied at once only where the rules allow; otherwise the broker decides). */
export async function requestCommissionTermChangeAction(input: import("@/lib/commission/commission-term-change").TermChangeInput) {
  const a = termAnchor(input)
  if (!a.ok) return { success: false as const, error: a.error }
  if (input?.evidenceDocumentId && !isValidUUID(String(input.evidenceDocumentId))) return { success: false as const, error: "That document id is not valid." }
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false as const, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { requestCommissionTermChange } = await import("@/lib/commission/commission-term-change")
  const r = await requestCommissionTermChange(createServiceClient() as never, s.actor, {
    ...a.anchor, valueType: input.valueType, value: Number(input.value), reason: String(input.reason ?? ""),
    effectiveDate: String(input.effectiveDate ?? ""), evidenceDocumentId: input.evidenceDocumentId ?? null, idempotencyKey: String(input.idempotencyKey ?? ""),
  })
  if (!r.ok) return { success: false as const, error: termSentence(r.error) }
  if (r.record.anchor.kind === "transaction") revalidatePath(`/dashboard/transactions/${r.record.anchor.id}`)
  revalidatePath("/dashboard/financials/agent")
  return { success: true as const, record: r.record, applied: r.applied, replayed: r.replayed, recalculated: r.recalculated, recheck: r.recheck, noticeError: r.noticeError }
}

/** A finance administrator approves or denies a requested change (approval moves the term and re-runs the waterfall). */
export async function decideCommissionTermChangeAction(input: { adjustmentId: string; decision: "approved" | "denied"; note?: string | null }) {
  if (!isValidUUID(String(input?.adjustmentId ?? ""))) return { success: false as const, error: "That change id is not valid." }
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false as const, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { decideCommissionTermChange } = await import("@/lib/commission/commission-term-change")
  const r = await decideCommissionTermChange(createServiceClient() as never, s.actor, { adjustmentId: input.adjustmentId, decision: input.decision, note: input.note ?? null })
  if (!r.ok) return { success: false as const, error: termSentence(r.error) }
  if (r.record.anchor.kind === "transaction") revalidatePath(`/dashboard/transactions/${r.record.anchor.id}`)
  revalidatePath("/dashboard/financials/payouts")
  return { success: true as const, record: r.record, applied: r.applied, recalculated: r.recalculated, recheck: r.recheck, noticeError: r.noticeError }
}

/** The person who asked withdraws their own still-pending change. */
export async function withdrawCommissionTermChangeAction(input: { adjustmentId: string }) {
  if (!isValidUUID(String(input?.adjustmentId ?? ""))) return { success: false as const, error: "That change id is not valid." }
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false as const, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { withdrawCommissionTermChange } = await import("@/lib/commission/commission-term-change")
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const receipted = await ledgerSessionAction({ brokerageId: s.actor.brokerageId, action: "commission.term_change.withdraw", actor: { type: "user", userId: s.actor.userId, agentId: s.actor.agentId ?? null }, subject: { type: "commission_adjustment", id: input.adjustmentId }, riskClass: "FINANCIAL", reasonCode: "HUMAN_REQUESTED" }, async () => {
  const r = await withdrawCommissionTermChange(createServiceClient() as never, s.actor, { adjustmentId: input.adjustmentId })
  return r.ok ? { success: true as const, record: r.record } : { success: false as const, error: termSentence(r.error) }
  })
  return "record" in receipted ? receipted : { success: false as const, error: receipted.error ?? "Not done" }
}

/** The finance administrators' queue of changes awaiting a decision. */
export async function listPendingCommissionTermChangesAction() {
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false as const, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { listPendingCommissionTermChanges } = await import("@/lib/commission/commission-term-change")
  const r = await listPendingCommissionTermChanges(createServiceClient() as never, s.actor)
  return r.ok ? { success: true as const, records: r.records } : { success: false as const, error: termSentence(r.error) }
}

// ============================================
// CLIENT COMMUNICATIONS
// ============================================

/**
 * Emit a client-friendly plain-language update to the portal and client_friendly_updates table.
 * Respects channel eligibility and consent before any send.
 */
export async function emitClientFriendlyUpdate(params: {
  transactionId: string
  brokerageId: string
  agentId: string
  contactId: string
  updateType: string
  updateText: string
  tone?: string
  sendVia?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  if (!isValidUUID(params.contactId)) return { success: false, error: "Invalid contact ID" }
  const gate = await requireTransactionActor(params.transactionId)
  if (!gate.ok) return { success: false, error: gate.error }
  // The recipient must be a contact of the SAME tenant — a body-supplied contact id
  // from another brokerage would otherwise receive this brokerage's client update.
  {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { data: c, error: cErr } = await createServiceClient()
      .from("contacts").select("id").eq("id", params.contactId).eq("brokerage_id", gate.brokerageId).maybeSingle()
    if (cErr) return { success: false, error: `Could not verify the contact: ${cErr.message}` }
    if (!c) return { success: false, error: "Contact not found" }
  }

  const { emitClientFriendlyUpdateCommand } = await import("@/lib/kernel/transactions")
  return emitClientFriendlyUpdateCommand({ ...params, brokerageId: gate.brokerageId })
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED updateChecklistItem → SURVIVOR app/actions/ai-closing-workflow.ts:275 completeChecklistItem · CALLED BY app/crm/components/closing-workflow-tab.tsx:204 completeChecklistItem
//   Closing-checklist sign-off lives on the closing-workflow tab, through a door that stamps the SESSION user as the attestation,
//   pins the tenant and leaves a receipt. This twin toggled `completed` by bare id with no completed_by at all.

// ============================================
// PARTICIPANTS
// ============================================

export async function addParticipant(participantData: {
  transaction_id: string
  role: string
  name: string
  company?: string
  email?: string
  phone?: string
  license_number?: string
  notes?: string
}) {
  if (!isValidUUID(participantData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addParticipant(participantData)
}

/**
 * WIRED (wave 155, lane 155R30): the deal page's Participants card edits a participant here (its row's "Edit" dialog,
 * app/dashboard/transactions/[id]/transaction-detail-client.tsx) — no other door edits a participant.
 * Made safe (lane 155R28): the participant's deal must pass the session gate (requireDealRowActor), only the participant's own fields are
 * accepted (never transaction_id / brokerage_id — the row cannot be moved to another deal), the write is counted (the service's
 * `.single()` refuses zero rows) and it leaves one receipt.
 */
export async function updateParticipant(
  participantId: string,
  updates: Partial<{
    role: string; name: string; company: string; email: string
    phone: string; license_number: string; notes: string
  }>,
) {
  if (!isValidUUID(participantId)) return { success: false, error: "Invalid participant ID" }
  const refusedFields = Object.keys(updates ?? {}).filter((k) => !PARTICIPANT_FIELDS.has(k))
  if (refusedFields.length > 0) return { success: false, error: `A participant's ${refusedFields.join(", ")} cannot be changed here.` }
  const gate = await requireDealRowActor("transaction_participants", participantId)
  if (!gate.ok) return { success: false, error: gate.error }
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: gate.brokerageId, action: "transaction.participant.update", actor: { type: "user", userId: gate.userId }, subject: { type: "transaction_participant", id: participantId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { transaction_id: gate.transactionId, fields: Object.keys(updates ?? {}) } }, async () => {
  return TransactionService.updateParticipant(participantId, updates)
  }))
}

/** A participant's own fields (live columns of transaction_participants, scripts/schema-snapshot.ts) — never its deal or tenant. */
const PARTICIPANT_FIELDS: ReadonlySet<string> = new Set(["role", "name", "company", "email", "phone", "license_number", "notes"])

/**
 * WIRED (wave 155, lane 155R30): the deal page's Participants card removes a participant here (its row's "Remove" control, after
 * a confirmation — app/dashboard/transactions/[id]/transaction-detail-client.tsx). No other door removes a participant.
 * Made safe (lane 155R28): the session gate on the participant's deal (requireDealRowActor), a COUNTED delete (the service now `.select()`s it —
 * zero rows is a refusal, CLAUDE.md §3) and one receipt.
 */
export async function removeParticipant(participantId: string) {
  if (!isValidUUID(participantId)) return { success: false, error: "Invalid participant ID" }
  const gate = await requireDealRowActor("transaction_participants", participantId)
  if (!gate.ok) return { success: false, error: gate.error }
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: gate.brokerageId, action: "transaction.participant.remove", actor: { type: "user", userId: gate.userId }, subject: { type: "transaction_participant", id: participantId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { transaction_id: gate.transactionId } }, async () => {
  return TransactionService.removeParticipant(participantId)
  }))
}

// ============================================
// LENDERS
// ============================================

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED addLender → SURVIVOR app/actions/multi-persona.ts:264 assignLenderToTransaction · CALLED BY app/dashboard/transactions/[id]/assign-lender-panel.tsx:65 assignLenderToTransaction
//   A lender is a VENDOR CATEGORY (CLAUDE.md §4): it joins a deal on the vendor rail (vendor_assignments + its transaction_lenders
//   row, lib/kernel/lender-linkage.ts), gated, tenant-pinned and receipted. This twin inserted a free-text lender_name row.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED updateLender → SURVIVOR app/actions/lender-portal-actions.ts:421 updateLenderLoanStatus · CALLED BY app/portal/lender/[transactionId]/lender-actions.tsx:112 updateLenderLoanStatus
//   The loan record is the lender seat's own (requireLenderVendorActor): status there, clear-to-close through issueClearToClose
//   (lender-portal-actions.ts:167), appraisal dates through markAppraisalOrderedAction / markAppraisalCompleteAction
//   (app/actions/transaction-milestones.ts, the deal page). This twin was a free patch of any loan row by id.

// ============================================
// TITLE & ESCROW
// ============================================

/**
 * WIRED (wave 155, lane 155R30): the deal page's Title & Escrow card adds the record here when the deal has none (the "Add title &
 * escrow" dialog, app/dashboard/transactions/[id]/transaction-detail-client.tsx). It is the only writer of the title company / officers / escrow number / closing appointment, and the producer of
 * CLOSING_SCHEDULED at the moment the date is written (lib/application/transactions.ts emitClosingScheduled).
 * Made safe (lane 155R28): the session gate on the deal (requireTransactionActor), the SESSION tenant stamped on the row (it was inserted with no
 * brokerage_id, which every tenant-pinned reader then could not see), one record per deal, and one receipt.
 */
export async function addTitleEscrow(data: {
  transaction_id: string
  title_company_name: string
  title_officer_name?: string
  title_officer_email?: string
  title_officer_phone?: string
  escrow_company_name?: string
  escrow_officer_name?: string
  escrow_officer_email?: string
  escrow_officer_phone?: string
  escrow_number?: string
  title_search_ordered_date?: string
  title_search_completed_date?: string
  title_commitment_date?: string
  title_issues?: string
  earnest_money_amount?: number
  earnest_money_held_by?: string
  earnest_money_received_date?: string
  closing_scheduled_date?: string
  closing_location?: string
  notes?: string
}) {
  if (!isValidUUID(data.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  const refusedFields = Object.keys(data ?? {}).filter((k) => k !== "transaction_id" && !TITLE_ESCROW_FIELDS.has(k))
  if (refusedFields.length > 0) return { success: false, error: `The title / escrow record's ${refusedFields.join(", ")} cannot be set here.` }
  const gate = await requireTransactionActor(data.transaction_id)
  if (!gate.ok) return { success: false, error: gate.error }
  // ONE record per deal: every reader resolves it with maybeSingle on transaction_id (the title portal, the closing-date door
  // above), and there is no unique index to refuse a second one — so the door refuses it. Tenant-pinned; a refused read refuses.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data: existing, error: existingErr } = await createServiceClient().from("transaction_title_escrow").select("id")
    .eq("transaction_id", data.transaction_id).eq("brokerage_id", gate.brokerageId).limit(1)
  if (existingErr) return { success: false, error: `Could not check the deal's title / escrow record: ${existingErr.message}` }
  if ((existing ?? []).length > 0) return { success: false, error: "This deal already has a title / escrow record — update it instead." }
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: gate.brokerageId, action: "transaction.title_escrow.add", actor: { type: "user", userId: gate.userId }, subject: { type: "transaction", id: data.transaction_id }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED", detail: { closing_scheduled: !!data.closing_scheduled_date } }, async () => {
  return TransactionService.addTitleEscrow({ ...data, brokerage_id: gate.brokerageId })
  }))
}

/**
 * WIRED (wave 155, lane 155R30): the same dialog on the deal page's Title & Escrow card edits the record here when the deal has one
 * (app/dashboard/transactions/[id]/transaction-detail-client.tsx) — the closing date it sets feeds getClosingDates above and
 * CLOSING_SCHEDULED. Besides it, only the title vendor's own status
 * (app/actions/title-portal.ts updateTitleStatus) and the earnest-money fields (app/actions/transaction-inspections.ts
 * updateEarnestMoneyAction) write this record — nothing else sets the company, officers, escrow number or closing appointment.
 * Made safe (lane 155R28): it took `Record<string, unknown>` straight into the row, so a caller could move the record to another deal or tenant
 * (transaction_id / brokerage_id) or set the title vendor's own `title_status`. Only the detail fields pass; the record's deal must
 * pass the session gate (requireDealRowActor); the write is counted (`.single()` refuses zero rows) and leaves one receipt.
 */
export async function updateTitleEscrow(titleEscrowId: string, updates: Record<string, unknown>) {
  if (!isValidUUID(titleEscrowId)) return { success: false, error: "Invalid title/escrow ID" }
  const refusedFields = Object.keys(updates ?? {}).filter((k) => !TITLE_ESCROW_FIELDS.has(k))
  if (refusedFields.length > 0) return { success: false, error: `The title / escrow record's ${refusedFields.join(", ")} cannot be changed here.` }
  const gate = await requireDealRowActor("transaction_title_escrow", titleEscrowId)
  if (!gate.ok) return { success: false, error: gate.error }
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: gate.brokerageId, action: "transaction.title_escrow.update", actor: { type: "user", userId: gate.userId }, subject: { type: "transaction_title_escrow", id: titleEscrowId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED", detail: { transaction_id: gate.transactionId, fields: Object.keys(updates ?? {}) } }, async () => {
  return TransactionService.updateTitleEscrow(titleEscrowId, updates)
  }))
}

/** The title / escrow record's detail fields (live columns, scripts/schema-snapshot.ts) — never its deal, tenant or title_status. */
const TITLE_ESCROW_FIELDS: ReadonlySet<string> = new Set([
  "title_company_name", "title_company_email", "title_officer_name", "title_officer_email", "title_officer_phone",
  "escrow_company_name", "escrow_officer_name", "escrow_officer_email", "escrow_officer_phone", "escrow_number",
  "title_search_ordered_date", "title_search_completed_date", "title_commitment_date", "title_issues",
  "earnest_money_amount", "earnest_money_held_by", "earnest_money_received_date",
  "closing_scheduled_date", "closing_location", "notes",
])

// ============================================
// INSPECTIONS
// ============================================

// TOMBSTONE (wave 155, lane 155R28 — §1 case 1) RETIRED scheduleInspection → SURVIVOR app/actions/transaction-inspections.ts:41 scheduleInspectionAction · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:1231 scheduleInspectionAction
//   The same insert (it calls the same service writer) with every field of this twin, plus the tenant gate, the
//   INSPECTION_ORDERED portal fan-out and the quote approval. Nothing to merge.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED updateInspection → SURVIVOR app/actions/transaction-inspections.ts:199 markInspectionCompleteAction · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:1314 markInspectionCompleteAction
//   The inspection's verbs live on the deal page: complete (markInspectionCompleteAction) and the report
//   (uploadInspectionReportAction, transaction-inspections.ts:276 ← transaction-detail-client.tsx:1341). This free patch named
//   `report_received`, which is not a column (PGRST204 refuses the whole update) — "report received" is a status value.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 1) RETIRED completeInspection → SURVIVOR app/actions/transaction-inspections.ts:199 markInspectionCompleteAction · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:1314 markInspectionCompleteAction
//   MERGED FIRST: `issuesFound` (the survivor now takes it and writes issues_found). The report URL is the survivor's sibling
//   uploadInspectionReportAction; both emit the portal fan-out this twin's service path emitted (and INSPECTION_COMPLETED too).

// ============================================
// VENDOR SERVICES
// ============================================

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED orderVendorService → SURVIVOR app/actions/vendor-marketplace.ts:355 createVendorBooking · CALLED BY app/components/transactions/suggested-vendors.tsx:94 createVendorBooking
//   A vendor is engaged for a deal on the vendor rail (bookings, RESPA disclosure, the vendor's own seat); the insurance quote has
//   its own door (requestInsuranceQuoteAction). This twin inserted a free-text vendor_name service row with no vendor at all.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED updateVendorService → SURVIVOR app/actions/ai-vendor-management.ts:39 transitionBookingStatus · CALLED BY app/dashboard/components/vendor-bookings-panel.tsx:55 transitionBookingStatus
//   A booking moves through its own state machine there. This twin patched any service row by id and named `paid`, which is not a
//   column (PGRST204). Payment is the vendor-payments rail.

// ============================================
// DOCUMENTS
// ============================================

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED addTransactionDocument → SURVIVOR app/transactions/[transactionId]/page.tsx:256 handleDocumentUpload · CALLED BY app/transactions/[transactionId]/page.tsx:256 handleDocumentUpload
//   A deal document is added by uploading it (store and sign as one step, then the row with the live columns). This twin could
//   never succeed: document_type, document_name, file_url, file_size and requires_signature are not columns of
//   transaction_documents (doc_type / doc_label / storage_url are), so PGRST204 refused every insert.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED updateDocumentStatus → SURVIVOR app/actions/transaction-document-signatures.ts:33 sendDocumentForSignature · CALLED BY app/components/shared/DocumentSignaturePanel.tsx:84 sendDocumentForSignature
//   A document's status moves with what happens to it: sent for signature there, signed by the e-sign webhooks, under review by the
//   auto-filer. This twin wrote a free-text status and a `signed_at` that is not a column (PGRST204 whenever it was given).

/** Staff toggle: show / hide a deal document in the client's portal (wave 98, m690). */
export async function setDocumentClientVisibility(documentId: string, visible: boolean) {
  if (!isValidUUID(documentId)) return { success: false, error: "Invalid document ID" }
  return TransactionService.setDocumentClientVisibility(documentId, visible === true)
}

// ============================================
// TIMELINE
// ============================================

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED addTimelineEntry → SURVIVOR lib/application/transactions.ts:1077 addTimelineEntry · CALLED BY lib/application/transactions.ts:544 addTimelineEntry
//   A deal's timeline is written by the act it records (every service writer calls it in-module — addParticipant, addDeadline,
//   respondToRepairRequest … — and the kernel's emitTransactionEvent). A public door that wrote ANY activity line onto ANY deal
//   with a caller-chosen `performedBy` is not a product verb.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getTransactionTimeline → SURVIVOR app/dashboard/transactions/[id]/page.tsx:317 transaction_timeline · CALLED BY app/dashboard/transactions/[id]/page.tsx:317 transaction_timeline
//   The deal page reads its timeline itself, inside the deal's tenant check.

// ============================================
// DEADLINES
// ============================================

export async function addDeadline(deadlineData: {
  transaction_id: string
  deadline_type: string
  notes: string
  deadline_date: string
}) {
  if (!isValidUUID(deadlineData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addDeadline(deadlineData)
}

/**
 * WIRED (wave 155, lane 155R30): the deal page's Deadlines card edits a deadline's date and label here (its row's "Edit" dialog,
 * app/dashboard/transactions/[id]/transaction-detail-client.tsx). Completion has its door (completeDeadline below); nothing else
 * edits a deadline's date or note. Open design note (not a hold on the door): whether a date change should be recorded as an
 * EXTENSION instead (transaction_deadlines.extension_date / extension_reason — read by lib/deal-health/health-scorer.ts and
 * written by nothing), the way the closing date became an amendment.
 * Made safe (lane 155R28): the deadline's deal must pass the session gate (requireDealRowActor), only its own fields pass (never its deal or
 * tenant), the status vocabulary gate below still runs, the write is counted (`.single()` refuses zero rows), one receipt.
 */
export async function updateDeadline(
  deadlineId: string,
  updates: Partial<{ status: string; deadline_date: string; notes: string; completed_at: string }>,
) {
  if (!isValidUUID(deadlineId)) return { success: false, error: "Invalid deadline ID" }
  const refusedFields = Object.keys(updates ?? {}).filter((k) => !["status", "deadline_date", "notes", "completed_at"].includes(k))
  if (refusedFields.length > 0) return { success: false, error: `A deadline's ${refusedFields.join(", ")} cannot be changed here.` }

  // VOCABULARY GATE (wave 26). `status` arrives here as free text on a
  // "use server" export — a public HTTP endpoint — and
  // lib/application/transactions.ts:1170 passes it straight into
  // transaction_deadlines.status, which is CHECK-constrained. An unadmitted
  // value therefore reached the database and came back as a raw constraint
  // error naming none of the valid states. Validated against the ONE canonical
  // list (lib/transactions/coordination-status.ts:49), the same shape
  // updateListingStatus already uses for listings.status, so the two cannot
  // drift. `completeDeadline` below writes 'completed' as a literal and is
  // unaffected.
  if (updates.status !== undefined && !isDeadlineStatus(updates.status)) {
    return {
      success: false,
      error: `'${String(updates.status)}' is not a deadline status. Valid: ${DEADLINE_STATUSES.join(", ")}`,
    }
  }

  const gate = await requireDealRowActor("transaction_deadlines", deadlineId)
  if (!gate.ok) return { success: false, error: gate.error }
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: gate.brokerageId, action: "transaction.deadline.update", actor: { type: "user", userId: gate.userId }, subject: { type: "transaction_deadline", id: deadlineId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED", detail: { transaction_id: gate.transactionId, fields: Object.keys(updates ?? {}) } }, async () => {
  return TransactionService.updateDeadline(deadlineId, updates)
  }))
}

export async function completeDeadline(deadlineId: string) {
  if (!isValidUUID(deadlineId)) return { success: false, error: "Invalid deadline ID" }
  return TransactionService.completeDeadline(deadlineId)
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getUpcomingDeadlines → SURVIVOR app/dashboard/coordinator/components/os/deadline-intelligence-panel.tsx:15 DeadlineIntelligencePanel · CALLED BY app/dashboard/coordinator/page.tsx:304 DeadlineIntelligencePanel
//   Upcoming deadlines are shown on the coordinator desk (and per deal on the deal page). This door read any agent's deadlines by
//   a caller-supplied agent id.

// ============================================
// COMMISSIONS
// ============================================

export async function addCommission(commissionData: {
  transaction_id: string
  recipient_type: string
  recipient_name: string
  recipient_id?: string
  commission_type: string
  rate_percentage?: number
  flat_amount?: number
  calculated_amount?: number
  split_percentage?: number
  notes?: string
}) {
  if (!isValidUUID(commissionData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addCommission(commissionData)
}

export async function calculateCommissions(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.calculateCommissions(transactionId)
}

export async function markCommissionPaid(commissionId: string, paidDate: string, checkNumber?: string) {
  if (!isValidUUID(commissionId)) return { success: false, error: "Invalid commission ID" }
  return TransactionService.markCommissionPaid(commissionId, paidDate, checkNumber)
}

// ============================================
// REPAIR NEGOTIATIONS
// ============================================

// TOMBSTONE (wave 155, lane 155R28 — §1 case 1) RETIRED submitRepairRequest → SURVIVOR app/actions/transaction-milestones.ts:594 requestRepairAction · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:4408 requestRepairAction
//   The deal page's repair form called this twin once and now calls the survivor (its own comment says so). MERGED FIRST: `notes`.
//   The survivor also stamps the tenant and emits the portal fan-out; the twin inserted with no brokerage_id.

export async function respondToRepairRequest(
  requestId: string,
  response: "accepted" | "rejected" | "counter",
  counterOffer?: number,
  notes?: string,
) {
  if (!isValidUUID(requestId)) return { success: false, error: "Invalid request ID" }
  return TransactionService.respondToRepairRequest(requestId, response, counterOffer, notes)
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED finalizeRepairNegotiation → SURVIVOR app/actions/transaction-milestones.ts:659 completeRepairAction · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:4473 completeRepairAction
//   The end of a repair item is recorded there (status completed, the actual cost — a repair or a credit amount — and the note,
//   tenant-pinned, with its fan-out); an "as is" outcome is a rejection through respondToRepairRequest above (← the same page,
//   transaction-detail-client.tsx:4451). This twin overwrote the item's own `notes` with "Resolved: …".

// ============================================
// DASHBOARD STATS
// ============================================

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getTransactionStats → SURVIVOR app/dashboard/transactions/page.tsx:71 getTransactions · CALLED BY app/dashboard/transactions/page.tsx:71 getTransactions
//   The pipeline page counts its deals from the session-scoped getTransactions above (active, at risk, closing soon — page.tsx:91).
//   This door took a caller-supplied agent id and counted pending documents with no tenant predicate at all.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getPendingDocuments → SURVIVOR app/actions/document-center.ts:76 getDocumentCenterData · CALLED BY app/dashboard/documents/page.tsx:16 getDocumentCenterData
//   Open documents are listed by the document center. This door read every tenant's open documents (no tenant predicate).
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED generateClientTimeline → SURVIVOR lib/application/transactions.ts:354 generateMilestones · CALLED BY lib/application/transactions.ts:262 generateMilestones
//   A deal's milestones come from the ONE catalog, seeded at creation. This door had a model invent milestones and target dates and
//   wrote them as client-visible rows (CLAUDE.md §1 LAW 4: AI does not bypass the business rules).

/**
 * @uncalledDoor case 3 (wave 155, lane 155R28) — owner question: wire "estimate closing costs" on the deal page (its reader, the
 * "Closing Cost Estimate" card, and ClosingCostActualInput already stand on cost_breakdown_tracking, and this is the ONLY writer of
 * those rows) or retire it? Note for the decision: the estimate is MODEL-AUTHORED money; a deterministic estimator would be the
 * honest survivor. Its prompt no longer names an invented "6%" commission (lane 155R30): the model is handed the deal's recorded
 * rate (transactions.commission_percentage) or told it is not on file (lib/application/transactions.ts generateCostBreakdown).
 * Made safe: the session gate on the deal (requireTransactionActor) runs BEFORE the model is reached; the lines that actually
 * landed are COUNTED (zero saved is a refusal, not "done"); one receipt.
 */
export async function generateCostBreakdown(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  const gate = await requireTransactionActor(transactionId)
  if (!gate.ok) return { success: false, error: gate.error }
  const { ledgerSessionAction, resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: gate.brokerageId, action: "transaction.cost_breakdown.generate", actor: { type: "user", userId: gate.userId }, subject: { type: "transaction", id: transactionId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async () => {
  const r = await TransactionService.generateCostBreakdown(transactionId)
  if (r.success && "written" in r && r.written === 0) return { success: false, error: "No closing-cost estimate line was saved." }
  return r
  }))
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED generateStatusUpdate → SURVIVOR app/actions/ai-transaction-coordinator.ts:640 draftTransactionCommunication · CALLED BY app/dashboard/transactions/[id]/ai-coordinator-panel.tsx:231 draftTransactionCommunication
//   A drafted client update is a DRAFT the agent reviews (there); sending one is emitClientFriendlyUpdate above (consent, channel,
//   the recipient proven in the tenant ← transaction-detail-client.tsx:1815). This door wrote a model's text straight into the
//   client's portal feed with no tenant on the row.

export async function generateSmartChecklist(transactionId: string, stage: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.generateSmartChecklist(transactionId, stage)
}

// ── Smart checklist card (transaction detail page) ─────────────────────────
// The reader + completion writer for smart_checklists / task_items. The
// generator above wrote per-deal compliance checklists that no surface could
// show; these are the two halves the card in
// app/dashboard/transactions/[id]/smart-checklist-panel.tsx stands on.

export async function getSmartChecklists(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false as const, error: "Invalid transaction ID" }
  return TransactionService.getSmartChecklists(transactionId)
}

export async function setTaskItemCompleted(taskItemId: string, transactionId: string, completed: boolean) {
  if (!isValidUUID(taskItemId)) return { success: false as const, error: "Invalid task ID" }
  if (!isValidUUID(transactionId)) return { success: false as const, error: "Invalid transaction ID" }
  return TransactionService.setTaskItemCompleted(taskItemId, transactionId, completed)
}

export async function detectTransactionIssues(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  return TransactionService.detectTransactionIssues(transactionId)
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED deliverEducationalContent → SURVIVOR lib/agents/education-delivery-producer.ts:544 produceEducationForEvent · CALLED BY lib/kernel/event-reactor.ts:361 produceEducationForEvent
//   Stage education is proposed at the milestone MOMENT by the kernel event-reactor (and the weekly education-delivery cron as the
//   safety net), through the client-message gate, side-aware and idempotent per contact + module (registry: education_delivery_loop).
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED monitorTransactionHealth → SURVIVOR app/actions/ai-transaction-coordinator.ts:134 analyzeTransactionHealth · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:573 analyzeTransactionHealth
//   The deal page's health analysis runs there (gated, receipted). This door threw on a bad id and on any model failure.

export async function detectTransactionDelays(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  return TransactionService.detectTransactionDelays(transactionId)
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED celebrateMilestone → SURVIVOR lib/transactions/milestone-service.ts:309 completeMilestone · CALLED BY app/actions/transaction-milestones.ts:64 completeMilestone
//   The client hears about a completed milestone from the portal fan-out of the completion itself (MILESTONE_COMPLETED → the
//   portal card). This door posted a canned "celebration" into the portal feed for any milestone name, untenanted.

export async function loadClientDashboard(transactionId: string, contactId?: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  if (contactId && !isValidUUID(contactId)) throw new Error("Invalid contact ID")
  return TransactionService.loadClientDashboard(transactionId, contactId)
}

// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED loadAgentDashboard → SURVIVOR app/dashboard/transactions/page.tsx:71 getTransactions · CALLED BY app/dashboard/transactions/page.tsx:71 getTransactions
//   The agent's pipeline, at-risk deals and upcoming closings are computed on the pipeline page from the session-scoped list.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getAgentTransactionKanban → SURVIVOR app/dashboard/transactions/page.tsx:71 getTransactions · CALLED BY app/dashboard/transactions/page.tsx:71 getTransactions
//   The same page is the board; it reads the deals once, scoped by the session.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED updateTransactionStage → SURVIVOR app/actions/transaction-stage-machine.ts:67 advanceTransactionStage · CALLED BY app/dashboard/transactions/[id]/transaction-detail-client.tsx:682 advanceTransactionStage
//   A deal's stage moves through ONE door: the gate, or the override with its reason (the same door updateTransaction points to).
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED getClientTasks → SURVIVOR app/dashboard/transactions/[id]/page.tsx:308 transaction_tasks · CALLED BY app/dashboard/transactions/[id]/page.tsx:308 transaction_tasks
//   A deal's tasks are read by the deal page (and worked on the coordinator task queue). This door read `tasks` by deal id on the
//   caller's client and was named for clients while returning every task.
// TOMBSTONE (wave 155, lane 155R28 — §1 case 2) RETIRED autoProgressMilestone → SURVIVOR lib/transactions/milestone-service.ts:309 completeMilestone · CALLED BY app/actions/transaction-milestones.ts:64 completeMilestone
//   Completing a milestone — and what follows it: the deadline mirror, the portal card, education at the moment — is the
//   survivor's (← completeMilestoneAction ← the deal page). This door completed EVERY milestone of a deal sharing a name, by name,
//   with no tenant predicate, then posted a celebration and an education assignment of its own.
