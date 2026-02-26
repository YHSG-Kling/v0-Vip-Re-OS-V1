"use server"

import {
  logAuditEventService,
  checkComplianceStatusService,
  trackCertificationExpirationService,
  analyzeFairHousingRiskService,
  monitorTRIDComplianceService,
  applyDocumentRetentionService,
  exportAuditTrailService,
  scanContentComplianceService,
  submitContentForApprovalService,
  reviewContentApprovalService,
  logCommunicationWithComplianceService,
  getApprovedContentLibraryService,
  getPendingApprovalsService,
  getComplianceViolationsService,
  generateComplianceReportService,
  createTRIDTimelineService,
  updateTRIDMilestoneService,
} from "@/lib/application/compliance-monitoring"
import { isValidUUID } from "@/lib/validations"

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
  if (!params.userId || !params.action || !params.entityType || !params.entityId) {
    throw new Error("userId, action, entityType and entityId are required")
  }
  return logAuditEventService(params)
}

// Check compliance status for a transaction
export async function checkComplianceStatus(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  return checkComplianceStatusService(transactionId)
}

// Track agent certification expiration
export async function trackCertificationExpiration(agentId: string) {
  if (!isValidUUID(agentId)) throw new Error("Invalid agent ID")
  return trackCertificationExpirationService(agentId)
}

// Analyze fair housing risk with AI
export async function analyzeFairHousingRisk(params: {
  contactId: string
  agentId: string
  interactionType: string
  communicationText: string
}) {
  if (!isValidUUID(params.contactId)) throw new Error("Invalid contact ID")
  if (!isValidUUID(params.agentId))  throw new Error("Invalid agent ID")
  if (!params.communicationText?.trim()) throw new Error("communicationText is required")
  return analyzeFairHousingRiskService(params)
}

// Monitor TRID compliance
export async function monitorTRIDCompliance(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  return monitorTRIDComplianceService(transactionId)
}

// Apply document retention policies
export async function applyDocumentRetention(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  return applyDocumentRetentionService(transactionId)
}

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
  return submitContentForApprovalService(data)
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
  return reviewContentApprovalService(data)
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
  if (!data.userId)           throw new Error("userId is required")
  if (!data.communicationType) throw new Error("communicationType is required")
  if (!data.leadTemperature)   throw new Error("leadTemperature is required")
  return logCommunicationWithComplianceService(data)
}

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
  return createTRIDTimelineService(transactionId)
}

// Update TRID milestone
export async function updateTRIDMilestone(params: {
  transactionId: string
  milestone: string
  date: string
}) {
  if (!isValidUUID(params.transactionId)) throw new Error("Invalid transaction ID")
  if (!params.milestone)                   throw new Error("milestone is required")
  if (!params.date)                        throw new Error("date is required")
  return updateTRIDMilestoneService(params)
}
