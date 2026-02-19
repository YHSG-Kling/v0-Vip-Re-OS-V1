"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"

// Audit logging
export async function logAuditEvent(params: {
  userId: string
  action: string
  entityType: string
  entityId: string
  changes?: any
  ipAddress?: string
  userAgent?: string
  complianceRelevant?: boolean
}) {
  const supabase = await createClient()

  const { error } = await supabase.from("audit_logs").insert({
    user_id: params.userId,
    action_type: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId,
    changes: params.changes,
    ip_address: params.ipAddress,
    user_agent: params.userAgent,
    compliance_relevant: params.complianceRelevant || false,
  })

  if (error) {
    console.error("[v0] Error logging audit event:", error)
    throw new Error("Failed to log audit event")
  }

  return { success: true }
}

// Check compliance status for a transaction
export async function checkComplianceStatus(transactionId: string) {
  const supabase = await createClient()

  const { data: checklists } = await supabase
    .from("compliance_checklists")
    .select("*")
    .eq("transaction_id", transactionId)

  const { data: trid } = await supabase.from("trid_timeline").select("*").eq("transaction_id", transactionId).single()

  const { data: alerts } = await supabase
    .from("compliance_alerts")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("resolved", false)

  return {
    checklists: checklists || [],
    trid: trid || null,
    alerts: alerts || [],
    overallStatus:
      (alerts?.length || 0) > 0
        ? "at_risk"
        : checklists?.every((c) => c.compliance_status === "compliant")
          ? "compliant"
          : "pending",
  }
}

// Track agent certification expiration
export async function trackCertificationExpiration(agentId: string) {
  const supabase = await createClient()

  const today = new Date()
  const thirtyDaysFromNow = new Date()
  thirtyDaysFromNow.setDate(today.getDate() + 30)

  const { data: certifications } = await supabase.from("agent_certifications").select("*").eq("agent_id", agentId)

  const expiringCerts = certifications?.filter((cert) => {
    const expDate = new Date(cert.expiration_date)
    return expDate <= thirtyDaysFromNow && expDate > today
  })

  const expiredCerts = certifications?.filter((cert) => {
    const expDate = new Date(cert.expiration_date)
    return expDate <= today
  })

  // Update status for expiring/expired certs
  for (const cert of expiringCerts || []) {
    await supabase.from("agent_certifications").update({ status: "expiring_soon" }).eq("id", cert.id)
  }

  for (const cert of expiredCerts || []) {
    await supabase.from("agent_certifications").update({ status: "expired" }).eq("id", cert.id)
  }

  return {
    active: certifications?.filter((c) => c.status === "active").length || 0,
    expiring: expiringCerts?.length || 0,
    expired: expiredCerts?.length || 0,
  }
}

// Analyze fair housing risk with AI
export async function analyzeFairHousingRisk(params: {
  contactId: string
  agentId: string
  interactionType: string
  communicationText: string
}) {
  const supabase = await createClient()

  const protectedClasses = [
    "race",
    "color",
    "religion",
    "national origin",
    "sex",
    "disability",
    "familial status",
    "age",
  ]

  const redFlagPhrases = [
    "perfect for families",
    "great for retirees",
    "quiet neighborhood",
    "young professional area",
    "walk to church",
    "good schools",
    "safe area",
    "changing neighborhood",
  ]

  // Check for red flag phrases
  const foundPhrases = redFlagPhrases.filter((phrase) =>
    params.communicationText.toLowerCase().includes(phrase.toLowerCase()),
  )

  // AI analysis for subtle violations
  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `Analyze this real estate communication for potential Fair Housing Act violations.

Communication: "${params.communicationText}"

Protected classes: ${protectedClasses.join(", ")}

Return a JSON object with:
- risk_score: 0.0 to 1.0 (0 = no risk, 1 = high risk)
- protected_class_mentioned: boolean
- steering_detected: boolean
- flagged_content: array of concerning phrases
- explanation: brief explanation of any concerns
- recommendation: what the agent should do

Focus on detecting:
1. Direct or indirect references to protected classes
2. Steering language that suggests or discourages based on demographics
3. Coded language that implies discrimination
4. Familial status violations (families with children)`,
  })

  let aiAnalysis
  try {
    aiAnalysis = JSON.parse(text)
  } catch {
    aiAnalysis = {
      risk_score: foundPhrases.length > 0 ? 0.7 : 0.3,
      protected_class_mentioned: false,
      steering_detected: foundPhrases.length > 0,
      flagged_content: foundPhrases,
      explanation: "Manual review needed",
      recommendation: "Review with compliance officer",
    }
  }

  // Log to fair housing logs
  const { data: log, error } = await supabase
    .from("fair_housing_logs")
    .insert({
      contact_id: params.contactId,
      agent_id: params.agentId,
      interaction_type: params.interactionType,
      communication_text: params.communicationText,
      protected_class_mentioned: aiAnalysis.protected_class_mentioned,
      steering_risk_detected: aiAnalysis.steering_detected,
      ai_analysis: aiAnalysis,
      risk_score: aiAnalysis.risk_score,
      flagged_phrases: [...foundPhrases, ...aiAnalysis.flagged_content],
    })
    .select()
    .single()

  if (error) {
    console.error("[v0] Error logging fair housing analysis:", error)
  }

  // Create alert if high risk
  if (aiAnalysis.risk_score >= 0.6) {
    await supabase.from("compliance_alerts").insert({
      transaction_id: null, // Contact-level, not transaction
      alert_type: "FAIR_HOUSING_RISK",
      severity: aiAnalysis.risk_score >= 0.8 ? "critical" : "high",
      message: `Potential fair housing violation detected in ${params.interactionType}`,
      details: {
        contact_id: params.contactId,
        agent_id: params.agentId,
        risk_score: aiAnalysis.risk_score,
        flagged_phrases: aiAnalysis.flagged_content,
        recommendation: aiAnalysis.recommendation,
      },
    })
  }

  revalidatePath("/compliance")
  return aiAnalysis
}

// Monitor TRID compliance
export async function monitorTRIDCompliance(transactionId: string) {
  const supabase = await createClient()

  const { data: timeline } = await supabase
    .from("trid_timeline")
    .select("*")
    .eq("transaction_id", transactionId)
    .single()

  if (!timeline) {
    return { compliant: true, violations: [] }
  }

  const violations: any[] = []

  // Helper to calculate business days
  const getBusinessDays = (startDate: string, endDate: string) => {
    const start = new Date(startDate)
    const end = new Date(endDate)
    let count = 0
    const current = new Date(start)

    while (current <= end) {
      const day = current.getDay()
      if (day !== 0 && day !== 6) count++ // Not weekend
      current.setDate(current.getDate() + 1)
    }
    return count
  }

  // Check Loan Estimate delivery (3 business days)
  if (timeline.loan_application_date && timeline.loan_estimate_delivered_date) {
    const days = getBusinessDays(timeline.loan_application_date, timeline.loan_estimate_delivered_date)
    if (days > 3) {
      violations.push({
        type: "TRID_LE_LATE",
        severity: "high",
        message: `Loan Estimate delivered ${days} business days after application (max 3)`,
        days_violation: days - 3,
      })
    }
  }

  // Check Closing Disclosure timing (3 business days before closing)
  if (timeline.closing_disclosure_delivered_date && timeline.scheduled_close_date) {
    const days = getBusinessDays(timeline.closing_disclosure_delivered_date, timeline.scheduled_close_date)
    if (days < 3) {
      violations.push({
        type: "TRID_CD_EARLY_CLOSE",
        severity: "critical",
        message: `Closing scheduled only ${days} business days after CD delivery (min 3 required)`,
        days_violation: 3 - days,
      })
    }
  }

  // Update timeline with violations
  await supabase
    .from("trid_timeline")
    .update({
      compliance_status: violations.length > 0 ? "violation" : "compliant",
      violations: violations,
    })
    .eq("id", timeline.id)

  // Create alerts for violations
  for (const violation of violations) {
    await supabase.from("compliance_alerts").insert({
      transaction_id: transactionId,
      alert_type: violation.type,
      severity: violation.severity,
      message: violation.message,
      details: violation,
    })
  }

  revalidatePath(`/transactions/${transactionId}`)
  return { compliant: violations.length === 0, violations }
}

// Apply document retention policies
export async function applyDocumentRetention(transactionId: string) {
  const supabase = await createClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select("actual_close_date")
    .eq("id", transactionId)
    .single()

  if (!transaction?.actual_close_date) {
    return { success: false, message: "Transaction not closed yet" }
  }

  const closeDate = new Date(transaction.actual_close_date)
  const retentionYears = 7
  const deleteAfterDate = new Date(closeDate)
  deleteAfterDate.setFullYear(deleteAfterDate.getFullYear() + retentionYears)

  // Get all documents for this transaction
  const { data: documents } = await supabase
    .from("client_documents")
    .select("id, document_type")
    .eq("transaction_id", transactionId)

  for (const doc of documents || []) {
    await supabase.from("document_retention").upsert(
      {
        document_id: doc.id,
        retention_category: "transaction",
        retention_years: retentionYears,
        transaction_close_date: transaction.actual_close_date,
        delete_after_date: deleteAfterDate.toISOString().split("T")[0],
      },
      { onConflict: "document_id" },
    )
  }

  return { success: true, documents_processed: documents?.length || 0 }
}

// Export audit trail
export async function exportAuditTrail(params: {
  transactionId?: string
  startDate: string
  endDate: string
}) {
  const supabase = await createClient()

  let query = supabase
    .from("audit_logs")
    .select("*")
    .gte("timestamp", params.startDate)
    .lte("timestamp", params.endDate)
    .order("timestamp", { ascending: false })

  if (params.transactionId) {
    query = query.eq("entity_type", "transaction").eq("entity_id", params.transactionId)
  }

  const { data: logs } = await query

  return { logs: logs || [], count: logs?.length || 0 }
}

// ============================================
// CONTENT APPROVAL & MARKETING COMPLIANCE
// ============================================

// Auto-scan content for compliance issues
export async function scanContentCompliance(content: {
  contentBody: string
  contentType: string
  targetAudience: string
  distributionChannels: string[]
  agentState: string
}) {
  const supabase = await createClient()

  const issues: any[] = []
  const warnings: any[] = []

  // Check prohibited phrases
  const { data: prohibitedPhrases } = await supabase.from("prohibited_phrases").select("*").eq("is_active", true)

  for (const phrase of prohibitedPhrases || []) {
    const regex = new RegExp(phrase.phrase_pattern || phrase.phrase, "gi")
    if (regex.test(content.contentBody)) {
      issues.push({
        type: "prohibited_phrase",
        category: phrase.category,
        severity: phrase.severity,
        found: phrase.phrase,
        suggestedAlternative: phrase.suggested_alternative,
        location: "content_body",
      })
    }
  }

  // Check channel restrictions for cold leads
  if (content.targetAudience === "cold_lead") {
    const allowedChannels = ["email", "print"]
    const invalidChannels = content.distributionChannels.filter((ch) => !allowedChannels.includes(ch))

    if (invalidChannels.length > 0) {
      issues.push({
        type: "channel_violation",
        category: "cold_lead_restriction",
        severity: "blocking",
        message: `Cold leads can only receive email or print mail. Invalid channels: ${invalidChannels.join(", ")}`,
        invalidChannels,
      })
    }
  }

  // Check required disclosures
  const { data: requiredDisclosures } = await supabase
    .from("required_disclosures")
    .select("*")
    .eq("is_active", true)

  for (const disclosure of requiredDisclosures || []) {
    // Check if state matches (NULL = all states)
    const stateMatches = !disclosure.required_for_states || disclosure.required_for_states.includes(content.agentState)

    // Check if channel matches
    const channelMatch = disclosure.required_for_channels?.some((ch: string) =>
      content.distributionChannels.includes(ch)
    )

    if (stateMatches && channelMatch && !content.contentBody.includes(disclosure.disclosure_text)) {
      warnings.push({
        type: "missing_disclosure",
        severity: "warning",
        disclosureType: disclosure.disclosure_type,
        requiredText: disclosure.disclosure_text,
        placement: disclosure.placement_requirement,
      })
    }
  }

  // Check them-first language ratio
  const selfReferentialTerms = ["I can", "I will", "my service", "my expertise", "hire me", "I am the best", "I specialize"]
  const themFirstTerms = ["you deserve", "your goals", "your needs", "for you", "help you", "your family", "your future"]

  const selfCount = selfReferentialTerms.filter((term) => new RegExp(term, "gi").test(content.contentBody)).length
  const themCount = themFirstTerms.filter((term) => new RegExp(term, "gi").test(content.contentBody)).length

  if (selfCount > themCount) {
    warnings.push({
      type: "them_first_violation",
      severity: "info",
      message:
        'Content appears to be agent-focused rather than client-focused. Consider rewriting with "them-first" philosophy.',
      selfReferentialCount: selfCount,
      clientFocusedCount: themCount,
    })
  }

  return {
    passed: issues.filter((i) => i.severity === "blocking").length === 0,
    issues,
    warnings,
    score: Math.max(0, 100 - issues.length * 20 - warnings.length * 5),
  }
}

// Submit content for approval
export async function submitContentForApproval(data: {
  userId: string
  agentId?: string
  contentType: string
  contentTitle: string
  contentBody: string
  contentMetadata?: any
  targetAudience: string
  distributionChannels: string[]
  agentState: string
}) {
  const supabase = await createClient()

  // Run auto-scan
  const scanResults = await scanContentCompliance({
    contentBody: data.contentBody,
    contentType: data.contentType,
    targetAudience: data.targetAudience,
    distributionChannels: data.distributionChannels,
    agentState: data.agentState,
  })

  // Create approval request as activity
  const { data: approval, error } = await supabase
    .from("activities")
    .insert({
      brokerage_id: data.userId, // TODO: Get actual brokerage_id
      activity_type: "content.approval",
      entity_type: "content",
      entity_id: crypto.randomUUID(),
      title: data.contentTitle,
      description: data.contentBody,
      status: scanResults.passed ? "pending" : "needs_revision",
      metadata: {
        content_type: data.contentType,
        content_metadata: data.contentMetadata,
        target_audience: data.targetAudience,
        distribution_channels: data.distributionChannels,
        compliance_issues: scanResults.issues,
        auto_scan_results: scanResults,
        agent_id: data.agentId,
      },
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/compliance")
  return approval
}

// Approve/reject content (compliance admin action)
export async function reviewContentApproval(data: {
  approvalId: string
  reviewerId: string
  status: "approved" | "rejected" | "needs_revision"
  reviewNotes?: string
  expiresInDays?: number
}) {
  const supabase = await createClient()

  const updateData: any = {
    status: data.status,
    completed_at: new Date().toISOString(),
    metadata: {}
  }

  // Get existing activity to preserve metadata
  const { data: existingActivity } = await supabase
    .from("activities")
    .select("metadata")
    .eq("id", data.approvalId)
    .single()

  if (existingActivity) {
    updateData.metadata = {
      ...existingActivity.metadata,
      reviewed_by: data.reviewerId,
      reviewed_at: new Date().toISOString(),
      review_notes: data.reviewNotes,
    }

    if (data.status === "approved") {
      updateData.metadata.approved_at = new Date().toISOString()
      if (data.expiresInDays) {
        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + data.expiresInDays)
        updateData.metadata.expires_at = expiresAt.toISOString()
      }
    }
  }

  const { error } = await supabase
    .from("activities")
    .update(updateData)
    .eq("id", data.approvalId)

  if (error) throw error

  // If approved, add to library
  if (data.status === "approved") {
    const { data: approval } = await supabase
      .from("activities")
      .select("*")
      .eq("id", data.approvalId)
      .single()

    if (approval && approval.metadata) {
      await supabase.from("approved_content_library").insert({
        approval_id: approval.id,
        content_category: approval.metadata.content_type,
        content_template: approval.description,
        allowed_channels: approval.metadata.distribution_channels,
        allowed_lead_types: [approval.metadata.target_audience],
        created_by: approval.brokerage_id,
      })
    }
  }

  revalidatePath("/compliance")
  return { success: true }
}

// Log communication with compliance check
export async function logCommunicationWithCompliance(data: {
  userId: string
  agentId?: string
  contactId?: string
  leadId?: string
  communicationType: string
  leadTemperature: string
  contentId?: string
  contentSnapshot: string
  sentVia?: string
}) {
  const supabase = await createClient()

  let complianceCheck = { passed: true, warnings: [] as any[] }

  // Check cold lead channel restriction
  if (data.leadTemperature === "cold" && !["email", "print"].includes(data.communicationType)) {
    complianceCheck = {
      passed: false,
      warnings: [
        {
          type: "channel_violation",
          message: "Cold leads can only be contacted via email or print mail",
        },
      ],
    }

    // Log violation
    await supabase.from("compliance_flags").insert({
      user_id: data.userId,
      agent_id: data.agentId,
      flag_type: "cold_lead_channel_violation",
      flag_details: {
        channel_used: data.communicationType,
        lead_temperature: data.leadTemperature,
        allowed_channels: ["email", "print"],
      },
      severity: "high",
      detected_by: "auto_scan",
    })
  }

  // Log the communication
  const { data: log, error } = await supabase
    .from("communication_audit_log")
    .insert({
      user_id: data.userId,
      agent_id: data.agentId,
      contact_id: data.contactId,
      lead_id: data.leadId,
      communication_type: data.communicationType,
      content_id: data.contentId,
      lead_temperature: data.leadTemperature,
      was_approved_content: !!data.contentId,
      content_snapshot: data.contentSnapshot,
      compliance_check_passed: complianceCheck.passed,
      compliance_warnings: complianceCheck.warnings,
      sent_via: data.sentVia,
    })
    .select()
    .single()

  if (error) {
    console.error("[v0] Error logging communication:", error)
    throw error
  }

  return { success: true, compliancePassed: complianceCheck.passed, log }
}

// Get approved content library
export async function getApprovedContentLibrary(filters?: {
  category?: string
  channel?: string
  leadType?: string
}) {
  const supabase = await createClient()

  let query = supabase.from("approved_content_library").select("*, activities(*)").eq("is_active", true)

  if (filters?.category) {
    query = query.eq("content_category", filters.category)
  }

  if (filters?.channel) {
    query = query.contains("allowed_channels", [filters.channel])
  }

  if (filters?.leadType) {
    query = query.contains("allowed_lead_types", [filters.leadType])
  }

  const { data, error } = await query.order("created_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching approved content:", error)
    return []
  }

  return data || []
}

// Get pending approvals (for compliance reviewers)
export async function getPendingApprovals() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("activity_type", "content.approval")
    .in("status", ["pending", "needs_revision"])
    .order("created_at", { ascending: true })

  if (error) {
    console.error("[v0] Error fetching pending approvals:", error)
    return []
  }

  return data || []
}

// Get compliance violations dashboard
export async function getComplianceViolations(agentId?: string, userId?: string) {
  const supabase = await createClient()

  let query = supabase
    .from("compliance_flags")
    .select(`
      *,
      agents (id, user_id(first_name, last_name, email))
    `)
    .order("detected_at", { ascending: false })

  if (agentId) {
    query = query.eq("agent_id", agentId)
  }
  
  if (userId) {
    query = query.eq("user_id", userId)
  }

  const { data, error } = await query.limit(100)

  if (error) {
    console.error("[v0] Error fetching compliance violations:", error)
    return []
  }

  return data || []
}

// Generate compliance report
export async function generateComplianceReport(filters: {
  startDate: string
  endDate: string
  agentId?: string
  userId?: string
}) {
  const supabase = await createClient()

  let logsQuery = supabase
    .from("communication_audit_log")
    .select("*")
    .gte("sent_at", filters.startDate)
    .lte("sent_at", filters.endDate)

  if (filters.agentId) {
    logsQuery = logsQuery.eq("agent_id", filters.agentId)
  }

  if (filters.userId) {
    logsQuery = logsQuery.eq("user_id", filters.userId)
  }

  const { data: logs } = await logsQuery

  let violationsQuery = supabase
    .from("compliance_flags")
    .select("*")
    .gte("detected_at", filters.startDate)
    .lte("detected_at", filters.endDate)

  if (filters.agentId) {
    violationsQuery = violationsQuery.eq("agent_id", filters.agentId)
  }

  if (filters.userId) {
    violationsQuery = violationsQuery.eq("user_id", filters.userId)
  }

  const { data: violations } = await violationsQuery

  const report = {
    totalCommunications: logs?.length || 0,
    compliantCommunications: logs?.filter((l) => l.compliance_check_passed).length || 0,
    totalViolations: violations?.length || 0,
    criticalViolations: violations?.filter((v) => v.severity === "critical").length || 0,
    violationsByType:
      violations?.reduce(
        (acc: Record<string, number>, v) => {
          acc[v.violation_type] = (acc[v.violation_type] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      ) || {},
    communicationsByChannel:
      logs?.reduce(
        (acc: Record<string, number>, l) => {
          acc[l.communication_type] = (acc[l.communication_type] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      ) || {},
    coldLeadChannelCompliance:
      logs?.filter((l) => l.lead_temperature === "cold").every((l) => ["email", "print"].includes(l.communication_type)) ??
      true,
  }

  return report
}

// Create TRID timeline for transaction
export async function createTRIDTimeline(transactionId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("trid_timeline")
    .insert({ transaction_id: transactionId })
    .select()
    .single()

  if (error) {
    console.error("[v0] Error creating TRID timeline:", error)
    throw new Error("Failed to create TRID timeline")
  }

  return data
}

// Update TRID milestone
export async function updateTRIDMilestone(params: {
  transactionId: string
  milestone: string
  date: string
}) {
  const supabase = await createClient()

  const updateData: any = {}
  updateData[params.milestone] = params.date

  const { error } = await supabase.from("trid_timeline").update(updateData).eq("transaction_id", params.transactionId)

  if (error) {
    console.error("[v0] Error updating TRID milestone:", error)
    throw new Error("Failed to update TRID milestone")
  }

  // Re-check compliance after update
  await monitorTRIDCompliance(params.transactionId)

  revalidatePath(`/transactions/${params.transactionId}`)
  return { success: true }
}
