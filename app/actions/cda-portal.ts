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
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"
import { revalidatePath } from "next/cache"
import { canApproveCda, canBrokerSignCda, canSendCdaToTitle } from "@/lib/transactions/cda-signing-policy"
import { buildCdaContractVerdict, expectedGrossFromTerms, sumOutstandingAgentFees, type CdaDiscrepancy } from "@/lib/commission/cda-discrepancy"
import { bestEffort } from "@/lib/db/best-effort"

const COMPLIANCE_ROLES = new Set([
  "compliance_officer",
  "admin",
  "broker",
  "broker_admin",
  "superadmin",
])

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

export interface CdaContractVerdict {
  passed: boolean
  discrepancies: CdaDiscrepancy[]
  contractSplitPct: number | null
  capReached: boolean
  /** Unpaid fees the agent owes the brokerage — must be deducted in the CDA. */
  outstandingFees: number
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
  return { ...verdict, contractSplitPct: contractSplit, capReached, outstandingFees }
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

  // Find or create the CDA row.
  const { data: existing } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, revision_number")
    .eq("transaction_id", input.transactionId)
    .maybeSingle()

  let cdaId: string
  if (existing) {
    await supabase
      .from("closing_disclosure_agreement")
      .update({
        preliminary_cd_uploaded_at: new Date().toISOString(),
        preliminary_cd_document_id: input.documentId,
        preliminary_cd_uploaded_by: auth.userId,
        // Don't downgrade status if the agent already started drafting.
      })
      .eq("id", existing.id)
    cdaId = existing.id
  } else {
    const { data: created, error } = await supabase
      .from("closing_disclosure_agreement")
      .insert({
        transaction_id: input.transactionId,
        brokerage_id: txn.brokerage_id,
        agent_id: agent.id,
        status: "pending",
        preliminary_cd_uploaded_at: new Date().toISOString(),
        preliminary_cd_document_id: input.documentId,
        preliminary_cd_uploaded_by: auth.userId,
        revision_number: 1,
      })
      .select("id")
      .single()
    if (error || !created) return { success: false as const, error: error?.message ?? "create_failed" }
    cdaId = created.id
  }

  // Keep-one: closing_notifications was a write-only ledger (nothing reads it);
  // `notifications` below is the canonical in-app surface and already carries
  // this exact closing event to the same agent — repointed, duplicate removed.

  // In-app notification + activity (existing tables).
  await supabase.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: txn.brokerage_id,
    type: "preliminary_cd_received",
    title: "Preliminary CD ready",
    body: `Preliminary CD uploaded${txn.property_address ? ` for ${txn.property_address}` : ""}. Draft your CDA now.`,
    entity_type: "transaction",
    entity_id: input.transactionId,
    priority: "high",
    channel: "in_app",
  })

  // The record that the preliminary CD arrived and a CDA draft is now required.
  // A lost row here is a compliance step nobody knows is outstanding.
  const { error: prelimCdActivityError } = await supabase.from("activities").insert({
    transaction_id: input.transactionId,
    brokerage_id: txn.brokerage_id,
    agent_id: txn.agent_id,
    entity_type: "transaction",
    activity_type: "preliminary_cd_received",
    title: "Preliminary CD received",
    description: "TC / title uploaded the preliminary closing disclosure. CDA draft required.",
    priority: "high",
    status: "pending",
    notes: JSON.stringify({ cda_id: cdaId, document_id: input.documentId }),
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
    await supabase.from("notifications").insert({
      user_id:      tcUserId,
      brokerage_id: txn.brokerage_id,
      type:         "preliminary_cd_received",
      title:        "Preliminary CD ready for CDA",
      body:         `Preliminary CD uploaded${txn.property_address ? ` for ${txn.property_address}` : ""}. Coordinate with the agent on the CDA.`,
      entity_type:  "transaction",
      entity_id:    input.transactionId,
      priority:     "high",
      channel:      "in_app",
    })
  }

  // Create a "Draft and submit CDA" task for the agent so it shows up in
  // their tasks queue alongside the notification. Resolve agents.id as
  // assigned_to_agent_id (FK target).
  await supabase.from("tasks").insert({
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

  // Fan out via the canonical kernel event router so any sequences listening
  // for CD_RECEIVED auto-enroll, buyer/seller portals get a transparency
  // update (when a template exists for the event), and downstream listeners
  // pick it up uniformly.
  try {
    const { fanOutKernelEvent } = await import("@/lib/kernel/event-fanout")
    const { KernelEvent }       = await import("@/lib/kernel/events")
    await fanOutKernelEvent({
      event:           KernelEvent.CD_RECEIVED,
      brokerageId:     txn.brokerage_id,
      entityType:      "transaction",
      entityId:        input.transactionId,
      transactionId:   input.transactionId,
      buyerContactId:  (txnFull as any)?.buyer_contact_id  ?? undefined,
      sellerContactId: (txnFull as any)?.seller_contact_id ?? undefined,
      contactId:       (txnFull as any)?.contact_id        ?? undefined,
      agentUserId:     auth.userId,
      metadata:        { cdaId, documentId: input.documentId },
    })
  } catch { /* fan-out is best-effort; agent + TC already notified above */ }

  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true as const, cdaId }
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
    await supabase.from("closing_disclosure_agreement").update(payload).eq("id", cdaId)
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
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "submitted",
      agent_signed_off_at: now,
      agent_signed_off_by: auth.userId,
      agent_submitted_at: now,
      agent_submitted_by: auth.userId,
      field_values: { ...submitPriorFieldValues, agent_esign: { mode: agentEsign.mode, provider: agentEsign.provider, loop_id: agentEsign.loopId ?? null, dispatched: agentEsign.dispatched, reason: agentEsign.reason, at: now }, disposition: disposition.route, ...(submitAudit ? { submit_audit: submitAudit } : {}) },
      updated_at: now,
    })
    .eq("id", cda.id)

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
    await supabase.from("notifications").insert({
      user_id: auth.userId,
      brokerage_id: cda.brokerage_id,
      type: "cda_route_external",
      title: "Send your signed CDA to your brokerage",
      body: "Your brokerage isn't on the platform, so your signed CDA is ready to send through your configured form platform for their broker signature and compliance.",
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    }).then(() => {}, () => {})
  } else {
    // Notify in-app compliance for the brokerage.
    const { data: complianceUsers } = await supabase
      .from("users")
      .select("id")
      .eq("brokerage_id", cda.brokerage_id)
      .in("user_type", ["compliance_officer", "admin", "broker"])

    for (const u of complianceUsers ?? []) {
      await supabase.from("notifications").insert({
        user_id: u.id,
        brokerage_id: cda.brokerage_id,
        type: "cda_submitted",
        title: "CDA submitted for approval",
        body: "Agent has signed off and submitted a CDA for review.",
        entity_type: "transaction",
        entity_id: cda.transaction_id,
        priority: "medium",
        channel: "in_app",
      })
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
      "id, transaction_id, brokerage_id, agent_id, status, agent_signed_off_at, revision_number, signature_check_passed, manual_override_by, gross_commission, agent_net",
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
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "approved",
      compliance_approved_at: now,
      compliance_approved_by: auth.userId,
      updated_at: now,
    })
    .eq("id", cda.id)

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
      eventType:   "cda.approved",
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
    await supabase.from("notifications").insert({
      user_id: b.id,
      brokerage_id: cda.brokerage_id,
      type: "cda_awaiting_broker_signature",
      title: "✍️ A CDA needs your signature",
      body: "Compliance approved a Commission Disbursement Authorization. Sign it to authorize the disbursement, then it goes to the closing agent.",
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    }).then(() => {}, () => {})
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

  // Dispatch the formal e-signature on the filled CDA, per the brokerage's provider
  // (Dotloop auto / other providers manual / in-app when none or no filled PDF). The
  // in-app sign-off below is the authoritative state gate; e-sign is the transport on
  // top and never blocks it (dispatch is best-effort).
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
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      broker_approved_at: now,
      broker_id: auth.userId,
      field_values: { ...priorFieldValues, broker_esign: { mode: esign.mode, provider: esign.provider, loop_id: esign.loopId ?? null, dispatched: esign.dispatched, reason: esign.reason, at: now } },
      updated_at: now,
    })
    .eq("id", cda.id)

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
  await supabase
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
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      manual_override_by:     auth.userId,
      manual_override_at:     now,
      manual_override_reason: reason,
      updated_at:             now,
    })
    .eq("id", cda.id)

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
  recipientEmail:  string
  recipientName?:  string
  method?:         "email" | "docusign" | "dotloop" | "manual"
  subject?:        string
  message?:        string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, status, broker_approved_at")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  // The signed CDA may only go to title AFTER the broker has signed it (agent
  // signed before submit → compliance approved → broker signed → then sent).
  const sendVerdict = canSendCdaToTitle({ status: cda.status, brokerSigned: !!cda.broker_approved_at })
  if (!sendVerdict.ok) return { success: false as const, error: sendVerdict.error }

  const method = input.method ?? "email"
  if (method === "email") {
    try {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      await dispatchEmail({
        brokerageId:   cda.brokerage_id,
        systemSource:  "cda",
        from:          "closings@platform.com",
        to:            input.recipientEmail,
        subject:       input.subject ?? "Approved Commission Disbursement Authorization",
        html:          (input.message ?? "")
                       + `<p>The approved CDA for this transaction is ready for the closing.</p>`,
      })
    } catch { /* best-effort — record the send anyway so the agent can fall back */ }
  }

  const sentNow = new Date().toISOString()
  const recipient = input.recipientName
    ? `${input.recipientName} <${input.recipientEmail}>`
    : input.recipientEmail

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
      sent_to_title_method:    method,
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
