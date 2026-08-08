"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { TRANSACTION_STATUSES_IN_ESCROW, TRANSACTION_STATUSES_TERMINAL, closeConfidence } from "@/lib/transactions/transaction-status"
import {
  MILESTONE_OPEN_STATUSES,
  DEADLINE_OPEN_STATUSES,
  isMilestoneStatus,
} from "@/lib/transactions/coordination-status"

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
  if (!["broker", "broker_admin", "admin", "superadmin", "tc", "agent", "team_lead"].includes(auth.userType)) {
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

  for (const action of actions) {
    switch (action.type) {
      case "send_email":
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
          break
        }
        await supabase
          .from("transaction_milestones")
          .update({ status: action.newStatus })
          .eq("transaction_id", contextData.transactionId)
          .eq("milestone_name", action.milestoneName)
        break
    }
  }

  await supabase
    .from("workflow_automations")
    .update({ execution_count: (workflow.execution_count ?? 0) + 1, last_executed_at: new Date().toISOString() })
    .eq("id", workflowId)

  return { success: true }
}

export async function submitClientFeedback(data: {
  leadId?: string
  contactId?: string
  transactionId: string
  agentId: string
  rating: number
  reviewText: string
  categories: any
  wouldRecommend: boolean
  brokerageId?: string
}) {
  const supabase = await createClient()

  // client_reviews does not exist — use agent_reviews
  // agent_reviews: id, brokerage_id, agent_id, contact_id, transaction_id,
  // rating, review_text, platform, source_url, is_published, response_text,
  // response_at, created_at, updated_at
  const { data: review, error } = await supabase
    .from("agent_reviews")
    .insert({
      brokerage_id: data.brokerageId,
      agent_id: data.agentId,
      contact_id: data.contactId,
      transaction_id: data.transactionId,
      rating: data.rating,
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

export async function createTeam(data: {
  teamName: string
  teamLeaderId: string
  brokerageId: string
  commissionSplitRules?: any
}) {
  const supabase = await createClient()

  // agent_teams does not exist — use teams table
  // teams: id, name, brokerage_id, team_lead_id, created_at, updated_at, deleted_at,
  // team_split_type, team_split_value, member_overrides_json, team_fees_json
  const { data: team, error } = await supabase
    .from("teams")
    .insert({
      name: data.teamName,
      team_lead_id: data.teamLeaderId,
      brokerage_id: data.brokerageId,
      member_overrides_json: data.commissionSplitRules
        ? JSON.stringify(data.commissionSplitRules)
        : "[]",
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/teams")
  return team
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

// DELIBERATELY LEFT UNWIRED — SECOND WRITER.
//
//   submitClientReview  ->  app/actions/multi-persona.ts:submitClientFeedback
//
// Same table (agent_reviews), same platform literal ("internal"), same
// is_published=false, and the survivor is a strict SUPERSET: it also writes
// `contact_id`, the column that ties a review to the client who left it. It is
// WIRED, at app/portal/[contactId]/transaction/[transactionId]/client-feedback-widget.tsx:45.
// agent_reviews already has a second client-side writer besides it
// (app/actions/portal-lifetime.ts:91, the lifetime testimonial capture).
//
// Wiring this one would put a THIRD independent path into the same table with a
// LESS complete row, so it is not wired. It is NOT deleted either: `leadId`,
// `reviewCategories`, `wouldRecommend` and `reviewSource` are accepted here and
// have no column anywhere in agent_reviews, so removing the function would not
// merely relocate a capability — it would erase the only remaining record that
// those four inputs were ever meant to be captured. Its schema-truth defects are
// fixed below so it is not a trap for whoever finishes it:
//   · brokerage_id is NOT NULL on agent_reviews AND is both halves of the RLS
//     policy (qual and with_check are `brokerage_id = current_user_brokerage_id()`),
//     so an omitted/undefined brokerageId made the insert unconditionally fail.
//     It is now derived from the session, never from the caller's parameter.
//   · contact_id was never written, so a review could not be traced to its author.
export async function submitClientReview(data: {
  leadId?: string
  contactId?: string
  transactionId?: string
  agentId: string
  rating: number
  reviewText?: string
  reviewCategories?: any
  wouldRecommend?: boolean
  reviewSource?: string
  brokerageId?: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = await createClient()

  // client_reviews does not exist — use agent_reviews.
  // TENANT: the session's brokerage wins over the parameter. A caller-supplied
  // brokerageId is spoofable and the RLS with_check would reject it anyway.
  const { data: review, error } = await supabase
    .from("agent_reviews")
    .insert({
      brokerage_id: auth.brokerageId,
      agent_id: data.agentId,
      contact_id: data.contactId ?? null,
      transaction_id: data.transactionId,
      rating: data.rating,
      review_text: data.reviewText,
      platform: "internal", // one of the six values agent_reviews_platform_check allows
      is_published: false,
    })
    .select()
    .single()

  if (error) throw error

  return review
}

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

export async function saveClientJourneyPreferences(data: {
  leadId?: string
  contactId?: string
  journeyType: string
  mustHaveFeatures?: string[]
  niceToHaveFeatures?: string[]
  dealBreakers?: string[]
  preferredNeighborhoods?: string[]
  commuteConsiderations?: any
  schoolRequirements?: any
  lifestylePriorities?: string[]
  sellingTimeline?: string
  sellingMotivation?: string[]
  preferredContactMethod?: string[]
  preferredContactTimes?: any
  frequencyPreference?: string
  decisionMakers?: string[]
  decisionTimeline?: string
}) {
  // DELIBERATELY LEFT UNWIRED — SECOND WRITER ON THE SAME ROW.
  //
  // property_interests is ONE ROW PER CONTACT (unique index uq_property_interests_contact
  // on contact_id) and it already has a writer:
  //
  //   app/crm/contacts/[contactId]/search/search-client.tsx:422  handleSaveCriteria
  //
  // — the AGENT-side "save this buyer's criteria" upsert, which writes
  // contact_id / brokerage_id / agent_user_id / min_price / max_price / bedrooms /
  // bathrooms / property_type / preferred_locations / zip_codes onto that same row.
  // This function writes preferred_locations too, so a client saving journey
  // preferences would silently overwrite the neighbourhoods the agent had saved,
  // with no second row to hold both opinions.
  //
  // It also JSON.stringify()s a nine-key blob into `notes`, a free-text column the
  // agent's contact page (app/crm/contacts/[contactId]/page.tsx:88) reads and shows
  // as prose — so wiring it would print raw JSON into the agent's view of the buyer.
  //
  // NOT DELETED: there is no other home in the schema for sellingTimeline /
  // sellingMotivation / decisionMakers / decisionTimeline / preferredContactTimes,
  // and this is the only place they are named. The tenant defect is fixed so the
  // row it would write is at least anchored (see brokerage_id below).
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  if (!data.contactId) {
    return { success: false, error: "contactId required" }
  }

  // client_journey_preferences does not exist — use property_interests for buyer prefs
  // property_interests: id, contact_id, property_type, min_price, max_price,
  // preferred_locations, bedrooms, bathrooms, notes, brokerage_id, agent_user_id,
  // keywords, zip_codes, must_have_features, max_days_on_market, year_built_min,
  // search_alert_enabled, alert_frequency, last_search_at, ai_preference_score, updated_at
  const { data: prefs, error } = await supabase
    .from("property_interests")
    .upsert(
      {
        contact_id: data.contactId,
        // TENANT ANCHOR. Omitting this wrote brokerage_id NULL, and
        // property_interests_tenant_select is
        //   (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
        // — an unanchored row is readable by EVERY tenant on the platform.
        brokerage_id: auth.brokerageId,
        must_have_features: data.mustHaveFeatures,
        keywords: [
          ...(data.dealBreakers || []),
          ...(data.lifestylePriorities || []),
        ].join(", "),
        preferred_locations: data.preferredNeighborhoods,
        notes: JSON.stringify({
          journey_type: data.journeyType,
          commute: data.commuteConsiderations,
          schools: data.schoolRequirements,
          contact_method: data.preferredContactMethod,
          contact_times: data.preferredContactTimes,
          frequency: data.frequencyPreference,
          decision_makers: data.decisionMakers,
          decision_timeline: data.decisionTimeline,
          selling_timeline: data.sellingTimeline,
          selling_motivation: data.sellingMotivation,
          nice_to_have: data.niceToHaveFeatures,
        }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )
    .select()
    .single()

  if (error) throw error
  return prefs
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
  leadId?: string,
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

  // conversations.them_first_score does not exist — use urgency_score as proxy
  const { data: conversationsData } = await supabase
    .from("conversations")
    .select("urgency_score")
    .eq("agent_id", agentId)
    .gte("created_at", thirtyDaysAgo.toISOString())

  const violationScore = Math.max(0, 100 - (violations?.length || 0) * 10)
  const contentScore = Math.max(
    0,
    100 - (unapprovedContent?.length || 0) * 5
  )
  const avgUrgency =
    conversationsData && conversationsData.length > 0
      ? conversationsData.reduce(
          (sum, s) => sum + (s.urgency_score || 0),
          0
        ) / conversationsData.length
      : 0
  // Invert urgency: high urgency = lower compliance score proxy
  const avgThemFirst = Math.max(0, 100 - avgUrgency)

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
      const { data: ra, error: raErr } = await supabase
        .from("user_role_assignments")
        .select("id")
        .eq("user_id", auth.userId)
        .eq("vendor_id", booking.vendor_id)
        .maybeSingle()
      if (raErr || !ra) return { success: false, error: "Forbidden" }
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
