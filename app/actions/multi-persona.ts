"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { getDefaultCommissionStructure } from "@/lib/brokerage"

// ============================================
// BROKERAGE ADMIN FUNCTIONS
// ============================================

export async function getBrokerageDashboard(brokerageId: string) {
  const supabase = await createClient()

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
    // compliance_checks: allowed=false means a violation was detected
    supabase
      .from("compliance_checks")
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

export async function getCoordinatorDashboard_v2(coordinatorId: string) {
  const supabase = await createClient()

  const { data: coordinator } = await supabase
    .from("transaction_coordinators")
    .select("*")
    .eq("id", coordinatorId)
    .single()

  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      *,
      transaction_milestones(*)
    `)
    .eq("coordinator_id", coordinatorId)
    .not("status", "in", "(closed,lost)")
    .order("close_date")

  const transactionIds = transactions?.map((t) => t.id) || []

  const { data: deadlines } = await supabase
    .from("transaction_deadlines")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .eq("status", "pending")
    .gte("deadline_date", new Date().toISOString().split("T")[0])
    .order("deadline_date")
    .limit(20)

  const { data: incompleteMilestones } = await supabase
    .from("transaction_milestones")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .in("status", ["pending", "in_progress"])
    .order("milestone_date")

  return { coordinator, transactions, deadlines, incompleteMilestones }
}

// ============================================
// VENDOR MANAGEMENT FUNCTIONS
// ============================================

export async function getVendorDirectory(filters?: {
  vendorType?: string
  minRating?: number
}) {
  const supabase = await createClient()

  // vendor_directory schema: id, brokerage_id, name, category, phone, email, website,
  // rating, preferred, notes, created_at
  // No vendor_type or service_areas columns — use category and preferred instead
  let query = supabase.from("vendor_directory").select("*")

  if (filters?.vendorType) {
    query = query.eq("category", filters.vendorType)
  }

  if (filters?.minRating) {
    query = query.gte("rating", filters.minRating)
  }

  const { data, error } = await query.order("rating", { ascending: false })

  if (error) throw error
  return data || []
}

export async function bookVendor(data: {
  vendorId: string
  transactionId: string
  bookedBy: string
  serviceType: string
  scheduledDate: string
  cost?: number
}) {
  const supabase = await createClient()

  // vendor_bookings schema: id, transaction_id, brokerage_id, vendor_id, service_type,
  // booked_by, booked_at, scheduled_date, completed_at, cost, status,
  // client_rating, agent_rating, notes, created_at, contact_id, listing_id
  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .insert({
      vendor_id: data.vendorId,
      transaction_id: data.transactionId,
      service_type: data.serviceType,
      scheduled_date: data.scheduledDate,
      cost: data.cost,
      status: "booked",
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/vendors")
  return booking
}

export async function updateVendorBookingStatus_v2(data: {
  bookingId: string
  status: string
  notes?: string
}) {
  const supabase = await createClient()

  // Only update columns that exist in vendor_bookings schema
  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .update({
      status: data.status,
      notes: data.notes,
    })
    .eq("id", data.bookingId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/portal/vendor")
  return booking
}

export async function rateVendor(data: {
  bookingId: string
  clientRating?: number
  agentRating?: number
}) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("vendor_bookings")
    .update({
      client_rating: data.clientRating,
      agent_rating: data.agentRating,
    })
    .eq("id", data.bookingId)

  if (error) throw error

  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("vendor_id, brokerage_id")
    .eq("id", data.bookingId)
    .single()

  if (booking) {
    const { data: allRatings } = await supabase
      .from("vendor_bookings")
      .select("agent_rating, client_rating")
      .eq("vendor_id", booking.vendor_id)
      .not("agent_rating", "is", null)

    if (allRatings && allRatings.length > 0) {
      const agentRatings = allRatings
        .filter((r) => r.agent_rating != null)
        .map((r) => r.agent_rating as number)
      const clientRatings = allRatings
        .filter((r) => r.client_rating != null)
        .map((r) => r.client_rating as number)
      const fiveStars = agentRatings.filter((r) => r === 5).length
      const oneStars = agentRatings.filter((r) => r === 1).length

      const avgAgentRating =
        agentRatings.length > 0
          ? agentRatings.reduce((a, b) => a + b, 0) / agentRatings.length
          : null
      const avgClientRating =
        clientRatings.length > 0
          ? clientRatings.reduce((a, b) => a + b, 0) / clientRatings.length
          : null

      if (avgAgentRating) {
        await supabase
          .from("vendors")
          .update({ rating: avgAgentRating })
          .eq("id", booking.vendor_id)
      }

      // vendor_ratings: id, vendor_id, brokerage_id, total_bookings, avg_client_rating,
      // avg_agent_rating, five_star_count, one_star_count, last_updated
      if (booking.brokerage_id) {
        await supabase.from("vendor_ratings").upsert(
          {
            vendor_id: booking.vendor_id,
            brokerage_id: booking.brokerage_id,
            avg_agent_rating: avgAgentRating,
            avg_client_rating: avgClientRating,
            total_bookings: allRatings.length,
            five_star_count: fiveStars,
            one_star_count: oneStars,
            last_updated: new Date().toISOString(),
          },
          { onConflict: "vendor_id" }
        )
      }
    }
  }

  return { success: true }
}

// ============================================
// LENDER PORTAL FUNCTIONS
// ============================================

export async function getLenderDashboard_v2(lenderId: string) {
  const supabase = await createClient()

  // lender_portal_users: id, user_id, transaction_id, brokerage_id, lender_company,
  // access_level, invited_at, last_accessed
  const { data: lenderUser } = await supabase
    .from("lender_portal_users")
    .select("*")
    .eq("id", lenderId)
    .single()

  const { data: loans } = await supabase
    .from("transaction_lenders")
    .select(`
      *,
      transactions(*)
    `)
    .eq("loan_officer_email", lenderUser?.email ?? "")
    .order("created_at", { ascending: false })

  return { lender: lenderUser, loans }
}

export async function assignLenderToTransaction(data: {
  transactionId: string
  lenderId: string
}) {
  const supabase = await createClient()

  // assigned_transactions column does not exist on lender_portal_users.
  // The correct pattern is to upsert a lender_portal_users row for each transaction.
  const { error } = await supabase.from("lender_portal_users").upsert(
    {
      user_id: data.lenderId,
      transaction_id: data.transactionId,
      access_level: "read",
      invited_at: new Date().toISOString(),
    },
    { onConflict: "user_id,transaction_id" }
  )

  if (error) throw error

  // Also link lender on the transaction row
  await supabase
    .from("transactions")
    .update({ lender_id: data.lenderId })
    .eq("id", data.transactionId)

  revalidatePath("/dashboard/transactions")
  return { success: true }
}

export async function updateLoanStatus(data: {
  loanId: string
  status: string
  notes?: string
  conditionsCleared?: number
}) {
  const supabase = await createClient()

  const { data: loan, error } = await supabase
    .from("transaction_lenders")
    .update({
      underwriting_status: data.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.loanId)
    .select("*, transactions(*)")
    .single()

  if (error) throw error

  await supabase.from("transaction_timeline").insert({
    transaction_id: loan.transaction_id,
    activity_type: "financing_update",
    description: data.notes || `Underwriting status updated to ${data.status}`,
    performed_by: null,
    metadata: { status: data.status },
  })

  revalidatePath("/portal/lender")
  return loan
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

  // conditions_list is not a schema column on transaction_lenders.
  // Store as notes JSON until a migration adds a proper column.
  const { error } = await supabase
    .from("transaction_lenders")
    .update({
      notes: JSON.stringify(data.conditions),
    })
    .eq("id", data.loanId)

  if (error) throw error

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

export async function getComplianceOfficerDashboard(officerId: string) {
  const supabase = await createClient()

  // compliance_reviews does not exist — use compliance_events (violations) and
  // compliance_flags (flagged messages/content)
  const [{ data: pendingReviews }, { data: recentViolations }] =
    await Promise.all([
      // compliance_events where allowed=false = blocked outbound attempts
      supabase
        .from("compliance_checks")
        .select("*")
        .eq("allowed", false)
        .order("created_at", { ascending: false })
        .limit(20),
      // compliance_flags for content violations
      supabase
        .from("compliance_flags")
        .select("*")
        .eq("status", "flagged")
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

  const { data: workflow } = await supabase
    .from("workflow_executions")
    .select("*")
    .eq("id", workflowId)
    .single()

  if (!workflow || workflow.status === "completed") {
    return { success: false, reason: "Workflow not active" }
  }

  const actions: any[] = workflow.context?.actions || []

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
        await supabase
          .from("transaction_milestones")
          .update({ status: action.newStatus })
          .eq("transaction_id", contextData.transactionId)
          .eq("milestone_name", action.milestoneName)
        break
    }
  }

  await supabase
    .from("workflow_executions")
    .update({ status: "completed", completed_at: new Date().toISOString() })
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
  const supabase = await createClient()

  const { data: team } = await supabase
    .from("teams")
    .select("*")
    .eq("id", teamId)
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

export async function submitClientReview(data: {
  leadId?: string
  transactionId?: string
  agentId: string
  rating: number
  reviewText?: string
  reviewCategories?: any
  wouldRecommend?: boolean
  reviewSource?: string
  brokerageId?: string
}) {
  const supabase = await createClient()

  // client_reviews does not exist — use agent_reviews
  const { data: review, error } = await supabase
    .from("agent_reviews")
    .insert({
      brokerage_id: data.brokerageId,
      agent_id: data.agentId,
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

export async function getAgentReviews(agentId: string) {
  const supabase = await createClient()

  // Use agent_reviews with is_published=true
  const { data, error } = await supabase
    .from("agent_reviews")
    .select("*")
    .eq("agent_id", agentId)
    .eq("is_published", true)
    .order("created_at", { ascending: false })

  if (error) throw error

  const avgRating =
    data && data.length > 0
      ? data.reduce((sum, r) => sum + (r.rating || 0), 0) / data.length
      : 0

  return {
    reviews: data || [],
    metrics: {
      totalReviews: data?.length || 0,
      averageRating: avgRating,
      recommendationRate: 0, // would_recommend not in agent_reviews schema
    },
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

export async function getClientJourneyPreferences(
  leadId?: string,
  contactId?: string
) {
  const supabase = await createClient()

  if (!contactId) return null

  const { data, error } = await supabase
    .from("property_interests")
    .select("*")
    .eq("contact_id", contactId)
    .single()

  if (error && error.code !== "PGRST116") throw error

  return data
}

// ============================================
// BROKERAGE REVENUE FORECASTING
// ============================================

export async function forecastBrokerageRevenue(
  brokerageId: string,
  months: number = 3
) {
  const supabase = await createClient()

  // brokerage_performance does not exist — use brokerage_earnings
  // brokerage_earnings: id, brokerage_id, period_type, period_label,
  // gross_commission_income, agent_splits_paid, brokerage_net,
  // transaction_count, active_agent_count, computed_at
  const { data: historical } = await supabase
    .from("brokerage_earnings")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("period_type", "monthly")
    .order("computed_at", { ascending: false })
    .limit(12)

  // transactions.transaction_status -> use status; contract_price -> purchase_price;
  // commission_rate -> commission_percentage; closing_date -> close_date
  const { data: pipeline } = await supabase
    .from("transactions")
    .select("purchase_price, close_date, status, commission_percentage")
    .eq("brokerage_id", brokerageId)
    .gte("close_date", new Date().toISOString().split("T")[0])
    .in("status", ["under_contract", "closing"])

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
        t.status === "closing" ? 0.9 : 0.6
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

export async function trackLicenseExpirations(brokerageId: string) {
  const supabase = await createClient()

  const { data: agents } = await supabase
    .from("agents")
    .select("*, agent_licenses(*)")
    .eq("brokerage_id", brokerageId)

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

export async function createReferralPartner(data: {
  partnerName: string
  partnerType: "real_estate_agent" | "mortgage_broker" | "title_company" | "home_inspector" | "contractor" | "insurance_agent" | "attorney" | "property_manager" | "other"
  contactEmail: string
  contactPhone?: string
  commissionSplit: number
  agreementSignedDate?: string
  notes?: string
  agentId: string
  brokerageId?: string
}) {
  const supabase = await createClient()

  // referral_partners schema: id, agent_id, brokerage_id, partner_name, partner_type,
  // company_name, email, phone, address, agreement_type, commission_split_percentage,
  // referral_fee_flat, agreement_date, agreement_end_date, total_referrals_sent,
  // total_referrals_received, total_value_generated, notes, active, created_at, updated_at
  const { data: partner, error } = await supabase
    .from("referral_partners")
    .insert({
      agent_id: data.agentId,
      brokerage_id: data.brokerageId,
      partner_name: data.partnerName,
      partner_type: data.partnerType,
      email: data.contactEmail,
      phone: data.contactPhone,
      commission_split_percentage: data.commissionSplit,
      agreement_date: data.agreementSignedDate,
      notes: data.notes,
      active: true,
    })
    .select()
    .single()

  if (error) throw error

  return partner
}

export async function trackReferral(data: {
  referralPartnerId?: string
  agentId: string
  brokerageId: string
  leadId?: string
  contactId?: string
  transactionId?: string
  referralStatus: "received" | "contacted" | "qualified" | "assigned" | "under_contract" | "closed" | "lost"
  commissionAmount?: number
}) {
  const supabase = await createClient()

  // referral_tracking does not exist — use referrals table
  // referrals: id, brokerage_id, agent_id, partner_id, referred_contact_id,
  // referred_lead_id, status, referral_source, notes, commission_amount, closed_at, ...
  const { data: referral, error } = await supabase
    .from("referrals")
    .insert({
      brokerage_id: data.brokerageId,
      agent_id: data.agentId,
      partner_id: data.referralPartnerId,
      referred_contact_id: data.contactId,
      referred_lead_id: data.leadId,
      status: data.referralStatus,
      commission_amount: data.commissionAmount,
      closed_at:
        data.referralStatus === "closed" ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error) throw error

  return referral
}

export async function getReferralPartnerStats(partnerId: string) {
  const supabase = await createClient()

  const { data: referrals } = await supabase
    .from("referrals")
    .select("*")
    .eq("partner_id", partnerId)

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

export async function trackConditionClearance(loanId: string) {
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
    clearanceRate === 100 &&
    loan?.underwriting_status !== "clear_to_close"
  ) {
    await supabase
      .from("transaction_lenders")
      .update({ underwriting_status: "clear_to_close" })
      .eq("id", loanId)
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
// VENDOR MATCHING & AVAILABILITY
// ============================================

export async function matchVendorToTransaction(data: {
  transactionId: string
  serviceType: string
  propertyCity: string
  urgency: "routine" | "urgent"
  brokerageId: string
}) {
  const supabase = await createClient()

  // vendor_directory schema: id, brokerage_id, name, category, phone, email,
  // website, rating, preferred, notes, created_at
  // No service_areas or vendor_type columns — use category and brokerage_id
  const { data: vendors } = await supabase
    .from("vendor_directory")
    .select("*")
    .eq("brokerage_id", data.brokerageId)
    .eq("category", data.serviceType)
    .gte("rating", 4.0)

  const sorted = vendors?.sort((a, b) => {
    if (data.urgency === "urgent") {
      // Prefer preferred vendors first, then by rating
      if (a.preferred !== b.preferred)
        return a.preferred ? -1 : 1
      return (b.rating || 0) - (a.rating || 0)
    }
    return (b.rating || 0) - (a.rating || 0)
  })

  return sorted?.[0] || null
}

export async function checkVendorAvailability(data: {
  vendorType: string
  preferredDate: string
  brokerageId: string
}) {
  const supabase = await createClient()

  const { data: vendors } = await supabase
    .from("vendor_directory")
    .select("*")
    .eq("brokerage_id", data.brokerageId)
    .eq("category", data.vendorType)

  const { data: existingBookings } = await supabase
    .from("vendor_bookings")
    .select("vendor_id, scheduled_date")
    .eq("scheduled_date", data.preferredDate)
    .in("status", ["booked", "confirmed"])

  const bookedVendorIds = existingBookings?.map((b) => b.vendor_id) || []
  const availableVendors = vendors?.filter(
    (v) => !bookedVendorIds.includes(v.id)
  )

  return {
    availableCount: availableVendors?.length || 0,
    availableVendors:
      availableVendors?.sort((a, b) => (b.rating || 0) - (a.rating || 0)) ||
      [],
  }
}

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
    const results = await Promise.all(
      updates.map(({ milestoneId, status, notes }) =>
        supabase
          .from("transaction_milestones")
          .update({ status, notes, updated_at: new Date().toISOString() })
          .eq("id", milestoneId)
      )
    )

    revalidatePath("/dashboard/coordinator")
    return { success: true, updated: results.length }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getCoordinatorDashboard(coordinatorId: string) {
  const supabase = await createClient()

  const { data: coordinator } = await supabase
    .from("transaction_coordinators")
    .select("*")
    .eq("id", coordinatorId)
    .single()

  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      *,
      transaction_milestones(*)
    `)
    .eq("coordinator_id", coordinatorId)
    .not("status", "in", "(closed,lost)")
    .order("close_date")

  const transactionIds = transactions?.map((t) => t.id) || []

  const { data: deadlines } = await supabase
    .from("transaction_deadlines")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .eq("status", "pending")
    .gte("deadline_date", new Date().toISOString().split("T")[0])
    .order("deadline_date")
    .limit(20)

  const { data: incompleteMilestones } = await supabase
    .from("transaction_milestones")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .in("status", ["pending", "in_progress"])
    .order("milestone_date")

  return { coordinator, transactions, deadlines, incompleteMilestones }
}

export async function getLenderDashboard(lenderId: string) {
  const supabase = await createClient()

  const { data: lenderUser } = await supabase
    .from("lender_portal_users")
    .select("*")
    .eq("id", lenderId)
    .single()

  const { data: loans } = await supabase
    .from("transaction_lenders")
    .select(`
      *,
      transactions(*)
    `)
    .eq("loan_officer_email", lenderUser?.email ?? "")
    .order("created_at", { ascending: false })

  return { lender: lenderUser, loans }
}

/**
 * Submit vendor invoice
 * vendor_invoices table does not exist in schema.
 * Stores invoice data as a note on the vendor_bookings record instead.
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

    // Store invoice details on the booking record (cost + notes)
    const invoiceData = {
      invoice_number: params.invoiceNumber,
      invoice_date: params.invoiceDate,
      due_date: params.dueDate,
      notes: params.notes,
    }

    const { data, error } = await supabase
      .from("vendor_bookings")
      .update({
        cost: params.amount,
        notes: JSON.stringify(invoiceData),
      })
      .eq("id", params.bookingId)
      .select("id")
      .single()

    if (error) throw error

    return { success: true, invoiceId: data.id }
  } catch (error) {
    console.error("[Multi-persona] Submit invoice error:", error)
    return { success: false, error: String(error) }
  }
}
