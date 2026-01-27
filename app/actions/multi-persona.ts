"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

// ============================================
// BROKERAGE ADMIN FUNCTIONS
// ============================================

export async function getBrokerageDashboard(brokerageId: string) {
  const supabase = await createClient()

  const [
    { data: brokerage },
    { data: agents },
    { data: activeTransactions },
    { data: pendingReviews },
    { data: recentBilling },
  ] = await Promise.all([
    supabase.from("brokerages").select("*").eq("id", brokerageId).single(),
    supabase.from("agents").select("*").eq("brokerage_id", brokerageId).eq("is_active", true),
    supabase
      .from("transactions")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .not("status", "in", "(closed,cancelled)"),
    supabase.from("compliance_reviews").select("*").eq("review_status", "pending").limit(10),
    supabase
      .from("agent_billing")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("billing_period_start", { ascending: false })
      .limit(5),
  ])

  // Calculate metrics
  const totalAgents = agents?.length || 0
  const totalActiveTransactions = activeTransactions?.length || 0
  const totalVolume = activeTransactions?.reduce((sum, t) => sum + (t.sale_price || t.list_price || 0), 0) || 0

  return {
    brokerage,
    agents,
    activeTransactions,
    pendingReviews,
    recentBilling,
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

export async function assignTransactionCoordinator(data: { transactionId: string; coordinatorId: string }) {
  const supabase = await createClient()

  // Update transaction with coordinator
  const { error: txnError } = await supabase
    .from("transactions")
    .update({ coordinator_id: data.coordinatorId })
    .eq("id", data.transactionId)

  if (txnError) throw txnError

  // Update coordinator's active count
  const { data: coordinator } = await supabase
    .from("transaction_coordinators")
    .select("active_transactions_count")
    .eq("id", data.coordinatorId)
    .single()

  await supabase
    .from("transaction_coordinators")
    .update({ active_transactions_count: (coordinator?.active_transactions_count || 0) + 1 })
    .eq("id", data.coordinatorId)

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
      leads(*),
      agents(*),
      transaction_milestones(*)
    `)
    .eq("transaction_coordinator_id", coordinatorId)
    .not("transaction_status", "in", "(closed,cancelled)")
    .order("closing_date")

  const transactionIds = transactions?.map((t) => t.id) || []

  const { data: deadlines } = await supabase
    .from("transaction_deadlines")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .eq("status", "pending")
    .gte("due_date", new Date().toISOString().split("T")[0])
    .order("due_date")
    .limit(20)

  const { data: incompleteMilestones } = await supabase
    .from("transaction_milestones")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .in("status", ["pending", "in_progress"])
    .order("due_date")

  return { coordinator, transactions, deadlines, incompleteMilestones }
}

// ============================================
// VENDOR MANAGEMENT FUNCTIONS
// ============================================

export async function getVendorDirectory(filters?: {
  vendorType?: string
  serviceArea?: string
  minRating?: number
}) {
  const supabase = await createClient()

  let query = supabase.from("vendor_directory").select("*").eq("is_active", true)

  if (filters?.vendorType) {
    query = query.eq("vendor_type", filters.vendorType)
  }

  if (filters?.serviceArea) {
    query = query.contains("service_areas", [filters.serviceArea])
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
  serviceDescription?: string
  scheduledDate: string
  estimatedDuration?: number
  cost?: number
}) {
  const supabase = await createClient()

  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .insert({
      vendor_id: data.vendorId,
      transaction_id: data.transactionId,
      booked_by: data.bookedBy,
      service_type: data.serviceType,
      service_description: data.serviceDescription,
      scheduled_date: data.scheduledDate,
      estimated_duration: data.estimatedDuration,
      cost: data.cost,
      status: "pending",
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/vendors")
  return booking
}

export async function updateVendorBookingStatus_v2(
  data: {
    bookingId: string
    status: string
    actualStartTime?: string
    actualEndTime?: string
    deliverables?: any[]
    notes?: string
  }
) {
  const supabase = await createClient()

  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .update({
      status: data.status,
      actual_start_time: data.actualStartTime,
      actual_end_time: data.actualEndTime,
      deliverables: data.deliverables,
      notes: data.notes,
    })
    .eq("id", data.bookingId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/portal/vendor")
  return booking
}

export async function rateVendor(data: { bookingId: string; clientRating?: number; agentRating?: number }) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("vendor_bookings")
    .update({
      client_rating: data.clientRating,
      agent_rating: data.agentRating,
    })
    .eq("id", data.bookingId)

  if (error) throw error

  // Update vendor's average rating
  const { data: booking } = await supabase.from("vendor_bookings").select("vendor_id").eq("id", data.bookingId).single()

  if (booking) {
    const { data: allRatings } = await supabase
      .from("vendor_bookings")
      .select("agent_rating")
      .eq("vendor_id", booking.vendor_id)
      .not("agent_rating", "is", null)

    if (allRatings && allRatings.length > 0) {
      const avgRating = allRatings.reduce((sum, r) => sum + (r.agent_rating || 0), 0) / allRatings.length
      await supabase.from("vendor_directory").update({ rating: avgRating }).eq("id", booking.vendor_id)
    }
  }

  return { success: true }
}

// ============================================
// LENDER PORTAL FUNCTIONS
// ============================================

export async function getLenderDashboard_v2(lenderId: string) {
  const supabase = await createClient()

  const { data: lender } = await supabase.from("lender_portal_users").select("*").eq("id", lenderId).single()

  const { data: loans } = await supabase
    .from("transaction_lenders")
    .select(`
      *,
      transactions(
        *,
        leads(*),
        agents(*)
      )
    `)
    .eq("lender_email", lender?.email)
    .order("created_at", { ascending: false })

  return { lender, loans }
}

export async function assignLenderToTransaction(data: { transactionId: string; lenderId: string }) {
  const supabase = await createClient()

  // Get current assigned transactions
  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("assigned_transactions")
    .eq("id", data.lenderId)
    .single()

  const currentTransactions = lender?.assigned_transactions || []
  if (!currentTransactions.includes(data.transactionId)) {
    currentTransactions.push(data.transactionId)
  }

  const { error } = await supabase
    .from("lender_portal_users")
    .update({ assigned_transactions: currentTransactions })
    .eq("id", data.lenderId)

  if (error) throw error

  // Also update transaction with lender info
  await supabase.from("transactions").update({ lender_id: data.lenderId }).eq("id", data.transactionId)

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
      conditions_cleared: data.conditionsCleared,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.loanId)
    .select("*, transactions(*)")
    .single()

  if (error) throw error

  await supabase.from("transaction_timeline").insert({
    transaction_id: loan.transaction_id,
    event_type: "financing_update",
    event_title: `Loan Status: ${data.status}`,
    event_description: data.notes || `Underwriting status updated to ${data.status}`,
    is_visible_to_client: true,
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

  const { error } = await supabase.from("transaction_lenders").update({ conditions_list: data.conditions }).eq("id", data.loanId)

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
        property_address,
        agents(first_name, last_name, email, phone)
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

  const [{ data: pendingReviews }, { data: recentViolations }, { data: agentScores }] = await Promise.all([
    supabase.from("compliance_reviews").select("*").in("review_status", ["pending", "in_review"]).order("created_at"),
    supabase
      .from("compliance_violations")
      .select("*, agents(first_name, last_name)")
      .eq("resolution_status", "open")
      .order("detected_at", { ascending: false })
      .limit(20),
    supabase
      .from("agent_performance_metrics")
      .select("agent_id, compliance_score, agents(first_name, last_name)")
      .order("compliance_score")
      .limit(10),
  ])

  return { pendingReviews, recentViolations, agentScores }
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

  const { data: review, error } = await supabase
    .from("compliance_reviews")
    .update({
      review_status: data.status,
      findings: data.findings,
      risk_level: data.riskLevel,
      action_required: data.actionRequired,
      notes: data.notes,
      reviewed_at: new Date().toISOString(),
      completed_at: data.status !== "needs_revision" ? new Date().toISOString() : null,
    })
    .eq("id", data.reviewId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/compliance")
  return review
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
}) {
  const supabase = await createClient()

  const { data: workflow, error } = await supabase
    .from("workflow_automations")
    .insert({
      workflow_name: data.workflowName,
      workflow_type: data.workflowType,
      trigger_event: data.triggerEvent,
      trigger_conditions: data.triggerConditions,
      actions: data.actions,
      assigned_to_role: data.assignedToRole,
      created_by: data.createdBy,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/admin/automations")
  return workflow
}

export async function executeWorkflow(workflowId: string, contextData: any) {
  const supabase = await createClient()

  const { data: workflow } = await supabase.from("workflow_automations").select("*").eq("id", workflowId).single()

  if (!workflow || !workflow.is_active) return { success: false, reason: "Workflow not active" }

  for (const action of workflow.actions || []) {
    switch (action.type) {
      case "send_email":
        // Integration with GHL email
        break
      case "create_task":
        await supabase.from("tasks").insert({
          title: action.taskTitle,
          description: action.taskDescription,
          assigned_to: contextData.assignedTo,
          related_transaction_id: contextData.transactionId,
          due_date: action.dueDateOffset
            ? new Date(Date.now() + action.dueDateOffset * 24 * 60 * 60 * 1000).toISOString()
            : null,
        })
        break
      case "update_milestone":
        await supabase
          .from("transaction_milestones")
          .update({ status: action.newStatus })
          .eq("transaction_id", contextData.transactionId)
          .eq("milestone_name", action.milestoneName)
        break
      case "notify_coordinator":
        // Send notification to TC
        break
    }
  }

  await supabase
    .from("workflow_automations")
    .update({
      execution_count: (workflow.execution_count || 0) + 1,
      last_executed_at: new Date().toISOString(),
    })
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
}) {
  const supabase = await createClient()

  const { data: review, error } = await supabase
    .from("client_reviews")
    .insert({
      lead_id: data.leadId,
      contact_id: data.contactId,
      transaction_id: data.transactionId,
      agent_id: data.agentId,
      rating: data.rating,
      review_text: data.reviewText,
      review_categories: data.categories,
      would_recommend: data.wouldRecommend,
      review_source: "portal",
      is_public: false,
      is_approved: false,
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
  teamMembers?: string[]
  commissionSplitRules?: any
}) {
  const supabase = await createClient()

  const { data: team, error } = await supabase
    .from("agent_teams")
    .insert({
      team_name: data.teamName,
      team_leader_id: data.teamLeaderId,
      brokerage_id: data.brokerageId,
      team_members: data.teamMembers || [data.teamLeaderId],
      commission_split_rules: data.commissionSplitRules,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/teams")
  return team
}

export async function getTeamDashboard(teamId: string) {
  const supabase = await createClient()

  const { data: team } = await supabase.from("agent_teams").select("*").eq("id", teamId).single()

  if (!team) throw new Error("Team not found")

  const { data: teamMembers } = await supabase.from("agents").select("*").in("id", team.team_members || [])

  const { data: teamTransactions } = await supabase
    .from("transactions")
    .select("*")
    .in("agent_id", team.team_members || [])
    .not("status", "in", "(closed,cancelled)")

  return {
    team,
    teamMembers,
    teamTransactions,
    metrics: {
      totalMembers: teamMembers?.length || 0,
      activeTransactions: teamTransactions?.length || 0,
      totalVolume: teamTransactions?.reduce((sum, t) => sum + (t.sale_price || t.list_price || 0), 0) || 0,
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

  // Get closed transactions in billing period
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*")
    .eq("agent_id", data.agentId)
    .eq("status", "closed")
    .gte("actual_closing_date", data.billingPeriodStart)
    .lte("actual_closing_date", data.billingPeriodEnd)

  // Get agent's commission structure
  const { data: agent } = await supabase.from("agents").select("commission_split, cap_amount").eq("id", data.agentId).single()

  const grossCommission = transactions?.reduce((sum, t) => sum + (t.commission_amount || 0), 0) || 0
  const brokerageSplit = (100 - (agent?.commission_split || 70)) / 100
  const brokerageSplitAmount = grossCommission * brokerageSplit

  // Standard fees (configurable per brokerage)
  const transactionFees = (transactions?.length || 0) * 395
  const deskFees = 100
  const technologyFees = 75
  const eAndOInsurance = 50

  const netToAgent = grossCommission - brokerageSplitAmount - transactionFees - deskFees - technologyFees - eAndOInsurance

  const { data: billing, error } = await supabase
    .from("agent_billing")
    .insert({
      agent_id: data.agentId,
      brokerage_id: data.brokerageId,
      billing_period_start: data.billingPeriodStart,
      billing_period_end: data.billingPeriodEnd,
      gross_commission: grossCommission,
      brokerage_split_amount: brokerageSplitAmount,
      transaction_fees: transactionFees,
      desk_fees: deskFees,
      technology_fees: technologyFees,
      e_and_o_insurance: eAndOInsurance,
      net_to_agent: netToAgent,
    })
    .select()
    .single()

  if (error) throw error

  return billing
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
}) {
  const supabase = await createClient()

  const { data: review, error } = await supabase
    .from("client_reviews")
    .insert({
      lead_id: data.leadId,
      transaction_id: data.transactionId,
      agent_id: data.agentId,
      rating: data.rating,
      review_text: data.reviewText,
      review_categories: data.reviewCategories,
      would_recommend: data.wouldRecommend,
      review_source: data.reviewSource || "portal",
    })
    .select()
    .single()

  if (error) throw error

  return review
}

export async function getAgentReviews(agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("client_reviews")
    .select("*")
    .eq("agent_id", agentId)
    .eq("is_approved", true)
    .order("submitted_at", { ascending: false })

  if (error) throw error

  const avgRating = data && data.length > 0 ? data.reduce((sum, r) => sum + r.rating, 0) / data.length : 0

  return {
    reviews: data || [],
    metrics: {
      totalReviews: data?.length || 0,
      averageRating: avgRating,
      recommendationRate: data && data.length > 0 ? (data.filter((r) => r.would_recommend).length / data.length) * 100 : 0,
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

  const { data: preferences, error } = await supabase
    .from("client_journey_preferences")
    .upsert(
      {
        lead_id: data.leadId,
        contact_id: data.contactId,
        journey_type: data.journeyType,
        must_have_features: data.mustHaveFeatures,
        nice_to_have_features: data.niceToHaveFeatures,
        deal_breakers: data.dealBreakers,
        preferred_neighborhoods: data.preferredNeighborhoods,
        commute_considerations: data.commuteConsiderations,
        school_requirements: data.schoolRequirements,
        lifestyle_priorities: data.lifestylePriorities,
        selling_timeline: data.sellingTimeline,
        selling_motivation: data.sellingMotivation,
        preferred_contact_method: data.preferredContactMethod,
        preferred_contact_times: data.preferredContactTimes,
        frequency_preference: data.frequencyPreference,
        decision_makers: data.decisionMakers,
        decision_timeline: data.decisionTimeline,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "lead_id" }
    )
    .select()
    .single()

  if (error) throw error

  return preferences
}

export async function getClientJourneyPreferences(leadId?: string, contactId?: string) {
  const supabase = await createClient()

  let query = supabase.from("client_journey_preferences").select("*")

  if (leadId) {
    query = query.eq("lead_id", leadId)
  } else if (contactId) {
    query = query.eq("contact_id", contactId)
  }

  const { data, error } = await query.single()

  if (error && error.code !== "PGRST116") throw error

  return data
}

// ============================================
// BROKERAGE REVENUE FORECASTING
// ============================================

export async function forecastBrokerageRevenue(brokerageId: string, months: number = 3) {
  const supabase = await createClient()

  const { data: historical } = await supabase
    .from("brokerage_performance")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("period_start_date", { ascending: false })
    .limit(12)

  const { data: pipeline } = await supabase
    .from("transactions")
    .select("contract_price, closing_date, transaction_status, commission_rate")
    .eq("brokerage_id", brokerageId)
    .gte("closing_date", new Date().toISOString().split("T")[0])
    .in("transaction_status", ["under_contract", "pending", "clear_to_close"])

  const avgHistoricalGCI = historical?.reduce((sum, p) => sum + (p.total_gci || 0), 0) / (historical?.length || 1)
  const pipelineGCI =
    pipeline?.reduce((sum, t) => {
      const commission = (t.contract_price || 0) * ((t.commission_rate || 3) / 100)
      const probability = t.transaction_status === "clear_to_close" ? 0.95 : t.transaction_status === "pending" ? 0.8 : 0.6
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

  const { data: agents } = await supabase.from("agents").select("*, agent_licenses(*)").eq("brokerage_id", brokerageId)

  const sixtyDaysFromNow = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)

  const expiringLicenses =
    agents?.filter((agent) => {
      const license = agent.agent_licenses?.[0]
      if (!license?.expiration_date) return false
      const expiry = new Date(license.expiration_date)
      return expiry <= sixtyDaysFromNow && expiry > new Date()
    }) || []

  const expiredLicenses =
    agents?.filter((agent) => {
      const license = agent.agent_licenses?.[0]
      if (!license?.expiration_date) return false
      return new Date(license.expiration_date) < new Date()
    }) || []

  return { expiringLicenses, expiredLicenses, totalAgents: agents?.length || 0 }
}

// ============================================
// REFERRAL PARTNER FUNCTIONS
// ============================================

export async function createReferralPartner(data: {
  partnerName: string
  partnerType: "agent" | "lender" | "past_client" | "business"
  contactEmail: string
  contactPhone?: string
  commissionSplit: number
  agreementSignedDate?: string
  notes?: string
  createdBy: string
}) {
  const supabase = await createClient()

  const { data: partner, error } = await supabase
    .from("referral_partners")
    .insert({
      partner_name: data.partnerName,
      partner_type: data.partnerType,
      contact_email: data.contactEmail,
      contact_phone: data.contactPhone,
      commission_split_percentage: data.commissionSplit,
      agreement_signed_date: data.agreementSignedDate,
      notes: data.notes,
      created_by: data.createdBy,
    })
    .select()
    .single()

  if (error) throw error

  return partner
}

export async function trackReferral(data: {
  referralPartnerId: string
  leadId?: string
  contactId?: string
  transactionId?: string
  referralStatus: "pending" | "converted" | "closed" | "lost"
  commissionAmount?: number
}) {
  const supabase = await createClient()

  const { data: referral, error } = await supabase
    .from("referral_tracking")
    .upsert({
      referral_partner_id: data.referralPartnerId,
      lead_id: data.leadId,
      contact_id: data.contactId,
      transaction_id: data.transactionId,
      referral_status: data.referralStatus,
      commission_amount: data.commissionAmount,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  return referral
}

export async function getReferralPartnerStats(partnerId: string) {
  const supabase = await createClient()

  const { data: referrals } = await supabase
    .from("referral_tracking")
    .select("*")
    .eq("referral_partner_id", partnerId)

  const totalReferrals = referrals?.length || 0
  const convertedReferrals = referrals?.filter((r) => r.referral_status === "converted" || r.referral_status === "closed").length || 0
  const totalCommission = referrals?.reduce((sum, r) => sum + (r.commission_amount || 0), 0) || 0
  const conversionRate = totalReferrals > 0 ? (convertedReferrals / totalReferrals) * 100 : 0

  return { totalReferrals, convertedReferrals, totalCommission, conversionRate }
}

// ============================================
// TRANSACTION COORDINATOR ANALYTICS
// ============================================

export async function predictDeadlineRisks(coordinatorId: string) {
  const supabase = await createClient()

  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      *,
      transaction_milestones(*),
      transaction_deadlines(*)
    `)
    .eq("coordinator_id", coordinatorId)
    .not("status", "in", "(closed,cancelled)")

  const atRisk = transactions?.filter((t) => {
    const completionRate = t.progress_percentage || 0
    const daysToClosing = Math.floor((new Date(t.closing_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
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
    .select("*, conditions_list")
    .eq("id", loanId)
    .single()

  const pendingConditions = loan?.conditions_list?.filter((c: any) => c.status !== "cleared") || []
  const clearedConditions = loan?.conditions_list?.filter((c: any) => c.status === "cleared") || []

  const clearanceRate = loan?.conditions_list?.length > 0 ? (clearedConditions.length / loan.conditions_list.length) * 100 : 0

  if (clearanceRate === 100 && loan?.underwriting_status !== "clear_to_close") {
    await supabase.from("transaction_lenders").update({ underwriting_status: "clear_to_close" }).eq("id", loanId)
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

  const unresolvedIssues = titleInfo?.title_issues?.filter((i: any) => i.status !== "resolved") || []
  const critical = unresolvedIssues.filter((i: any) => i.severity === "critical")
  const moderate = unresolvedIssues.filter((i: any) => i.severity === "moderate")

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
}) {
  const supabase = await createClient()

  const { data: vendors } = await supabase
    .from("vendor_directory")
    .select("*")
    .eq("vendor_type", data.serviceType)
    .contains("service_areas", [data.propertyCity])
    .eq("is_active", true)
    .gte("rating", 4.0)

  const sorted = vendors?.sort((a, b) => {
    if (data.urgency === "urgent") {
      return (b.rating || 0) - (a.rating || 0)
    }
    return (b.total_jobs_completed || 0) - (a.total_jobs_completed || 0)
  })

  return sorted?.[0] || null
}

export async function checkVendorAvailability(data: { vendorType: string; preferredDate: string; propertyCity: string }) {
  const supabase = await createClient()

  const { data: vendors } = await supabase
    .from("vendor_directory")
    .select("*")
    .eq("vendor_type", data.vendorType)
    .contains("service_areas", [data.propertyCity])
    .eq("is_active", true)

  const { data: existingBookings } = await supabase
    .from("vendor_bookings")
    .select("vendor_id, scheduled_date")
    .eq("scheduled_date", data.preferredDate)
    .in("status", ["scheduled", "confirmed"])

  const bookedVendorIds = existingBookings?.map((b) => b.vendor_id) || []
  const availableVendors = vendors?.filter((v) => !bookedVendorIds.includes(v.id))

  return {
    availableCount: availableVendors?.length || 0,
    availableVendors: availableVendors?.sort((a, b) => (b.rating || 0) - (a.rating || 0)) || [],
  }
}

// ============================================
// COMPLIANCE RISK SCORING
// ============================================

export async function calculateComplianceRiskScore(agentId: string) {
  const supabase = await createClient()

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [{ data: violations }, { data: unapprovedContent }, { data: themFirstScores }] = await Promise.all([
    supabase.from("compliance_violations").select("*").eq("agent_id", agentId).gte("detected_at", thirtyDaysAgo.toISOString()),
    supabase
      .from("content_approvals")
      .select("*")
      .eq("agent_id", agentId)
      .eq("compliance_status", "needs_revision")
      .gte("submitted_at", thirtyDaysAgo.toISOString()),
    supabase.from("chat_sessions").select("them_first_score").eq("agent_id", agentId).gte("created_at", thirtyDaysAgo.toISOString()),
  ])

  const violationScore = Math.max(0, 100 - (violations?.length || 0) * 10)
  const contentScore = Math.max(0, 100 - (unapprovedContent?.length || 0) * 5)
  const avgThemFirst =
    themFirstScores && themFirstScores.length > 0
      ? themFirstScores.reduce((sum, s) => sum + (s.them_first_score || 0), 0) / themFirstScores.length
      : 100

  const overallScore = (violationScore * 0.4 + contentScore * 0.3 + avgThemFirst * 0.3).toFixed(0)

  return {
    overallScore: Number(overallScore),
    violationScore,
    contentScore,
    avgThemFirst: Math.round(avgThemFirst),
    violationsCount: violations?.length || 0,
    unapprovedContentCount: unapprovedContent?.length || 0,
    riskLevel: Number(overallScore) >= 80 ? "low" : Number(overallScore) >= 60 ? "medium" : "high",
  }
}

// ============================================
// COORDINATOR & LENDER DASHBOARDS
// ============================================

export async function bulkUpdateMilestones(updates: Array<{ milestoneId: string; status: string; notes?: string }>) {
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

  const { data: coordinator } = await supabase.from("transaction_coordinators").select("*").eq("id", coordinatorId).single()

  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      *,
      leads(*),
      agents(*),
      transaction_milestones(*)
    `)
    .eq("coordinator_id", coordinatorId)
    .not("status", "in", "(closed,cancelled)")
    .order("closing_date")

  const transactionIds = transactions?.map((t) => t.id) || []

  const { data: deadlines } = await supabase
    .from("transaction_deadlines")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .eq("status", "pending")
    .gte("due_date", new Date().toISOString().split("T")[0])
    .order("due_date")
    .limit(20)

  const { data: incompleteMilestones } = await supabase
    .from("transaction_milestones")
    .select("*, transactions(property_address)")
    .in("transaction_id", transactionIds)
    .in("status", ["pending", "in_progress"])
    .order("due_date")

  return { coordinator, transactions, deadlines, incompleteMilestones }
}

export async function getLenderDashboard(lenderId: string) {
  const supabase = await createClient()

  const { data: lender } = await supabase.from("lender_portal_users").select("*").eq("id", lenderId).single()

  const { data: loans } = await supabase
    .from("transaction_lenders")
    .select(`
      *,
      transactions(
        *,
        leads(*),
        agents(*)
      )
    `)
    .eq("lender_email", lender?.email)
    .order("created_at", { ascending: false })

  return { lender, loans }
}
