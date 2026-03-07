/**
 * Deal Health Scorer — Layer 6 Transaction Orchestration
 * 
 * Computes a rollup health score (0-100) for transactions and writes:
 *   - deal_health_scores: aggregated score + risk level
 *   - deal_health_components: per-factor breakdown (9 categories, expandable to 47-factor model)
 * 
 * Categories (initial 9):
 *   EARNEST_MONEY, INSPECTION, LENDER, TITLE, MILESTONES,
 *   COMPLIANCE, COMMUNICATION, DOCUMENTS, PARTICIPANTS
 */

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent }         from "@/lib/kernel/events"

// ─── Types ────────────────────────────────────────────────────────────────────

export type HealthCategory =
  | "EARNEST_MONEY"
  | "INSPECTION"
  | "LENDER"
  | "TITLE"
  | "MILESTONES"
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

export interface DealHealthResult {
  transactionId:   string
  brokerageId:     string
  overallScore:    number       // 0-100 weighted average
  riskLevel:       RiskLevel
  components:      ComponentScore[]
  calculatedAt:    string
  aiNarrative?:    string       // Generated when tier changes or first score
}

// ─── Category Weights (sum = 100) ─────────────────────────────────────────────

const CATEGORY_WEIGHTS: Record<HealthCategory, number> = {
  EARNEST_MONEY:   15,
  INSPECTION:      12,
  LENDER:          15,
  TITLE:           10,
  MILESTONES:      12,
  COMPLIANCE:      12,
  COMMUNICATION:    8,
  DOCUMENTS:       10,
  PARTICIPANTS:     6,
}

// ─── Scorer Functions ─────────────────────────────────────────────────────────

async function scoreEarnestMoney(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check earnest_money_deposits for this transaction
  const { data: deposits } = await supabase
    .from("earnest_money_deposits")
    .select("id, status, amount, due_date, received_date")
    .eq("transaction_id", transactionId)

  if (!deposits || deposits.length === 0) {
    issues.push("No earnest money deposit recorded")
    score = 30
  } else {
    for (const dep of deposits) {
      if (dep.status === "pending" && dep.due_date) {
        const due = new Date(dep.due_date)
        const now = new Date()
        if (due < now) {
          issues.push(`Earnest money overdue since ${dep.due_date}`)
          score = Math.min(score, 20)
        } else {
          const daysUntilDue = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          if (daysUntilDue <= 2) {
            issues.push(`Earnest money due in ${daysUntilDue} day(s)`)
            score = Math.min(score, 60)
          }
        }
      } else if (dep.status === "received") {
        // Good
      } else if (dep.status === "failed" || dep.status === "bounced") {
        issues.push(`Earnest money ${dep.status}`)
        score = Math.min(score, 10)
      }
    }
  }

  return {
    category: "EARNEST_MONEY",
    score,
    weight: CATEGORY_WEIGHTS.EARNEST_MONEY,
    issues,
    data: { deposits },
  }
}

async function scoreInspection(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check milestones for inspection-related items
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, name, due_date, completed_at")
    .eq("transaction_id", transactionId)
    .ilike("name", "%inspection%")

  const now = new Date()
  for (const m of milestones ?? []) {
    if (!m.completed_at && m.due_date) {
      const due = new Date(m.due_date)
      if (due < now) {
        issues.push(`Inspection milestone "${m.name}" overdue`)
        score = Math.min(score, 30)
      }
    }
  }

  // Check documents for inspection report
  const { data: docs } = await supabase
    .from("documents")
    .select("id, doc_type, status")
    .eq("transaction_id", transactionId)
    .eq("doc_type", "inspection_report")

  if (!docs || docs.length === 0) {
    issues.push("No inspection report uploaded")
    score = Math.min(score, 70)
  }

  return {
    category: "INSPECTION",
    score,
    weight: CATEGORY_WEIGHTS.INSPECTION,
    issues,
    data: { milestones, docs },
  }
}

async function scoreLender(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check for lender-related milestones
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, name, due_date, completed_at")
    .eq("transaction_id", transactionId)
    .or("name.ilike.%appraisal%,name.ilike.%loan%,name.ilike.%financing%,name.ilike.%clear to close%")

  const now = new Date()
  for (const m of milestones ?? []) {
    if (!m.completed_at && m.due_date) {
      const due = new Date(m.due_date)
      if (due < now) {
        issues.push(`Lender milestone "${m.name}" overdue`)
        score = Math.min(score, 25)
      }
    }
  }

  // Check for clear to close document
  const { data: ctcDoc } = await supabase
    .from("documents")
    .select("id")
    .eq("transaction_id", transactionId)
    .eq("doc_type", "clear_to_close_letter")
    .maybeSingle()

  if (!ctcDoc) {
    // Not critical until late stages, minor deduction
    score = Math.min(score, 90)
  }

  return {
    category: "LENDER",
    score,
    weight: CATEGORY_WEIGHTS.LENDER,
    issues,
    data: { milestones },
  }
}

async function scoreTitle(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check for title-related documents
  const { data: titleDocs } = await supabase
    .from("documents")
    .select("id, doc_type, status")
    .eq("transaction_id", transactionId)
    .in("doc_type", ["title_commitment", "title_search", "title_insurance"])

  if (!titleDocs || titleDocs.length === 0) {
    issues.push("No title documents uploaded")
    score = Math.min(score, 70)
  }

  // Check milestones
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, name, due_date, completed_at")
    .eq("transaction_id", transactionId)
    .ilike("name", "%title%")

  const now = new Date()
  for (const m of milestones ?? []) {
    if (!m.completed_at && m.due_date && new Date(m.due_date) < now) {
      issues.push(`Title milestone "${m.name}" overdue`)
      score = Math.min(score, 40)
    }
  }

  return {
    category: "TITLE",
    score,
    weight: CATEGORY_WEIGHTS.TITLE,
    issues,
    data: { titleDocs, milestones },
  }
}

async function scoreMilestones(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, name, due_date, completed_at")
    .eq("transaction_id", transactionId)

  if (!milestones || milestones.length === 0) {
    issues.push("No milestones defined")
    score = 50
  } else {
    const now = new Date()
    let overdueCount = 0
    let totalIncomplete = 0

    for (const m of milestones) {
      if (!m.completed_at) {
        totalIncomplete++
        if (m.due_date && new Date(m.due_date) < now) {
          overdueCount++
        }
      }
    }

    if (overdueCount > 0) {
      issues.push(`${overdueCount} milestone(s) overdue`)
      score = Math.max(20, 100 - overdueCount * 20)
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

async function scoreCompliance(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string,
  contactId: string | null
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check compliance_checklists for this transaction
  const { data: checklists } = await supabase
    .from("compliance_checklists")
    .select("id, item_name, status, is_required")
    .eq("transaction_id", transactionId)
    .eq("is_required", true)

  const incomplete = (checklists ?? []).filter(c => c.status !== "completed" && c.status !== "passed")
  if (incomplete.length > 0) {
    issues.push(`${incomplete.length} required compliance item(s) incomplete`)
    score = Math.max(30, 100 - incomplete.length * 15)
  }

  // Check compliance_flags by contact linkage
  if (contactId) {
    const { data: flags } = await supabase
      .from("compliance_flags")
      .select("id, flag_type, severity, status")
      .eq("contact_id", contactId)
      .in("status", ["unresolved", "flagged"])

    const dealBreakers = (flags ?? []).filter(f => f.severity === "deal_breaker")
    if (dealBreakers.length > 0) {
      issues.push(`${dealBreakers.length} deal-breaker compliance flag(s)`)
      score = Math.min(score, 10)
    }

    const warnings = (flags ?? []).filter(f => f.severity === "warning")
    if (warnings.length > 0) {
      issues.push(`${warnings.length} warning-level compliance flag(s)`)
      score = Math.min(score, 60)
    }
  }

  return {
    category: "COMPLIANCE",
    score,
    weight: CATEGORY_WEIGHTS.COMPLIANCE,
    issues,
    data: { checklists, contactId },
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

async function scoreDocuments(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check document_checklist for required but missing documents
  const { data: checklist } = await supabase
    .from("document_checklist")
    .select("id, document_name, status, is_required")
    .eq("transaction_id", transactionId)
    .eq("is_required", true)

  const missing = (checklist ?? []).filter(d => d.status !== "received" && d.status !== "approved")
  if (missing.length > 0) {
    issues.push(`${missing.length} required document(s) missing or pending`)
    score = Math.max(30, 100 - missing.length * 10)
  }

  return {
    category: "DOCUMENTS",
    score,
    weight: CATEGORY_WEIGHTS.DOCUMENTS,
    issues,
    data: { checklist },
  }
}

async function scoreParticipants(
  supabase: ReturnType<typeof createServiceClient>,
  transactionId: string
): Promise<ComponentScore> {
  const issues: string[] = []
  let score = 100

  // Check transaction_participants
  const { data: participants } = await supabase
    .from("transaction_participants")
    .select("id, role, user_id, contact_id, status")
    .eq("transaction_id", transactionId)

  if (!participants || participants.length === 0) {
    issues.push("No participants assigned to transaction")
    score = 40
  } else {
    // Check for key roles
    const roles = participants.map(p => p.role?.toLowerCase())
    if (!roles.includes("buyer") && !roles.includes("buyer_agent")) {
      issues.push("No buyer/buyer agent assigned")
      score = Math.min(score, 60)
    }
    if (!roles.includes("seller") && !roles.includes("listing_agent")) {
      issues.push("No seller/listing agent assigned")
      score = Math.min(score, 60)
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
  contactId?:    string | null
}): Promise<DealHealthResult> {
  const supabase = createServiceClient()
  const { transactionId, brokerageId } = params

  // Get contact_id if not provided
  let contactId = params.contactId ?? null
  if (!contactId) {
    const { data: txn } = await supabase
      .from("transactions")
      .select("contact_id")
      .eq("id", transactionId)
      .maybeSingle()
    contactId = txn?.contact_id ?? null
  }

  // Score all categories in parallel
  const [
    earnestMoney,
    inspection,
    lender,
    title,
    milestones,
    compliance,
    communication,
    documents,
    participants,
  ] = await Promise.all([
    scoreEarnestMoney(supabase, transactionId),
    scoreInspection(supabase, transactionId),
    scoreLender(supabase, transactionId),
    scoreTitle(supabase, transactionId),
    scoreMilestones(supabase, transactionId),
    scoreCompliance(supabase, transactionId, contactId),
    scoreCommunication(supabase, transactionId),
    scoreDocuments(supabase, transactionId),
    scoreParticipants(supabase, transactionId),
  ])

  const components: ComponentScore[] = [
    earnestMoney,
    inspection,
    lender,
    title,
    milestones,
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
    .select("overall_score, risk_level, ai_narrative")
    .eq("transaction_id", transactionId)
    .maybeSingle()

  const previousRiskLevel = previousScoreRow?.risk_level as RiskLevel | null
  const previousOverallScore = previousScoreRow?.overall_score as number | null
  const isFirstScore = !previousScoreRow
  const tierChanged = previousRiskLevel && previousRiskLevel !== riskLevel
  const scoreDroppedMaterially = previousOverallScore !== null && (previousOverallScore - overallScore) >= 10

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

  // ─── Persist to deal_health_scores ────────────────────────────────────────
  await supabase.from("deal_health_scores").upsert(
    {
      transaction_id: transactionId,
      brokerage_id:   brokerageId,
      overall_score:  overallScore,
      risk_level:     riskLevel,
      calculated_at:  calculatedAt,
      ai_narrative:   aiNarrative ?? null,
    },
    { onConflict: "transaction_id" }
  )

  // ─── UPDATE transactions.health_score ─────────────────────────────────────
  await supabase
    .from("transactions")
    .update({ health_score: overallScore })
    .eq("id", transactionId)

  // ─── Persist per-factor rows to deal_health_components ────────────────────
  const componentRows = components.map(c => ({
    transaction_id: transactionId,
    brokerage_id:   brokerageId,
    category:       c.category,
    score:          c.score,
    weight:         c.weight,
    issues:         c.issues,
    data:           c.data,
    calculated_at:  calculatedAt,
  }))

  // Delete old components then insert new (full refresh)
  await supabase
    .from("deal_health_components")
    .delete()
    .eq("transaction_id", transactionId)

  await supabase.from("deal_health_components").insert(componentRows)

  // ─── Emit kernel event if risk level changed ──────────────────────────────
  if (tierChanged) {
    await supabase.from("lifecycle_events").insert({
      brokerage_id:  brokerageId,
      entity_type:   "transaction",
      entity_id:     transactionId,
      event_type:    KernelEvent.DEAL_HEALTH_CHANGED,
      metadata:      {
        previous_risk_level: previousRiskLevel,
        new_risk_level:      riskLevel,
        overall_score:       overallScore,
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
  }
}

// ─── AI Narrative Generator ───────────────────────────────────────────────────

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
  } else if (previousOverallScore !== null && (previousOverallScore - overallScore) >= 10) {
    contextNote = `Score dropped ${previousOverallScore - overallScore} points from ${previousOverallScore} to ${overallScore}.`
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
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    })

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const text = data.content?.[0]?.text ?? ""
    return text.trim()
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

export { CATEGORY_WEIGHTS, type RiskLevel }
