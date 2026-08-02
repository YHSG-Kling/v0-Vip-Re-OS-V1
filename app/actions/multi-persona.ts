"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { TRANSACTION_STATUSES_IN_ESCROW, closeConfidence } from "@/lib/transactions/transaction-status"
import { isMilestoneStatus } from "@/lib/transactions/coordination-status"

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
      .not("status", "in", "(closed,lost)"),
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

export async function assignTransactionCoordinator(data: {
  transactionId: string
  coordinatorId: string
}) {
  const supabase = await createClient()

  // Update transaction with coordinator
  const { error: txnError } = await supabase
    .from("transactions")
    .update({ coordinator_id: data.coordinatorId })
    .eq("id", data.transactionId)

  if (txnError) throw txnError

  // active_transactions_count does not exist on transaction_coordinators.
  // max_active_deals is the cap — no counter column to update.
  // We track load by querying coordinator_id on transactions instead.

  revalidatePath("/dashboard/transactions")
  return { success: true }
}

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
        .not("status", "in", "(closed,lost)")
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
    .not("status", "in", "(closed,lost)")

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
    const supabase = createServiceClient()

    // Resolve vendor_id and brokerage_id from the booking
    const { data: booking } = await supabase
      .from("vendor_bookings")
      .select("vendor_id, brokerage_id, listing_id")
      .eq("id", params.bookingId)
      .single()

    const { data: invoice, error } = await supabase
      .from("vendor_invoices")
      .insert({
        vendor_id: booking?.vendor_id ?? null,
        brokerage_id: booking?.brokerage_id ?? null,
        booking_id: params.bookingId,
        listing_id: booking?.listing_id ?? null,
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
