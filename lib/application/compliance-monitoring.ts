import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { businessDaysInclusive } from "@/lib/compliance/trid-disclosure-clock"

// ============================================
// AUDIT LOGGING
// ============================================

export async function logAuditEventService(params: {
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

  const { error } = await supabase.from("audit_log").insert({
    user_id: params.userId,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId,
    // audit_log carries before/after JSONB. The legacy `audit_logs` callsite
    // passed a single `changes` payload; we put it in `after` and fold the
    // request-context (ip / UA / compliance flag) into the same JSONB so we
    // don't lose the data on the schema unification.
    before: null,
    after: {
      changes: params.changes ?? null,
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null,
      compliance_relevant: params.complianceRelevant ?? false,
    },
  })

  if (error) {
    console.error("[ComplianceMonitoring] Error logging audit event:", error)
    throw new Error("Failed to log audit event")
  }

  return { success: true }
}

// ============================================
// COMPLIANCE STATUS
// ============================================

export async function checkComplianceStatusService(transactionId: string) {
  const supabase = await createClient()

  const { data: checklists } = await supabase
    .from("compliance_checklists")
    .select("*")
    .eq("transaction_id", transactionId)

  const { data: trid } = await supabase
    .from("trid_timeline")
    .select("*")
    .eq("transaction_id", transactionId)
    .single()

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

// ============================================
// CERTIFICATION TRACKING
// ============================================

export async function trackCertificationExpirationService(agentId: string, client?: SupabaseClient) {
  // Accept a caller-supplied client so system crons can pass a service-role
  // client (bypasses RLS); UI callers default to the user-context client.
  const supabase = client ?? await createClient()

  const today = new Date()
  const thirtyDaysFromNow = new Date()
  thirtyDaysFromNow.setDate(today.getDate() + 30)

  const { data: certifications } = await supabase
    .from("agent_certifications")
    .select("*")
    .eq("agent_id", agentId)

  const expiringCerts = certifications?.filter((cert) => {
    const expDate = new Date(cert.expires_at)
    return expDate <= thirtyDaysFromNow && expDate > today
  })

  const expiredCerts = certifications?.filter((cert) => {
    const expDate = new Date(cert.expires_at)
    return expDate <= today
  })

  // agent_certifications has no status column — the expiring/expired/active lifecycle
  // is fully derived from expires_at, so there is nothing to persist.

  return {
    active: certifications?.filter((c) => !c.expires_at || new Date(c.expires_at) > today).length || 0,
    expiring: expiringCerts?.length || 0,
    expired: expiredCerts?.length || 0,
  }
}

// ============================================
// FAIR HOUSING
// ============================================

export async function analyzeFairHousingRiskService(params: {
  contactId: string
  agentId: string
  interactionType: string
  communicationText: string
}) {
  const supabase = await createClient()

  const protectedClasses = [
    "race", "color", "religion", "national origin",
    "sex", "disability", "familial status", "age",
  ]

  const redFlagPhrases = [
    "perfect for families", "great for retirees", "quiet neighborhood",
    "young professional area", "walk to church", "good schools",
    "safe area", "changing neighborhood",
  ]

  const foundPhrases = redFlagPhrases.filter((phrase) =>
    params.communicationText.toLowerCase().includes(phrase.toLowerCase()),
  )

  const { text } = await generateText({
    model: resolveModel("openai/gpt-4o-mini"),
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

  // Resolve brokerage from the contact (fallback to agent) so every audit row is
  // tenant-scoped and visible to brokerage-scoped reads / RLS.
  const { data: fhContact } = await supabase
    .from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle()
  let brokerageId: string | null = fhContact?.brokerage_id ?? null
  if (!brokerageId && params.agentId) {
    const { data: fhAgent } = await supabase
      .from("agents").select("brokerage_id").eq("id", params.agentId).maybeSingle()
    brokerageId = fhAgent?.brokerage_id ?? null
  }

  // compliance_flags is the CANONICAL compliance ledger (the compliance UI
  // reads it and explicitly ignores fair_housing_logs — that table was a
  // write-only twin nothing consumed; keep-one repoint, open-loop sweep).
  const allFlagged = [...foundPhrases, ...aiAnalysis.flagged_content]
  const { error } = await supabase
    .from("compliance_flags")
    .insert({
      brokerage_id: brokerageId,
      contact_id: params.contactId,
      agent_id: params.agentId,
      violation_type: "fair_housing_violation",
      severity: aiAnalysis.risk_score >= 75 ? "critical" : aiAnalysis.risk_score >= 40 ? "high" : "medium",
      content_type: params.interactionType,
      flagged_content: `${allFlagged.join("; ").slice(0, 300)} :: ${params.communicationText.slice(0, 400)}`,
      detected_at: new Date().toISOString(),
      status: "flagged",
    })

  if (error) {
    console.error("[ComplianceMonitoring] Error logging fair housing analysis:", error)
  }

  if (aiAnalysis.risk_score >= 0.6) {
    await supabase.from("compliance_alerts").insert({
      brokerage_id: brokerageId,
      transaction_id: null,
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

    // Surface to compliance_flags — the table the compliance dashboard reads
    // (filtered by violation_type='fair_housing' + brokerage_id). Without this,
    // the analysis is invisible to the UI.
    await supabase.from("compliance_flags").insert({
      brokerage_id: brokerageId,
      agent_id: params.agentId,
      contact_id: params.contactId,
      content_type: params.interactionType,
      violation_type: "fair_housing",
      flagged_content: { text: params.communicationText, ...aiAnalysis },
      severity: aiAnalysis.risk_score >= 0.8 ? "critical" : "high",
      status: "flagged",
      detected_at: new Date().toISOString(),
    })
  }

  revalidatePath("/compliance")
  return aiAnalysis
}

// ============================================
// TRID
// ============================================

// Single source of truth for the TRID business-day convention (weekends + federal
// holidays excluded) — delegate to the disclosure clock so the post-hoc monitor and
// the forward-looking clock can never drift. Dates may arrive as timestamps; the
// clock expects yyyy-mm-dd, so slice.
const getBusinessDays = (startDate: string, endDate: string) =>
  businessDaysInclusive(startDate.slice(0, 10), endDate.slice(0, 10))

export async function monitorTRIDComplianceService(transactionId: string, client?: SupabaseClient) {
  // Accept a caller-supplied client so the compliance cron can pass a
  // service-role client (bypasses RLS); UI callers default to user context.
  const supabase = client ?? await createClient()

  const { data: timeline } = await supabase
    .from("trid_timeline")
    .select("*")
    .eq("transaction_id", transactionId)
    .single()

  if (!timeline) {
    return { compliant: true, violations: [] }
  }

  // Resolve brokerage from the transaction so alerts are tenant-scoped.
  const { data: tridTxn } = await supabase
    .from("transactions").select("brokerage_id").eq("id", transactionId).maybeSingle()
  const tridBrokerageId: string | null = tridTxn?.brokerage_id ?? null

  const violations: any[] = []

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

  await supabase
    .from("trid_timeline")
    .update({
      compliance_status: violations.length > 0 ? "violation" : "compliant",
      violations,
    })
    .eq("id", timeline.id)

  for (const violation of violations) {
    await supabase.from("compliance_alerts").insert({
      brokerage_id: tridBrokerageId,
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

export async function createTRIDTimelineService(transactionId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("trid_timeline")
    .insert({ transaction_id: transactionId })
    .select()
    .single()

  if (error) {
    console.error("[ComplianceMonitoring] Error creating TRID timeline:", error)
    throw new Error("Failed to create TRID timeline")
  }

  return data
}

export async function updateTRIDMilestoneService(params: {
  transactionId: string
  milestone: string
  date: string
}) {
  const supabase = await createClient()

  const updateData: any = {}
  updateData[params.milestone] = params.date

  const { error } = await supabase
    .from("trid_timeline")
    .update(updateData)
    .eq("transaction_id", params.transactionId)

  if (error) {
    console.error("[ComplianceMonitoring] Error updating TRID milestone:", error)
    throw new Error("Failed to update TRID milestone")
  }

  await monitorTRIDComplianceService(params.transactionId)

  revalidatePath(`/transactions/${params.transactionId}`)
  return { success: true }
}

// ============================================
// DOCUMENT RETENTION
// ============================================

export async function applyDocumentRetentionService(transactionId: string) {
  const supabase = await createClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select("actual_close_date:close_date")
    .eq("id", transactionId)
    .single()

  if (!transaction?.actual_close_date) {
    return { success: false, message: "Transaction not closed yet" }
  }

  const closeDate = new Date(transaction.actual_close_date)
  const retentionYears = 7
  const deleteAfterDate = new Date(closeDate)
  deleteAfterDate.setFullYear(deleteAfterDate.getFullYear() + retentionYears)

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

// ============================================
// AUDIT TRAIL
// ============================================

export async function exportAuditTrailService(params: {
  transactionId?: string
  startDate: string
  endDate: string
}) {
  const supabase = await createClient()

  let query = supabase
    .from("audit_log")
    .select("*")
    .gte("created_at", params.startDate)
    .lte("created_at", params.endDate)
    .order("created_at", { ascending: false })

  if (params.transactionId) {
    query = query.eq("entity_type", "transaction").eq("entity_id", params.transactionId)
  }

  const { data: logs } = await query

  return { logs: logs || [], count: logs?.length || 0 }
}

// ============================================
// CONTENT COMPLIANCE
// ============================================

export async function scanContentComplianceService(content: {
  contentBody: string
  contentType: string
  targetAudience: string
  distributionChannels: string[]
  agentState: string
}) {
  const supabase = await createClient()

  const issues: any[] = []
  const warnings: any[] = []

  const { data: prohibitedPhrases } = await supabase
    .from("prohibited_phrases")
    .select("*")
    .eq("is_active", true)

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

  const { data: requiredDisclosures } = await supabase
    .from("required_disclosures")
    .select("*")
    .eq("is_active", true)

  for (const disclosure of requiredDisclosures || []) {
    const stateMatches =
      !disclosure.required_for_states || disclosure.required_for_states.includes(content.agentState)
    const channelMatch = disclosure.required_for_channels?.some((ch: string) =>
      content.distributionChannels.includes(ch),
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

  const selfReferentialTerms = [
    "I can", "I will", "my service", "my expertise", "hire me", "I am the best", "I specialize",
  ]
  const themFirstTerms = [
    "you deserve", "your goals", "your needs", "for you", "help you", "your family", "your future",
  ]

  const selfCount = selfReferentialTerms.filter((term) =>
    new RegExp(term, "gi").test(content.contentBody),
  ).length
  const themCount = themFirstTerms.filter((term) =>
    new RegExp(term, "gi").test(content.contentBody),
  ).length

  if (selfCount > themCount) {
    warnings.push({
      type: "them_first_violation",
      severity: "info",
      message: 'Content appears to be agent-focused rather than client-focused. Consider rewriting with "them-first" philosophy.',
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

export async function submitContentForApprovalService(data: {
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

  const scanResults = await scanContentComplianceService({
    contentBody: data.contentBody,
    contentType: data.contentType,
    targetAudience: data.targetAudience,
    distributionChannels: data.distributionChannels,
    agentState: data.agentState,
  })

  // Resolve the submitting user's brokerage — the column is brokerage_id, NOT the
  // user id. (Previously stored data.userId here, corrupting tenant scoping.)
  const { data: submitterRow } = await supabase
    .from("users").select("brokerage_id").eq("id", data.userId).maybeSingle()

  const { data: approval, error } = await supabase
    .from("activities")
    .insert({
      brokerage_id: submitterRow?.brokerage_id ?? null,
      agent_user_id: data.userId,
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

export async function reviewContentApprovalService(data: {
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
    metadata: {},
  }

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

export async function logCommunicationWithComplianceService(data: {
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

  // Resolve brokerage from the acting user so audit rows are tenant-scoped.
  const { data: logUser } = await supabase
    .from("users").select("brokerage_id").eq("id", data.userId).maybeSingle()
  const logBrokerageId: string | null = logUser?.brokerage_id ?? null

  let complianceCheck = { passed: true, warnings: [] as any[] }

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

    await supabase.from("compliance_flags").insert({
      brokerage_id: logBrokerageId,
      user_id: data.userId,
      agent_id: data.agentId,
      contact_id: data.contactId ?? null,
      content_type: data.communicationType,
      violation_type: "cold_lead_channel_violation",
      flagged_content: {
        channel_used: data.communicationType,
        lead_temperature: data.leadTemperature,
        allowed_channels: ["email", "print"],
      },
      severity: "high",
      status: "flagged",
      detected_at: new Date().toISOString(),
    })
  }

  const { data: log, error } = await supabase
    .from("communication_audit_log")
    .insert({
      brokerage_id: logBrokerageId,
      user_id: data.userId,
      agent_id: data.agentId,
      contact_id: data.contactId,
      lead_id: data.leadId,
      communication_type: data.communicationType,
      lead_temperature: data.leadTemperature,
      was_approved_content: !!data.contentId,
      channel: data.sentVia,
      body_snippet: data.contentSnapshot?.slice(0, 500),
      compliance_passed: complianceCheck.passed,
      sent_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    console.error("[ComplianceMonitoring] Error logging communication:", error)
    throw error
  }

  return { success: true, compliancePassed: complianceCheck.passed, log }
}

export async function getApprovedContentLibraryService(filters?: {
  category?: string
  channel?: string
  leadType?: string
}) {
  const supabase = await createClient()

  let query = supabase
    .from("approved_content_library")
    .select("*, activities(*)")
    .eq("is_active", true)

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
    console.error("[ComplianceMonitoring] Error fetching approved content:", error)
    return []
  }

  return data || []
}

export async function getPendingApprovalsService() {
  const supabase = await createClient()

  // Resolve brokerage_id from session — never trust caller-supplied value
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userData?.brokerage_id
  if (!brokerageId) return []

  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("activity_type", "content.approval")
    .eq("brokerage_id", brokerageId)
    .in("status", ["pending", "needs_revision"])
    .order("created_at", { ascending: true })

  if (error) {
    console.error("[ComplianceMonitoring] Error fetching pending approvals:", error)
    return []
  }

  return data || []
}

export async function getComplianceViolationsService(agentId?: string, userId?: string) {
  const supabase = await createClient()

  // Resolve brokerage_id from session — never trust caller-supplied value
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userData?.brokerage_id
  if (!brokerageId) return []

  let query = supabase
    .from("compliance_flags")
    .select(`*, users (id, first_name, last_name, email)`)
    .eq("brokerage_id", brokerageId)
    .order("detected_at", { ascending: false })

  if (agentId) {
    query = query.eq("agent_id", agentId)
  }

  if (userId) {
    query = query.eq("user_id", userId)
  }

  const { data, error } = await query.limit(100)

  if (error) {
    console.error("[ComplianceMonitoring] Error fetching compliance violations:", error)
    return []
  }

  return data || []
}

export async function generateComplianceReportService(filters: {
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

  if (filters.agentId) logsQuery = logsQuery.eq("agent_id", filters.agentId)
  if (filters.userId)  logsQuery = logsQuery.eq("user_id", filters.userId)

  const { data: logs } = await logsQuery

  let violationsQuery = supabase
    .from("compliance_flags")
    .select("*")
    .gte("detected_at", filters.startDate)
    .lte("detected_at", filters.endDate)

  if (filters.agentId) violationsQuery = violationsQuery.eq("agent_id", filters.agentId)
  if (filters.userId)  violationsQuery = violationsQuery.eq("user_id", filters.userId)

  const { data: violations } = await violationsQuery

  return {
    totalCommunications: logs?.length || 0,
    compliantCommunications: logs?.filter((l) => l.compliance_check_passed).length || 0,
    totalViolations: violations?.length || 0,
    criticalViolations: violations?.filter((v) => v.severity === "critical").length || 0,
    violationsByType:
      violations?.reduce((acc: Record<string, number>, v) => {
        acc[v.violation_type] = (acc[v.violation_type] || 0) + 1
        return acc
      }, {} as Record<string, number>) || {},
    communicationsByChannel:
      logs?.reduce((acc: Record<string, number>, l) => {
        acc[l.communication_type] = (acc[l.communication_type] || 0) + 1
        return acc
      }, {} as Record<string, number>) || {},
    coldLeadChannelCompliance:
      logs
        ?.filter((l) => l.lead_temperature === "cold")
        .every((l) => ["email", "print"].includes(l.communication_type)) ?? true,
  }
}
