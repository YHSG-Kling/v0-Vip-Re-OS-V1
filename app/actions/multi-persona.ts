"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireBrokerageAdmin, type BrokerageAdminContext } from "@/lib/auth/require-brokerage-admin"
import { revalidatePath } from "next/cache"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { TRANSACTION_STATUSES_IN_ESCROW, TRANSACTION_STATUSES_TERMINAL, closeConfidence } from "@/lib/transactions/transaction-status"
import {
  MILESTONE_OPEN_STATUSES,
  DEADLINE_OPEN_STATUSES,
  isMilestoneStatus,
} from "@/lib/transactions/coordination-status"
import { requireContactAccess } from "@/lib/portal/require-contact-access"

// Multi-persona file covers brokerage admin, TC, lender, vendor, compliance,
// team, agent, and client surfaces. Every dashboard read in this file used
// to accept the persona-id (coordinatorId / lenderId / brokerageId / etc.)
// as a parameter with no auth check — a signed-in user could enumerate
// any persona's dashboard by guessing the id. Adding requireCaller() helper
// + ownership-verification across all dashboard reads. Mutations will be
// gated in subsequent commits as we audit each persona's write paths.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id, userType: u.user_type ?? "agent" }
}

// ============================================
// BROKERAGE ADMIN FUNCTIONS
// ============================================

export async function getBrokerageDashboard(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return null

  const supabase = await createClient()
  const brokerageId = auth.brokerageId

  const [
    { data: brokerage },
    { data: agents },
    { data: activeTransactions },
    // compliance_checks: pending reviews where allowed=false
    { data: pendingReviews },
    { data: recentCommissions },
  ] = await Promise.all([
    supabase.from("brokerages").select("*").eq("id", brokerageId).single(),
    supabase.from("agents").select("*").eq("brokerage_id", brokerageId).eq("is_active", true),
    supabase
      .from("transactions")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .not("status", "in", `(${TRANSACTION_STATUSES_TERMINAL.join(",")})`),
    // compliance_events is the gate ledger; allowed=false means a blocked/violation event
    // (compliance_checks is the separate doc-scan table with no `allowed` column).
    supabase
      .from("compliance_events")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .eq("allowed", false)
      .order("created_at", { ascending: false })
      .limit(10),
    // agent_commissions replaces agent_billing
    supabase
      .from("agent_commissions")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(5),
  ])

  const totalAgents = agents?.length || 0
  const totalActiveTransactions = activeTransactions?.length || 0
  const totalVolume =
    activeTransactions?.reduce(
      (sum, t) => sum + (t.purchase_price || t.list_price || 0),
      0
    ) || 0

  return {
    brokerage,
    agents,
    activeTransactions,
    pendingReviews,
    recentCommissions,
    metrics: {
      totalAgents,
      totalActiveTransactions,
      totalVolume,
      pendingComplianceReviews: pendingReviews?.length || 0,
    },
  }
}

// ============================================
// TRANSACTION COORDINATOR FUNCTIONS
// ============================================

/**
 * THE SPLIT-BRAIN THIS CLOSES.
 *
 * A TC assignment lived in TWO places that never talked to each other:
 *
 *   transactions.coordinator_id       written ONLY here, and this is the function
 *                                     behind the transaction detail page's
 *                                     "Assign TC" panel — the assignment UI an
 *                                     agent actually reaches
 *                                     (app/dashboard/transactions/[id]/assign-tc-panel.tsx:63).
 *   transaction_assignments           written ONLY by
 *                                     app/dashboard/settings/team/tc/tc-actions.ts,
 *                                     and READ by the coordinator dashboard
 *                                     (app/dashboard/coordinator/page.tsx:111).
 *
 * So a TC assigned from the deal page NEVER appeared on that TC's own dashboard —
 * the assignment looked like it worked, the deal was simply invisible to the person
 * assigned to it. Confirmed live: transaction_assignments and
 * transactions.coordinator_id both hold 0 rows, i.e. neither side has ever seen the
 * other's writes.
 *
 * The fix writes the junction the dashboard reads, in the same call. It is not a
 * competing writer: the junction row is keyed by UNIQUE (transaction_id,
 * coordinator_id), so this and tc-actions converge on the same row instead of
 * racing, and other coordinators on the deal are demoted rather than deleted —
 * transactions.coordinator_id is single-valued but the junction is not, and
 * throwing away another TC's assignment to satisfy a column is not a fix.
 *
 * THE THROWING CONTRACT IS DELIBERATE AND MUST STAY. Its one caller discards the
 * return value, which is only safe because failure arrives as an exception;
 * scripts/discarded-outcome-guard.ts:194 asserts exactly that. Every new failure
 * path below therefore throws too.
 */
export async function assignTransactionCoordinator(data: {
  transactionId: string
  coordinatorId: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = await createClient()

  // The coordinator must be one of OURS. Without this a caller could hand any
  // transaction to a coordinator id belonging to another brokerage.
  const { data: coordinator, error: coordError } = await supabase
    .from("transaction_coordinators")
    .select("id, brokerage_id")
    .eq("id", data.coordinatorId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (coordError) throw coordError
  if (!coordinator) throw new Error("Coordinator not found in your brokerage")

  // Update transaction with coordinator
  const { error: txnError } = await supabase
    .from("transactions")
    .update({ coordinator_id: data.coordinatorId })
    .eq("id", data.transactionId)
    .eq("brokerage_id", auth.brokerageId)

  if (txnError) throw txnError

  // Demote any other coordinator on this deal — one primary, many possible helpers.
  const { error: demoteError } = await supabase
    .from("transaction_assignments")
    .update({ is_primary: false })
    .eq("transaction_id", data.transactionId)
    .eq("brokerage_id", auth.brokerageId)
    .neq("coordinator_id", data.coordinatorId)
  if (demoteError) throw demoteError

  // THE ROW THE COORDINATOR DASHBOARD READS.
  const { error: junctionError } = await supabase
    .from("transaction_assignments")
    .upsert(
      {
        transaction_id: data.transactionId,
        coordinator_id: data.coordinatorId,
        brokerage_id: auth.brokerageId,
        assigned_by: auth.userId, // users-class: transaction_assignments.assigned_by is a users id
        is_primary: true,
      },
      { onConflict: "transaction_id,coordinator_id" }
    )
  if (junctionError) throw junctionError

  // active_transactions_count does not exist on transaction_coordinators.
  // max_active_deals is the cap — no counter column to update.

  revalidatePath("/dashboard/transactions")
  revalidatePath("/dashboard/coordinator")
  revalidatePath("/dashboard/settings/team/tc")
  return { success: true }
}

// getCoordinatorDashboard_v2 — DELETED, EXACT DUPLICATE.
//
//   getCoordinatorDashboard_v2 -> getCoordinatorDashboard (same file, below)
//
// The two bodies were byte-identical once the function name and one comment
// line were removed — same requireCaller() gate, same brokerage-scoped
// transaction_coordinators lookup, same three reads (transactions +
// transaction_milestones embed, transaction_deadlines, incomplete milestones),
// same shape returned. Nothing was lost because there was nothing different to
// lose. Both were unwired; the surviving name is the canonical one the
// coordinator dashboard is written against.

// ============================================
// VENDOR MANAGEMENT — CONSOLIDATED AWAY
// ============================================
//
// getVendorDirectory / bookVendor / updateVendorBookingStatus_v2 / rateVendor
// were a SECOND vendor rail living beside the live one, and every one of them
// was strictly weaker than its counterpart — three of the four leaked across
// tenants. They had no callers; the surfaces that book and rate vendors all use
// the rail below. Deleted with named replacements:
//
//   getVendorDirectory          -> searchVendors            (vendor-marketplace)
//       …the deleted one could not see GLOBAL vendors (brokerage_id IS NULL)
//        and never joined vendor_ratings.
//   bookVendor                  -> createVendorBooking      (vendor-marketplace)
//       …the deleted one ACCEPTED bookedBy and never wrote it, omitted
//        brokerage_id entirely (an anchorless row), and logged no timeline entry.
//   updateVendorBookingStatus_v2-> updateVendorBookingStatus (lib/kernel/vendors)
//       …the deleted one filtered on id alone — a cross-brokerage write — and
//        skipped the status transition graph and its lifecycle events.
//   rateVendor                  -> rateVendorBooking        (vendor-marketplace)
//       …the deleted one read the booking unscoped, so any authenticated user
//        could one-star a vendor in another brokerage's marketplace.
//
// matchVendorToTransaction and checkVendorAvailability were NOT duplicates —
// nothing else did either job. They moved to vendor-marketplace.ts (the rail
// that owns vendors) and were finished there.

// ============================================
// LENDER PORTAL FUNCTIONS
// ============================================


/**
 * Assign a LENDER VENDOR (vendors.category 'Lender') to a transaction.
 *
 * Lenders are vendors — a lender in a deal is a vendor assigned through the vendor
 * rail (vendor_assignments, assignment_type 'lending') plus a transaction_lenders
 * financing row. This replaced the retired lender_portal_users identity rail. The
 * lender vendor then inherits the RESPA settlement-service disclosure/kickback
 * gates automatically. Accepts the legacy `lenderId` param name (now a vendorId).
 */
export async function assignLenderToTransaction(data: {
  transactionId: string
  /** vendors.id of the lender vendor (accepts legacy `lenderUserId`/`lenderId`). */
  vendorId?: string
  lenderUserId?: string
  lenderId?: string
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  // SCOPE LADDER (kept inline — admits tc/agent/team_lead): 'superadmin' removed
  // — dead as users.user_type (0 live rows); broker_owner added — storable seat
  // that owns the brokerage. Mirrored by assign-lender-panel.tsx.
  if (!["broker", "broker_owner", "broker_admin", "admin", "tc", "agent", "team_lead"].includes(auth.userType)) {
    return { success: false, error: "Your role cannot assign a lender" }
  }
  const vendorId = data.vendorId ?? data.lenderUserId ?? data.lenderId
  if (!vendorId) return { success: false, error: "vendorId required" }

  const svc = createServiceClient()

  // The transaction (scoped to the caller's brokerage) is the source of truth for brokerage_id.
  const { data: txn } = await svc
    .from("transactions")
    .select("id, brokerage_id")
    .eq("id", data.transactionId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!txn) return { success: false, error: "Transaction not found in your brokerage" }

  // The lender must be a LENDER-category vendor in the same brokerage.
  const { data: vendor } = await svc
    .from("vendors")
    .select("id, name, category, brokerage_id")
    .eq("id", vendorId)
    .maybeSingle()
  const { isLenderVendorCategory, linkLenderVendorToTransaction } = await import("@/lib/kernel/lender-linkage")
  if (!vendor || !isLenderVendorCategory(vendor.category)) {
    return { success: false, error: "Selected vendor is not a lender" }
  }
  if (vendor.brokerage_id && vendor.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Lender vendor belongs to another brokerage" }
  }

  const link = await linkLenderVendorToTransaction(svc, {
    vendorId,
    transactionId: data.transactionId,
    brokerageId: txn.brokerage_id,
    lenderName: vendor.name ?? null,
  })
  if (!link.ok) return { success: false, error: link.error ?? "Failed to assign lender vendor" }

  revalidatePath("/dashboard/transactions")
  revalidatePath(`/dashboard/transactions/${data.transactionId}`)
  return { success: true }
}

// updateLoanStatus — DELETED, SUPERSEDED BY THE GATED LENDER ACTION.
//
//   updateLoanStatus -> app/actions/lender-portal-actions.ts:updateLenderLoanStatus
//
// Same capability — write transaction_lenders.underwriting_status + updated_at —
// evolved. The survivor is WIRED (app/portal/lender/[transactionId]/lender-actions.tsx)
// and adds requireLenderVendorActor(transactionId), which proves the caller is the
// lender VENDOR ASSIGNED to that deal (the deleted one had no auth check at all),
// plus a KernelEvent.JOURNEY_STAGE_UPDATED fan-out so the agent dashboard, the
// buyer/seller portals and the title portal all see the loan move.
//
// NOTHING WAS LOST. The deleted function's only distinct side effect — the
// transaction_timeline "financing_update" row carrying the free-text `notes` —
// COULD NEVER BE WRITTEN: it used createClient() (anon key, RLS applies) and
// omitted brokerage_id, so both WITH CHECK clauses on transaction_timeline
// (brokerage_id = current_user_brokerage_id()) evaluate to NULL and the INSERT is
// rejected — verified live: "new row violates row-level security policy for table
// transaction_timeline". The error was never checked, so the failure was silent.
// `notes` fed only that dead insert and `conditionsCleared` was never referenced
// at all. It targeted transaction_lenders by row id where the survivor targets by
// transaction_id, which is the same row: every reader in this codebase resolves a
// deal's loan with .maybeSingle() on transaction_id.
//
// FOLLOW-UP (not carried over deliberately, one line): the deleted one called
// revalidatePath("/portal/lender") — the lender INDEX — while the survivor
// revalidates only /portal/lender/[transactionId]. Adding the index path to
// updateLenderLoanStatus would make the loan list refresh after a status change.

export async function submitLoanConditions(data: {
  loanId: string
  conditions: Array<{
    condition: string
    status: string
    documents: string[]
  }>
}) {
  const supabase = await createClient()

  // Resolve the deal from the loan row FIRST so the vendor auth gate can run —
  // conditions previously saved with NO auth and NO notification (they died in
  // a notes column; the buyer never learned the lender needed their paystubs).
  const { data: loanRow } = await supabase
    .from("transaction_lenders")
    .select("id, transaction_id, lender_name, notes")
    .eq("id", data.loanId)
    .maybeSingle()
  // Same split as elsewhere: a missing ROW and a missing LINK are different
  // repairs. An unlinked loan row exists and is editable — saying "not found"
  // points the lender at re-creating a record that is already there, when the
  // actual fix is attaching it to its deal.
  if (!loanRow) throw new Error("Loan record not found")
  if (!loanRow.transaction_id) {
    throw new Error("This loan record is not linked to a transaction yet — attach it to the deal first.")
  }

  const { requireLenderVendorActor } = await import("@/lib/kernel/portal-auth")
  const actor = await requireLenderVendorActor(loanRow.transaction_id as string)

  // conditions_list is not a schema column on transaction_lenders.
  // Store as notes JSON until a migration adds a proper column.
  const { error } = await supabase
    .from("transaction_lenders")
    .update({
      notes: JSON.stringify(data.conditions),
    })
    .eq("id", data.loanId)

  if (error) throw error

  // CLOSE THE LOOP (owner rule: "lender requesting certain documents from the
  // buyer") — NEW outstanding conditions reach the humans who can act:
  // the agent gets the collection task, the buyer gets a GATED portal draft
  // (the request flows through the agent's governed rail, never raw), and
  // the ledger records who asked for what.
  try {
    let prior: string[] = []
    try { prior = (JSON.parse(String(loanRow.notes ?? "[]")) as any[]).map((c) => String(c?.condition ?? "")) } catch { /* fresh list */ }
    const outstanding = data.conditions.filter((c) => c.status !== "cleared" && c.condition.trim())
    const fresh = outstanding.filter((c) => !prior.includes(c.condition))
    if (fresh.length > 0) {
      const svc = (await import("@/lib/supabase/service")).createServiceClient()
      const { data: tx } = await svc.from("transactions")
        .select("id, agent_id, buyer_contact_id, contact_id, property_address, brokerage_id")
        .eq("id", loanRow.transaction_id).maybeSingle()
      const docList = fresh.map((c) => c.condition).join("; ")

      await svc.from("lifecycle_events").insert({
        brokerage_id: actor.brokerageId,
        entity_type: "transaction",
        entity_id: loanRow.transaction_id,
        event_type: "lender_document_request",
        actor_user_id: actor.userId,
        metadata: { lender: loanRow.lender_name ?? "lender", conditions: fresh.map((c) => c.condition) },
      }).then(() => {}, () => {})

      // The agent's collection task (assignee NOT-NULL contract honored).
      const assignee = (tx as any)?.agent_id ?? null
      if (assignee) {
        await svc.from("tasks").insert({
          brokerage_id: actor.brokerageId,
          transaction_id: loanRow.transaction_id,
          contact_id: (tx as any)?.buyer_contact_id ?? (tx as any)?.contact_id ?? null,
          assigned_to_agent_id: assignee,
          title: `Lender needs documents from the buyer — ${fresh.length} item${fresh.length === 1 ? "" : "s"}`,
          description: `${loanRow.lender_name ?? "The lender"} posted new loan conditions${(tx as any)?.property_address ? ` on ${(tx as any).property_address}` : ""}: ${docList}. Collect from the buyer and upload to the deal file.`,
          due_date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          assignee_type: "agent",
          source: "lender_condition",
          status: "pending",
          created_at: new Date().toISOString(),
        }).then(() => {}, () => {})
      }

      // The buyer's GATED portal draft — governed like every client touch.
      const buyerContactId = (tx as any)?.buyer_contact_id ?? (tx as any)?.contact_id ?? null
      if (buyerContactId) {
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        await proposeClientMessage({
          brokerageId: actor.brokerageId,
          agentKind: "deal_coordinator",
          entityType: "transaction",
          entityId: loanRow.transaction_id,
          recipientContactId: buyerContactId,
          audience: "buyer",
          subject: "Your lender needs a few documents",
          body: `Quick one from your loan team — they need: ${docList}. Send them over whenever you can today or tomorrow and I'll make sure they land in the right hands. This is normal at this stage and keeps your closing on schedule.`,
          rationale: `lender_condition_request — ${loanRow.lender_name ?? "lender"} posted ${fresh.length} new condition(s); the doc ask flows through the agent's governed rail.`,
          channel: "portal",
          outreachReason: "decision_required",
        }).catch(() => {})
      }
    }
  } catch (e) {
    console.error("[submitLoanConditions] notify fan-out failed (non-blocking):", e)
  }

  revalidatePath("/portal/lender")
  return { success: true }
}

// ============================================
// VENDOR PORTAL FUNCTIONS
// ============================================

export async function getVendorBookings(vendorId: string) {
  const supabase = await createClient()

  const { data: bookings } = await supabase
    .from("vendor_bookings")
    .select(`
      *,
      transactions(
        property_address
      )
    `)
    .eq("vendor_id", vendorId)
    .order("scheduled_date")

  return bookings || []
}

// ============================================
// COMPLIANCE OFFICER FUNCTIONS
// ============================================

export async function getComplianceOfficerDashboard(_officerId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { pendingReviews: [], recentViolations: [] }

  const supabase = await createClient()

  // compliance_reviews does not exist — use compliance_checks (violations) and
  // compliance_flags (flagged messages/content). Scope to caller's brokerage.
  const [{ data: pendingReviews }, { data: recentViolations }] =
    await Promise.all([
      supabase
        .from("compliance_events")
        .select("*")
        .eq("allowed", false)
        .eq("brokerage_id", auth.brokerageId)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("compliance_flags")
        .select("*")
        .eq("status", "flagged")
        .eq("brokerage_id", auth.brokerageId)
        .order("detected_at", { ascending: false })
        .limit(20),
    ])

  return { pendingReviews, recentViolations }
}

export async function submitComplianceReviewDecision(data: {
  reviewId: string
  status: "approved" | "rejected" | "needs_revision"
  findings: any[]
  riskLevel: string
  actionRequired?: string
  notes?: string
}) {
  const supabase = await createClient()

  // compliance_reviews does not exist — update compliance_flags instead
  const statusMap: Record<string, string> = {
    approved: "resolved",
    rejected: "resolved",
    needs_revision: "reviewed",
  }

  const { data: flag, error } = await supabase
    .from("compliance_flags")
    .update({
      status: statusMap[data.status] ?? "reviewed",
      severity: data.riskLevel,
      resolution_notes: data.notes,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", data.reviewId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/compliance")
  return flag
}

// ============================================
// WORKFLOW AUTOMATION
// ============================================

export async function createWorkflowAutomation(data: {
  workflowName: string
  workflowType: string
  triggerEvent: string
  triggerConditions: any
  actions: any[]
  assignedToRole: string
  createdBy: string
  brokerageId?: string
}) {
  const supabase = await createClient()

  const { data: workflow, error } = await supabase
    .from("workflow_automations")
    .insert({
      brokerage_id: data.brokerageId,
      workflow_name: data.workflowName,
      workflow_type: data.workflowType,
      trigger_event: data.triggerEvent,
      trigger_conditions: data.triggerConditions,
      actions: data.actions,
      assigned_to_role: data.assignedToRole,
      created_by: data.createdBy,
      is_active: true,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/admin/automations")
  return workflow
}

export async function executeWorkflow(workflowId: string, contextData: any) {
  const supabase = await createClient()

  // Runs a saved automation from workflow_automations — the canonical table the admin
  // automations UI manages. (Previously this read the retired workflow_executions with
  // an automation id — a table mismatch that made the Execute button a silent no-op.)
  const { data: workflow } = await supabase
    .from("workflow_automations")
    .select("*")
    .eq("id", workflowId)
    .single()

  if (!workflow || workflow.is_active === false) {
    return { success: false, reason: "Automation not active" }
  }

  const actions: any[] = workflow.actions || []

  // ── PER-ACTION OUTCOMES, so the run is recordable ────────────────────────
  // Until now this loop reported nothing about itself: the only trace a run left
  // was `execution_count + 1`, which counts attempts and cannot distinguish a
  // milestone update that landed from one this function refused. Each branch now
  // says what it did, and the summary goes to the automation_logs ledger below.
  const outcomes: Array<{ type: string; status: "done" | "skipped" | "refused"; detail?: string }> = []

  for (const action of actions) {
    switch (action.type) {
      case "send_email":
        // Deliberately a no-op here: outbound email has ONE egress and it is not
        // this loop. Recorded as skipped rather than silently counted as done.
        outcomes.push({ type: "send_email", status: "skipped", detail: "no egress wired in this executor" })
        break
      case "create_task":
        await supabase.from("tasks").insert({
          title: action.taskTitle,
          description: action.taskDescription,
          brokerage_id: contextData.brokerageId,
          assigned_to_agent_id: contextData.assignedTo,
          transaction_id: contextData.transactionId,
          due_date: action.dueDateOffset
            ? new Date(
                Date.now() + action.dueDateOffset * 24 * 60 * 60 * 1000
              )
                .toISOString()
                .split("T")[0]
            : null,
          status: "pending",
        })
        outcomes.push({ type: "create_task", status: "done", detail: String(action.taskTitle ?? "") })
        break
      case "update_milestone":
        // action.newStatus is operator-authored JSON from the automations UI —
        // nothing constrained it, and the update result was discarded. A status
        // the column cannot hold was rejected in silence while execution_count
        // still incremented below, so the automation reported a successful run
        // that moved nothing. Refuse the write instead of firing a doomed one.
        if (!isMilestoneStatus(action.newStatus)) {
          console.error(
            `[executeWorkflow] automation ${workflowId}: '${action.newStatus}' is not a milestone status; milestone not updated`,
          )
          outcomes.push({
            type: "update_milestone",
            status: "refused",
            detail: `'${String(action.newStatus)}' is not a milestone status`,
          })
          break
        }
        await supabase
          .from("transaction_milestones")
          .update({ status: action.newStatus })
          .eq("transaction_id", contextData.transactionId)
          .eq("milestone_name", action.milestoneName)
        outcomes.push({
          type: "update_milestone",
          status: "done",
          detail: `${String(action.milestoneName ?? "")} → ${String(action.newStatus)}`,
        })
        break
      default:
        // An action type this executor does not implement used to fall through in
        // total silence and still increment the counter — a run reported as
        // successful that did nothing at all.
        outcomes.push({ type: String(action?.type ?? "unknown"), status: "skipped", detail: "no handler in this executor" })
        break
    }
  }

  await supabase
    .from("workflow_automations")
    .update({ execution_count: (workflow.execution_count ?? 0) + 1, last_executed_at: new Date().toISOString() })
    .eq("id", workflowId)

  // ── THE PER-RUN LEDGER ───────────────────────────────────────────────────
  // `execution_count` counts attempts; it cannot tell a run that moved a
  // milestone from one that refused an operator-authored status and moved
  // nothing. app/actions/assistant.ts:handleAutomationTriggered is the writer for
  // that record — it existed, fully built and gated, with no caller anywhere in
  // the tree, and app/dashboard/admin/automations now reads what it writes.
  //
  // BEST-EFFORT BY CONSTRUCTION: the automation already ran and its effects are
  // committed, so a failure to journal it must not turn a completed run into a
  // reported failure. The refusal is logged, not thrown.
  try {
    const { data: { user: runUser } } = await supabase.auth.getUser()
    if (runUser) {
      const { handleAutomationTriggered } = await import("@/app/actions/assistant")
      await handleAutomationTriggered({
        automation_id: workflowId,
        user_id: runUser.id,
        trigger_type: workflow.trigger_event ?? "manual",
        result: {
          workflow_name: workflow.workflow_name ?? null,
          workflow_type: workflow.workflow_type ?? null,
          actions_total: actions.length,
          actions_done: outcomes.filter((o) => o.status === "done").length,
          actions_refused: outcomes.filter((o) => o.status === "refused").length,
          actions_skipped: outcomes.filter((o) => o.status === "skipped").length,
          outcomes,
          context: {
            transaction_id: contextData?.transactionId ?? null,
            brokerage_id: contextData?.brokerageId ?? null,
          },
        },
      })
    } else {
      console.warn(`[executeWorkflow] automation ${workflowId} ran without a session user — run not journalled`)
    }
  } catch (journalError) {
    console.error(`[executeWorkflow] automation ${workflowId} ran but the automation_logs journal failed:`, journalError)
  }

  revalidatePath("/dashboard/admin/automations")
  return { success: true, outcomes }
}

/**
 * THE client review writer — the portal's "Share your experience" widget
 * (app/portal/[contactId]/transaction/[transactionId]/client-feedback-widget.tsx).
 *
 * GATED ON THE CONTACT'S OWN PORTAL SESSION (§4). This is a `"use server"`
 * export, i.e. a public endpoint, and it used to take `brokerageId` and
 * `agentId` straight from the BODY with no session check at all — any signed-in
 * user could file a review into any brokerage against any agent. The gate is
 * the portal's shared one, `requireContactAccess`: it resolves whether the
 * caller IS this contact (linked user id, matching email, or an accepted
 * unexpired portal invite) or same-tenant staff. A review is authored by the
 * CLIENT, so `isContactSelf` is required — staff do not write a client's words.
 *
 * TENANT AND AGENT FROM THE RECORD, NOT THE BODY: brokerage_id is the gate's
 * (the contact's row), and the transaction must belong to this contact in that
 * brokerage — its agent_id is what the review is filed against. `agentId` and
 * `brokerageId` are kept in the signature for the existing caller and ignored.
 *
 * `leadId`, `categories` and `wouldRecommend` have no column on agent_reviews
 * (scripts/schema-snapshot.ts) and are accepted but not persisted — the same
 * un-homed inputs the deleted duplicate `submitClientReview` carried (see the
 * tombstone in the CLIENT REVIEW section below).
 *
 * The session client is used deliberately so `agent_reviews_pol` still runs
 * underneath this check; §3: every read destructures `error`.
 */
export async function submitClientFeedback(data: {
  leadId?: string
  contactId?: string
  transactionId: string
  /** @deprecated ignored — the agent is the transaction's agent_id. */
  agentId?: string
  rating: number
  reviewText: string
  categories: any
  wouldRecommend: boolean
  /** @deprecated ignored — the tenant is the contact's brokerage. */
  brokerageId?: string
}) {
  if (!data.contactId) throw new Error("contactId required")
  const access = await requireContactAccess(data.contactId)
  if (!access.ok) throw new Error(access.error)
  if (!access.isContactSelf) throw new Error("Only the client can submit their own review")

  const rating = Number(data.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("Rating must be 1–5")

  const svc = createServiceClient()
  const { data: txn, error: txnErr } = await svc
    .from("transactions")
    .select("id, agent_id, brokerage_id, contact_id, buyer_contact_id, seller_contact_id")
    .eq("id", data.transactionId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()
  if (txnErr) throw new Error(`Could not verify the transaction: ${txnErr.message}`)
  const t = txn as {
    id: string; agent_id: string | null; contact_id: string | null
    buyer_contact_id: string | null; seller_contact_id: string | null
  } | null
  const belongsToContact =
    !!t && [t.contact_id, t.buyer_contact_id, t.seller_contact_id].includes(data.contactId)
  if (!t || !belongsToContact) throw new Error("That transaction isn't yours to review")
  if (!t.agent_id) throw new Error("That transaction has no agent to review")

  const supabase = await createClient()

  // client_reviews does not exist — use agent_reviews
  // agent_reviews: id, brokerage_id, agent_id, contact_id, transaction_id,
  // rating, review_text, platform, source_url, is_published, response_text,
  // response_at, created_at, updated_at
  const { data: review, error } = await supabase
    .from("agent_reviews")
    .insert({
      brokerage_id: access.brokerageId,
      agent_id: t.agent_id,
      contact_id: data.contactId,
      transaction_id: t.id,
      rating,
      review_text: data.reviewText,
      platform: "internal",
      is_published: false,
    })
    .select()
    .single()

  if (error) throw error

  return review
}

// ============================================
// TEAM MANAGEMENT FUNCTIONS
// ============================================

/**
 * Create a team. The ONLY writer of `public.teams` in the app.
 *
 * ── THE TENANT IS NOT AN ARGUMENT ────────────────────────────────────────────
 * This used to take `brokerageId` from its caller, and its caller is a CLIENT
 * component — so the tenant a row was written into came from the browser. It is
 * resolved from the SESSION here instead, through the one shared gate
 * (`lib/auth/require-brokerage-admin.ts`), which also asserts the caller may
 * administer that tenant.
 *
 * The gate MIRRORS m457's `teams_tenant_insert`
 * (`brokerage_id = current_user_brokerage_id() AND is_brokerage_admin()`); it
 * never exceeds it. The session client is used deliberately — NOT the service
 * client — so that policy still runs underneath this check and remains the
 * final authority. A zero-row refusal from it is caught below.
 *
 * ── WHAT IS DELIBERATELY NOT WRITTEN ─────────────────────────────────────────
 * `member_overrides_json` is left to its column default (`'[]'::jsonb`). Despite
 * the name, its ONLY reader is `lib/kernel/brand-voice.ts:142`
 * (`member_overrides_json.brand_voice`) — that column is the team's BRAND VOICE
 * override, not money. PER-MEMBER MONEY lives in `team_members`
 * (`split_percent`, `source_of_funds`, effective dating), written by
 * `app/actions/admin/team-members.ts` and read by
 * `lib/commission/waterfall/08-team-split.ts:82-102`. The old
 * `commissionSplitRules` parameter (which no caller ever passed) wrote
 * `JSON.stringify(...)` into it, storing a jsonb STRING SCALAR rather than an
 * object — a shape the brand-voice reader can only see as `undefined`. Nothing
 * read it back as splits. See the column inventory in
 * `app/actions/team-branding.ts:149-166`, which reaches the same conclusion.
 */
export async function createTeam(data: {
  teamName: string
  teamLeaderId: string
}) {
  const supabase = await createClient()

  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError) throw new Error(`Could not verify your session: ${authError.message}`)
  const user = authData?.user
  if (!user) throw new Error("You must be signed in to create a team.")

  // requireBrokerageAdmin THROWS on refusal and speaks in gate language. This
  // string is shown verbatim in the dialog's toast, so a REFUSAL is translated
  // into what the reader can act on, while anything that is not a refusal (a
  // failed read, a malformed id) keeps its own reason — "you may not" and "we
  // could not tell" must not look identical to the person at the screen.
  let admin: BrokerageAdminContext
  try {
    admin = await requireBrokerageAdmin(supabase, user.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith("Forbidden") || message.startsWith("User not found")) {
      throw new Error("Only a broker, brokerage admin or brokerage owner can create a team.")
    }
    throw new Error(`Could not create the team: ${message}`)
  }

  const name = typeof data.teamName === "string" ? data.teamName.trim() : ""
  if (!name) throw new Error("Team name is required.")
  if (!data.teamLeaderId) throw new Error("Select a team leader.")

  // teams.team_lead_id is a FK to users.id (verified against the live schema:
  // teams_team_lead_id_fkey → users(id)), and m457's UPDATE policy compares it
  // to auth.uid() — so it is a USERS id, not an agents id. The picker in
  // app/dashboard/team/page.tsx reads `users`, which is the right id class; this
  // check is what stops a hand-crafted request naming a user from ANOTHER
  // brokerage as the lead, which no database constraint would refuse.
  const { data: lead, error: leadError } = await supabase
    .from("users")
    .select("id")
    .eq("id", data.teamLeaderId)
    .eq("brokerage_id", admin.brokerageId)
    .maybeSingle()

  // supabase-js RESOLVES a failed query, so an unchecked read would report a
  // permission denial as "no such user" and blame the wrong thing.
  if (leadError) throw new Error(`Could not verify the team leader: ${leadError.message}`)
  if (!lead) throw new Error("That team leader is not a member of your brokerage.")

  // agent_teams does not exist — use teams table
  // teams: id, name, brokerage_id, team_lead_id, created_at, updated_at, deleted_at,
  // team_split_type, team_split_value, member_overrides_json, team_fees_json
  const { data: inserted, error } = await supabase
    .from("teams")
    .insert({
      name,
      team_lead_id: lead.id,
      brokerage_id: admin.brokerageId,
    })
    .select("id, name, brokerage_id, team_lead_id")

  if (error) throw new Error(`Could not create the team: ${error.message}`)

  // A row refused by RLS comes back as `error: null` with ZERO rows — the insert
  // is filtered, not failed. Without this the caller would be told the team was
  // created and shown nothing. `.select()` returns a list precisely so that the
  // refusal is countable; `.single()` would have turned it into a coercion error
  // whose message says nothing about permissions.
  if (!inserted || inserted.length === 0) {
    throw new Error(
      "The database refused to create this team. Only a broker, brokerage admin or brokerage owner may create teams, and only in their own brokerage.",
    )
  }

  // /dashboard/teams is a redirect-only route; the team surface that lists these
  // rows is /dashboard/team.
  revalidatePath("/dashboard/team")
  return inserted[0]
}

export async function getTeamDashboard(teamId: string) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = await createClient()

  const { data: team } = await supabase
    .from("teams")
    .select("*")
    .eq("id", teamId)
    .eq("brokerage_id", auth.brokerageId)
    .single()

  if (!team) throw new Error("Team not found")

  // team_members junction table
  const { data: teamMemberRows } = await supabase
    .from("team_members")
    .select("agent_id")
    .eq("team_id", teamId)
    .eq("is_active", true)

  const agentIds = teamMemberRows?.map((r) => r.agent_id) || []

  const { data: teamMembers } = agentIds.length > 0
    ? await supabase.from("agents").select("*").in("id", agentIds)
    : { data: [] }

  const { data: teamTransactions } = agentIds.length > 0
    ? await supabase
        .from("transactions")
        .select("*")
        .in("agent_id", agentIds)
        .not("status", "in", `(${TRANSACTION_STATUSES_TERMINAL.join(",")})`)
    : { data: [] }

  return {
    team,
    teamMembers,
    teamTransactions,
    metrics: {
      totalMembers: teamMembers?.length || 0,
      activeTransactions: teamTransactions?.length || 0,
      totalVolume:
        teamTransactions?.reduce(
          (sum, t) => sum + (t.purchase_price || 0),
          0
        ) || 0,
    },
  }
}

// ============================================
// BILLING & COMMISSION FUNCTIONS
// ============================================

export async function calculateAgentBilling(data: {
  agentId: string
  brokerageId: string
  billingPeriodStart: string
  billingPeriodEnd: string
}) {
  const supabase = await createClient()

  // Closed transactions in billing period — use close_date (not actual_closing_date)
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*")
    .eq("agent_id", data.agentId)
    .eq("status", "closed")
    .gte("close_date", data.billingPeriodStart)
    .lte("close_date", data.billingPeriodEnd)

  let brokerageSplit: number
  if (data.agentId && data.brokerageId) {
    const structure = await getDefaultCommissionStructure(
      data.brokerageId,
      data.agentId
    )
    brokerageSplit = 1 - structure.splitDecimal
  } else {
    throw new Error(
      "[multi-persona] brokerageId and agentId required to resolve commission structure"
    )
  }

  // commission_amount is on the transactions table (canonical column)
  const grossCommission =
    transactions?.reduce(
      (sum, t) => sum + (t.commission_amount || 0),
      0
    ) || 0
  const brokerageSplitAmount = grossCommission * brokerageSplit

  const transactionFees = (transactions?.length || 0) * 395
  const deskFees = 100
  const technologyFees = 75
  const eAndOInsurance = 50
  const netToAgent =
    grossCommission -
    brokerageSplitAmount -
    transactionFees -
    deskFees -
    technologyFees -
    eAndOInsurance

  // agent_billing table does not exist — log to agent_commissions instead
  // Return the calculated values for the caller to use
  return {
    agentId: data.agentId,
    brokerageId: data.brokerageId,
    billingPeriodStart: data.billingPeriodStart,
    billingPeriodEnd: data.billingPeriodEnd,
    grossCommission,
    brokerageSplitAmount,
    transactionFees,
    deskFees,
    technologyFees,
    eAndOInsurance,
    netToAgent,
    transactionCount: transactions?.length || 0,
  }
}

// ============================================
// CLIENT REVIEW FUNCTIONS
// ============================================

// TOMBSTONE (§1.1, wave 26, lane L4): `submitClientReview` DELETED.
//
//   SURVIVOR: app/actions/multi-persona.ts:submitClientFeedback (above, in the
//   AUTOMATION section) — the same agent_reviews insert (platform "internal",
//   is_published=false), WIRED from
//   app/portal/[contactId]/transaction/[transactionId]/client-feedback-widget.tsx.
//
// What the survivor was MISSING was ported onto it first, per the doctrine: the
// duplicate's session gate (the survivor took brokerage_id and agent_id from
// the request body with no auth at all) — now the portal contact's own session
// via requireContactAccess + isContactSelf, tenant from the contact row, agent
// from the verified transaction. Nothing else was portable: `leadId`,
// `reviewCategories`, `wouldRecommend` and `reviewSource` — the inputs this
// function accepted — have no column on agent_reviews (scripts/schema-snapshot.ts),
// so they are recorded HERE as the un-homed capture the widget still collects
// client-side (categories + wouldRecommend) and the survivor accepts and does
// not persist. agent_reviews' other client-side writer is
// app/actions/portal-lifetime.ts (the lifetime testimonial capture).

/**
 * The CLIENT-FACING read of an agent's reputation: PUBLISHED reviews only.
 *
 * NOT a duplicate of lib/kernel/reputation.ts:loadReputationWorkspace, which is the
 * AGENT-side workspace — it returns every review including unpublished drafts, plus
 * review_requests and referrals, for the agent's own console. This one is what a
 * client may see about their agent, and `is_published = true` is the whole point of
 * the distinction.
 *
 * TENANT: createClient() means the anon key and RLS applies — agent_reviews_pol is
 * `brokerage_id = current_user_brokerage_id()`, and a portal contact has a real
 * users row (user_type 'contact', brokerage_id = the contact's brokerage; see
 * lib/portal/portal-invite-core.ts), so the policy resolves for them. The explicit
 * brokerage filter below is belt-and-braces so the query is still correct if this
 * is ever moved onto a service client.
 *
 * Returns rather than throws: this is read by a page, and an exception here would
 * blank the whole portal instead of one card.
 */
export async function getAgentReviews(agentId: string) {
  const auth = await requireCaller()
  if (!auth.ok) {
    return { reviews: [], metrics: { totalReviews: 0, averageRating: 0, recommendationRate: 0 }, error: auth.error }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_reviews")
    .select("id, agent_id, contact_id, rating, review_text, platform, reviewer_name, created_at")
    .eq("agent_id", agentId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("is_published", true)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[multi-persona] getAgentReviews read failed:", error.message)
    return { reviews: [], metrics: { totalReviews: 0, averageRating: 0, recommendationRate: 0 }, error: error.message }
  }

  const rows = data ?? []
  const avgRating = rows.length > 0 ? rows.reduce((sum, r) => sum + (r.rating || 0), 0) / rows.length : 0

  return {
    reviews: rows,
    metrics: {
      totalReviews: rows.length,
      averageRating: avgRating,
      // agent_reviews has no would_recommend column. A 4-or-5 star review is the
      // closest HONEST proxy and it is labelled as that, not as a recommendation rate.
      recommendationRate:
        rows.length > 0 ? Math.round((rows.filter((r) => (r.rating ?? 0) >= 4).length / rows.length) * 100) : 0,
    },
    error: null as string | null,
  }
}

// ============================================
// CLIENT JOURNEY PREFERENCES
// ============================================

/**
 * The CLIENT's own must-haves — the portal contact tells their agent what a
 * home has to have. Wired from app/portal/[contactId]/journey (the
 * "What we're looking for" card's editor island).
 *
 * NARROWED ON PURPOSE (wave 26, lane L4). property_interests is ONE ROW PER
 * CONTACT (unique index uq_property_interests_contact) and the AGENT already
 * writes it — app/crm/contacts/[contactId]/search/search-client.tsx
 * handleSaveCriteria upserts min/max price, beds, baths, property_type,
 * preferred_locations, zip_codes. This writer therefore touches ONLY the
 * columns the agent's writer does not own: `must_have_features` (the client's
 * list) and `keywords` (deal-breakers + lifestyle priorities, comma-joined). A
 * partial upsert leaves the agent's price/beds/areas intact on the same row.
 *
 * DROPPED from the earlier, never-wired shape: writing `preferred_locations`
 * (would have clobbered the agent's areas) and a JSON blob into `notes` (a
 * prose column the agent's contact page prints verbatim). The inputs that had
 * no column anywhere — sellingTimeline, sellingMotivation, decisionMakers,
 * decisionTimeline, preferredContactTimes, frequencyPreference, commute,
 * schools, niceToHave — are recorded here as un-homed; they need a table before
 * they can be accepted honestly.
 *
 * GATE (§4): requireContactAccess — the contact themself (linked user, matching
 * email, or an accepted unexpired portal invite) OR same-tenant staff entering
 * them on the client's behalf. Tenant = the contact row's brokerage, never a
 * parameter. The write runs on the service client because the boundary IS this
 * gate (property_interests' tenant policy admits every row in the brokerage,
 * which is the wrong grain for a client); §3: `error` is read, and the upsert
 * is `.select()`ed so a silently unmatched write cannot report success.
 */
export async function saveClientJourneyPreferences(data: {
  contactId: string
  mustHaveFeatures?: string[]
  dealBreakers?: string[]
  lifestylePriorities?: string[]
}): Promise<{ success: true; mustHaveFeatures: string[] } | { success: false; error: string }> {
  if (!data.contactId) return { success: false, error: "contactId required" }
  const access = await requireContactAccess(data.contactId)
  if (!access.ok) return { success: false, error: access.error }

  const clean = (xs: string[] | undefined, max: number) =>
    Array.from(new Set((xs ?? []).map((s) => String(s).trim()).filter(Boolean))).slice(0, max)
  const mustHave = clean(data.mustHaveFeatures, 25)
  const keywords = clean([...(data.dealBreakers ?? []), ...(data.lifestylePriorities ?? [])], 25)

  const svc = createServiceClient()
  const { data: row, error } = await svc
    .from("property_interests")
    .upsert(
      {
        contact_id: data.contactId,
        // TENANT ANCHOR — the contact row's brokerage (from the gate). Omitting
        // this wrote brokerage_id NULL, and property_interests_tenant_select is
        //   (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
        // — an unanchored row is readable by EVERY tenant on the platform.
        brokerage_id: access.brokerageId,
        must_have_features: mustHave,
        keywords: keywords.join(", "),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "contact_id" },
    )
    .select("id, must_have_features")
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!row) return { success: false, error: "Preferences were not saved (no row returned)" }

  revalidatePath(`/portal/${data.contactId}/journey`)
  return {
    success: true,
    mustHaveFeatures: Array.isArray((row as { must_have_features?: unknown }).must_have_features)
      ? ((row as { must_have_features: string[] }).must_have_features)
      : mustHave,
  }
}

/**
 * The client's stated criteria as they stand on file.
 *
 * A READ, so it is not blocked by the second-writer verdict above — the row exists
 * (written by the agent-side handleSaveCriteria) and the client had no way to see
 * what their agent had recorded for them.
 *
 * AUTHORIZATION: property_interests_tenant_select admits any row whose brokerage
 * matches the caller's, so RLS alone lets one portal contact read ANOTHER portal
 * contact's criteria — both are `user_type: 'contact'` rows in the same brokerage.
 * requireContactAccess is what actually stops that: it proves the caller is either
 * this contact or same-brokerage staff before the query runs.
 */
export async function getClientJourneyPreferences(
  // TOMBSTONE — this was `leadId?: string` and was read by NOTHING. The row this
  // reads (`property_interests`) is keyed on the CONTACT, and the one caller
  // (app/portal/[contactId]/journey/page.tsx) has always passed `undefined` for it.
  // Kept as a positional placeholder and `_`-prefixed rather than removed, so the
  // existing call shape keeps working — the same idiom `forecastBrokerageRevenue`
  // below already uses for `_brokerageId`. Survivor of the "which record is this
  // about" question: `contactId`, plus the tenant on the session
  // (requireContactAccess, below).
  _leadId?: string,
  contactId?: string
) {
  if (!contactId) return null

  const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(contactId)
  if (!access.ok) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("property_interests")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle() // .single() made "no criteria on file yet" an exception (PGRST116)

  if (error) {
    console.error("[multi-persona] getClientJourneyPreferences read failed:", error.message)
    return null
  }

  return data
}

// ============================================
// BROKERAGE REVENUE FORECASTING
// ============================================

export async function forecastBrokerageRevenue(
  _brokerageId?: string,
  months: number = 3
) {
  // Financial forecast — was leaking historical GCI + pipeline value
  // across tenants. Always scope to caller's session brokerage.
  const auth = await requireCaller()
  if (!auth.ok) {
    return { conservative: 0, likely: 0, optimistic: 0, pipelineValue: 0, historicalAverage: 0 }
  }

  const supabase = await createClient()
  const brokerageId = auth.brokerageId

  const { data: historical } = await supabase
    .from("brokerage_earnings")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("period_type", "monthly")
    .order("computed_at", { ascending: false })
    .limit(12)

  const { data: pipeline } = await supabase
    .from("transactions")
    .select("purchase_price, close_date, status, commission_percentage")
    .eq("brokerage_id", brokerageId)
    .gte("close_date", new Date().toISOString().split("T")[0])
    .in("status", [...TRANSACTION_STATUSES_IN_ESCROW])

  const avgHistoricalGCI =
    (historical?.reduce(
      (sum, p) => sum + (p.gross_commission_income || 0),
      0
    ) || 0) / (historical?.length || 1)

  const pipelineGCI =
    pipeline?.reduce((sum, t) => {
      const commission =
        (t.purchase_price || 0) * ((t.commission_percentage || 3) / 100)
      const probability =
        closeConfidence(t.status)
      return sum + commission * probability
    }, 0) || 0

  return {
    conservative: pipelineGCI * 0.7 + avgHistoricalGCI * 0.3 * months,
    likely: pipelineGCI * 0.85 + avgHistoricalGCI * 0.5 * months,
    optimistic: pipelineGCI + avgHistoricalGCI * 0.8 * months,
    pipelineValue: pipelineGCI,
    historicalAverage: avgHistoricalGCI,
  }
}

// ============================================
// LICENSE EXPIRATION TRACKING
// ============================================

export async function trackLicenseExpirations(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { expiringLicenses: [], expiredLicenses: [], totalAgents: 0 }

  const supabase = await createClient()

  const { data: agents } = await supabase
    .from("agents")
    .select("*, agent_licenses(*)")
    .eq("brokerage_id", auth.brokerageId)

  const sixtyDaysFromNow = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)

  const expiringLicenses =
    agents?.filter((agent) => {
      const license = (agent.agent_licenses as any[])?.[0]
      if (!license?.expiration_date) return false
      const expiry = new Date(license.expiration_date)
      return expiry <= sixtyDaysFromNow && expiry > new Date()
    }) || []

  const expiredLicenses =
    agents?.filter((agent) => {
      const license = (agent.agent_licenses as any[])?.[0]
      if (!license?.expiration_date) return false
      return new Date(license.expiration_date) < new Date()
    }) || []

  return {
    expiringLicenses,
    expiredLicenses,
    totalAgents: agents?.length || 0,
  }
}

// ============================================
// REFERRAL PARTNER FUNCTIONS
// ============================================

// CONSOLIDATED AWAY — createReferralPartner
//
// Its ONLY advantage over the wired path was that it captured the partner's
// email, phone and agreement_date. That is no longer true: those three now live
// on app/actions/referrals/referral-actions.ts:createPartner, which additionally
// enforces the RESPA kickback gate and derives agentId/brokerageId from the
// session instead of taking them as spoofable parameters, and the agent referrals
// form now collects all three. Nothing is lost by its removal — which is exactly
// the bar it had to clear.
// CONSOLIDATED AWAY — trackReferral
//
// It inserted into `referrals` exactly like the wired path does, and had zero
// callers. Four things it could do that the wired path could not have been
// asked for — all four now live on
// app/actions/referrals/referral-actions.ts:createReferral:
//
//   the full 7-value status vocabulary  -> lib/referrals/referral-status.ts,
//       which ReferralRow["status"] and CreateReferralParams.status both use.
//   referred_lead_id                    -> CreateReferralParams.referredLeadId.
//       This was the ONLY function in the codebase that ever wrote that column.
//   a partner-less referral             -> CreateReferralParams.partnerId is now
//       optional, matching the nullable column.
//   closed_at stamped at creation       -> createReferral stamps it when the
//       referral is created already closed.
//
// Its `transactionId` parameter was accepted and never written anywhere, so
// there was nothing there to carry over.
//
// What the survivor adds, and why it is the one that lives: it derives agentId
// and brokerageId from the session instead of taking them as spoofable
// parameters, runs the referred person through captureContact(), bumps the
// partner's total_referrals_received, and writes a REFERRAL_RECEIVED lifecycle
// event. Nothing is lost by this removal — which is exactly the bar it had
// to clear.

export async function getReferralPartnerStats(partnerId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { totalReferrals: 0, convertedReferrals: 0, totalCommission: 0, conversionRate: 0 }

  const supabase = await createClient()

  const { data: referrals } = await supabase
    .from("referrals")
    .select("*")
    .eq("partner_id", partnerId)
    .eq("brokerage_id", auth.brokerageId)

  const totalReferrals = referrals?.length || 0
  const convertedReferrals =
    referrals?.filter(
      (r) => r.status === "under_contract" || r.status === "closed"
    ).length || 0
  const totalCommission =
    referrals?.reduce((sum, r) => sum + (r.commission_amount || 0), 0) || 0
  const conversionRate =
    totalReferrals > 0 ? (convertedReferrals / totalReferrals) * 100 : 0

  return { totalReferrals, convertedReferrals, totalCommission, conversionRate }
}

// ============================================
// TRANSACTION COORDINATOR ANALYTICS
// ============================================

export async function predictDeadlineRisks(
  coordinatorId: string,
  scopedTransactionIds?: string[]
) {
  const supabase = await createClient()

  // When the caller already has the canonical list of transaction IDs (e.g.
  // fetched via transaction_assignments), restrict the query to that set so
  // the risk results stay in sync with what the dashboard displays.
  let query = supabase
    .from("transactions")
    .select(`
      *,
      transaction_milestones(*),
      transaction_deadlines(*)
    `)
    .not("status", "in", `(${TRANSACTION_STATUSES_TERMINAL.join(",")})`)

  if (scopedTransactionIds !== undefined) {
    // Explicit scope provided — use it; empty array means no transactions in scope
    if (scopedTransactionIds.length === 0) {
      return { atRiskTransactions: [], atRiskCount: 0 }
    }
    query = query.in("id", scopedTransactionIds)
  } else {
    query = query.eq("coordinator_id", coordinatorId)
  }

  const { data: transactions } = await query

  const atRisk = transactions?.filter((t) => {
    const daysToClosing = t.close_date
      ? Math.floor(
          (new Date(t.close_date).getTime() - Date.now()) /
            (1000 * 60 * 60 * 24)
        )
      : 999
    const milestones = (t.transaction_milestones as any[]) || []
    const completedCount = milestones.filter(
      (m) => m.status === "completed"
    ).length
    const completionRate =
      milestones.length > 0
        ? (completedCount / milestones.length) * 100
        : 0
    return completionRate < 70 && daysToClosing <= 10
  })

  return {
    atRiskTransactions: atRisk || [],
    atRiskCount: atRisk?.length || 0,
    totalActive: transactions?.length || 0,
  }
}

// ============================================
// LENDER CONDITION TRACKING
// ============================================

/**
 * Measure how far a loan's conditions have been cleared.
 *
 * `promoteOnFullClearance` DEFAULTS TO FALSE ON PURPOSE.
 *
 * This function used to flip `underwriting_status` to `clear_to_close` by itself
 * the moment the last condition was marked cleared — silently, with no
 * confirmation and no notification to anyone. That never actually fired, because
 * nothing called this function and the lender panel did not even offer the
 * "cleared" status it keys on, so the branch was unreachable.
 *
 * Wiring the panel up makes it reachable, and a reachable silent milestone write
 * is a different thing from a dormant one. Clear-to-close is the lender signing
 * off on the loan: `app/actions/lender-portal-actions.ts:issueClearToClose` is the
 * explicit path for it, and it is confirmation-gated AND notifies the buyer and
 * the agent. Two writers of the same milestone, one of them silent, is how a deal
 * advances without anybody being told.
 *
 * So the promotion is kept — nothing is deleted — but it is now opt-in. The panel
 * reads this for the meter only and routes the actual milestone through the gated
 * path. A caller that genuinely wants the automatic promotion can still ask for it.
 */
export async function trackConditionClearance(loanId: string, promoteOnFullClearance = false) {
  const supabase = await createClient()

  const { data: loan } = await supabase
    .from("transaction_lenders")
    .select("*")
    .eq("id", loanId)
    .single()

  // conditions_list stored in notes as JSON (see submitLoanConditions)
  let conditionsList: any[] = []
  try {
    conditionsList = loan?.notes ? JSON.parse(loan.notes) : []
  } catch {
    conditionsList = []
  }

  const pendingConditions = conditionsList.filter(
    (c) => c.status !== "cleared"
  )
  const clearedConditions = conditionsList.filter(
    (c) => c.status === "cleared"
  )
  const clearanceRate =
    conditionsList.length > 0
      ? (clearedConditions.length / conditionsList.length) * 100
      : 0

  if (
    promoteOnFullClearance &&
    clearanceRate === 100 &&
    loan?.underwriting_status !== "clear_to_close"
  ) {
    const { error: promoteError } = await supabase
      .from("transaction_lenders")
      .update({ underwriting_status: "clear_to_close" })
      .eq("id", loanId)
    if (promoteError) {
      console.error("[trackConditionClearance] clear_to_close promotion failed:", promoteError.message)
    }
  }

  return { pendingConditions, clearedConditions, clearanceRate }
}

// ============================================
// TITLE ISSUE TRACKING
// ============================================

export async function trackTitleIssues(transactionId: string) {
  const supabase = await createClient()

  const { data: titleInfo } = await supabase
    .from("transaction_title_escrow")
    .select("*")
    .eq("transaction_id", transactionId)
    .single()

  // title_issues is a text column in schema — parse as JSON if structured
  let issues: any[] = []
  try {
    issues = titleInfo?.title_issues
      ? JSON.parse(titleInfo.title_issues)
      : []
  } catch {
    // Plain text — treat as single unresolved issue
    issues = titleInfo?.title_issues
      ? [{ text: titleInfo.title_issues, status: "open", severity: "moderate" }]
      : []
  }

  const unresolvedIssues = issues.filter((i) => i.status !== "resolved")
  const critical = unresolvedIssues.filter(
    (i) => i.severity === "critical"
  )
  const moderate = unresolvedIssues.filter(
    (i) => i.severity === "moderate"
  )

  return {
    critical,
    moderate,
    totalUnresolved: unresolvedIssues.length,
    canClose: critical.length === 0,
  }
}

// ============================================
// VENDOR MATCHING & AVAILABILITY — MOVED
// ============================================
//
// matchVendorToTransaction and checkVendorAvailability now live in
// app/actions/vendor-marketplace.ts, the rail that owns vendors, where they are
// wired into the transaction booking form. They were real capabilities with no
// counterpart anywhere — they moved and were finished, not removed.
// ============================================
// COMPLIANCE RISK SCORING
// ============================================

export async function calculateComplianceRiskScore(agentId: string) {
  const supabase = await createClient()

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [{ data: violations }, { data: unapprovedContent }] =
    await Promise.all([
      supabase
        .from("compliance_flags")
        .select("*")
        .eq("user_id", agentId)
        .gte("detected_at", thirtyDaysAgo.toISOString()),
      supabase
        .from("activities")
        .select("*")
        .eq("agent_id", agentId)
        .eq("activity_type", "content.approval")
        .eq("status", "pending")
        .gte("created_at", thirtyDaysAgo.toISOString()),
    ])

  // ── THE THIRD OF THIS SCORE WAS A CONSTANT ──────────────────────────────
  //
  // This read was `conversations.urgency_score`, chosen because
  // `conversations.them_first_score` does not exist. Neither does a WRITER for
  // urgency_score: it was READ BY CODE AND WRITTEN BY NOBODY (census 1b), so
  // `s.urgency_score || 0` summed to zero on every row, `avgUrgency` was always
  // 0, and `avgThemFirst = 100 - 0` was a hardcoded 100 — a full 30% of a
  // compliance RISK score that could never move, in either direction, for any
  // agent. An agent with a genuinely poor conversation record scored the same
  // 30 points as the best one.
  //
  // SURVIVOR: `conversation_insights.health_score`, which is genuinely written
  // for every analysed thread (lib/intelligence/conversation-insights.ts:434/464)
  // and is DERIVED there from the thread itself — reply gaps, unanswered
  // questions, objections, sentiment. It is stored on a 0..1 scale, enforced by
  // the live CHECK (`health_score >= 0 AND <= 1`), so it is scaled to the 0-100
  // this function's arithmetic works in.
  //
  // `conversation_insights.agent_id` is the same AGENTS class this function's
  // other predicates use (conversation_insights_agent_id_fkey → agents, and the
  // writer carries it straight off the conversation row).
  const { data: conversationsData, error: convHealthError } = await supabase
    .from("conversation_insights")
    .select("health_score")
    .eq("agent_id", agentId)
    .not("health_score", "is", null)
    .gte("created_at", thirtyDaysAgo.toISOString())

  // supabase-js RESOLVES a refusal. A refused read here must not be scored as
  // "this agent has no conversation history" — that is worth 30 points.
  if (convHealthError) {
    console.error("[multi-persona] conversation health read refused — compliance risk score is incomplete:", convHealthError.message)
  }

  const violationScore = Math.max(0, 100 - (violations?.length || 0) * 10)
  const contentScore = Math.max(
    0,
    100 - (unapprovedContent?.length || 0) * 5
  )
  // health_score is 0..1 (live CHECK) — scaled to the 0-100 this file scores in.
  // An agent with NO analysed conversations has no reading, and a missing
  // measurement must not be scored as a perfect one: the neutral 50 says
  // "unmeasured" rather than awarding the full 30 points to someone we have
  // never looked at, which is what the old constant did.
  const UNMEASURED_CONVERSATION_HEALTH = 50
  const healthScores = (conversationsData ?? [])
    .map((r: any) => (typeof r.health_score === "number" ? r.health_score * 100 : null))
    .filter((n): n is number => n != null)
  const avgThemFirst =
    healthScores.length > 0
      ? Math.max(0, Math.min(100, healthScores.reduce((a, b) => a + b, 0) / healthScores.length))
      : UNMEASURED_CONVERSATION_HEALTH

  const overallScore = (
    violationScore * 0.4 +
    contentScore * 0.3 +
    avgThemFirst * 0.3
  ).toFixed(0)

  return {
    overallScore: Number(overallScore),
    violationScore,
    contentScore,
    avgThemFirst: Math.round(avgThemFirst),
    violationsCount: violations?.length || 0,
    unapprovedContentCount: unapprovedContent?.length || 0,
    riskLevel:
      Number(overallScore) >= 80
        ? "low"
        : Number(overallScore) >= 60
        ? "medium"
        : "high",
  }
}

// ============================================
// COORDINATOR & LENDER DASHBOARDS
// ============================================

export async function bulkUpdateMilestones(
  updates: Array<{ milestoneId: string; status: string; notes?: string }>
) {
  const supabase = await createClient()

  try {
    // Caller-supplied statuses were written straight through. supabase-js
    // RESOLVES a rejected write with { error } rather than throwing, so a status
    // outside the CHECK never reached the catch below — and `updated` reported
    // the ARRAY LENGTH, not the number of rows that moved. Every milestone could
    // fail and the coordinator would still be told they all updated.
    const invalid = updates.filter((u) => !isMilestoneStatus(u.status))
    if (invalid.length) {
      return {
        success: false,
        error: `Not a milestone status: ${[...new Set(invalid.map((u) => u.status))].join(", ")}`,
      }
    }

    const results = await Promise.all(
      updates.map(({ milestoneId, status, notes }) =>
        supabase
          .from("transaction_milestones")
          .update({ status, notes, updated_at: new Date().toISOString() })
          .eq("id", milestoneId)
      )
    )

    const failed = results.filter((r) => r.error)
    revalidatePath("/dashboard/coordinator")
    if (failed.length) {
      return {
        success: false,
        updated: results.length - failed.length,
        error: failed[0].error?.message ?? "milestone update failed",
      }
    }
    return { success: true, updated: results.length }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * THE ONE COORDINATOR WORKLOAD READ.
 *
 * It used to see only `transactions.coordinator_id` while the coordinator dashboard
 * read only `transaction_assignments` — the two halves of the split-brain documented
 * on assignTransactionCoordinator above. Either source alone hides real work from the
 * TC, so this reads BOTH and unions them by transaction id. Fixing the writer stops
 * NEW divergence; reading the union is what makes deals assigned before the fix
 * visible at all.
 *
 * TENANT: every statement carries `brokerage_id = auth.brokerageId`, and the
 * coordinator lookup is the authorization gate — a coordinatorId from another
 * brokerage resolves to null and the read stops there rather than enumerating
 * someone else's pipeline.
 */
export async function getCoordinatorDashboard(
  coordinatorId: string,
  options?: { deadlineWindowDays?: number },
) {
  const empty = {
    coordinator: null as any,
    transactions: [] as any[],
    transactionIds: [] as string[],
    deadlines: [] as any[],
    incompleteMilestones: [] as any[],
    error: null as string | null,
  }

  const auth = await requireCaller()
  if (!auth.ok) return { ...empty, error: auth.error }

  const supabase = await createClient()

  const { data: coordinator, error: coordError } = await supabase
    .from("transaction_coordinators")
    .select("*")
    .eq("id", coordinatorId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle() // .single() turned "no such coordinator" into a thrown error

  if (coordError) {
    console.error("[multi-persona] getCoordinatorDashboard coordinator read failed:", coordError.message)
    return { ...empty, error: coordError.message }
  }
  if (!coordinator) return empty

  // SOURCE A — the junction the settings page writes and the dashboard reads.
  const { data: assignments, error: assignError } = await supabase
    .from("transaction_assignments")
    .select("id, is_primary, assigned_at, transaction_id")
    .eq("coordinator_id", coordinatorId)
    .eq("brokerage_id", auth.brokerageId)

  if (assignError) {
    console.error("[multi-persona] getCoordinatorDashboard assignment read failed:", assignError.message)
    return { ...empty, coordinator, error: assignError.message }
  }

  const assignmentByTxn = new Map(
    (assignments ?? []).map((a) => [
      a.transaction_id as string,
      { assignment_id: a.id as string, is_primary: a.is_primary as boolean, assigned_at: a.assigned_at as string },
    ]),
  )

  // SOURCE B — the column the deal page's Assign TC panel writes.
  const { data: directTxns, error: directError } = await supabase
    .from("transactions")
    .select("id")
    .eq("coordinator_id", coordinatorId)
    .eq("brokerage_id", auth.brokerageId)

  if (directError) {
    console.error("[multi-persona] getCoordinatorDashboard direct read failed:", directError.message)
    return { ...empty, coordinator, error: directError.message }
  }

  const unionIds = Array.from(
    new Set([...assignmentByTxn.keys(), ...(directTxns ?? []).map((t) => t.id as string)]),
  )
  if (unionIds.length === 0) return { ...empty, coordinator }

  const { data: transactionRows, error: txnError } = await supabase
    .from("transactions")
    .select(`*, transaction_milestones(*)`)
    .in("id", unionIds)
    .eq("brokerage_id", auth.brokerageId)
    .not("status", "in", `(${TRANSACTION_STATUSES_TERMINAL.join(",")})`)
    .order("close_date")

  if (txnError) {
    console.error("[multi-persona] getCoordinatorDashboard transaction read failed:", txnError.message)
    return { ...empty, coordinator, error: txnError.message }
  }

  const transactions = (transactionRows ?? []).map((t) => ({
    ...t,
    ...(assignmentByTxn.get(t.id as string) ?? { assignment_id: null, is_primary: true, assigned_at: null }),
  }))
  const transactionIds = transactions.map((t) => t.id as string)

  if (transactionIds.length === 0) {
    return { ...empty, coordinator }
  }

  const today = new Date().toISOString().split("T")[0]
  let deadlineQuery = supabase
    .from("transaction_deadlines")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .in("status", [...DEADLINE_OPEN_STATUSES])
    .gte("deadline_date", today)
  if (options?.deadlineWindowDays) {
    const until = new Date(Date.now() + options.deadlineWindowDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0]
    deadlineQuery = deadlineQuery.lte("deadline_date", until)
  }
  const { data: deadlines, error: deadlineError } = await deadlineQuery.order("deadline_date").limit(50)
  if (deadlineError) {
    console.error("[multi-persona] getCoordinatorDashboard deadline read failed:", deadlineError.message)
  }

  const { data: incompleteMilestones, error: milestoneError } = await supabase
    .from("transaction_milestones")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .in("status", [...MILESTONE_OPEN_STATUSES])
    .order("target_date")
  if (milestoneError) {
    console.error("[multi-persona] getCoordinatorDashboard milestone read failed:", milestoneError.message)
  }

  return {
    coordinator,
    transactions,
    transactionIds,
    deadlines: deadlines ?? [],
    incompleteMilestones: incompleteMilestones ?? [],
    error: deadlineError?.message ?? milestoneError?.message ?? null,
  }
}

/** Lenders are vendors — the loan pipeline for a lender VENDOR (vendors.id).
 *  Scopes by the transactions the vendor is assigned to (vendor_assignments). */
export async function getLenderDashboard(vendorId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { lender: null, loans: [] }

  const supabase = await createClient()

  const { data: vendor } = await supabase
    .from("vendors")
    .select("id, name, category, brokerage_id")
    .eq("id", vendorId)
    .eq("brokerage_id", auth.brokerageId)
    .single()

  const { isLenderVendorCategory, lenderVendorTransactionIds, lenderFilterIds } =
    await import("@/lib/kernel/lender-linkage")
  if (!vendor || !isLenderVendorCategory(vendor.category)) return { lender: null, loans: [] }

  const txnIds = lenderFilterIds(await lenderVendorTransactionIds(supabase, vendorId, auth.brokerageId))
  const { data: loans } = await supabase
    .from("transaction_lenders")
    .select(`*, transactions!inner(*)`)
    .in("transaction_id", txnIds)
    .eq("transactions.brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  return { lender: { ...vendor, company_name: vendor.name }, loans }
}

/**
 * Submit vendor invoice — creates a proper record in vendor_invoices table
 * and marks it submitted. Supersedes the old vendor_bookings.notes workaround.
 *
 * SECURITY (w4s1): this was a `"use server"` endpoint with NO auth gate at all —
 * it went straight to `createServiceClient()` on a caller-supplied bookingId and
 * amount. Any caller could mint a `billed_to='brokerage'` vendor invoice of any
 * amount against ANY tenant's booking, and it also overwrote that booking's
 * `cost`. That is not a paperwork bug: this is the ONLY live producer of
 * brokerage-billed vendor invoices, and `markInvoicePaid` turns a paid one into a
 * `vendor_earnings` row with status 'available', which `initiateVendorPayout`
 * wires out through Stripe Connect. Ungated invoice creation was the front door of
 * that money path.
 *
 * Gate: the caller must be signed in AND either (a) in the booking's brokerage, or
 * (b) BE the vendor the booking is for (user_role_assignments.vendor_id — the
 * canonical vendor linkage; `vendors` has no user_id). No unattended caller exists
 * — the only call site is the brokerage dashboard's vendor-bookings panel
 * (app/dashboard/components/vendor-bookings-panel.tsx); `app/api/cron/`,
 * `app/api/webhooks/` and the queue workers were checked and none reach it.
 */
export async function submitVendorInvoice(params: {
  bookingId: string
  amount: number
  invoiceDate: string
  dueDate: string
  invoiceNumber: string
  notes?: string
}): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: "Unauthorized" }

    if (!params.bookingId) return { success: false, error: "bookingId required" }
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      return { success: false, error: "Invoice amount must be greater than zero" }
    }

    const supabase = createServiceClient()

    // Resolve vendor_id and brokerage_id from the booking. `error` is destructured
    // deliberately — supabase-js RESOLVES a refused read, so `data`-only would read
    // a denial as "no such booking" and (in the old shape) insert an invoice with
    // NULL vendor_id/brokerage_id: an unscoped money row. Fails closed.
    const { data: booking, error: bookingErr } = await supabase
      .from("vendor_bookings")
      .select("vendor_id, brokerage_id, listing_id")
      .eq("id", params.bookingId)
      .maybeSingle()

    if (bookingErr) return { success: false, error: "Could not verify the booking" }
    if (!booking?.brokerage_id || !booking?.vendor_id) {
      return { success: false, error: "Booking not found" }
    }

    if (booking.brokerage_id !== auth.brokerageId) {
      // Not the booking's brokerage — the only other legitimate submitter is the
      // vendor being invoiced for.
      // EXISTENCE, not identity: "does this caller hold ANY grant linking them to
      // the booking's vendor?" (user_id, vendor_id) is not a unique key — the
      // table is UNIQUE on (user_id, role) — so a caller holding two grants
      // against the same vendor produced two rows, `.maybeSingle()` errored, and
      // this money gate returned Forbidden to the vendor it was written to admit.
      // Counting rows answers the question the gate is actually asking.
      const { data: ras, error: raErr } = await supabase
        .from("user_role_assignments")
        .select("id")
        .eq("user_id", auth.userId)
        .eq("vendor_id", booking.vendor_id)
      if (raErr || (ras?.length ?? 0) === 0) return { success: false, error: "Forbidden" }
    }

    const { data: invoice, error } = await supabase
      .from("vendor_invoices")
      .insert({
        vendor_id: booking.vendor_id,
        brokerage_id: booking.brokerage_id,
        booking_id: params.bookingId,
        listing_id: booking.listing_id ?? null,
        billed_to: "brokerage",
        invoice_number: params.invoiceNumber,
        invoice_date: params.invoiceDate,
        due_date: params.dueDate,
        line_items: [{ description: "Services rendered", quantity: 1, unitPrice: params.amount, amount: params.amount }],
        subtotal: params.amount,
        total_amount: params.amount,
        status: "submitted",
        notes: params.notes ?? null,
      })
      .select("id")
      .single()

    if (error) throw error

    // Also update the booking cost for backwards-compatible UIs
    await supabase
      .from("vendor_bookings")
      .update({ cost: params.amount })
      .eq("id", params.bookingId)

    return { success: true, invoiceId: invoice.id }
  } catch (error) {
    console.error("[Multi-persona] Submit invoice error:", error)
    return { success: false, error: String(error) }
  }
}
