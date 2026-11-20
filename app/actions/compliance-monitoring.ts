"use server"

// Imported from the defining modules, not the barrel (wave 143): the barrel re-exports siblings this action never calls, and every app entry that reaches this action compiled them — test:proxy-graph-budget counts the server graph.
import { analyzeFairHousingRiskService, checkComplianceStatusService, resolveComplianceAlertService, resolveCompRiskFlagService, trackCertificationExpirationService, monitorTRIDComplianceService, exportAuditTrailService, scanContentComplianceService, submitContentForApprovalService, reviewContentApprovalService, getApprovedContentLibraryService, getPendingApprovalsService, getComplianceViolationsService, generateComplianceReportService, createTRIDTimelineService, updateTRIDMilestoneService } from "@/lib/application/compliance-monitoring"
import {
  FAIR_HOUSING_INTERACTION_TYPES,
  type FairHousingInteractionType,
} from "@/lib/application/compliance-monitoring"
import { isValidUUID } from "@/lib/validations"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * WAVE 155 (lane 155S2): THE GATE for the three TRID exports (monitor / create timeline / update milestone). They are
 * public endpoints that read no session and wrote trid_timeline rows by a transaction id alone (RLS the only fence). Now:
 * a session with a tenant, and the deal must be that tenant's (a tenant predicate on the read — another tenant's id finds
 * nothing) BEFORE the service runs. Throws, the convention of every export in this file. Not exported ("use server").
 * @proofSeam scripts/wave155-ungated-deal-guard.ts
 */
async function requireSessionDeal(transactionId: string) {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const session = await getAgentContext()
  if (!session.isAuthenticated || !session.brokerageId) throw new Error("Unauthorized")
  const { createClient } = await import("@/lib/supabase/server")
  const sb = await createClient()
  const { data, error } = await sb.from("transactions").select("id").eq("id", transactionId).eq("brokerage_id", session.brokerageId).maybeSingle()
  if (error) throw new Error("Could not verify that transaction")
  if (!data) throw new Error("Transaction not found")
  return session
}

// TOMBSTONE (§1, lane E2 2026-08-28) — `logAuditEvent` deleted. Audit logging
// lives at the call sites as direct `supabase.from("audit_log").insert(...)`
// writes (e.g. app/actions/billing.ts:633, lib/kernel/transactions.ts:1457,
// app/actions/tenant-sso.ts:115) and, for session-derived user activity, at
// app/actions/workflows.ts:logUserActivity. This wrapper had zero callers
// outside the app/actions/index.ts barrel (itself importer-less) and was also
// the §4 anti-shape: a public "use server" endpoint accepting a caller-supplied
// userId/ip/UA as audit truth — any authenticated session could write audit
// rows attributed to anyone.

// Check compliance status for a transaction
export async function checkComplianceStatus(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  return checkComplianceStatusService(transactionId)
}

/**
 * Clear one compliance alert — the half `checkComplianceStatus` was missing.
 *
 * Its `overallStatus` reads `resolved = false` and nothing in the tree ever set
 * that column true, so a transaction that raised a single alert was 'at_risk'
 * permanently. Identity and tenant come from the SESSION inside the service; the
 * only thing this endpoint accepts is which alert and what the person did.
 */
export async function resolveComplianceAlert(params: { alertId: string; note?: string }) {
  if (!isValidUUID(params.alertId)) throw new Error("Invalid alert ID")
  return resolveComplianceAlertService(params)
}

/** Clear one comp risk flag on a CMA — the same missing half on the listing side. */
export async function resolveCompRiskFlag(params: { flagId: string; note?: string }) {
  if (!isValidUUID(params.flagId)) throw new Error("Invalid flag ID")
  return resolveCompRiskFlagService(params)
}

// Track agent certification expiration
export async function trackCertificationExpiration(agentId: string) {
  if (!isValidUUID(agentId)) throw new Error("Invalid agent ID")
  return trackCertificationExpirationService(agentId)
}

// RESTORED (owner ruling, lane F2 2026-08-28) — `analyzeFairHousingRisk` is
// back. The earlier deletion note (lane E2 2026-08-28) called it a fourth
// spelling of the three wired scanners, but on the owner's
// compare-the-process rule it is not: checkCompliance gates AI GENERATIONS,
// evaluateOutboundCompliance gates OUTBOUND SENDS, scanContentCompliance
// scans MARKETING CONTENT for approval — none of them is a CONTACT-LINKED
// POST-HOC review of a communication that already happened, filed against
// that contact and agent for coaching/audit. Identity and tenant come from
// the SESSION inside the service (§4); the caller supplies only which
// contact, what kind of communication, and the text. Findings land as ONE
// compliance_flags row (status 'flagged') — the queue the compliance command
// center lists and resolves. Wired at the Communication Intelligence
// Risk & Compliance tab (fair-housing-review-card.tsx).
export async function analyzeFairHousingRisk(params: {
  contactId: string
  interactionType: FairHousingInteractionType
  communicationText: string
}) {
  if (!isValidUUID(params.contactId)) throw new Error("Invalid contact ID")
  if (!params.communicationText?.trim()) throw new Error("communicationText is required")
  if (!FAIR_HOUSING_INTERACTION_TYPES.includes(params.interactionType)) {
    throw new Error("Unknown interaction type")
  }
  return analyzeFairHousingRiskService(params)
}

// Monitor TRID compliance
export async function monitorTRIDCompliance(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  const session = await requireSessionDeal(transactionId)
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const { resultFamily } = await import("@/lib/kernel/action-ledger")
  return resultFamily(await ledgerSessionAction({ brokerageId: session.brokerageId ?? "", action: "compliance.trid.monitor", actor: { type: "user", userId: session.userId || null, agentId: session.agentId ?? null }, subject: { type: "transaction", id: transactionId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async () => {
  return monitorTRIDComplianceService(transactionId)
  }))
}

// TOMBSTONE (§1, lane E2 2026-08-28) — the `applyDocumentRetention` action
// wrapper was deleted; the CAPABILITY was wired instead of the paper door.
// SURVIVOR: lib/application/compliance-monitoring.ts:applyDocumentRetentionService,
// now reached from the daily compliance cron
// (app/api/cron/compliance-monitoring/route.ts), which sweeps recently closed
// transactions and stamps document_retention rows automatically. Retention is
// a records-law obligation (§5: real-estate records are kept), so it must not
// depend on a human remembering to press a button; the census found this
// wrapper had zero callers outside the importer-less app/actions/index.ts
// barrel, i.e. retention had never run at all.

// Export audit trail
export async function exportAuditTrail(params: {
  transactionId?: string
  startDate: string
  endDate: string
}) {
  if (!params.startDate || !params.endDate) throw new Error("startDate and endDate are required")
  if (params.transactionId && !isValidUUID(params.transactionId)) throw new Error("Invalid transaction ID")
  return exportAuditTrailService(params)
}

// Auto-scan content for compliance issues
export async function scanContentCompliance(content: {
  contentBody: string
  contentType: string
  targetAudience: string
  distributionChannels: string[]
  agentState: string
}) {
  if (!content.contentBody?.trim()) throw new Error("contentBody is required")
  if (!content.contentType)        throw new Error("contentType is required")
  if (!content.targetAudience)     throw new Error("targetAudience is required")
  return scanContentComplianceService(content)
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
  if (!data.userId)        throw new Error("userId is required")
  if (!data.contentBody?.trim())  throw new Error("contentBody is required")
  if (!data.contentTitle?.trim()) throw new Error("contentTitle is required")
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const session = await getAgentContext()
  // WAVE 155 (lane 155S2): THE GATE. The submitter recorded on the approval row (activities.agent_user_id, and its tenant)
  // came from the BODY — anyone could file content in another person's name. The submitter is the SESSION user; a body
  // userId naming someone else is refused; the agent on the row is the session's own (or none).
  if (!session.isAuthenticated || !session.brokerageId || !session.userId) throw new Error("Unauthorized")
  if (data.userId !== session.userId) throw new Error("Forbidden: content is submitted in your own name")
  const submission = { ...data, userId: session.userId, agentId: session.agentId ?? undefined }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return await ledgerSessionAction({ brokerageId: session.brokerageId, action: "compliance.content_approval.submit", actor: { type: "user", userId: session.userId, agentId: session.agentId ?? null }, subject: { type: "users", id: session.userId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { content_type: data.contentType } }, async () => {
  return submitContentForApprovalService(submission)
  })
}

// Approve/reject content (compliance admin action)
export async function reviewContentApproval(data: {
  approvalId: string
  reviewerId: string
  status: "approved" | "rejected" | "needs_revision"
  reviewNotes?: string
  expiresInDays?: number
}) {
  if (!isValidUUID(data.approvalId))  throw new Error("Invalid approval ID")
  if (!isValidUUID(data.reviewerId))  throw new Error("Invalid reviewer ID")
  if (!data.status)                    throw new Error("status is required")
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const session = await getAgentContext()
  // WAVE 155 (lane 155S2): THE GATE. A LEGAL approval decision whose reviewer (metadata.reviewed_by, and the approved
  // library row's created_by) came from the BODY, on an approval keyed by id alone, open to any seat. Now: the reviewer is
  // the SESSION user (a body reviewerId naming someone else is refused); the reviewer holds the tenant roster
  // (isAdminOrBroker → TENANT_ADMIN_USER_TYPES: brokers, admin, team lead, compliance officer); and the approval row must
  // be the session tenant's — another tenant's approval id finds nothing.
  if (!session.isAuthenticated || !session.brokerageId || !session.userId) throw new Error("Unauthorized")
  if (data.reviewerId !== session.userId) throw new Error("Forbidden: you review content as yourself")
  if (!isAdminOrBroker({ user_type: session.userType })) throw new Error("Forbidden: only your brokerage's reviewers may decide content approvals")
  const { createClient } = await import("@/lib/supabase/server")
  const sb = await createClient()
  const { data: approvalRow, error: approvalError } = await sb.from("activities").select("id").eq("id", data.approvalId).eq("brokerage_id", session.brokerageId).maybeSingle()
  if (approvalError) throw new Error("Could not verify that approval")
  if (!approvalRow) throw new Error("Approval not found")
  const decision = { ...data, reviewerId: session.userId }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return await ledgerSessionAction({ brokerageId: session.brokerageId, action: "compliance.content_approval.review", actor: { type: "user", userId: session.userId, agentId: session.agentId ?? null }, subject: { type: "content_approval", id: data.approvalId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED", detail: { decision: data.status } }, async () => {
  return reviewContentApprovalService(decision)
  })
}

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `logCommunicationWithCompliance`
// deleted. SURVIVOR: lib/services/communication.service.tsx:logCommunication,
// the communication_audit_log writer that real sends actually reach. What this
// orphan had that the survivor lacked was MERGED onto the survivor first:
// lead_temperature + was_approved_content on the audit row, and the cold-lead
// channel rule (compliance_passed=false + a compliance_flags row when a cold
// lead is reached outside email/print) — the exact columns the daily
// compliance cron's cold-lead and unapproved-content sweeps read, which could
// match nothing while their only writer was this uncalled wrapper. A
// stripped-source census found zero callers outside the app/actions/index.ts
// barrel, which itself has zero importers.

// Get approved content library
export async function getApprovedContentLibrary(filters?: {
  category?: string
  channel?: string
  leadType?: string
}) {
  return getApprovedContentLibraryService(filters)
}

// Get pending approvals (for compliance reviewers)
export async function getPendingApprovals() {
  return getPendingApprovalsService()
}

// Get compliance violations dashboard
export async function getComplianceViolations(agentId?: string, userId?: string) {
  if (agentId && !isValidUUID(agentId)) throw new Error("Invalid agent ID")
  if (userId  && !isValidUUID(userId))  throw new Error("Invalid user ID")
  return getComplianceViolationsService(agentId, userId)
}

// Generate compliance report
export async function generateComplianceReport(filters: {
  startDate: string
  endDate: string
  agentId?: string
  userId?: string
}) {
  if (!filters.startDate || !filters.endDate) throw new Error("startDate and endDate are required")
  if (filters.agentId && !isValidUUID(filters.agentId)) throw new Error("Invalid agent ID")
  if (filters.userId  && !isValidUUID(filters.userId))  throw new Error("Invalid user ID")
  return generateComplianceReportService(filters)
}

// Create TRID timeline for transaction
export async function createTRIDTimeline(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  const session = await requireSessionDeal(transactionId)
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return await ledgerSessionAction({ brokerageId: session.brokerageId ?? "", action: "compliance.trid_timeline.create", actor: { type: "user", userId: session.userId || null, agentId: session.agentId ?? null }, subject: { type: "transaction", id: transactionId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED" }, async () => {
  return createTRIDTimelineService(transactionId)
  })
}

// The four date columns a TRID milestone may write. The service applies
// `updateData[milestone] = date` — an unconstrained column name here would let
// a caller write compliance_status or violations directly, so the vocabulary
// is closed at the door (lane E2 2026-08-28, hardened while wiring the
// transaction compliance tab's milestone dialog to this action).
// NOT exported as a value: "use server" files may only export async functions.
//
// TOMBSTONE (wave 153, lane 153C): `closing_disclosure_delivered_date` is NO LONGER a typed milestone. A date somebody types is
// not the buyer's RECEIPT of the Closing Disclosure (owner: "trid is determined from the lender … if lender isn't on the platform,
// the agent needs to find out from the lender and then mark the timeline"). SURVIVOR: the receipt ledger —
// app/actions/trid-disclosure-receipt.ts (lender-confirmed / agent-reported-pending / compliance-verified) →
// lib/compliance/trid-disclosure-clock-evidence.ts recordTridReceiptEvidence, which alone mirrors the lender-verified effective
// receipt into trid_timeline.closing_disclosure_delivered_date.
const TRID_MILESTONES = [
  "loan_application_date",
  "loan_estimate_delivered_date",
  "scheduled_close_date",
] as const
export type TridMilestone = (typeof TRID_MILESTONES)[number]

// Update TRID milestone
export async function updateTRIDMilestone(params: {
  transactionId: string
  milestone: TridMilestone
  date: string
}) {
  if (!isValidUUID(params.transactionId)) throw new Error("Invalid transaction ID")
  if ((params.milestone as string) === "closing_disclosure_delivered_date") {
    throw new Error("The Closing Disclosure's receipt is recorded from the lender's evidence on the deal's Closing Disclosure panel — a typed date does not start the waiting period.")
  }
  if (!TRID_MILESTONES.includes(params.milestone as TridMilestone)) throw new Error("Unknown TRID milestone")
  if (!params.date)                        throw new Error("date is required")
  const session = await requireSessionDeal(params.transactionId)
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return await ledgerSessionAction({ brokerageId: session.brokerageId ?? "", action: "compliance.trid_milestone.update", actor: { type: "user", userId: session.userId || null, agentId: session.agentId ?? null }, subject: { type: "transaction", id: params.transactionId }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED", detail: { milestone: params.milestone } }, async () => {
  return updateTRIDMilestoneService(params)
  })
}
