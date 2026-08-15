/**
 * Deal Health Scorer — Layer 6 Transaction Orchestration
 * 
 * Computes a rollup health score (0-100) for transactions and writes:
 *   - deal_health_scores: UPSERT by transaction_id
 *   - deal_health_components: delete old rows, insert new run consistently
 *   - transactions.health_score: update every run
 * 
 * Categories (10):
 *   EARNEST_MONEY, INSPECTION, LENDER, TITLE, MILESTONES, DEADLINES,
 *   COMPLIANCE, COMMUNICATION, DOCUMENTS, PARTICIPANTS
 * 
 * Schema source of truth (from Supabase):
 *   - transactions
 *   - transaction_milestones
 *   - transaction_deadlines
 *   - transaction_inspections
 *   - transaction_lenders
 *   - transaction_title_escrow
 *   - transaction_documents
 *   - transaction_participants
 *   - transaction_compliance_log
 *   - compliance_checklists
 *   - deal_health_scores
 *   - deal_health_components
 * 
 * Data Source Mappings:
 *   - earnest money status → transaction_title_escrow.earnest_money_received_date
 *   - inspection state → transaction_inspections.status
 *   - lender state → transaction_lenders.clear_to_close_date, lender assignment fields
 *   - title state → transaction_title_escrow.title_company_name, escrow_number, title dates
 *   - milestones → transaction_milestones.milestone_name, target_date, status
 *   - deadlines → transaction_deadlines.deadline_type, deadline_date, status
 *   - documents → transaction_documents
 *   - compliance → transaction_compliance_log, compliance_checklists
 *   - participants → transaction_participants
 */

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent }         from "@/lib/kernel/events"
import { emitKernelEvent }     from "@/lib/kernel/emit"
import { gatewayChat }         from "@/lib/ai/gateway-chat"

// ─── Types ────────────────────────────────────────────────────────────────────

export type HealthCategory =
  | "EARNEST_MONEY"
  | "INSPECTION"
  | "LENDER"
  | "TITLE"
  | "MILESTONES"
  | "DEADLINES"
  | "COMPLIANCE"
  | "COMMUNICATION"
  | "DOCUMENTS"
  | "PARTICIPANTS"

export interface ComponentScore {
  category:    HealthCategory
  score:       number          // 0-100
  weight:      number          // factor weight for rollup
  issues:      string[]        // specific issues found
  data:        Record<string, unknown>  // raw data for debugging
}

export type RiskLevel = "healthy" | "watch" | "at_risk" | "critical"

/**
 * Required scoring output shape per specification
 */
export interface DealHealthOutput {
  overall_score: number
  risk_level: RiskLevel
  score_components: Record<string, number>
  flags: string[]
  ai_narrative?: string
  previous_score?: number | null
  score_delta?: number
}

export interface DealHealthResult {
  transactionId:   string
  brokerageId:     string
  overallScore:    number       // 0-100 weighted average
  riskLevel:       RiskLevel
  components:      ComponentScore[]
  calculatedAt:    string
  aiNarrative?:    string       // Generated when tier changes or first score
  previousScore?:  number | null
  scoreDelta?:     number
}

// ─── Category Weights (sum = 100) ─────────────────────────────────────────────

// Weights adjusted to sum to 100 with 10 categories
const CATEGORY_WEIGHTS: Record<HealthCategory, number> = {
  EARNEST_MONEY:   14,
  INSPECTION:      12,
  LENDER:          14,
  TITLE:           10,
  MILESTONES:      10,
  DEADLINES:       10,
  COMPLIANCE:      10,
  COMMUNICATION:    6,
  DOCUMENTS:        8,
  PARTICIPANTS:     6,
}

// ─── Scorer Functions ─────────────────────────────────────────────────────────

/**
 * EARNEST MONEY: Maps to transaction_title_escrow.earnest_money_received_date
 */
async function scoreEarnestMoney(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_title_escrow.earnest_money_received_date
  const { data: titleEscrow } = await supabase
    .from("transaction_title_escrow")
    .select("id, earnest_money_received_date, earnest_money_amount, earnest_money_held_by")
    .eq("transaction_id", transactionId)
    .maybeSingle()

  if (!titleEscrow) {
    issues.push("No title/escrow record found")
    score = 40
  } else if (!titleEscrow.earnest_money_received_date) {
    issues.push("Earnest money not yet received")
    score = 30
  } else {
    // Earnest money received - check if amount is recorded
    if (!titleEscrow.earnest_money_amount) {
      issues.push("Earnest money received but amount not recorded")
      score = Math.min(score, 80)
    }
    if (!titleEscrow.earnest_money_held_by) {
      issues.push("Earnest money holder not specified")
      score = Math.min(score, 85)
    }
    // All good if no issues added
  }

  return {
    category: "EARNEST_MONEY",
    score,
    weight: CATEGORY_WEIGHTS.EARNEST_MONEY,
    issues,
    data: { titleEscrow },
  }
}

/**
 * INSPECTION: Maps to transaction_inspections.status
 */
async function scoreInspection(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_inspections.status
  const { data: inspections } = await supabase
    .from("transaction_inspections")
    .select("id, inspection_type, status, scheduled_date, completed_date, issues_found, report_url")
    .eq("transaction_id", transactionId)

  if (!inspections || inspections.length === 0) {
    issues.push("No inspections scheduled or recorded")
    score = 50
  } else {
    const now = new Date()
    let hasCompletedMain = false
    
    for (const insp of inspections) {
      // Check status - normalized: completed, pass (not "passed")
      if (insp.status === "completed" || insp.status === "pass") {
        if (insp.inspection_type?.toLowerCase().includes("home") || 
            insp.inspection_type?.toLowerCase().includes("general")) {
          hasCompletedMain = true
        }
      } else if (insp.status === "fail") {
        issues.push(`Inspection "${insp.inspection_type}" failed`)
        score = Math.min(score, 25)
      } else if (insp.status === "pending" || insp.status === "scheduled") {
        if (insp.scheduled_date) {
          const scheduled = new Date(insp.scheduled_date)
          if (scheduled < now) {
            issues.push(`Inspection "${insp.inspection_type}" overdue since ${insp.scheduled_date}`)
            score = Math.min(score, 35)
          }
        }
      } else if (insp.status === "issues_found" || insp.issues_found) {
        issues.push(`Inspection "${insp.inspection_type}" has unresolved issues`)
        score = Math.min(score, 50)
      }
      
      // Check if report uploaded
      if (insp.status === "completed" && !insp.report_url) {
        issues.push(`Inspection "${insp.inspection_type}" completed but no report uploaded`)
        score = Math.min(score, 70)
      }
    }
    
    if (!hasCompletedMain) {
      issues.push("Main home inspection not yet completed")
      score = Math.min(score, 60)
    }
  }

  return {
    category: "INSPECTION",
    score,
    weight: CATEGORY_WEIGHTS.INSPECTION,
    issues,
    data: { inspections },
  }
}

/**
 * LENDER: Maps to transaction_lenders.clear_to_close_date and lender assignment fields
 */
async function scoreLender(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_lenders - clear_to_close_date, lender assignment fields
  const { data: lender } = await supabase
    .from("transaction_lenders")
    .select(`
      id, lender_name, loan_officer_name, loan_officer_email, loan_officer_phone,
      loan_type, loan_amount, interest_rate, loan_term_years,
      pre_approval_date, pre_approval_amount,
      appraisal_ordered_date, appraisal_completed_date, appraisal_value,
      underwriting_status, clear_to_close_date
    `)
    .eq("transaction_id", transactionId)
    .maybeSingle()

  if (!lender) {
    issues.push("No lender assigned to transaction")
    score = 30
  } else {
    // Check lender assignment fields
    if (!lender.lender_name) {
      issues.push("Lender name not specified")
      score = Math.min(score, 50)
    }
    if (!lender.loan_officer_name && !lender.loan_officer_email) {
      issues.push("Loan officer contact not assigned")
      score = Math.min(score, 60)
    }
    
    // Check pre-approval
    if (!lender.pre_approval_date) {
      issues.push("Pre-approval not received")
      score = Math.min(score, 40)
    }
    
    // Check appraisal progress
    if (lender.appraisal_ordered_date && !lender.appraisal_completed_date) {
      issues.push("Appraisal ordered but not completed")
      score = Math.min(score, 65)
    }
    
    // Check underwriting status
    if (lender.underwriting_status === "denied" || lender.underwriting_status === "suspended") {
      issues.push(`Underwriting ${lender.underwriting_status}`)
      score = Math.min(score, 15)
    } else if (lender.underwriting_status === "pending" || lender.underwriting_status === "in_review") {
      issues.push("Underwriting still in progress")
      score = Math.min(score, 70)
    }
    
    // Check clear to close date
    if (!lender.clear_to_close_date) {
      issues.push("Clear to close not received")
      score = Math.min(score, 75)
    }
  }

  return {
    category: "LENDER",
    score,
    weight: CATEGORY_WEIGHTS.LENDER,
    issues,
    data: { lender },
  }
}

/**
 * TITLE: Maps to transaction_title_escrow.title_company_name, escrow_number, title dates
 */
async function scoreTitle(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_title_escrow - title_company_name, escrow_number, title dates
  const { data: titleEscrow } = await supabase
    .from("transaction_title_escrow")
    .select(`
      id, title_company_name, title_officer_name, title_officer_email, title_officer_phone,
      escrow_company_name, escrow_officer_name, escrow_officer_email, escrow_officer_phone,
      escrow_number, title_search_ordered_date, title_search_completed_date,
      title_commitment_date, title_issues, closing_scheduled_date, closing_location
    `)
    .eq("transaction_id", transactionId)
    .maybeSingle()

  if (!titleEscrow) {
    issues.push("No title/escrow record found")
    score = 40
  } else {
    // Check title company assignment
    if (!titleEscrow.title_company_name) {
      issues.push("Title company not assigned")
      score = Math.min(score, 50)
    }
    
    // Check escrow number
    if (!titleEscrow.escrow_number) {
      issues.push("Escrow number not assigned")
      score = Math.min(score, 60)
    }
    
    // Check title search progress
    if (!titleEscrow.title_search_ordered_date) {
      issues.push("Title search not ordered")
      score = Math.min(score, 55)
    } else if (!titleEscrow.title_search_completed_date) {
      issues.push("Title search ordered but not completed")
      score = Math.min(score, 70)
    }
    
    // Check title commitment
    if (!titleEscrow.title_commitment_date) {
      issues.push("Title commitment not received")
      score = Math.min(score, 65)
    }
    
    // Check for title issues
    if (titleEscrow.title_issues) {
      issues.push(`Title issues identified: ${titleEscrow.title_issues.substring(0, 50)}...`)
      score = Math.min(score, 35)
    }
    
    // Check closing scheduled
    if (!titleEscrow.closing_scheduled_date) {
      issues.push("Closing not scheduled")
      score = Math.min(score, 75)
    }
  }

  return {
    category: "TITLE",
    score,
    weight: CATEGORY_WEIGHTS.TITLE,
    issues,
    data: { titleEscrow },
  }
}

/**
 * MILESTONES: Maps to transaction_milestones
 */
async function scoreMilestones(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_milestones - milestone_name, target_date, status, completed_at
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, milestone_name, target_date, status, completed_at, completed_by, notes")
    .eq("transaction_id", transactionId)

  if (!milestones || milestones.length === 0) {
    issues.push("No milestones defined")
    score = 50
  } else {
    const now = new Date()
    let overdueCount = 0
    let totalIncomplete = 0

    for (const m of milestones) {
      if (!m.completed_at && m.status !== "completed") {
        totalIncomplete++
        if (m.target_date && new Date(m.target_date) < now) {
          overdueCount++
          issues.push(`Milestone "${m.milestone_name}" overdue since ${m.target_date}`)
        }
      }
    }

    if (overdueCount > 0) {
      score = Math.max(20, 100 - overdueCount * 20)
    } else if (totalIncomplete > 0) {
      // Penalize slightly for incomplete but not overdue
      score = Math.max(60, 100 - totalIncomplete * 5)
    }
  }

  return {
    category: "MILESTONES",
    score,
    weight: CATEGORY_WEIGHTS.MILESTONES,
    issues,
    data: { milestones },
  }
}

/**
 * DEADLINES: Maps to transaction_deadlines
 * Schema columns: deadline_type, deadline_date, status, completed_at, completed_by, extension_date, extension_reason
 */
async function scoreDeadlines(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_deadlines
  const { data: deadlines } = await supabase
    .from("transaction_deadlines")
    .select("id, deadline_type, deadline_date, status, completed_at, completed_by, extension_date, extension_reason, notes")
    .eq("transaction_id", transactionId)

  if (!deadlines || deadlines.length === 0) {
    issues.push("No deadlines tracked for this transaction")
    score = 60
  } else {
    const now = new Date()
    let overdueCount = 0
    let upcomingCount = 0
    let extendedCount = 0

    for (const d of deadlines) {
      // Skip completed deadlines
      if (d.status === "completed" || d.completed_at) continue

      const deadlineDate = d.extension_date ? new Date(d.extension_date) : (d.deadline_date ? new Date(d.deadline_date) : null)
      
      if (!deadlineDate) continue

      // Check if extended
      if (d.extension_date) {
        extendedCount++
      }

      // Check if overdue
      if (deadlineDate < now) {
        overdueCount++
        issues.push(`Deadline "${d.deadline_type}" overdue since ${d.deadline_date}`)
      } else {
        // Check if deadline is within 3 days
        const threeDaysFromNow = new Date()
        threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3)
        if (deadlineDate <= threeDaysFromNow) {
          upcomingCount++
        }
      }
    }

    // Overdue deadlines are critical
    if (overdueCount > 0) {
      score = Math.max(15, 100 - overdueCount * 25)
    }

    // Extended deadlines indicate issues
    if (extendedCount > 0 && score > 60) {
      issues.push(`${extendedCount} deadline(s) extended`)
      score = Math.min(score, 75)
    }

    // Upcoming deadlines warrant attention
    if (upcomingCount > 0 && score > 70) {
      issues.push(`${upcomingCount} deadline(s) due within 3 days`)
      score = Math.min(score, 85)
    }
  }

  return {
    category: "DEADLINES",
    score,
    weight: CATEGORY_WEIGHTS.DEADLINES,
    issues,
    data: { deadlines },
  }
}

/**
 * COMPLIANCE: Maps to transaction_compliance_log and compliance_checklists
 */
async function scoreCompliance(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string,
  brokerageId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source 1: transaction_compliance_log
  const { data: complianceLog } = await supabase
    .from("transaction_compliance_log")
    .select("id, check_type, check_label, status, is_blocking, failure_reason, checked_at, resolved_at")
    .eq("transaction_id", transactionId)

  if (complianceLog && complianceLog.length > 0) {
    // Normalized status values: pending, pass, fail, waived, needs_review
    const failed = complianceLog.filter(c => c.status === "fail" || c.status === "violation")
    const blocking = complianceLog.filter(c => c.is_blocking && c.status !== "pass" && c.status !== "waived")
    const pending = complianceLog.filter(c => c.status === "pending" || c.status === "needs_review")
    
    if (blocking.length > 0) {
      issues.push(`${blocking.length} blocking compliance issue(s)`)
      score = Math.min(score, 15)
      for (const b of blocking.slice(0, 2)) {
        if (b.failure_reason) {
          issues.push(`Blocking: ${b.check_label || b.check_type} - ${b.failure_reason.substring(0, 40)}`)
        }
      }
    }
    
    if (failed.length > 0) {
      issues.push(`${failed.length} compliance check(s) failed`)
      score = Math.min(score, 35)
    }
    
    if (pending.length > 0) {
      issues.push(`${pending.length} compliance check(s) pending`)
      score = Math.min(score, 70)
    }
  }

  // Source 2: compliance_checklists (transaction-level)
  const { data: checklists } = await supabase
    .from("compliance_checklists")
    .select("id, checklist_type, items, compliance_score, ai_recommendations")
    .eq("transaction_id", transactionId)

  if (checklists && checklists.length > 0) {
    for (const checklist of checklists) {
      // Check compliance_score from checklist
      if (checklist.compliance_score !== null && checklist.compliance_score < 70) {
        issues.push(`${checklist.checklist_type} checklist score: ${checklist.compliance_score}%`)
        score = Math.min(score, checklist.compliance_score)
      }
      
      // Check individual items if available
      if (checklist.items && Array.isArray(checklist.items)) {
        // Normalized status values: completed, pass (not "passed")
        const incompleteItems = checklist.items.filter(
          (item: { status?: string; required?: boolean }) => 
            item.required && item.status !== "completed" && item.status !== "pass"
        )
        if (incompleteItems.length > 0) {
          issues.push(`${incompleteItems.length} incomplete required items in ${checklist.checklist_type}`)
          score = Math.min(score, Math.max(30, 100 - incompleteItems.length * 10))
        }
      }
    }
  }

  return {
    category: "COMPLIANCE",
    score,
    weight: CATEGORY_WEIGHTS.COMPLIANCE,
    issues,
    data: { complianceLog, checklists },
  }
}

async function scoreCommunication(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check recent activities/communications
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const { data: activities, count } = await supabase
    .from("activities")
    .select("id", { count: "exact" })
    .eq("entity_id", transactionId)
    .eq("entity_type", "transaction")
    .gte("created_at", thirtyDaysAgo.toISOString())

  if ((count ?? 0) < 3) {
    issues.push("Low communication activity in last 30 days")
    score = Math.min(score, 60)
  }

  return {
    category: "COMMUNICATION",
    score,
    weight: CATEGORY_WEIGHTS.COMMUNICATION,
    issues,
    data: { activityCount: count },
  }
}

/**
 * DOCUMENTS: Maps to transaction_documents
 */
async function scoreDocuments(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_documents
  const { data: docs } = await supabase
    .from("transaction_documents")
    .select("id, doc_type, doc_label, status, uploaded_at, storage_url, rejection_reason")
    .eq("transaction_id", transactionId)

  if (!docs || docs.length === 0) {
    issues.push("No documents uploaded")
    score = 40
  } else {
    // Check document statuses
    const rejected = docs.filter(d => d.status === "rejected")
    const pending = docs.filter(d => d.status === "pending" || d.status === "pending_review")
    const missing = docs.filter(d => !d.storage_url)
    
    if (rejected.length > 0) {
      issues.push(`${rejected.length} document(s) rejected`)
      score = Math.min(score, 30)
      // Add specific rejection reasons
      for (const doc of rejected.slice(0, 2)) {
        if (doc.rejection_reason) {
          issues.push(`"${doc.doc_label || doc.doc_type}" rejected: ${doc.rejection_reason.substring(0, 40)}`)
        }
      }
    }
    
    if (pending.length > 0) {
      issues.push(`${pending.length} document(s) pending review`)
      score = Math.min(score, 70)
    }
    
    if (missing.length > 0) {
      issues.push(`${missing.length} document(s) missing file`)
      score = Math.min(score, 50)
    }
    
    // Check for key documents (contract, disclosures)
    const docTypes = docs.map(d => d.doc_type?.toLowerCase() ?? "")
    if (!docTypes.some(t => t.includes("contract") || t.includes("purchase"))) {
      issues.push("Purchase contract not found")
      score = Math.min(score, 45)
    }
  }

  return {
    category: "DOCUMENTS",
    score,
    weight: CATEGORY_WEIGHTS.DOCUMENTS,
    issues,
    data: { documents: docs },
  }
}

/**
 * PARTICIPANTS: Maps to transaction_participants
 */
async function scoreParticipants(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Source: transaction_participants
  const { data: participants } = await supabase
    .from("transaction_participants")
    .select("id, role, name, company, email, phone, license_number")
    .eq("transaction_id", transactionId)

  if (!participants || participants.length === 0) {
    issues.push("No participants assigned to transaction")
    score = 40
  } else {
    // Check for key roles
    const roles = participants.map(p => p.role?.toLowerCase() ?? "")
    
    // Check buyer side
    const hasBuyer = roles.some(r => r.includes("buyer"))
    const hasBuyerAgent = roles.some(r => r.includes("buyer_agent") || r.includes("buyer agent"))
    if (!hasBuyer && !hasBuyerAgent) {
      issues.push("No buyer or buyer agent assigned")
      score = Math.min(score, 55)
    }
    
    // Check seller side
    const hasSeller = roles.some(r => r.includes("seller"))
    const hasListingAgent = roles.some(r => r.includes("listing_agent") || r.includes("listing agent") || r.includes("seller_agent"))
    if (!hasSeller && !hasListingAgent) {
      issues.push("No seller or listing agent assigned")
      score = Math.min(score, 55)
    }
    
    // Check contact info completeness
    const missingContact = participants.filter(p => !p.email && !p.phone)
    if (missingContact.length > 0) {
      issues.push(`${missingContact.length} participant(s) missing contact info`)
      score = Math.min(score, 75)
    }
    
    // Check for title/escrow participants
    const hasTitle = roles.some(r => r.includes("title") || r.includes("escrow") || r.includes("closing"))
    if (!hasTitle) {
      issues.push("No title/escrow officer assigned")
      score = Math.min(score, 70)
    }
  }

  return {
    category: "PARTICIPANTS",
    score,
    weight: CATEGORY_WEIGHTS.PARTICIPANTS,
    issues,
    data: { participants },
  }
}

// ─── Main Scorer ──────────────────────────────────────────────────────────────

export async function calculateDealHealth(params: {
  transactionId: string
  brokerageId:   string
}): Promise<DealHealthResult> {
  const supabase = createServiceClient()
  const { transactionId, brokerageId } = params

  // Score all 10 categories in parallel
  // Using exact data source mappings per schema source of truth
  const [
    earnestMoney,
    inspection,
    lender,
    title,
    milestones,
    deadlines,
    compliance,
    communication,
    documents,
    participants,
  ] = await Promise.all([
    scoreEarnestMoney(supabase, transactionId),      // → transaction_title_escrow.earnest_money_received_date
    scoreInspection(supabase, transactionId),        // → transaction_inspections.status
    scoreLender(supabase, transactionId),            // → transaction_lenders.clear_to_close_date, lender fields
    scoreTitle(supabase, transactionId),             // → transaction_title_escrow.title_company_name, escrow_number, dates
    scoreMilestones(supabase, transactionId),        // → transaction_milestones.milestone_name, target_date, status
    scoreDeadlines(supabase, transactionId),         // → transaction_deadlines.deadline_type, deadline_date, status
    scoreCompliance(supabase, transactionId, brokerageId), // → transaction_compliance_log, compliance_checklists
    scoreCommunication(supabase, transactionId),     // → activities
    scoreDocuments(supabase, transactionId),         // → transaction_documents
    scoreParticipants(supabase, transactionId),      // → transaction_participants
  ])

  const components: ComponentScore[] = [
    earnestMoney,
    inspection,
    lender,
    title,
    milestones,
    deadlines,
    compliance,
    communication,
    documents,
    participants,
  ]

  // Calculate weighted average
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0)
  const weightedSum = components.reduce((sum, c) => sum + c.score * c.weight, 0)
  const overallScore = Math.round(weightedSum / totalWeight)

  // Determine risk level: healthy(85+), watch(70-84), at_risk(40-69), critical(<40)
  let riskLevel: RiskLevel = "healthy"
  if (overallScore < 40) {
    riskLevel = "critical"
  } else if (overallScore < 70) {
    riskLevel = "at_risk"
  } else if (overallScore < 85) {
    riskLevel = "watch"
  }

  const calculatedAt = new Date().toISOString()

  // ─── Get previous score to detect tier changes ────────────────────────────
  const { data: previousScoreRow } = await supabase
    .from("deal_health_scores")
    .select("overall_score, risk_level, ai_narrative, previous_score, score_delta")
    .eq("transaction_id", transactionId)
    .maybeSingle()

  const previousRiskLevel = previousScoreRow?.risk_level as RiskLevel | null
  const previousOverallScore = previousScoreRow?.overall_score as number | null
  const isFirstScore = !previousScoreRow
  const tierChanged = previousRiskLevel && previousRiskLevel !== riskLevel
  const scoreDroppedMaterially = previousOverallScore !== null && (previousOverallScore - overallScore) >= 10

  // Calculate score delta
  const scoreDelta = previousOverallScore !== null ? overallScore - previousOverallScore : 0

  // ─── Generate AI narrative when: first score, tier changes, or score drops 10+ points
  let aiNarrative: string | undefined
  if (isFirstScore || tierChanged || scoreDroppedMaterially) {
    aiNarrative = await generateDealHealthNarrative({
      transactionId,
      overallScore,
      riskLevel,
      components,
      previousRiskLevel,
      previousOverallScore,
    }).catch(() => undefined)
  } else {
    aiNarrative = previousScoreRow?.ai_narrative ?? undefined
  }

  // ─── Build score_components Record<string, number> ────────────────────────
  const scoreComponents: Record<string, number> = {}
  for (const c of components) {
    scoreComponents[c.category] = c.score
  }

  // ─── Collect all flags from issues ────────────────────────────────────────
  const flags: string[] = components.flatMap(c => c.issues)

  // ═══════════════════════════════════════════════════════════════════════════
  // REQUIRED WRITE BEHAVIOR
  // ═══════════════════════════════════════════════════════════════════════════

  // 1. deal_health_scores: UPSERT by transaction_id
  await supabase.from("deal_health_scores").upsert(
    {
      transaction_id:   transactionId,
      brokerage_id:     brokerageId,
      overall_score:    overallScore,
      risk_level:       riskLevel,
      score_components: scoreComponents,
      flags:            flags,
      ai_narrative:     aiNarrative ?? null,
      previous_score:   previousOverallScore ?? null,
      score_delta:      scoreDelta,
      scored_at:        calculatedAt,
    },
    { onConflict: "transaction_id" }
  )

  // 2. transactions.health_score: UPDATE every run
  await supabase
    .from("transactions")
    .update({ health_score: overallScore })
    .eq("id", transactionId)

  // 3. deal_health_components: delete old rows, insert new run consistently
  // Generate a unique score_run_id for this scoring run
  const scoreRunId = crypto.randomUUID()

  // Delete old components for this transaction
  await supabase
    .from("deal_health_components")
    .delete()
    .eq("transaction_id", transactionId)

  // Insert new component rows with consistent score_run_id
  const componentRows = components.map(c => ({
    transaction_id:     transactionId,
    brokerage_id:       brokerageId,
    score_run_id:       scoreRunId,
    component_category: c.category,
    component_name:     c.category,
    points_earned:      c.score,
    points_possible:    100,
    pass:               c.score >= 70,
    detail:             c.issues.length > 0 ? c.issues.join("; ") : "No issues",
    scored_at:          calculatedAt,
  }))

  await supabase.from("deal_health_components").insert(componentRows)

  // ─── Emit kernel event if risk level changed ──────────────────────────────
  // emitKernelEvent does BOTH the lifecycle_events insert AND fans into the reactor (staff
  // notifications + marketing-trigger enrollment + canonical campaign_sequences enrollment +
  // client-portal cards). Bare lifecycle_events inserts silently dropped all four channels.
  if (tierChanged) {
    await emitKernelEvent({
      event:        KernelEvent.DEAL_HEALTH_CHANGED,
      brokerageId,
      entityType:   "transaction",
      entityId:     transactionId,
      transactionId,
      metadata: {
        previous_risk_level: previousRiskLevel,
        new_risk_level:      riskLevel,
        overall_score:       overallScore,
        score_delta:         scoreDelta,
      },
    })
  }

  return {
    transactionId,
    brokerageId,
    overallScore,
    riskLevel,
    components,
    calculatedAt,
    aiNarrative,
    previousScore: previousOverallScore,
    scoreDelta,
  }
}

// ─── AI Narrative Generator ───────────���───────────────────────────────────────

async function generateDealHealthNarrative(params: {
  transactionId:       string
  overallScore:        number
  riskLevel:           RiskLevel
  components:          ComponentScore[]
  previousRiskLevel?:  RiskLevel | null
  previousOverallScore?: number | null
}): Promise<string> {
  const { overallScore, riskLevel, components, previousRiskLevel, previousOverallScore } = params

  // Identify top issues
  const issueCategories = components
    .filter(c => c.issues.length > 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)

  const issuesSummary = issueCategories
    .map(c => `${c.category}: ${c.issues.join("; ")}`)
    .join("\n")

  let contextNote = ""
  if (previousRiskLevel && previousRiskLevel !== riskLevel) {
    contextNote = `Risk level changed from ${previousRiskLevel.toUpperCase()} to ${riskLevel.toUpperCase()}.`
  } else if (previousOverallScore != null && ((previousOverallScore ?? 0) - overallScore) >= 10) {
    contextNote = `Score dropped ${(previousOverallScore ?? 0) - overallScore} points from ${previousOverallScore ?? 0} to ${overallScore}.`
  } else {
    contextNote = "This is the first health score for this deal."
  }

  const prompt = `You are a real estate transaction coordinator AI. Write a 2-3 sentence summary of this deal's health status.

Deal Health Score: ${overallScore}/100
Risk Level: ${riskLevel.toUpperCase()}
${contextNote}

Top Issues:
${issuesSummary || "No major issues identified."}

Write a concise, actionable summary for the agent/broker. Focus on what needs attention.`

  try {
    const response = await gatewayChat({
      model: "anthropic/claude-sonnet-4-20250514",
      maxTokens: 200,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    })

    if (!response.ok) {
      throw new Error(`AI gateway error: ${response.error}`)
    }

    return (response.content ?? "").trim()
  } catch {
    // Fallback narrative
    const topIssue = issueCategories[0]
    if (topIssue) {
      return `Deal health is ${riskLevel.toUpperCase()} (${overallScore}/100). Primary concern: ${topIssue.category} - ${topIssue.issues[0] ?? "needs attention"}.`
    }
    return `Deal health is ${riskLevel.toUpperCase()} (${overallScore}/100). No critical issues identified.`
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { CATEGORY_WEIGHTS }
