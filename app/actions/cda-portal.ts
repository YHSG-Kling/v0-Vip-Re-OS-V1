"use server"

/**
 * app/actions/cda-portal.ts
 *
 * The CDA workflow as the user described it:
 *
 *   ┌───────────────────────────────────────────────────────────────────────┐
 *   │ 1. TC or Title/Closing Attorney uploads PRELIMINARY CD to portal      │
 *   │    → notifyAgentOfPreliminaryCdAction                                 │
 *   │    → CDA row created with status = 'pending' (drafting)               │
 *   │    → notification (canonical `notifications`) + activity to agent     │
 *   │                                                                       │
 *   │ 2. Agent fills out the CDA in the portal                              │
 *   │    → draftOrUpdateCdaAction (writes commission_breakdown + notes)     │
 *   │                                                                       │
 *   │ 3. Agent signs off + submits to compliance                            │
 *   │    → submitCdaForApprovalAction                                       │
 *   │    → status: pending|drafting → submitted                             │
 *   │    → revision row stamped action='submitted'                          │
 *   │                                                                       │
 *   │ 4. Compliance Manager:                                                │
 *   │    a. Approves                                                        │
 *   │       → approveCdaAction                                              │
 *   │       → status: submitted → approved                                  │
 *   │       → triggers downstream commission_distributions flow             │
 *   │    OR                                                                 │
 *   │    b. Sends back with changes                                         │
 *   │       → requestCdaChangesAction(reason)                               │
 *   │       → status: submitted → changes_requested                         │
 *   │       → revision_number incremented                                   │
 *   │       → notification + activity to agent                              │
 *   │                                                                       │
 *   │ 5. Agent makes the changes and re-submits → loops back to step 3      │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * Hard rules:
 *   • Only the assigned agent can draft, edit, or submit the CDA.
 *   • Only compliance_officer / admin / broker / broker_admin / superadmin
 *     can approve or send back.
 *   • Approval is blocked unless the agent has signed off.
 *   • Every state change writes an audit row to
 *     closing_disclosure_agreement_revisions.
 *
 * Tables used (all already in DB — no new tables introduced here):
 *   closing_disclosure_agreement, closing_disclosure_agreement_revisions,
 *   notifications, transaction_documents, activities, transactions
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"
import { revalidatePath } from "next/cache"
import { CDA_APPROVE_ROLES, canApproveCda, canBrokerSignCda, canSendCdaToTitle } from "@/lib/transactions/cda-signing-policy"
import {
  PRELIMINARY_STATEMENT_DOC_TYPES,
  nextPreliminaryStatementVersion,
  reviewOnNewStatementVersion,
  reviewOnCorrectionRequested,
  reviewOnConfirmed,
  cdaFigureGate,
  preliminaryReviewOf,
  comparePreliminaryStatementFigures,
  describePreliminaryDiscrepancies,
  cdaDeliveryRoute,
  deliveryIdempotency,
  type PreliminaryDiscrepancy,
  type StatementFigures,
} from "@/lib/transactions/cda-closing-policy"
import { buildCdaContractVerdict, buildCdaFeeDeduction, expectedGrossFromTerms, sumOutstandingAgentFees, type CdaDiscrepancy, type CdaFeeDeduction } from "@/lib/commission/cda-discrepancy"
import { bestEffort } from "@/lib/db/best-effort"

// ONE ROSTER (wave 142, lane 142C): the seats that may APPROVE a CDA are the seats that may send it
// back, override, close the file and review the preliminary statement —
// lib/transactions/cda-signing-policy.ts CDA_APPROVE_ROLES. The local literal this replaces restated
// it MINUS broker_owner (the brokerage's owner could not send a CDA back or close the file) and PLUS
// 'superadmin', which is dead as a users.user_type (0 live rows; platform staff live in platform_role
// and are never fallen back to it — wave 141 ruling, m780 live).
const COMPLIANCE_ROLES = CDA_APPROVE_ROLES

type CdaAction =
  | "drafted"
  | "submitted"
  | "signed_off"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "cancelled"

async function recordRevision(opts: {
  cdaId: string
  revisionNumber: number
  status: string
  action: CdaAction
  commissionBreakdown?: Record<string, unknown> | null
  notes?: string | null
  changesRequestedNotes?: string | null
  actedBy: string
}) {
  const supabase = await createClient()
  // supabase-js RESOLVES a failed insert — an unchecked `await` here silently
  // drops the audit row for a money instruction. Callers treat the revision log
  // as best-effort (the state change already happened), so this never throws,
  // but a failure is now visible instead of invisible.
  const { error } = await supabase.from("closing_disclosure_agreement_revisions").insert({
    cda_id: opts.cdaId,
    revision_number: opts.revisionNumber,
    status_at_snapshot: opts.status,
    action: opts.action,
    commission_breakdown: opts.commissionBreakdown ?? null,
    notes: opts.notes ?? null,
    changes_requested_notes: opts.changesRequestedNotes ?? null,
    acted_by: opts.actedBy,
  })
  if (error) {
    console.error("[cda-portal] revision audit row NOT written", { cdaId: opts.cdaId, action: opts.action, error: error.message })
  }
}

// ─── Contract / split compliance verdict ─────────────────────────────────────
//
// The business step the compliance officer performs at approval: "be sure the
// agent's contract with the brokerage agrees with the split and cap." We compute
// it LIVE (always reflects the CURRENT contract — a stored snapshot could go stale
// between submit and approve) from agent_commission_profiles + agent_cap_tracking
// and the CDA's own gross/agent_net. A capped agent keeps 100%, so the effective
// split is 100 once cap_paid_to_date ≥ cap_amount. A BLOCKER-level mismatch must be
// resolved (or manually overridden, same as the signature gate) before approval.

// UN-EXPORTED (§1.1, 2026-08-31, lane M4): only the private
// loadCdaContractVerdict below names it; the export claimed an entry point no
// file used. (Types may be exported from a "use server" file — this is about
// the reader, not the rule.)
interface CdaContractVerdict {
  passed: boolean
  discrepancies: CdaDiscrepancy[]
  contractSplitPct: number | null
  capReached: boolean
  /** Unpaid fees the agent owes the brokerage — must be deducted in the CDA. */
  outstandingFees: number
  /** The DEDUCTION LINE those fees become on the CDA (wave 26). The total above
   *  says how much is owed; this says what it does to the agent's disbursement:
   *  `netAfterFees` = the agent's post-split share MINUS the fees, or null when
   *  the share is unknown. Compliance confirms this line appears on the CDA.
   *  SURFACES, DOES NOT BLOCK — a fee deduction is not a split discrepancy, and
   *  buildCdaFeeDeduction's own contract keeps the two apart
   *  (lib/commission/cda-discrepancy.ts:126-129). `passed` is unaffected. */
  feeDeduction: CdaFeeDeduction
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

async function loadCdaContractVerdict(
  supabase: SupabaseClient,
  cda: { transaction_id: string; brokerage_id: string; agent_id: string; gross_commission: number | null; agent_net: number | null },
): Promise<CdaContractVerdict | null> {
  // cda.agent_id is agents-class, the same class agent_commission_profiles,
  // agent_cap_tracking and agent_fee_charges key on — so all three read
  // directly off it. No agent on the CDA means no contract to check against.
  const cdaAgentRecordId = cda.agent_id ?? null
  if (!cdaAgentRecordId) return null

  const [{ data: txn }, { data: profile }, { data: cap }, { data: feeCharges }] = await Promise.all([
    supabase.from("transactions")
      .select("estimated_commission, purchase_price, commission_percentage")
      .eq("id", cda.transaction_id).maybeSingle(),
    supabase.from("agent_commission_profiles")
      .select("split_percent, cap_amount")
      .eq("agent_id", cdaAgentRecordId).eq("is_active", true)
      .order("effective_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("agent_cap_tracking")
      .select("cap_amount, cap_paid_to_date")
      .eq("agent_id", cdaAgentRecordId).eq("brokerage_id", cda.brokerage_id)
      .order("cap_paid_to_date", { ascending: false }).limit(1).maybeSingle(),
    // OUTSTANDING FEES — unpaid charges the agent owes the brokerage, to be deducted in the CDA.
    supabase.from("agent_fee_charges")
      .select("amount, status, paid_at")
      .eq("agent_id", cdaAgentRecordId).eq("brokerage_id", cda.brokerage_id)
      .in("status", ["open", "overdue"]),
  ])

  const outstandingFees = sumOutstandingAgentFees(
    (feeCharges ?? []) as Array<{ amount?: number | null; status?: string | null; paid_at?: string | null }>,
  )

  const contractSplit = (profile as { split_percent?: number | null } | null)?.split_percent ?? null
  // No contract on file ⇒ nothing to check against (grandfathered, like signature_check null).
  // An agent can still owe fees with no split on file — but with no split we can't compute the
  // expected post-fee net, so there's nothing to gate on here.
  if (contractSplit == null || !Number.isFinite(contractSplit)) return null

  const capAmount = Number((cap as { cap_amount?: number } | null)?.cap_amount ?? (profile as { cap_amount?: number } | null)?.cap_amount ?? 0)
  const capPaid = Number((cap as { cap_paid_to_date?: number } | null)?.cap_paid_to_date ?? 0)
  const capReached = capAmount > 0 && capPaid >= capAmount
  const effectiveSplit = capReached ? 100 : contractSplit

  // Commission verdict is split-only. Outstanding tech/desk fees are a SEPARATE deduction line
  // (returned alongside), never folded into the split discrepancy.
  const verdict = buildCdaContractVerdict({
    computedGross: Number(cda.gross_commission ?? 0),
    computedAgentNet: Number(cda.agent_net ?? 0),
    expectedGross: expectedGrossFromTerms((txn ?? {}) as Record<string, number | null>),
    contractSplitPct: effectiveSplit,
  })

  // ── THE FEES BECOME A DEDUCTION LINE, NOT JUST A TOTAL (§1 wire, wave 26) ──
  // sumOutstandingAgentFees has been wired since the fee rail landed, and the
  // total rode the verdict and the queue row — but the half that turns it into
  // the CDA's deduction (and the agent's post-fee disbursement) had no caller,
  // so the fees were COUNTED and DISPLAYED and never DEDUCTED. The agent's net
  // on the CDA read as the pre-fee split.
  //
  // agent_net is the post-split, PRE-fee share, which is exactly what
  // buildCdaFeeDeduction expects as `agentCommissionShare`; it returns null for
  // netAfterFees when the share is unknown rather than inventing one.
  const feeDeduction = buildCdaFeeDeduction({
    outstandingFees,
    agentCommissionShare: cda.agent_net == null ? null : Number(cda.agent_net),
  })

  return { ...verdict, contractSplitPct: contractSplit, capReached, outstandingFees, feeDeduction }
}

// The compliance review panel surfaces this verdict for every CDA in its queue via the batched
// listCdasForComplianceReviewAction (one set of lookups for the whole queue); approveCdaAction
// re-checks it live as the hard gate below. No per-CDA read action needed.

// Platform-membership disposition for a brokerage — do the in-app broker-side steps apply, or must the
// CDA be handled through the agent's external form platform (a solo agent whose brokerage isn't on the
// platform)? Loaded from the explicit membership flag set at account creation.
async function loadCdaDispositionRoute(
  supabase: SupabaseClient,
  brokerageId: string,
): Promise<"in_app" | "external_form_platform"> {
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("plan_tier, brokerage_on_platform")
    .eq("id", brokerageId)
    .maybeSingle()
  const { resolveDispositionRoute } = await import("@/lib/platform/disposition-route")
  return resolveDispositionRoute({
    planTier: (brokerage as { plan_tier?: string | null } | null)?.plan_tier ?? null,
    brokerageOnPlatform: (brokerage as { brokerage_on_platform?: boolean | null } | null)?.brokerage_on_platform ?? null,
  }).route
}

// ─── 1. Preliminary CD upload trigger ────────────────────────────────────────

/**
 * Called immediately after a TC or title/closing-attorney user inserts a
 * row into transaction_documents with doc_type IN ('preliminary_closing_disclosure',
 * 'closing_disclosure'). Idempotent — if a CDA already exists for the
 * transaction, the prelim CD pointer is just attached to it.
 */
export async function notifyAgentOfPreliminaryCdAction(input: {
  transactionId: string
  documentId: string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id, property_address")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("id, user_id")
    .eq("id", txn.agent_id ?? "")
    .maybeSingle()

  if (!agent?.user_id) return { success: false as const, error: "agent_user_not_found" }

  // ── VERSIONING (wave 142, lane 142C; owner: "attach to the transaction with versioning … revised
  // official statement → version retained"). Every statement upload is its own transaction_documents
  // row; the CDA points at the LATEST (preliminary_cd_document_id) and carries the review state of
  // that version in field_values.preliminary_statement, with every prior version's terminal state
  // kept in its history. A revised statement re-opens the review (pending_review) — a correction
  // request is never left standing against a document that was replaced.
  const { data: priorStatements, error: priorStatementsErr } = await supabase
    .from("transaction_documents")
    .select("id, doc_type")
    .eq("transaction_id", input.transactionId)
    .eq("brokerage_id", txn.brokerage_id)
    .in("doc_type", [...PRELIMINARY_STATEMENT_DOC_TYPES])
    .neq("id", input.documentId)
  if (priorStatementsErr) console.error("[cda-portal] prior statement read refused — version counted from 1:", priorStatementsErr.message)
  const statementVersion = nextPreliminaryStatementVersion(priorStatements ?? [])
  const receivedAt = new Date().toISOString()

  // Find or create the CDA row.
  const { data: existing } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, revision_number, field_values")
    .eq("transaction_id", input.transactionId)
    .maybeSingle()

  let cdaId: string
  if (existing) {
    const priorValues = ((existing as { field_values?: Record<string, unknown> | null }).field_values ?? {}) as Record<string, unknown>
    const review = reviewOnNewStatementVersion(preliminaryReviewOf(priorValues), { version: statementVersion, documentId: input.documentId, at: receivedAt })
    const { error: prelimCdErr } = await supabase
      .from("closing_disclosure_agreement")
      .update({
        preliminary_cd_uploaded_at: receivedAt,
        preliminary_cd_document_id: input.documentId,
        preliminary_cd_uploaded_by: auth.userId,
        field_values: { ...priorValues, preliminary_statement: review },
        // Don't downgrade status if the agent already started drafting.
      })
      .eq("id", existing.id)
    if (prelimCdErr) return { success: false as const, error: `Could not record the preliminary CD upload: ${prelimCdErr.message}` }
    cdaId = existing.id
  } else {
    const review = reviewOnNewStatementVersion(null, { version: statementVersion, documentId: input.documentId, at: receivedAt })
    const { data: created, error } = await supabase
      .from("closing_disclosure_agreement")
      .insert({
        transaction_id: input.transactionId,
        brokerage_id: txn.brokerage_id,
        agent_id: agent.id,
        status: "pending",
        preliminary_cd_uploaded_at: receivedAt,
        preliminary_cd_document_id: input.documentId,
        preliminary_cd_uploaded_by: auth.userId,
        field_values: { preliminary_statement: review },
        revision_number: 1,
      })
      .select("id")
      .single()
    if (error || !created) return { success: false as const, error: error?.message ?? "create_failed" }
    cdaId = created.id
  }
  const versionLabel = statementVersion > 1 ? ` (revised statement, version ${statementVersion})` : ""

  // Keep-one: closing_notifications was a write-only ledger (nothing reads it);
  // `notifications` below is the canonical in-app surface and already carries
  // this exact closing event to the same agent — repointed, duplicate removed.

  // In-app notification + activity (existing tables). Blind-spot burn-down
  // (lane 75D, notification fan-out census) — bestEffort (this file's own
  // wrapper, §6): `supabase` here is the cookie session client, so
  // sentinelWrite's self_heal_events ledger write would be RLS-refused.
  await bestEffort(supabase.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: txn.brokerage_id,
    type: "preliminary_cd_received",
    title: statementVersion > 1 ? "Revised preliminary statement received" : "Preliminary CD ready",
    body: `Preliminary CD uploaded${txn.property_address ? ` for ${txn.property_address}` : ""}${versionLabel}. ${statementVersion > 1 ? "Review the corrected figures against the executed contract and the waterfall." : "Draft your CDA now."}`,
    entity_type: "transaction",
    entity_id: input.transactionId,
    priority: "high",
    channel: "in_app",
  }), "the preliminary CD upload itself already succeeded; this is only the agent heads-up")

  // The record that the preliminary CD arrived and a CDA draft is now required.
  // A lost row here is a compliance step nobody knows is outstanding.
  const { error: prelimCdActivityError } = await supabase.from("activities").insert({
    transaction_id: input.transactionId,
    brokerage_id: txn.brokerage_id,
    agent_id: txn.agent_id,
    entity_type: "transaction",
    activity_type: "preliminary_cd_received",
    title: statementVersion > 1 ? `Preliminary statement received — version ${statementVersion}` : "Preliminary CD received",
    description: `TC / title uploaded the preliminary closing disclosure${versionLabel}. ${statementVersion > 1 ? "Review it against the executed contract + waterfall." : "CDA draft required."}`,
    priority: "high",
    status: "pending",
    notes: JSON.stringify({ cda_id: cdaId, document_id: input.documentId, version: statementVersion }),
  })
  if (prelimCdActivityError) {
    console.error("[cdaPortal] preliminary_cd_received activity REJECTED — the CDA-required step will not appear on the transaction:", prelimCdActivityError.message)
  }

  // ── Cross-party notifications + task (additive) ───────────────────────
  // Existing code above notified the AGENT. Spec calls for cross-portal
  // fan-out so TC + buyer/seller portals also see the CD landed.

  // Resolve TC for this transaction (if assigned) and notify them too.
  const { data: txnFull } = await supabase
    .from("transactions")
    .select("coordinator_id, buyer_contact_id, seller_contact_id, contact_id")
    .eq("id", input.transactionId)
    .maybeSingle()
  const tcUserId = (txnFull as any)?.coordinator_id ?? null
  if (tcUserId) {
    await bestEffort(supabase.from("notifications").insert({
      user_id:      tcUserId,
      brokerage_id: txn.brokerage_id,
      type:         "preliminary_cd_received",
      title:        "Preliminary CD ready for CDA",
      body:         `Preliminary CD uploaded${txn.property_address ? ` for ${txn.property_address}` : ""}. Coordinate with the agent on the CDA.`,
      entity_type:  "transaction",
      entity_id:    input.transactionId,
      priority:     "high",
      channel:      "in_app",
    }), "the preliminary CD upload itself already succeeded; this is only the TC heads-up")
  }

  // Create a "Draft and submit CDA" task for the agent so it shows up in
  // their tasks queue alongside the notification. Resolve agents.id as
  // assigned_to_agent_id (FK target).
  const { error: cdaTaskErr } = await supabase.from("tasks").insert({
    brokerage_id:         txn.brokerage_id,
    contact_id:           (txnFull as any)?.buyer_contact_id
                          ?? (txnFull as any)?.contact_id
                          ?? null,
    transaction_id:       input.transactionId,
    assigned_to_agent_id: txn.agent_id,
    title:                "Draft and submit CDA",
    description:          `Preliminary CD landed. Open the transaction to draft your commission disbursement, sign off, and submit to compliance for approval.`,
    due_date:             new Date(Date.now() + 2 * 86_400_000).toISOString(),
    assignee_type:        "agent",
    source:               "cda_workflow",
    status:               "pending",
    priority:             "high",
  })
  if (cdaTaskErr) console.error(`[cda-portal] 'Draft and submit CDA' task NOT created: ${cdaTaskErr.message}`)

  // Fan out via the canonical kernel event router so any sequences listening
  // for CD_RECEIVED auto-enroll, buyer/seller portals get a transparency
  // update (when a template exists for the event), and downstream listeners
  // pick it up uniformly.
  try {
    // emitKernelEvent also writes the cd_received audit row this path never had.
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const { KernelEvent }     = await import("@/lib/kernel/events")
    await emitKernelEvent({
      event:           KernelEvent.CD_RECEIVED,
      brokerageId:     txn.brokerage_id,
      entityType:      "transaction",
      entityId:        input.transactionId,
      transactionId:   input.transactionId,
      buyerContactId:  (txnFull as any)?.buyer_contact_id  ?? undefined,
      sellerContactId: (txnFull as any)?.seller_contact_id ?? undefined,
      contactId:       (txnFull as any)?.contact_id        ?? undefined,
      agentUserId:     auth.userId,
      actorUserId:     auth.userId,
      metadata:        { cdaId, documentId: input.documentId, version: statementVersion },
    })
  } catch { /* fan-out is best-effort; agent + TC already notified above */ }

  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true as const, cdaId, version: statementVersion }
}

// ─── 2. Agent draft / update ─────────────────────────────────────────────────

export async function draftOrUpdateCdaAction(input: {
  transactionId: string
  commissionBreakdown: Record<string, unknown>
  notes?: string
  grossCommission?: number
  agentNet?: number
  brokerageNet?: number
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }
  // Only the assigned agent can draft.
  if (auth.agentId !== txn.agent_id) {
    return { success: false as const, error: "only_assigned_agent_can_draft" }
  }

  const { data: existing } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, status, revision_number")
    .eq("transaction_id", input.transactionId)
    .maybeSingle()

  // Lock once approved.
  if (existing && existing.status === "approved") {
    return { success: false as const, error: "cda_already_approved" }
  }

  // Status transitions: pending|changes_requested → drafting; submitted stays.
  const nextStatus =
    !existing || existing.status === "pending" || existing.status === "awaiting_preliminary_cd"
      ? "drafting"
      : existing.status === "changes_requested"
        ? "drafting"
        : existing.status

  const payload = {
    commission_breakdown: input.commissionBreakdown,
    notes: input.notes ?? null,
    gross_commission: input.grossCommission ?? null,
    agent_net: input.agentNet ?? null,
    brokerage_net: input.brokerageNet ?? null,
    status: nextStatus,
    agent_drafted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  let cdaId: string
  let revision = 1
  if (existing) {
    cdaId = existing.id
    revision = existing.revision_number
    const { error: cdaSaveErr } = await supabase.from("closing_disclosure_agreement").update(payload).eq("id", cdaId)
    if (cdaSaveErr) return { success: false as const, error: `Could not save the CDA: ${cdaSaveErr.message}` }
  } else {
    const { data: created, error } = await supabase
      .from("closing_disclosure_agreement")
      .insert({
        ...payload,
        transaction_id: input.transactionId,
        brokerage_id: txn.brokerage_id,
        // The gate above already established auth.agentId === txn.agent_id, so
        // the assigned agent's agents id is what this row is stamped with.
        agent_id: txn.agent_id,
        revision_number: 1,
      })
      .select("id")
      .single()
    if (error || !created) return { success: false as const, error: error?.message ?? "create_failed" }
    cdaId = created.id
  }

  await recordRevision({
    cdaId,
    revisionNumber: revision,
    status: nextStatus,
    action: "drafted",
    commissionBreakdown: input.commissionBreakdown,
    notes: input.notes ?? null,
    actedBy: auth.userId,
  })

  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true as const, cdaId, status: nextStatus }
}

// ─── 3. Agent sign-off + submit ──────────────────────────────────────────────

export async function submitCdaForApprovalAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, status, revision_number, generated_pdf_url, field_values, gross_commission, agent_net")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  // Both sides are agents-class now: auth.agentId is agents.id (lib/kernel/api-auth
  // says so in capitals) and so is cda.agent_id. Comparing across the two id
  // spaces is what used to lock the assigned agent out of their own CDA.
  if (!auth.agentId || auth.agentId !== cda.agent_id) {
    return { success: false as const, error: "only_assigned_agent_can_submit" }
  }
  if (!["pending", "drafting", "changes_requested"].includes(cda.status)) {
    return { success: false as const, error: `cannot_submit_from_status:${cda.status}` }
  }

  // ── FULL DOCUMENT COMPLIANCE, BEFORE THE CDA CAN BE ACCEPTED ───────────────
  // The owner's process: the preliminary HUD arrives, the agent fills the CDA
  // from the brokerage's template, and FULL COMPLIANCE OF ALL DOCUMENTS IN THE
  // FILE IS RUN BEFORE THE CDA IS ACCEPTED. This rail had a signature pre-scan
  // and a contract/fee audit but never checked the deal FILE — so a CDA could
  // reach the compliance officer with disclosures missing, documents rejected
  // or signatures outstanding, and the first person to notice would be the
  // closing agent holding a disbursement instruction for an incomplete deal.
  // runFinalComplianceCheck is the canonical gate (required documents present,
  // nothing rejected, every signature/initial complete, no open blocking
  // compliance check) and it reuses canProceedToClosingPrep rather than
  // re-implementing it. BLOCKING, with the blockers named so the agent knows
  // what to fix — an unexplained refusal on a commission is worse than none.
  const { runFinalComplianceCheck } = await import("@/lib/transactions/final-compliance-check")
  const fileCheck = await runFinalComplianceCheck(cda.transaction_id, cda.brokerage_id)
  if (!fileCheck.passed) {
    return {
      success: false as const,
      error: "final_compliance_failed",
      blockers: fileCheck.blockers,
    }
  }

  const now = new Date().toISOString()

  // CONTRACT/FEE AUDIT at submit — the AI matches the agent's brokerage CONTRACT (split + cap)
  // and OUTSTANDING FEES against the CDA the agent filled in, and stamps the verdict onto the CDA
  // so the compliance packet is complete the moment it lands: the signature last-scan (below) PLUS
  // the contract/CDA discrepancies + fee deduction check, on record at submit. Best-effort — the
  // live queue re-computes it and approveCdaAction re-checks it as the hard gate.
  let submitAudit: Record<string, unknown> | null = null
  let submitVerdict: Awaited<ReturnType<typeof loadCdaContractVerdict>> | null = null
  try {
    submitVerdict = await loadCdaContractVerdict(supabase, cda as Parameters<typeof loadCdaContractVerdict>[1])
    if (submitVerdict) {
      submitAudit = {
        at: now,
        passed: submitVerdict.passed,
        contract_split_pct: submitVerdict.contractSplitPct,
        cap_reached: submitVerdict.capReached,
        outstanding_fees: submitVerdict.outstandingFees,
        // THE DEDUCTION LINE, beside the total it comes from (wave 26). This is
        // what compliance confirms appears on the CDA, and what makes the
        // agent's disbursement readable as share − fees rather than the raw
        // split. Surfaced, never a blocker: `passed` above is untouched by it.
        fee_deduction: {
          amount:         submitVerdict.feeDeduction.amount,
          required:       submitVerdict.feeDeduction.required,
          net_after_fees: submitVerdict.feeDeduction.netAfterFees,
        },
        discrepancies: submitVerdict.discrepancies,
      }
    }
  } catch { /* audit is informational at submit; approval gate still enforces */ }

  // PLATFORM-MEMBERSHIP DISPOSITION — where do the broker-side steps run? If the brokerage is not on
  // the platform (a solo agent whose managing brokerage isn't a customer), there's no in-app broker /
  // compliance user, so the CDA is handled through the agent's EXTERNAL form platform, not the in-app
  // compliance→broker-sign queue.
  const { data: subBrokerage } = await supabase
    .from("brokerages")
    .select("plan_tier, brokerage_on_platform")
    .eq("id", cda.brokerage_id)
    .maybeSingle()
  const { resolveDispositionRoute } = await import("@/lib/platform/disposition-route")
  const disposition = resolveDispositionRoute({
    planTier: (subBrokerage as { plan_tier?: string | null } | null)?.plan_tier ?? null,
    brokerageOnPlatform: (subBrokerage as { brokerage_on_platform?: boolean | null } | null)?.brokerage_on_platform ?? null,
  })

  // AUTONOMOUS DISPUTE DETECTION — a BLOCKER contract mismatch means the CDA's split/gross doesn't
  // agree with the agent's contract. The Finance Manager acts: auto-file the dispute for the on-platform
  // broker, or flag the agent to raise it with their external brokerage. Best-effort.
  try {
    const { autoDetectCommissionDispute } = await import("@/lib/finance/auto-dispute")
    await autoDetectCommissionDispute(supabase, {
      transactionId: cda.transaction_id,
      brokerageId: cda.brokerage_id,
      discrepancies: submitVerdict?.discrepancies ?? null,
      dispositionRoute: disposition.route,
    })
  } catch { /* auto-dispute is best-effort — the approval gate still blocks a mismatch */ }

  // The AGENT signs the CDA via their configured e-sign provider BEFORE it goes to
  // compliance (per spec). Provider-agnostic + best-effort; the in-app sign-off below
  // is the authoritative gate and is never blocked by an e-sign transport failure.
  const { data: subTxn } = await supabase
    .from("transactions")
    .select("property_address")
    .eq("id", cda.transaction_id)
    .maybeSingle()
  const { dispatchCdaSignerEsign } = await import("@/lib/transactions/cda-esign")
  const agentEsign = await dispatchCdaSignerEsign(supabase, {
    brokerageId: cda.brokerage_id,
    signerUserId: auth.userId,
    signerRole: "agent",
    transactionId: cda.transaction_id,
    filledPdfUrl: (cda as { generated_pdf_url?: string | null }).generated_pdf_url ?? null,
    propertyAddress: (subTxn as { property_address?: string | null } | null)?.property_address ?? null,
  })

  const submitPriorFieldValues = ((cda as { field_values?: Record<string, unknown> | null }).field_values ?? {}) as Record<string, unknown>
  const { error: cdaSubmitErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "submitted",
      agent_signed_off_at: now,
      agent_signed_off_by: auth.userId,
      agent_submitted_at: now,
      agent_submitted_by: auth.userId,
      field_values: { ...submitPriorFieldValues, agent_esign: { mode: agentEsign.mode, provider: agentEsign.provider, envelope_id: agentEsign.envelopeId ?? null, status: agentEsign.status ?? null, handoff_url: agentEsign.handoffUrl ?? null, dispatched: agentEsign.dispatched, reason: agentEsign.reason, at: now }, disposition: disposition.route, ...(submitAudit ? { submit_audit: submitAudit } : {}) },
      updated_at: now,
    })
    .eq("id", cda.id)
  if (cdaSubmitErr) return { success: false as const, error: `Could not submit the CDA: ${cdaSubmitErr.message}` }

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "submitted",
    action: "submitted",
    actedBy: auth.userId,
  })

  // DISCREPANCY SURFACE — carried over from the deleted cda-workflow.ts, which
  // raised a cda_review_required activity when the computed commission disagreed
  // with the contract. Here the same check is strictly stronger (live split, cap
  // and outstanding fees, not just gross), so the activity now rides the verdict
  // that actually gates approval instead of a parallel comparison.
  if (submitVerdict && !submitVerdict.passed) {
    await bestEffort(
      supabase.from("activities").insert({
        transaction_id: cda.transaction_id,
        brokerage_id:   cda.brokerage_id,
        entity_type:    "transaction",
        activity_type:  "cda_review_required",
        title:          "CDA discrepancy — review before approving",
        description:    `The submitted CDA disagrees with the agent's contract in ${submitVerdict.discrepancies.length} place${submitVerdict.discrepancies.length === 1 ? "" : "s"}. Approval is blocked until it is resolved or manually overridden.`,
        priority:       "urgent",
        status:         "pending",
        notes:          JSON.stringify({ cda_id: cda.id, discrepancies: submitVerdict.discrepancies }),
      }),
      "this only SURFACES the discrepancy for a human; approval is blocked by submitVerdict itself, not by this row, so losing it must not roll back a CDA the agent has already submitted — but the loss is now logged instead of silent",
    )
  }

  // Run signature/initials pre-scan so compliance sees gate status the
  // moment the CDA hits their queue. Best-effort — never blocks submission.
  // Approval-time gate is enforced separately in approveCdaAction.
  try {
    await runSignatureCheckForCdaAction({ cdaId: cda.id })
  } catch { /* informational pre-scan; approval gate still enforces */ }

  // KERNEL LEDGER. Carried over from lib/transactions/cda-workflow.ts (deleted —
  // it was a second, weaker rail on this same table). The lifecycle ledger is how
  // the OS reconstructs what happened to a deal; losing the cda.submitted event
  // when the duplicate went away would have left a hole in the audit trail.
  try {
    const { transitionLifecycle } = await import("@/lib/kernel/lifecycle")
    await transitionLifecycle({
      brokerageId: cda.brokerage_id,
      entityType:  "transaction",
      entityId:    cda.transaction_id,
      fromState:   "cda_pending",
      toState:     "cda_submitted",
      actorUserId: auth.userId,
      actorRole:   "agent",
      eventType:   "cda.submitted",
      metadata:    { cda_id: cda.id, disposition: disposition.route },
    })
  } catch { /* ledger is best-effort — the CDA already moved */ }

  if (disposition.route === "external_form_platform") {
    // No in-app broker/compliance — the broker-side steps happen through the agent's external form
    // platform. Tell the AGENT the CDA is theirs to route to their brokerage; skip the in-app queue.
    await bestEffort(supabase.from("notifications").insert({
      user_id: auth.userId,
      brokerage_id: cda.brokerage_id,
      type: "cda_route_external",
      title: "Send your signed CDA to your brokerage",
      body: "Your brokerage isn't on the platform, so your signed CDA is ready to send through your configured form platform for their broker signature and compliance.",
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    }), "the CDA disposition itself already recorded; this is only the agent heads-up")
  } else {
    // Notify in-app compliance for the brokerage.
    const { data: complianceUsers } = await supabase
      .from("users")
      .select("id")
      .eq("brokerage_id", cda.brokerage_id)
      .in("user_type", ["compliance_officer", "admin", "broker"])

    for (const u of complianceUsers ?? []) {
      await bestEffort(supabase.from("notifications").insert({
        user_id: u.id,
        brokerage_id: cda.brokerage_id,
        type: "cda_submitted",
        title: "CDA submitted for approval",
        body: "Agent has signed off and submitted a CDA for review.",
        entity_type: "transaction",
        entity_id: cda.transaction_id,
        priority: "medium",
        channel: "in_app",
      }), "the CDA submission itself already recorded; this is only the compliance heads-up")
    }
  }

  // Keep-one: closing_notifications was a write-only ledger (nothing reads it,
  // and this row carried no recipient). The canonical `notifications` inserts
  // above already deliver cda_submitted to the real audience (compliance users,
  // or the solo agent on the external route) — repointed, duplicate removed.

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const }
}

// ─── 4a. Compliance approves ─────────────────────────────────────────────────

export async function approveCdaAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select(
      "id, transaction_id, brokerage_id, agent_id, status, agent_signed_off_at, revision_number, signature_check_passed, manual_override_by, gross_commission, agent_net, field_values",
    )
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  // Platform-membership guard — in-app compliance approval only applies when the brokerage is on the
  // platform. For a solo agent whose brokerage is external, there's no in-app compliance officer; the
  // CDA is approved/signed through their external form platform.
  if ((await loadCdaDispositionRoute(supabase, cda.brokerage_id)) === "external_form_platform") {
    return { success: false as const, error: "handled_via_external_form_platform" }
  }
  // Shared state-machine gate (compliance role + submitted status + agent e-signed).
  const approveVerdict = canApproveCda({ status: cda.status, agentSignedOff: !!cda.agent_signed_off_at, role: auth.userType })
  if (!approveVerdict.ok) return { success: false as const, error: approveVerdict.error }
  // FIGURE GATE (wave 142, lane 142C; owner: "broker cannot approve a CDA on unresolved inaccurate
  // figures"): a correction request against the title company's preliminary statement is still open —
  // the revised official statement has not arrived — so the disbursement cannot be authorized against
  // figures everyone agrees are wrong. No override: the fix is title's corrected statement.
  const figureGate = cdaFigureGate(preliminaryReviewOf((cda as { field_values?: Record<string, unknown> | null }).field_values))
  if (!figureGate.ok) return { success: false as const, error: figureGate.error }
  // Approval gate — required signatures/initials must be present on every
  // transaction document, OR a compliance manager must have invoked manual
  // override (with a logged reason). signature_check_passed === null is
  // grandfathered for legacy CDAs created before the gate existed.
  if (cda.signature_check_passed === false && !cda.manual_override_by) {
    return {
      success: false as const,
      error: "signature_check_failed_use_manual_override",
    }
  }
  // Contract gate — the agent's brokerage CONTRACT (split + cap) must agree with
  // the CDA's split. A BLOCKER-level mismatch can't be approved without the same
  // manual override the signature gate uses. Computed live from the current contract.
  const contractVerdict = await loadCdaContractVerdict(supabase, cda)
  if (contractVerdict && !contractVerdict.passed && !cda.manual_override_by) {
    return {
      success: false as const,
      error: "contract_check_failed_use_manual_override",
    }
  }

  const now = new Date().toISOString()
  // Compliance APPROVES — it does NOT apply the broker's signature. broker_approved_at
  // / broker_id are set later by brokerSignCdaAction (a separate, explicit step), and
  // the cda_delivered milestone completes only when the signed CDA is sent to title.
  const { error: cdaApproveErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "approved",
      compliance_approved_at: now,
      compliance_approved_by: auth.userId,
      updated_at: now,
    })
    .eq("id", cda.id)
  if (cdaApproveErr) return { success: false as const, error: `Could not record compliance approval: ${cdaApproveErr.message}` }

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "approved",
    action: "approved",
    actedBy: auth.userId,
  })

  // KERNEL LEDGER — carried over from the deleted lib/transactions/cda-workflow.ts.
  // NOTE the deliberate difference from that rail: it completed the cda_delivered
  // milestone HERE and shipped the disbursement authorization to title the instant
  // compliance approved, skipping the broker's signature entirely. The owner's
  // process is compliance approves → the BROKER SIGNS → it is sent to the closing
  // agent with a record of the send, so the milestone stays with
  // sendCdaToTitleAction where the delivery actually happens.
  //
  // eventType was the dotted string "cda.approved" (CLAUDE.md §6 defect class —
  // lib/kernel/lifecycle.ts's identity arm only accepts a lifecycle STATE name it
  // has a key for, or a canonical KernelEvent VALUE; "cda.approved" is neither, so
  // processKernelEvent was NEVER CALLED here). KernelEvent.CDA_APPROVED IS that
  // value ('cda_approved') and is a live campaign_sequences.trigger_event
  // (scripts/check-vocabularies.ts) with zero writers before this — a brokerage
  // that configured a sequence on it could never have had it fire (kernel-event-census-z1
  // NEITHER list). The reactor's enrollMatchingSequences (lib/kernel/event-reactor.ts:144)
  // runs generically on every processKernelEvent call, so naming the canonical value
  // is the whole fix — no new fanout template needed for this compliance-facing event.
  try {
    const { transitionLifecycle } = await import("@/lib/kernel/lifecycle")
    await transitionLifecycle({
      brokerageId: cda.brokerage_id,
      entityType:  "transaction",
      entityId:    cda.transaction_id,
      fromState:   "cda_submitted",
      toState:     "cda_approved",
      actorUserId: auth.userId,
      actorRole:   (auth.userType ?? "compliance_officer") as never,
      eventType:   KernelEvent.CDA_APPROVED,
      metadata:    { cda_id: cda.id, approver_role: auth.userType },
    })
  } catch { /* ledger is best-effort — the approval is already recorded */ }

  // Notify the agent that compliance cleared it — now awaiting the broker's signature.
  // notifications.user_id FKs users while cda.agent_id is agents-class, so this
  // is the one direction that genuinely has to be resolved back.
  const notifyUserId = await resolveUserIdForAgentRecord(supabase, cda.agent_id ?? "")
  if (notifyUserId) {
    await supabase.from("notifications").insert({
      user_id: notifyUserId,
      brokerage_id: cda.brokerage_id,
      type: "cda_approved",
      title: "CDA approved by compliance",
      body: "Compliance approved your CDA. The broker will sign it next, then it's sent to the closing agent.",
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "medium",
      channel: "in_app",
    })
  }

  // Trigger the BROKER signature step — notify the brokerage's broker(s)/admin(s).
  const { data: brokers } = await supabase
    .from("users")
    .select("id")
    .eq("brokerage_id", cda.brokerage_id)
    .in("user_type", ["broker", "admin"])
    .limit(10)
  for (const b of (brokers ?? []) as Array<{ id: string }>) {
    await bestEffort(supabase.from("notifications").insert({
      user_id: b.id,
      brokerage_id: cda.brokerage_id,
      type: "cda_awaiting_broker_signature",
      title: "✍️ A CDA needs your signature",
      body: "Compliance approved a Commission Disbursement Authorization. Sign it to authorize the disbursement, then it goes to the closing agent.",
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    }), "the compliance approval itself already recorded; this is only the broker heads-up")
  }

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const }
}

// ─── 4c. Broker signs the approved CDA (the final authorization) ─────────────
// After compliance approval, the BROKER signs the CDA — the second signature (the
// agent already signed before submitting). Only then can it be sent to title. If an
// e-sign provider is configured in the brokerage's integration settings, the broker's
// signature is captured through it; this records the broker sign-off either way.
export async function brokerSignCdaAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, status, broker_approved_at, revision_number, generated_pdf_url, field_values")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  // Platform-membership guard — in-app broker signature only applies when the brokerage is on the
  // platform. For a solo agent whose brokerage is external, the broker signs through their external
  // form platform, not here.
  if (!cda.broker_approved_at && (await loadCdaDispositionRoute(supabase, cda.brokerage_id)) === "external_form_platform") {
    return { success: false as const, error: "handled_via_external_form_platform" }
  }
  // Shared state-machine gate (role + approved status + not-already-signed).
  const verdict = canBrokerSignCda({ status: cda.status, brokerSigned: !!cda.broker_approved_at, role: auth.userType })
  if (cda.broker_approved_at) return { success: true as const } // idempotent
  if (!verdict.ok) return { success: false as const, error: verdict.error }

  const now = new Date().toISOString()

  // Dispatch the formal e-signature on the filled CDA through the broker's E-SIGN selection
  // (user → team → brokerage, else the DocuSign default) via the canonical dispatch core —
  // never a transaction-vendor read, never a Dotloop branch (wave 141). In-app when no certified
  // provider or no filled PDF. The in-app sign-off below is the authoritative state gate; e-sign
  // is the transport on top and never blocks it (dispatch is best-effort).
  const { data: txnRow } = await supabase
    .from("transactions")
    .select("property_address")
    .eq("id", cda.transaction_id)
    .maybeSingle()
  const { dispatchCdaSignerEsign } = await import("@/lib/transactions/cda-esign")
  const esign = await dispatchCdaSignerEsign(supabase, {
    brokerageId: cda.brokerage_id,
    signerUserId: auth.userId,
    signerRole: "broker",
    transactionId: cda.transaction_id,
    filledPdfUrl: (cda as { generated_pdf_url?: string | null }).generated_pdf_url ?? null,
    propertyAddress: (txnRow as { property_address?: string | null } | null)?.property_address ?? null,
  })

  const priorFieldValues = ((cda as { field_values?: Record<string, unknown> | null }).field_values ?? {}) as Record<string, unknown>
  const { error: cdaBrokerSignErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      broker_approved_at: now,
      broker_id: auth.userId,
      field_values: { ...priorFieldValues, broker_esign: { mode: esign.mode, provider: esign.provider, envelope_id: esign.envelopeId ?? null, status: esign.status ?? null, handoff_url: esign.handoffUrl ?? null, dispatched: esign.dispatched, reason: esign.reason, at: now } },
      updated_at: now,
    })
    .eq("id", cda.id)
  if (cdaBrokerSignErr) return { success: false as const, error: `Could not record the broker signature: ${cdaBrokerSignErr.message}` }

  // AUTONOMOUS COMMISSION APPROVAL — the broker signing the CDA IS the broker approving the
  // commission (in the manual flow the broker calls markCommissionApproved). Advance the related
  // pending agent_commissions row pending → approved so it stops stalling in 'pending' after the CDA
  // is authorized and can reach payout. Broker-gated inside markCommissionApproved; idempotent (an
  // already-approved commission fails the transition guard and is ignored). Best-effort — never
  // blocks the broker sign-off.
  try {
    const { data: comm } = await supabase
      .from("agent_commissions")
      .select("id")
      .eq("transaction_id", cda.transaction_id)
      .eq("brokerage_id", cda.brokerage_id)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle()
    if ((comm as { id?: string } | null)?.id) {
      const { markCommissionApproved } = await import("@/lib/kernel/financial")
      await markCommissionApproved({
        ctx: { userId: auth.userId, agentId: auth.agentId ?? null, brokerageId: cda.brokerage_id, userType: auth.userType as "broker" | "admin" | "superadmin" },
        commissionId: (comm as { id: string }).id,
        brokerageId: cda.brokerage_id,
        approvedBy: auth.userId,
      })
    }
  } catch { /* commission auto-approval is best-effort — the broker sign-off is the authoritative gate */ }

  // FINALIZATION LOCK (owner rule): a broker-signed CDA finalizes the transaction's
  // commission — it becomes immutable from here. First-writer-wins with the CD-upload
  // trigger; best-effort so it never blocks the sign-off.
  try {
    const { finalizeTransactionCommission } = await import("@/lib/commission/finalization")
    await finalizeTransactionCommission(supabase, cda.transaction_id, "cda_signed")
  } catch { /* finalization is best-effort */ }

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "approved",
    action: "approved",
    notes:
      esign.mode === "esign"
        ? `Broker signed the CDA via ${esign.provider} — authorized for delivery to the closing agent.`
        : "Broker signed the CDA in-app — authorized for delivery to the closing agent.",
    actedBy: auth.userId,
  })

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const, signMode: esign.mode, provider: esign.provider }
}

// ─── 4b. Compliance sends back with changes ──────────────────────────────────

export async function requestCdaChangesAction(input: { cdaId: string; reason: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }
  if (!input.reason?.trim()) return { success: false as const, error: "reason_required" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, status, revision_number")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  if (cda.status !== "submitted") {
    return { success: false as const, error: `cannot_send_back_from_status:${cda.status}` }
  }

  const now = new Date().toISOString()
  const nextRevision = cda.revision_number + 1
  const { error: cdaChangesErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "changes_requested",
      changes_requested_at: now,
      changes_requested_by: auth.userId,
      changes_requested_notes: input.reason.trim(),
      // Clear sign-off — agent has to re-sign on re-submit.
      agent_signed_off_at: null,
      agent_signed_off_by: null,
      revision_number: nextRevision,
      updated_at: now,
    })
    .eq("id", cda.id)
  if (cdaChangesErr) return { success: false as const, error: `Could not record the change request: ${cdaChangesErr.message}` }

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "changes_requested",
    action: "changes_requested",
    changesRequestedNotes: input.reason.trim(),
    actedBy: auth.userId,
  })

  // Notify agent. notifications.user_id FKs users; cda.agent_id is agents-class.
  const notifyUserId = await resolveUserIdForAgentRecord(supabase, cda.agent_id ?? "")
  if (notifyUserId) {
    await supabase.from("notifications").insert({
      user_id: notifyUserId,
      brokerage_id: cda.brokerage_id,
      type: "cda_changes_requested",
      title: "CDA needs changes",
      body: `Compliance returned the CDA with notes: ${input.reason.trim().slice(0, 200)}`,
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    })
  }

  // Keep-one: closing_notifications was a write-only ledger (nothing reads it,
  // and this row carried no recipient). The canonical `notifications` insert
  // above already delivers cda_changes_requested to the agent — repointed,
  // duplicate removed.

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The whole CDA record for one transaction PLUS its revision history.
 *
 * closing_disclosure_agreement_revisions is written on every state change of a
 * money instruction and this is the only reader of it in the codebase — an audit
 * trail nobody could see is not an audit trail. Surfaced on the transaction CDA
 * page ("CDA record & audit trail").
 *
 * Selects the delivery + post-close columns too, so a caller can tell whether the
 * signed CDA actually reached the closing agent and whether the final CD and the
 * check copy came back.
 */
export async function getCdaForTransactionAction(transactionId: string) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda, error } = await supabase
    .from("closing_disclosure_agreement")
    .select(
      `id, transaction_id, brokerage_id, agent_id, status, revision_number,
       commission_breakdown, notes, gross_commission, agent_net, brokerage_net,
       preliminary_cd_uploaded_at, preliminary_cd_document_id,
       agent_drafted_at, agent_signed_off_at, agent_submitted_at,
       compliance_approved_at, compliance_approved_by,
       broker_approved_at, broker_id,
       sent_to_title_at, sent_to_title_recipient, sent_to_title_method,
       final_cd_document_id, final_cd_uploaded_at,
       check_copy_document_id, check_copy_uploaded_at, closed_at,
       uses_cda, non_cda_payout_method, non_cda_payout_details,
       signature_check_passed, manual_override_by, manual_override_reason,
       changes_requested_at, changes_requested_notes,
       created_at, updated_at`,
    )
    .eq("transaction_id", transactionId)
    .maybeSingle()
  if (error) return { success: false as const, error: error.message }
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: true as const, cda: null, revisions: [] }
  }

  const { data: revisions, error: revErr } = await supabase
    .from("closing_disclosure_agreement_revisions")
    // commission_breakdown is the MONEY SNAPSHOT recordRevision stores at each
    // state change — the whole point of an audit trail on a disbursement
    // instruction — and it had no reader anywhere: the trail showed who acted
    // and when, but never what the numbers were at that moment.
    .select("id, revision_number, action, status_at_snapshot, commission_breakdown, notes, changes_requested_notes, acted_at, acted_by")
    .eq("cda_id", cda.id)
    .order("acted_at", { ascending: false })
  if (revErr) return { success: false as const, error: revErr.message }

  return { success: true as const, cda, revisions: revisions ?? [] }
}

// ─── 0. Preliminary CD upload entry point (TC / title / closing attorney) ────

/**
 * Single entry point any uploader (TC, title company user, closing attorney)
 * calls to upload the preliminary CD. Writes the document row using the
 * actual production column names (doc_type / doc_label / storage_url) and
 * then fires the agent notification.
 */
export async function uploadPreliminaryCdAction(input: {
  transactionId: string
  fileName: string
  fileUrl: string
  uploadedByRole: "tc" | "title_agent" | "closing_attorney"
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id, property_address")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }

  const { data: doc, error: docErr } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: input.transactionId,
      brokerage_id: txn.brokerage_id,
      doc_type: "preliminary_closing_disclosure",
      doc_label: input.fileName,
      storage_url: input.fileUrl,
      status: "uploaded",
      uploaded_by: auth.userId,
      uploaded_at: new Date().toISOString(),
    })
    .select("id")
    .single()
  if (docErr || !doc) return { success: false as const, error: docErr?.message ?? "insert_failed" }

  return notifyAgentOfPreliminaryCdAction({
    transactionId: input.transactionId,
    documentId: doc.id,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// EXTENSIONS — signature gate, manual override, send-to-title, non-CDA path,
// post-close artifacts. Pure additions to the existing CDA workflow above.
// ────────────────────────────────────────────────────────────────────────────

interface MissingDoc { document_type: string; reason: string }

/**
 * Pre-scan transaction documents for required signatures/initials so the
 * compliance manager sees a clean go/no-go indicator on the CDA review page.
 *
 * Approval gate (enforced in approveCdaAction below):
 *   signature_check_passed === true  → may approve
 *   signature_check_passed === false → must manual_override with reason
 *   signature_check_passed === null  → grandfathered (older CDAs)
 *
 * Idempotent — overwrites the latest scan result.
 */
export async function runSignatureCheckForCdaAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }

  // Walk every document on the transaction and check for completion + sigs.
  // Production sources: documents (Workflow OS) + transaction_documents (legacy).
  const missing: MissingDoc[] = []

  const { data: docs1 } = await supabase
    .from("documents")
    .select("document_type, status, metadata")
    .eq("transaction_id", cda.transaction_id)
  // documents.status live CHECK: draft | draft_ready | generating | review | complete |
  // archived | needs_agent_input | pending_signature | signed | declined | cancelled.
  // This used to demand "complete" alone, so a document in the terminal SIGNED state —
  // the exact state this gate is looking for — was reported as "not finalized + signed".
  const DOC_SIGNED_OFF = new Set(["complete", "signed"])
  for (const d of docs1 ?? []) {
    if (!DOC_SIGNED_OFF.has(d.status)) {
      missing.push({ document_type: d.document_type, reason: `Status="${d.status}" — not finalized + signed` })
      continue
    }
    const sig = (d.metadata as { signature_check?: { all_signed?: boolean; missing?: string[] } } | null)?.signature_check
    if (sig && sig.all_signed === false) {
      missing.push({
        document_type: d.document_type,
        reason: `Missing: ${(sig.missing ?? []).join(", ") || "signatures/initials"}`,
      })
    }
  }

  const { data: docs2 } = await supabase
    .from("transaction_documents")
    .select("doc_type, status")
    .eq("transaction_id", cda.transaction_id)
  // transaction_documents.status live CHECK: missing | requested | uploaded |
  // under_review | approved | rejected | pending_signature. "received", "signed" and
  // "complete" were in this pass-list but are NOT in the constraint — no row can ever
  // hold them, so they never matched anything. Dropped (behaviour unchanged: "approved"
  // was and remains the only status that clears this side of the gate) so the vocabulary
  // in the code is the vocabulary the database actually enforces.
  for (const d of docs2 ?? []) {
    if ((d.status ?? "").toLowerCase() !== "approved") {
      missing.push({ document_type: d.doc_type, reason: `Document status="${d.status}" — not approved` })
    }
  }

  const passed = missing.length === 0
  const { error: scanErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      signature_check_passed: passed,
      missing_docs:           missing.length > 0 ? missing : null,
      updated_at:             new Date().toISOString(),
    })
    .eq("id", cda.id)
  // The approval gate reads signature_check_passed. A silently-dropped write here
  // leaves it NULL, which approveCdaAction treats as grandfathered — i.e. a failed
  // scan would have opened the gate instead of closing it.
  if (scanErr) return { success: false as const, error: scanErr.message }

  return { success: true as const, passed, missing }
}

// ─── Manual override (compliance manager bypasses sig gate with reason) ────

export async function manualOverrideCdaAction(input: { cdaId: string; reason: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }
  const reason = (input.reason ?? "").trim()
  if (reason.length < 10) {
    return { success: false as const, error: "reason_required_min_10_chars" }
  }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, brokerage_id, revision_number, status")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }

  const now = new Date().toISOString()
  const { error: cdaOverrideErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      manual_override_by:     auth.userId,
      manual_override_at:     now,
      manual_override_reason: reason,
      updated_at:             now,
    })
    .eq("id", cda.id)
  if (cdaOverrideErr) return { success: false as const, error: `Could not record the manual override: ${cdaOverrideErr.message}` }

  await recordRevision({
    cdaId:                cda.id,
    revisionNumber:       cda.revision_number,
    status:               cda.status,
    action:               "approved",
    notes:                `MANUAL OVERRIDE: ${reason}`,
    actedBy:              auth.userId,
  })

  return { success: true as const }
}

// ─── Send approved CDA to title / closing attorney ────────────────────────

export async function sendCdaToTitleAction(input: {
  cdaId:           string
  /** Required for method 'email'; ignored for 'portal' (the title company's portal account is the recipient). */
  recipientEmail?: string
  recipientName?:  string
  /** 'portal' = the title company on the Deal Team (a title_company_users account for this transaction) — wave 142. */
  method?:         "email" | "portal" | "docusign" | "dotloop" | "manual"
  subject?:        string
  message?:        string
  /** A delivery already recorded is never repeated on retry; an explicit re-send needs a reason (≥ 5 chars). */
  resend?:         boolean
  resendReason?:   string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  // THE MONEY COLUMNS RIDE ALONG (wave 26). This SELECT used to stop at the
  // status columns, so the send below had nothing to say and said nothing —
  // see the body composition note further down.
  const { data: cda, error: cdaReadErr } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, status, broker_approved_at, gross_commission, agent_net, brokerage_net, sent_to_title_at, sent_to_title_recipient, generated_pdf_url, field_values")
    .eq("id", input.cdaId)
    .maybeSingle()
  // A refused read is not "no such CDA" — supabase-js resolves refusals, and
  // reporting one as not_found would send the agent looking for a missing row.
  if (cdaReadErr) {
    console.error("[cda-portal] CDA read refused in sendCdaToTitleAction:", cdaReadErr.message)
    return { success: false as const, error: `cda_read_refused:${cdaReadErr.message}` }
  }
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  // The signed CDA may only go to title AFTER the broker has signed it (agent
  // signed before submit → compliance approved → broker signed → then sent).
  const sendVerdict = canSendCdaToTitle({ status: cda.status, brokerSigned: !!cda.broker_approved_at })
  if (!sendVerdict.ok) return { success: false as const, error: sendVerdict.error }

  // ── NEVER DUPLICATE A DELIVERY ON RETRY (wave 142, lane 142C) ───────────────
  // A recorded delivery (sent_to_title_at) is the record; a retry of the same send is refused by
  // name with the prior recipient and time. An explicit re-send (a bounced address, a new closer)
  // needs a reason and is recorded as such on the delivery activity.
  const method = input.method ?? "email"
  const idem = deliveryIdempotency({
    sentToTitleAt: (cda as { sent_to_title_at?: string | null }).sent_to_title_at ?? null,
    sentRecipient: (cda as { sent_to_title_recipient?: string | null }).sent_to_title_recipient ?? null,
    recipient: input.recipientEmail ?? "portal",
    resend: input.resend,
    resendReason: input.resendReason ?? null,
  })
  if (!idem.ok) {
    return { success: false as const, error: `${idem.error}: delivered to ${(cda as { sent_to_title_recipient?: string | null }).sent_to_title_recipient ?? "title"} at ${(cda as { sent_to_title_at?: string | null }).sent_to_title_at} — pass resend with a reason to send again` }
  }

  // ── THE ROUTE (wave 142): title on the Deal Team → the portal inbox; outside → the verified email.
  let portalUser: { userId: string; email: string | null; company: string | null } | null = null
  if (method === "portal") {
    portalUser = await resolveTitlePortalUser(supabase, cda.transaction_id, cda.brokerage_id)
    const route = cdaDeliveryRoute({ titlePortalUserId: portalUser?.userId ?? null, requested: "portal" })
    if (route.route !== "portal") return { success: false as const, error: route.reason }
    if (!(cda as { generated_pdf_url?: string | null }).generated_pdf_url) {
      return { success: false as const, error: "no_signed_cda_pdf: generate the filled CDA PDF before delivering it to the title portal" }
    }
  } else if (method === "email") {
    const route = cdaDeliveryRoute({ titleEmail: input.recipientEmail ?? null, requested: "email" })
    if (route.route !== "email") return { success: false as const, error: route.reason }
  }

  // ── THE AUTHORIZATION NOW CARRIES THE DISBURSEMENT (§1 merge, wave 26) ─────
  // The subject line has always said "Approved Commission Disbursement
  // Authorization"; the body said only "The approved CDA for this transaction is
  // ready for the closing". The closing agent was told a disbursement was
  // authorized and never told WHAT to disburse — the figures existed only on
  // lib/transactions/deal-vendor-notify.ts:deliverCdaToClosingAgent, which
  // nothing called. Composed here through that module's ONE composer (§6) so the
  // two surfaces cannot state different splits.
  //
  // Honest when the row is thin: a CDA whose money columns are null composes no
  // figure block rather than a row of $0 the closing agent would have to
  // interpret. `tcNet` is not a column on this table — the TC take lives in
  // commission_breakdown and is not modelled here yet, so it is left absent
  // rather than guessed (the composer omits the line entirely when it is null).
  const grossCommission = cda.gross_commission == null ? null : Number(cda.gross_commission)
  const agentNet        = cda.agent_net        == null ? null : Number(cda.agent_net)
  const brokerageNet    = cda.brokerage_net    == null ? null : Number(cda.brokerage_net)
  const figuresKnown =
    grossCommission != null && Number.isFinite(grossCommission) &&
    agentNet != null        && Number.isFinite(agentNet) &&
    brokerageNet != null    && Number.isFinite(brokerageNet)

  let disbursementHtml = ""
  if (figuresKnown) {
    // WAVE 143 (lane 143C): "CDA payouts include referrals." The authorization names EVERY payee the deal funds - the
    // referral fee(s) and the team share ride the live commission_distributions (voided rows excluded, corrections
    // netted). The tenant gate above (cda.brokerage_id === the session's brokerage) has run, so the service read is
    // pinned to it; a REFUSED read stops the send - an authorization that silently omits a payee is not sent.
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { cdaPayeesFromDistributions } = await import("@/lib/transactions/cda-payees")
    const svc = createServiceClient()
    // WAVE 144 (lane 144D): select("*") so the outside-partner payee (referral_partner_id, m850) is read once applied
    // without naming a column that does not exist before it (a 42703 would refuse the whole send).
    const { data: payeeRows, error: payeeErr } = await svc
      .from("commission_distributions")
      .select("*")
      .eq("transaction_id", cda.transaction_id)
      .eq("brokerage_id", cda.brokerage_id)
      .in("distribution_type", ["referral", "team_member"])
    if (payeeErr) return { success: false as const, error: `cda_payees_read_refused:${payeeErr.message}` }
    const payeePartnerIds = Array.from(new Set(((payeeRows ?? []) as Array<{ referral_partner_id?: string | null }>).map((r) => r.referral_partner_id).filter((x): x is string => !!x)))
    const nameByPartnerId = new Map<string, string>()
    if (payeePartnerIds.length > 0) {
      const { data: partners, error: partnersErr } = await svc
        .from("referral_partners")
        .select("id, company_name, partner_name")
        .eq("brokerage_id", cda.brokerage_id)
        .in("id", payeePartnerIds)
      if (partnersErr) return { success: false as const, error: `cda_payees_read_refused:${partnersErr.message}` }
      for (const p of (partners ?? []) as Array<{ id: string; company_name?: string | null; partner_name?: string | null }>) {
        const brokerage = (p.company_name ?? "").trim()
        const agent = (p.partner_name ?? "").trim()
        if (brokerage) nameByPartnerId.set(p.id, agent ? `${brokerage} (${agent})` : brokerage)
      }
      // An outside payee title cannot be told the name of is an authorization missing a payee — not sent.
      const unnamed = payeePartnerIds.filter((id) => !nameByPartnerId.has(id))
      if (unnamed.length > 0) return { success: false as const, error: `cda_partner_payee_unnamed:${unnamed.join(",")}` }
    }
    const payeeAgentIds = Array.from(new Set(((payeeRows ?? []) as Array<{ agent_id?: string | null }>).map((r) => r.agent_id).filter((x): x is string => !!x)))
    const nameByAgentId = new Map<string, string>()
    if (payeeAgentIds.length > 0) {
      const { data: payeeAgents, error: payeeAgentsErr } = await svc
        .from("agents")
        .select("id, users(first_name, last_name)")
        .eq("brokerage_id", cda.brokerage_id)
        .in("id", payeeAgentIds)
      if (payeeAgentsErr) return { success: false as const, error: `cda_payees_read_refused:${payeeAgentsErr.message}` }
      for (const a of (payeeAgents ?? []) as any[]) {
        const u = Array.isArray(a.users) ? a.users[0] : a.users
        const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim()
        if (name) nameByAgentId.set(a.id, name)
      }
    }
    const payees = cdaPayeesFromDistributions((payeeRows ?? []) as Array<{ distribution_type?: string | null; calculated_amount?: number | string | null; status?: string | null; agent_id?: string | null; referral_partner_id?: string | null }>, nameByAgentId, nameByPartnerId)

    const { composeCdaDisbursementLines } = await import("@/lib/transactions/deal-vendor-notify")
    const lines = composeCdaDisbursementLines({
      grossCommission: grossCommission as number,
      agentNet:        agentNet as number,
      brokerageNet:    brokerageNet as number,
      tcNet:           null,
      referralPayouts: payees.referralPayouts,
      teamShare:       payees.teamShare,
    })
    disbursementHtml =
      `<p>Our brokerage's compliance review of this commission disbursement is complete and APPROVED. `
      + `Please disburse at closing as follows:</p><ul>`
      + lines.map((l) => `<li>${l}</li>`).join("")
      + `</ul>`
  }

  // TRACKED STATUS (wave 142): what the provider / the portal said happened, recorded beside the send.
  let deliveryEvidence: Record<string, unknown> = { method, resend: idem.resend, resend_reason: idem.resend ? (input.resendReason ?? null) : null }
  // ── A SWALLOWED SEND IS NOT A DELIVERY (wave 26) ──────────────────────────
  // This used to be `try { await dispatchEmail(...) } catch {}` with the result
  // discarded, and then stamped sent_to_title_at unconditionally below. A send
  // that threw — or that resolved with success:false, which dispatchEmail does
  // rather than throwing — was recorded as a delivered disbursement
  // authorization, and the compliance queue (which buckets delivery off
  // sent_to_title_at) showed the money instruction as having reached title when
  // it had not. On the last mile of the money rail that is the §3 swallowed
  // refusal in its most expensive form. The result is now READ, and a failed
  // send refuses instead of recording.
  if (method === "email") {
    let emailOk = false
    let emailErr: string | null = null
    try {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const sendResult = await dispatchEmail({
        brokerageId:   cda.brokerage_id,
        systemSource:  "cda",
        from:          "closings@platform.com",
        to:            input.recipientEmail as string,
        subject:       input.subject ?? "Approved Commission Disbursement Authorization",
        html:          (input.message ?? "")
                       + disbursementHtml
                       + `<p>The approved CDA for this transaction is ready for the closing.</p>`,
      })
      // dispatchEmail reports failure in its RESULT rather than throwing — a
      // compliance/autonomy/fair-housing hold comes back as { success: false }.
      // Tested for an explicit true so an unexpected shape fails CLOSED (§4):
      // "nobody checked" must never render as "checked and fine".
      emailOk = (sendResult as { success?: boolean } | null)?.success === true
      if (!emailOk) {
        emailErr = (sendResult as { error?: string } | null)?.error ?? "provider reported failure"
      } else {
        deliveryEvidence = { ...deliveryEvidence, provider: (sendResult as { providerKey?: string }).providerKey ?? null, message_id: (sendResult as { messageId?: string }).messageId ?? null, state: "accepted_by_provider" }
      }
    } catch (e) {
      emailErr = e instanceof Error ? e.message : String(e)
    }
    if (!emailOk) {
      console.error("[cda-portal] CDA delivery to title FAILED — nothing recorded as sent", {
        cdaId: cda.id, transactionId: cda.transaction_id, error: emailErr,
      })
      return { success: false as const, error: `delivery_failed:${emailErr ?? "unknown"}` }
    }
  }

  // ── THE PORTAL INBOX (wave 142): the signed CDA becomes a document the title portal lists
  // (app/actions/title-portal.ts getTitlePortalData reads doc_type 'cda') and a bell on the title
  // company's own account — evidence of WHAT was delivered to WHOM, not an email in flight.
  if (method === "portal" && portalUser) {
    const { data: portalDoc, error: portalDocErr } = await supabase
      .from("transaction_documents")
      .insert({
        transaction_id: cda.transaction_id,
        brokerage_id:   cda.brokerage_id,
        doc_type:       "cda",
        doc_label:      "Commission Disbursement Authorization — approved and signed",
        storage_url:    (cda as { generated_pdf_url?: string | null }).generated_pdf_url,
        status:         "approved",
        uploaded_by:    auth.userId,
        uploaded_at:    new Date().toISOString(),
        metadata:       { cda_id: cda.id, delivered_to_title_user_id: portalUser.userId },
      })
      .select("id")
      .single()
    if (portalDocErr || !portalDoc) {
      return { success: false as const, error: `delivery_failed:portal document not recorded (${portalDocErr?.message ?? "no row"})` }
    }
    const { error: portalBellErr } = await supabase.from("notifications").insert({
      user_id:      portalUser.userId,
      brokerage_id: cda.brokerage_id,
      type:         "cda_delivered_portal",
      title:        "Commission Disbursement Authorization delivered",
      body:         `The brokerage's approved and signed CDA for this closing is in your portal documents.${figuresKnown ? " It states the disbursement figures." : ""}`,
      entity_type:  "transaction",
      entity_id:    cda.transaction_id,
      priority:     "high",
      channel:      "in_app",
    })
    if (portalBellErr) {
      // The document IS in the portal (the delivery); the bell is the heads-up. Logged, not hidden.
      console.error("[cda-portal] title portal bell refused — the CDA is in the portal documents but the title user was not pinged:", portalBellErr.message)
    }
    deliveryEvidence = { ...deliveryEvidence, portal_document_id: portalDoc.id, title_user_id: portalUser.userId, state: portalBellErr ? "document_delivered_bell_refused" : "document_delivered_and_notified" }
  }

  const sentNow = new Date().toISOString()
  const recipient = method === "portal" && portalUser
    ? `portal:${portalUser.email ?? portalUser.company ?? portalUser.userId}`
    : input.recipientName
      ? `${input.recipientName} <${input.recipientEmail}>`
      : (input.recipientEmail as string)
  const priorSendValues = ((cda as { field_values?: Record<string, unknown> | null }).field_values ?? {}) as Record<string, unknown>

  // THE RECORD OF THE SEND. This write used to also set status:"delivered" — a value the
  // live CHECK constraint (closing_disclosure_agreement_status_check: awaiting_preliminary_cd,
  // pending, drafting, submitted, changes_requested, approved, rejected, cancelled) REJECTS.
  // supabase-js resolves the failed UPDATE instead of throwing and the result was never
  // destructured, so the whole row update was a silent no-op: the CDA was emailed to the
  // closing agent and sent_to_title_at / _recipient / _method were never written. Nothing
  // read status "delivered" anywhere (grep: this line was its only occurrence), and the
  // compliance queue buckets delivery off sent_to_title_at — which stayed NULL, so the
  // signed CDA sat in "awaiting delivery" forever and could be re-sent without limit.
  // Delivery now lives in the sent_to_title_* columns and the status stays "approved".
  const { error: sendErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      sent_to_title_at:        sentNow,
      sent_to_title_recipient: recipient,
      // 'portal' is admitted by m788 (the lane stamp); until it is applied the CHECK refuses the write
      // and this action reports delivery_not_recorded — never a silent success.
      sent_to_title_method:    method,
      field_values:            { ...priorSendValues, title_delivery: { ...deliveryEvidence, recipient, at: sentNow } },
      updated_at:              sentNow,
    })
    .eq("id", cda.id)
  if (sendErr) {
    return { success: false as const, error: `delivery_not_recorded:${sendErr.message}` }
  }

  // The cda_delivered milestone completes on actual DELIVERY to title — not at
  // compliance approval (it used to complete too early, before broker sign + send).
  const { error: milestoneErr } = await supabase
    .from("transaction_milestones")
    .update({ status: "completed", completed_at: sentNow })
    .eq("transaction_id", cda.transaction_id)
    .or("milestone_type.eq.cda_delivered,milestone_name.eq.cda_delivered")
  if (milestoneErr) {
    // The delivery record above is the authoritative one; a milestone that didn't
    // move is a reporting gap, not a money error. Surface it rather than hide it.
    console.error("[cda-portal] cda_delivered milestone not completed", { transactionId: cda.transaction_id, error: milestoneErr.message })
  }

  // ── THE DELIVERY IS A COMPLIANCE ARTIFACT, NOT A LOG LINE (§1 merge, wave 26)
  // Merged from lib/transactions/deal-vendor-notify.ts:deliverCdaToClosingAgent,
  // which recorded this and was never called. The sent_to_title_* columns say
  // THAT the authorization went out; this row is the timeline entry a compliance
  // reviewer reads on the transaction — who received the disbursement
  // instruction, and for what gross. activities.activity_type carries no CHECK
  // constraint (verified against scripts/check-vocabularies.ts, which has no
  // `activities:` entry), so this value cannot be refused by the vocabulary.
  // Best-effort: the delivery already happened and is already recorded above, so
  // a refused activity must not undo it — but it is LOGGED, never swallowed.
  const { error: deliveredActivityErr } = await supabase.from("activities").insert({
    brokerage_id:   cda.brokerage_id,
    transaction_id: cda.transaction_id,
    entity_type:    "transaction",
    activity_type:  "cda_delivered_to_title",
    title:          "CDA delivered to the closing agent",
    description:    `Approved disbursement authorization sent to ${recipient}.`,
    notes:          JSON.stringify({
      cda_id: cda.id,
      recipient,
      method,
      grossCommission: figuresKnown ? grossCommission : null,
      figuresIncluded: figuresKnown,
      delivery: deliveryEvidence,
    }),
    status:         "completed",
    completed_at:   sentNow,
    channel:        method === "email" ? "email" : method,
  })
  if (deliveredActivityErr) {
    console.error(
      "[cda-portal] cda_delivered_to_title activity REJECTED — the CDA reached title but the transaction has no timeline record of it:",
      deliveredActivityErr.message,
    )
  }

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const, sentAt: sentNow, recipient, method }
}

// ─── Non-CDA path — agent's payout preference ─────────────────────────────
//
// When the brokerage does not offer CDAs (brokerages.offers_cda = false),
// the agent records how they'd like the brokerage to disburse to them
// after funds clear. Stored on the CDA row itself for unified tracking.

export async function recordNonCdaPayoutPreferenceAction(input: {
  transactionId: string
  method:        "direct_deposit" | "check"
  details?:      Record<string, unknown>
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  // Get-or-create CDA row for this transaction in non-CDA path
  let cdaId: string
  const { data: existing } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, brokerage_id")
    .eq("transaction_id", input.transactionId)
    .maybeSingle()

  if (existing) {
    if (existing.brokerage_id !== auth.brokerageId) return { success: false as const, error: "forbidden" }
    cdaId = existing.id
  } else {
    const { data: txn } = await supabase
      .from("transactions").select("brokerage_id, agent_id").eq("id", input.transactionId).maybeSingle()
    if (!txn || txn.brokerage_id !== auth.brokerageId) {
      return { success: false as const, error: "transaction_not_found" }
    }
    // Unlike the draft path there is no "caller is the assigned agent" gate
    // here, so the CDA is stamped with the transaction's own assigned agent.
    if (!txn.agent_id) {
      return { success: false as const, error: "transaction_has_no_agent" }
    }
    const { data: created, error } = await supabase
      .from("closing_disclosure_agreement")
      .insert({
        transaction_id:        input.transactionId,
        brokerage_id:          txn.brokerage_id,
        agent_id:              txn.agent_id,
        status:                "pending",
        revision_number:       1,
        uses_cda:              false,
      })
      .select("id")
      .single()
    if (error || !created) return { success: false as const, error: error?.message ?? "create_failed" }
    cdaId = created.id
  }

  // non_cda_payout_method has a live CHECK: NULL | 'direct_deposit' | 'check'.
  // Anything else is rejected by the database, and an unchecked update would have
  // reported success while the agent's payout instruction went nowhere.
  const { data: saved, error: prefErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      uses_cda:                false,
      non_cda_payout_method:   input.method,
      non_cda_payout_details:  input.details ?? null,
      updated_at:              new Date().toISOString(),
    })
    .eq("id", cdaId)
    .select("id, non_cda_payout_method, transaction_id")
    .maybeSingle()
  if (prefErr) return { success: false as const, error: prefErr.message }
  if (!saved) return { success: false as const, error: "not_found" }

  revalidatePath(`/dashboard/transactions/${saved.transaction_id}`)
  return { success: true as const, cdaId, method: saved.non_cda_payout_method as "direct_deposit" | "check" }
}

// ─── Post-close artifact uploads ──────────────────────────────────────────

/**
 * Entry point for the two POST-CLOSE artifacts, mirroring uploadPreliminaryCdAction
 * at the other end of the chain: it records the file as a transaction document and
 * then attaches it to the CDA through the existing attach actions below, which stay
 * the only writers of the CDA's artifact columns.
 *
 * Why an entry point at all: uploadFinalCdAction / uploadCdaCheckCopyAction both take
 * a documentId, and nothing in the app created that document for either artifact — so
 * the tail of the money rail (final CD back from title, copy of the commission check,
 * close the file) had no way to start. The final CD is also one of the two events that
 * FINALIZES a transaction's commission (lib/commission/finalization, source
 * 'cd_uploaded'); with no caller, that half of the finalization lock could never fire.
 */
export async function recordCdaClosingArtifactAction(input: {
  cdaId:    string
  kind:     "final_cd" | "check_copy"
  fileName: string
  fileUrl:  string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda, error: cdaErr } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id")
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (cdaErr) return { success: false as const, error: cdaErr.message }
  if (!cda) return { success: false as const, error: "not_found" }

  // transaction_documents.status live CHECK: missing | requested | uploaded |
  // under_review | approved | rejected | pending_signature. 'uploaded' is the state
  // uploadPreliminaryCdAction uses for the same kind of arriving artifact.
  const { data: doc, error: docErr } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: cda.transaction_id,
      brokerage_id:   cda.brokerage_id,
      doc_type:       input.kind === "final_cd" ? "final_closing_disclosure" : "cda_check_copy",
      doc_label:      input.fileName,
      storage_url:    input.fileUrl,
      status:         "uploaded",
      uploaded_by:    auth.userId,
      uploaded_at:    new Date().toISOString(),
    })
    .select("id")
    .single()
  if (docErr || !doc) return { success: false as const, error: docErr?.message ?? "insert_failed" }

  return input.kind === "final_cd"
    ? uploadFinalCdAction({ cdaId: cda.id, documentId: doc.id })
    : uploadCdaCheckCopyAction({ cdaId: cda.id, documentId: doc.id })
}

export async function uploadFinalCdAction(input: {
  cdaId:           string
  documentId:      string                                // FK to documents OR transaction_documents
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cdaRow, error: finalErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      final_cd_document_id:  input.documentId,
      final_cd_uploaded_by:  auth.userId,
      final_cd_uploaded_at:  new Date().toISOString(),
      updated_at:            new Date().toISOString(),
    })
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)
    .select("transaction_id")
    .maybeSingle()
  if (finalErr) return { success: false as const, error: finalErr.message }
  // No row matched ⇒ wrong CDA or wrong tenant. Reporting success here would tell the
  // user the final CD is on file when nothing was written, and would skip the
  // commission finalization lock below.
  if (!cdaRow) return { success: false as const, error: "not_found" }

  // FINALIZATION LOCK (owner rule): an uploaded final CD finalizes the transaction's
  // commission — immutable from here. First-writer-wins with the CDA-sign trigger;
  // best-effort so it never blocks the upload.
  const finalTxnId = (cdaRow as { transaction_id?: string | null } | null)?.transaction_id
  if (finalTxnId) {
    try {
      const { finalizeTransactionCommission } = await import("@/lib/commission/finalization")
      await finalizeTransactionCommission(supabase, finalTxnId, "cd_uploaded")
    } catch { /* finalization is best-effort */ }
  }

  return { success: true as const }
}

export async function uploadCdaCheckCopyAction(input: {
  cdaId:        string
  documentId:   string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: row, error } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      check_copy_document_id:  input.documentId,
      check_copy_uploaded_at:  new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    })
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)
    .select("id, transaction_id")
    .maybeSingle()
  if (error) return { success: false as const, error: error.message }
  if (!row) return { success: false as const, error: "not_found" }

  revalidatePath(`/dashboard/transactions/${row.transaction_id}`)
  return { success: true as const }
}

/**
 * Close the CDA file — the last step of the money rail. The disbursement was
 * authorized, delivered to the closing agent, the final CD came back and the
 * check copy is on file; closing the CDA marks the commission record complete.
 * Idempotent (closing an already-closed CDA re-stamps the same terminal state).
 */
export async function closeCdaAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }

  const now = new Date().toISOString()
  const { data: row, error } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      closed_at:  now,
      updated_at: now,
    })
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)
    .select("id, transaction_id, revision_number, status")
    .maybeSingle()
  if (error) return { success: false as const, error: error.message }
  if (!row) return { success: false as const, error: "not_found" }

  // The revision log is how the OS reconstructs what happened to a disbursement.
  // 'cancelled' is not what this is; the closest truthful value in the live
  // revisions action CHECK (drafted|submitted|signed_off|changes_requested|
  // approved|rejected|cancelled) for "the authorized CDA reached its end state"
  // is 'approved', stamped with an explicit note so the row is unambiguous.
  await recordRevision({
    cdaId:          row.id,
    revisionNumber: row.revision_number ?? 1,
    status:         row.status ?? "approved",
    action:         "approved",
    notes:          "CDA file closed — final CD and check copy on record.",
    actedBy:        auth.userId,
  })

  revalidatePath(`/dashboard/transactions/${row.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const, closedAt: now }
}

// ────────────────────────────────────────────────────────────────────────────
// WAVE 142 (lane 142C) — the preliminary statement review loop, the external-broker return path,
// and the title-portal identity the delivery routes read. Pure rules in
// lib/transactions/cda-closing-policy.ts; these are the I/O doors.
// ────────────────────────────────────────────────────────────────────────────

/** The title company on the DEAL TEAM for this transaction: a title_company_users row with a users account. */
async function resolveTitlePortalUser(
  supabase: SupabaseClient,
  transactionId: string,
  brokerageId: string,
): Promise<{ userId: string; email: string | null; company: string | null } | null> {
  const { data, error } = await supabase
    .from("title_company_users")
    .select("user_id, email, company_name")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .not("user_id", "is", null)
    .limit(1)
    .maybeSingle()
  if (error) { console.error("[cda-portal] title_company_users read refused:", error.message); return null }
  const row = data as { user_id?: string | null; email?: string | null; company_name?: string | null } | null
  if (!row?.user_id) return null
  return { userId: row.user_id, email: row.email ?? null, company: row.company_name ?? null }
}

/** The verified title email outside the platform (transaction_title_escrow), or null. */
async function resolveTitleEmail(supabase: SupabaseClient, transactionId: string): Promise<{ email: string | null; name: string | null }> {
  const { data, error } = await supabase
    .from("transaction_title_escrow")
    .select("title_officer_email, title_company_email, escrow_officer_email, title_officer_name, escrow_officer_name")
    .eq("transaction_id", transactionId)
    .maybeSingle()
  if (error) { console.error("[cda-portal] transaction_title_escrow read refused:", error.message); return { email: null, name: null } }
  const t = data as Record<string, string | null> | null
  return { email: t?.title_officer_email ?? t?.title_company_email ?? t?.escrow_officer_email ?? null, name: t?.title_officer_name ?? t?.escrow_officer_name ?? null }
}

/** The actors who review the statement: the assigned agent, the TC, or a compliance/broker seat. */
async function canReviewPreliminaryStatement(
  supabase: SupabaseClient,
  auth: { userId: string; agentId: string | null; userType: string },
  cda: { transaction_id: string; agent_id: string | null },
): Promise<boolean> {
  if (COMPLIANCE_ROLES.has(auth.userType)) return true
  if (auth.agentId && auth.agentId === cda.agent_id) return true
  const { data: txn } = await supabase.from("transactions").select("coordinator_id").eq("id", cda.transaction_id).maybeSingle()
  return !!(txn as { coordinator_id?: string | null } | null)?.coordinator_id && (txn as { coordinator_id?: string | null }).coordinator_id === auth.userId
}

/**
 * THE AGENT / TC COMPARED THE TITLE COMPANY'S PRELIMINARY STATEMENT AGAINST THE EXECUTED CONTRACT +
 * WATERFALL AND FOUND IT WRONG. Owner: "discrepancy documented → correction request to title → revised
 * official statement → version retained → waterfall reconciled → broker reviews. AI may identify/explain
 * discrepancies, never fabricate values; never silently alter the title company's document."
 *
 * The discrepancies are either DOCUMENTED by the human (items) or IDENTIFIED deterministically from the
 * figures the human read off the statement (statementFigures vs the transaction's terms + the CDA's
 * waterfall — comparePreliminaryStatementFigures; no model, nothing invented). The request reaches title
 * through the title portal when title is on the deal team, else the verified title email; the review
 * state becomes correction_requested, which BLOCKS approval (cdaFigureGate) until the revised statement
 * arrives (notifyAgentOfPreliminaryCdAction re-opens the review as pending_review).
 */
export async function requestPreliminaryCdCorrectionAction(input: {
  cdaId: string
  /** Discrepancies the reviewer documented by hand (field + the two figures). */
  items?: Array<{ field: string; statementValue: number; expectedValue: number; note?: string }>
  /** The figures as the reviewer reads them off the statement — compared deterministically against the record. */
  statementFigures?: StatementFigures
  message?: string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda, error: cdaErr } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, status, revision_number, field_values, gross_commission, agent_net, brokerage_net")
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (cdaErr) return { success: false as const, error: `cda_read_refused:${cdaErr.message}` }
  if (!cda) return { success: false as const, error: "not_found" }
  if (!(await canReviewPreliminaryStatement(supabase, auth, cda))) return { success: false as const, error: "forbidden" }

  const priorValues = ((cda as { field_values?: Record<string, unknown> | null }).field_values ?? {}) as Record<string, unknown>
  const review = preliminaryReviewOf(priorValues)
  if (!review) return { success: false as const, error: "no_preliminary_statement_on_file" }

  // IDENTIFY — deterministic: the statement's figures vs the executed contract + the waterfall.
  const { data: txn } = await supabase
    .from("transactions")
    .select("purchase_price, closing_cost_contribution, property_address, agent_id, coordinator_id")
    .eq("id", cda.transaction_id)
    .maybeSingle()
  const t = txn as { purchase_price?: number | null; closing_cost_contribution?: number | null; property_address?: string | null; agent_id?: string | null; coordinator_id?: string | null } | null
  // Wave 143 (lane 143C → lane 143A seam): the EXPECTED price / credits come from the authoritative terms record —
  // an executed counter supersedes the original (lib/offers/governing-terms.ts); the transaction row is the fallback.
  let govPrice: number | null = null
  let govCredits: number | null = null
  try {
    const { governingContractTerms } = await import("@/lib/offers/governing-terms")
    const g = await governingContractTerms(supabase as any, String((cda as { brokerage_id?: string | null }).brokerage_id ?? ""), { transactionId: cda.transaction_id })
    if (g.ok) {
      const v = g.governing.values as Record<string, unknown>
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null)
      govPrice = num(v.offer_price ?? v.purchase_price)
      govCredits = num(v.closing_cost_contribution ?? v.seller_credit)
    }
  } catch (e) {
    console.warn("[cda-portal] authoritative terms record unreadable — transaction row used:", e instanceof Error ? e.message : String(e))
  }
  const expected: StatementFigures = {
    sales_price: govPrice ?? t?.purchase_price ?? null,
    gross_commission: cda.gross_commission == null ? null : Number(cda.gross_commission),
    agent_net: cda.agent_net == null ? null : Number(cda.agent_net),
    brokerage_net: cda.brokerage_net == null ? null : Number(cda.brokerage_net),
    seller_credits: govCredits ?? t?.closing_cost_contribution ?? null,
  }
  const identified = input.statementFigures ? comparePreliminaryStatementFigures(input.statementFigures, expected) : { discrepancies: [] as PreliminaryDiscrepancy[], compared: [], unverifiable: [] }
  const documented: PreliminaryDiscrepancy[] = (input.items ?? [])
    .filter((i) => i && typeof i.field === "string" && Number.isFinite(i.statementValue) && Number.isFinite(i.expectedValue))
    .map((i) => {
      const delta = i.statementValue - i.expectedValue
      const deltaPct = i.expectedValue === 0 ? 100 : Math.round((Math.abs(delta) / Math.abs(i.expectedValue)) * 1000) / 10
      return { field: i.field as PreliminaryDiscrepancy["field"], statement: Math.round(i.statementValue), expected: Math.round(i.expectedValue), delta: Math.round(delta), deltaPct, severity: deltaPct >= 5 ? "blocker" : "warning" } as PreliminaryDiscrepancy
    })
  const items = [...documented, ...identified.discrepancies.filter((d) => !documented.some((x) => x.field === d.field))]
  if (items.length === 0) return { success: false as const, error: "no_discrepancy_documented", unverifiable: identified.unverifiable }

  // DELIVER the correction request to title — portal inbox when on the deal team, else the verified email.
  const now = new Date().toISOString()
  const lines = describePreliminaryDiscrepancies(items)
  const portalUser = await resolveTitlePortalUser(supabase, cda.transaction_id, cda.brokerage_id)
  const titleEmail = portalUser ? { email: null, name: null } : await resolveTitleEmail(supabase, cda.transaction_id)
  const route = cdaDeliveryRoute({ titlePortalUserId: portalUser?.userId ?? null, titleEmail: titleEmail.email })
  let delivery: { route: "portal" | "email" | "none"; recipient: string | null; message_id: string | null; at: string } = { route: "none", recipient: null, message_id: null, at: now }
  const subject = `Correction requested on the preliminary settlement statement${t?.property_address ? ` — ${t.property_address}` : ""}`
  if (route.route === "portal" && portalUser) {
    const { error: bellErr } = await supabase.from("notifications").insert({
      user_id: portalUser.userId,
      brokerage_id: cda.brokerage_id,
      type: "preliminary_cd_correction_requested",
      title: subject,
      body: `${input.message?.trim() ? `${input.message.trim()} ` : ""}${lines.join(" ")}`.slice(0, 480),
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    })
    if (bellErr) return { success: false as const, error: `delivery_failed:${bellErr.message}` }
    delivery = { route: "portal", recipient: portalUser.email ?? portalUser.company ?? portalUser.userId, message_id: null, at: now }
  } else if (route.route === "email" && titleEmail.email) {
    try {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const sendResult = await dispatchEmail({
        brokerageId: cda.brokerage_id,
        systemSource: "cda",
        from: "closings@platform.com",
        to: titleEmail.email,
        subject,
        html: `<p>${input.message?.trim() ? input.message.trim() : "Our review of the preliminary settlement statement against the executed contract found figures that do not agree. Please issue a corrected statement:"}</p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul><p>Reply with the revised official statement; the brokerage's disbursement authorization is held until it arrives.</p>`,
      })
      if ((sendResult as { success?: boolean } | null)?.success !== true) {
        return { success: false as const, error: `delivery_failed:${(sendResult as { error?: string } | null)?.error ?? "provider reported failure"}` }
      }
      delivery = { route: "email", recipient: titleEmail.email, message_id: (sendResult as { messageId?: string }).messageId ?? null, at: now }
    } catch (e) {
      return { success: false as const, error: `delivery_failed:${e instanceof Error ? e.message : String(e)}` }
    }
  }
  // route 'none': no title recipient is known — the request is RECORDED (approval blocked) and the
  // caller is told to deliver it by hand; the correction state does not depend on a send.

  const nextReview = reviewOnCorrectionRequested(review, { items, by: auth.userId, at: now, delivery, note: input.message ?? null })
  const { data: saved, error: saveErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({ field_values: { ...priorValues, preliminary_statement: nextReview }, updated_at: now })
    .eq("id", cda.id)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")
  if (saveErr) return { success: false as const, error: `correction_not_recorded:${saveErr.message}` }
  if (!saved || saved.length === 0) return { success: false as const, error: "not_found" }

  const { error: activityErr } = await supabase.from("activities").insert({
    brokerage_id: cda.brokerage_id,
    transaction_id: cda.transaction_id,
    agent_id: t?.agent_id ?? cda.agent_id ?? null,
    entity_type: "transaction",
    activity_type: "preliminary_cd_correction_requested",
    title: `Correction requested on the preliminary statement (version ${review.version})`,
    description: lines.join(" "),
    priority: "urgent",
    status: "pending",
    notes: JSON.stringify({ cda_id: cda.id, version: review.version, items, delivery, unverifiable: identified.unverifiable }),
  })
  if (activityErr) console.error("[cda-portal] preliminary_cd_correction_requested activity REJECTED:", activityErr.message)

  // The broker / compliance seats learn at once that approval is blocked on title's correction.
  const { data: reviewers } = await supabase
    .from("users")
    .select("id")
    .eq("brokerage_id", cda.brokerage_id)
    .in("user_type", [...CDA_APPROVE_ROLES])
    .limit(20)
  for (const u of (reviewers ?? []) as Array<{ id: string }>) {
    if (u.id === auth.userId) continue
    await bestEffort(supabase.from("notifications").insert({
      user_id: u.id,
      brokerage_id: cda.brokerage_id,
      type: "preliminary_cd_correction_requested",
      title: "CDA approval held — statement correction requested",
      body: `${items.length} discrepanc${items.length === 1 ? "y" : "ies"} documented on the preliminary statement${t?.property_address ? ` for ${t.property_address}` : ""}; approval is blocked until title's revised statement arrives.`,
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    }), "the correction request is already recorded; this is only the reviewer heads-up")
  }

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const, items, delivered: delivery.route !== "none", route: delivery.route, recipient: delivery.recipient, unverifiable: identified.unverifiable, version: review.version }
}

/** The statement's figures reconcile with the executed contract + waterfall — the version is REVIEWED (the broker may approve). */
export async function confirmPreliminaryCdReviewAction(input: { cdaId: string; note?: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda, error: cdaErr } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, field_values")
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (cdaErr) return { success: false as const, error: `cda_read_refused:${cdaErr.message}` }
  if (!cda) return { success: false as const, error: "not_found" }
  if (!(await canReviewPreliminaryStatement(supabase, auth, cda))) return { success: false as const, error: "forbidden" }

  const priorValues = ((cda as { field_values?: Record<string, unknown> | null }).field_values ?? {}) as Record<string, unknown>
  const review = preliminaryReviewOf(priorValues)
  if (!review) return { success: false as const, error: "no_preliminary_statement_on_file" }
  const now = new Date().toISOString()
  const nextReview = reviewOnConfirmed(review, auth.userId, now, input.note ?? null)
  const { data: saved, error: saveErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({ field_values: { ...priorValues, preliminary_statement: nextReview }, updated_at: now })
    .eq("id", cda.id)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")
  if (saveErr) return { success: false as const, error: `review_not_recorded:${saveErr.message}` }
  if (!saved || saved.length === 0) return { success: false as const, error: "not_found" }

  const { error: activityErr } = await supabase.from("activities").insert({
    brokerage_id: cda.brokerage_id,
    transaction_id: cda.transaction_id,
    agent_id: cda.agent_id ?? null,
    entity_type: "transaction",
    activity_type: "preliminary_cd_reviewed",
    title: `Preliminary statement version ${review.version} reconciled with the contract + waterfall`,
    description: input.note?.trim() || "Figures agree with the executed contract and the commission waterfall.",
    priority: "medium",
    status: "completed",
    completed_at: now,
    notes: JSON.stringify({ cda_id: cda.id, version: review.version, reviewed_by: auth.userId }),
  })
  if (activityErr) console.error("[cda-portal] preliminary_cd_reviewed activity REJECTED:", activityErr.message)

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const, version: review.version }
}

/**
 * THE BROKER IS OUTSIDE THE PLATFORM (owner verbatim: "otherwise the agent has to send the document
 * outside … fill the form out … download it and send it to the broker outside"): the agent delivered
 * the filled CDA to their managing broker outside VIPAgents (or through a legal-forms provider both
 * use) and RETURNS THE SIGNED DOCUMENT here. The signed copy on file is the broker's authorization —
 * never an envelope that was merely sent — so the CDA becomes approved + broker-signed and may go to
 * title. In-app brokerages never take this door (their broker signs in brokerSignCdaAction).
 */
export async function returnExternallySignedCdaAction(input: { cdaId: string; fileName: string; fileUrl: string; signedBy?: string | null }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!input.fileUrl?.trim() || !input.fileName?.trim()) return { success: false as const, error: "signed_document_required" }

  const { data: cda, error: cdaErr } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, status, revision_number, broker_approved_at, field_values")
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (cdaErr) return { success: false as const, error: `cda_read_refused:${cdaErr.message}` }
  if (!cda) return { success: false as const, error: "not_found" }
  if (!(auth.agentId && auth.agentId === cda.agent_id) && !COMPLIANCE_ROLES.has(auth.userType)) return { success: false as const, error: "forbidden" }
  if ((await loadCdaDispositionRoute(supabase, cda.brokerage_id)) !== "external_form_platform") {
    return { success: false as const, error: "brokerage_on_platform_use_in_app_broker_signature" }
  }
  if (cda.broker_approved_at) return { success: true as const, alreadyRecorded: true }
  if (cda.status !== "submitted") return { success: false as const, error: `cannot_return_signed_from_status:${cda.status}` }

  const now = new Date().toISOString()
  const { data: doc, error: docErr } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: cda.transaction_id,
      brokerage_id:   cda.brokerage_id,
      doc_type:       "cda_signed_external",
      doc_label:      input.fileName,
      storage_url:    input.fileUrl,
      status:         "uploaded",
      uploaded_by:    auth.userId,
      uploaded_at:    now,
      metadata:       { cda_id: cda.id, signed_by: input.signedBy ?? null, signed_outside_platform: true },
    })
    .select("id")
    .single()
  if (docErr || !doc) return { success: false as const, error: docErr?.message ?? "insert_failed" }

  const priorValues = ((cda as { field_values?: Record<string, unknown> | null }).field_values ?? {}) as Record<string, unknown>
  const { data: saved, error: saveErr } = await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "approved",
      broker_approved_at: now,
      field_values: { ...priorValues, broker_esign: { mode: "external_signed", provider: null, envelope_id: null, document_id: doc.id, signed_by: input.signedBy ?? null, returned_by: auth.userId, at: now } },
      updated_at: now,
    })
    .eq("id", cda.id)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")
  if (saveErr) return { success: false as const, error: `signed_return_not_recorded:${saveErr.message}` }
  if (!saved || saved.length === 0) return { success: false as const, error: "not_found" }

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "approved",
    action: "approved",
    notes: `Broker signed the CDA OUTSIDE the platform${input.signedBy ? ` (${input.signedBy})` : ""}; the signed copy is on file (transaction document ${doc.id}) — authorized for delivery to the closing agent.`,
    actedBy: auth.userId,
  })
  try {
    const { finalizeTransactionCommission } = await import("@/lib/commission/finalization")
    await finalizeTransactionCommission(supabase, cda.transaction_id, "cda_signed")
  } catch { /* finalization is best-effort */ }

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  return { success: true as const, documentId: doc.id }
}
