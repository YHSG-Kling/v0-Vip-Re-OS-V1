"use server"

import { isValidUUID } from "@/lib/validations"
import * as TransactionKernel from "@/lib/kernel/transactions"
import * as TransactionService from "@/lib/application/transactions"

// ============================================
// TRANSACTION CRUD
// ============================================

export async function getTransactions(filters?: {
  status?: string
  agent_id?: string
  agentId?: string
  brokerage_id?: string
}) {
  const agentIdValue = filters?.agent_id || filters?.agentId
  if (agentIdValue && !isValidUUID(agentIdValue)) {
    console.warn("[transactions.ts] getTransactions called with invalid UUID:", agentIdValue)
    return []
  }
  // Use application service for now - kernel doesn't have direct list function
  // TODO: Migrate to kernel when loadTransactionWorkspace is refactored for listing
  return TransactionService.getTransactions(filters)
}

export async function getTransactionById(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.getTransactionById(transactionId)
}

export async function createTransaction(transactionData: {
  property_address: string
  property_city?: string
  property_state?: string  // 2-letter US state code, e.g. "FL", "CA", "TX"
  property_zip?: string
  transaction_type: "purchase" | "sale" | "lease" | "dual"
  status?: string
  contract_price?: number
  listing_price?: number
  client_name?: string
  client_email?: string
  client_phone?: string
  agent_id?: string
  close_date?: string
  notes?: string
  commissionPercentage?: number
}) {
  if (!transactionData.property_address?.trim()) return { success: false, error: "Property address is required" }
  return TransactionService.createTransaction(transactionData)
}

export async function updateTransaction(
  transactionId: string,
  updates: Partial<{
    property_address: string
    property_city: string
    property_state: string
    property_zip: string
    transaction_type: string
    status: string
    contract_price: number
    listing_price: number
    client_name: string
    client_email: string
    client_phone: string
    agent_id: string
    contract_date: string
    close_date: string
    notes: string
    commissionPercentage: number
  }>,
) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.updateTransaction(transactionId, updates)
}

// ============================================
// MILESTONES
// ============================================

export async function generateMilestones(transactionId: string, transactionType: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.generateMilestones(transactionId, transactionType)
}

export async function completeMilestone(milestoneId: string, completedBy?: string, notes?: string) {
  if (!isValidUUID(milestoneId)) return { success: false, error: "Invalid milestone ID" }
  return TransactionService.completeMilestone(milestoneId, completedBy, notes)
}

export async function getTransactionMilestones(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.getTransactionMilestones(transactionId)
}

export async function updateMilestone(
  milestoneId: string,
  updates: Partial<{ status: string; due_date: string; notes: string; assigned_to: string }>,
) {
  if (!isValidUUID(milestoneId)) return { success: false, error: "Invalid milestone ID" }
  return TransactionService.updateMilestone(milestoneId, updates)
}

/**
 * Set whether a milestone is visible to the client in the portal.
 * Writes to transaction_milestones.is_client_visible (live schema column).
 */
export async function setMilestoneClientVisibility(
  milestoneId: string,
  isVisible: boolean,
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(milestoneId)) return { success: false, error: "Invalid milestone ID" }
  return TransactionService.updateMilestone(milestoneId, { is_client_visible: isVisible } as any)
}

export async function getClosingChecklist(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.getClosingChecklist(transactionId)
}

// ============================================
// TRANSACTION LIFECYCLE — CLOSE / REOPEN / CLOSE PREP
// ============================================

/**
 * Close a transaction. Sets status=closed, stage=CLOSED, close_date to today if not set.
 * Writes a timeline entry and emits lifecycle_events record.
 */
export async function closeTransaction(params: {
  transactionId: string
  brokerageId: string
  agentId: string
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  if (!isValidUUID(params.brokerageId)) return { success: false, error: "Invalid brokerage ID" }

  const { closeTransactionCommand } = await import("@/lib/kernel/transactions")
  return closeTransactionCommand(params)
}

/**
 * Reopen a closed transaction. Requires broker/admin role.
 * Sets status=active, stage=CLOSING_PREP, writes audit trail.
 */
export async function reopenTransactionIfAuthorized(params: {
  transactionId: string
  brokerageId: string
  requestingUserId: string
  requestingUserRole: string
  reason: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  if (!["broker", "admin"].includes(params.requestingUserRole)) {
    return { success: false, error: "Only brokers and admins can reopen transactions." }
  }

  const { reopenTransactionCommand } = await import("@/lib/kernel/transactions")
  return reopenTransactionCommand(params)
}

// ============================================
// COMMISSIONS
// ============================================

/**
 * Recalculate commission state from agent_commission_profiles and transaction purchase_price.
 * Upserts transaction_commissions rows and writes commission_calculations record.
 */
export async function recalculateCommissionState(params: {
  transactionId: string
  brokerageId: string
  agentId: string
}): Promise<{ success: boolean; error?: string; data?: unknown }> {
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }

  const { recalculateCommissionStateCommand } = await import("@/lib/kernel/transactions")
  return recalculateCommissionStateCommand(params)
}

// ============================================
// CLIENT COMMUNICATIONS
// ============================================

/**
 * Emit a client-friendly plain-language update to the portal and client_friendly_updates table.
 * Respects channel eligibility and consent before any send.
 */
export async function emitClientFriendlyUpdate(params: {
  transactionId: string
  brokerageId: string
  agentId: string
  contactId: string
  updateType: string
  updateText: string
  tone?: string
  sendVia?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  if (!isValidUUID(params.contactId)) return { success: false, error: "Invalid contact ID" }

  const { emitClientFriendlyUpdateCommand } = await import("@/lib/kernel/transactions")
  return emitClientFriendlyUpdateCommand(params)
}

export async function updateChecklistItem(itemId: string, completed: boolean) {
  if (!isValidUUID(itemId)) return { success: false, error: "Invalid item ID" }
  return TransactionService.updateChecklistItem(itemId, completed)
}

// ============================================
// PARTICIPANTS
// ============================================

export async function addParticipant(participantData: {
  transaction_id: string
  role: string
  name: string
  company?: string
  email?: string
  phone?: string
  license_number?: string
  notes?: string
}) {
  if (!isValidUUID(participantData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addParticipant(participantData)
}

export async function updateParticipant(
  participantId: string,
  updates: Partial<{
    role: string; name: string; company: string; email: string
    phone: string; license_number: string; notes: string
  }>,
) {
  if (!isValidUUID(participantId)) return { success: false, error: "Invalid participant ID" }
  return TransactionService.updateParticipant(participantId, updates)
}

export async function removeParticipant(participantId: string) {
  if (!isValidUUID(participantId)) return { success: false, error: "Invalid participant ID" }
  return TransactionService.removeParticipant(participantId)
}

// ============================================
// LENDERS
// ============================================

export async function addLender(lenderData: {
  transaction_id: string
  lender_name: string
  loan_officer_name?: string
  loan_officer_email?: string
  loan_officer_phone?: string
  loan_type?: string
  loan_amount?: number
  interest_rate?: number
  loan_term_years?: number
  pre_approval_date?: string
  pre_approval_amount?: number
  appraisal_ordered_date?: string
  appraisal_completed_date?: string
  appraisal_value?: number
  underwriting_status?: string
  clear_to_close_date?: string
  notes?: string
}) {
  if (!isValidUUID(lenderData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addLender(lenderData)
}

export async function updateLender(
  lenderId: string,
  updates: Partial<{
    lender_name: string; loan_officer_name: string; loan_officer_email: string
    loan_officer_phone: string; loan_type: string; loan_amount: number
    interest_rate: number; loan_term_years: number; pre_approval_date: string
    pre_approval_amount: number; appraisal_ordered_date: string
    appraisal_completed_date: string; appraisal_value: number
    underwriting_status: string; clear_to_close_date: string; notes: string
  }>,
) {
  if (!isValidUUID(lenderId)) return { success: false, error: "Invalid lender ID" }
  return TransactionService.updateLender(lenderId, updates)
}

// ============================================
// TITLE & ESCROW
// ============================================

export async function addTitleEscrow(data: {
  transaction_id: string
  title_company_name: string
  title_officer_name?: string
  title_officer_email?: string
  title_officer_phone?: string
  escrow_company_name?: string
  escrow_officer_name?: string
  escrow_officer_email?: string
  escrow_officer_phone?: string
  escrow_number?: string
  title_search_ordered_date?: string
  title_search_completed_date?: string
  title_commitment_date?: string
  title_issues?: string
  earnest_money_amount?: number
  earnest_money_held_by?: string
  earnest_money_received_date?: string
  closing_scheduled_date?: string
  closing_location?: string
  notes?: string
}) {
  if (!isValidUUID(data.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addTitleEscrow(data)
}

export async function updateTitleEscrow(titleEscrowId: string, updates: Record<string, unknown>) {
  if (!isValidUUID(titleEscrowId)) return { success: false, error: "Invalid title/escrow ID" }
  return TransactionService.updateTitleEscrow(titleEscrowId, updates)
}

// ============================================
// INSPECTIONS
// ============================================

export async function scheduleInspection(inspectionData: {
  transaction_id: string
  inspection_type: string
  inspector_name?: string
  inspector_company?: string
  inspector_email?: string
  inspector_phone?: string
  scheduled_date?: string
  cost?: number
  notes?: string
}) {
  if (!isValidUUID(inspectionData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.scheduleInspection(inspectionData)
}

export async function updateInspection(
  inspectionId: string,
  updates: Partial<{
    status: string; scheduled_date: string; completed_date: string
    inspector_name: string; inspector_company: string; inspector_email: string
    inspector_phone: string; cost: number; report_received: boolean
    report_url: string; issues_found: string; notes: string
  }>,
) {
  if (!isValidUUID(inspectionId)) return { success: false, error: "Invalid inspection ID" }
  return TransactionService.updateInspection(inspectionId, updates)
}

export async function completeInspection(inspectionId: string, reportUrl?: string, issuesFound?: string) {
  if (!isValidUUID(inspectionId)) return { success: false, error: "Invalid inspection ID" }
  return TransactionService.completeInspection(inspectionId, reportUrl, issuesFound)
}

// ============================================
// VENDOR SERVICES
// ============================================

export async function orderVendorService(serviceData: {
  transaction_id: string
  service_type: string
  vendor_name: string
  vendor_email?: string
  vendor_phone?: string
  cost?: number
  scheduled_date?: string
  notes?: string
}) {
  if (!isValidUUID(serviceData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.orderVendorService(serviceData)
}

export async function updateVendorService(
  serviceId: string,
  updates: Partial<{ status: string; scheduled_date: string; completed_date: string; cost: number; paid: boolean; notes: string }>,
) {
  if (!isValidUUID(serviceId)) return { success: false, error: "Invalid service ID" }
  return TransactionService.updateVendorService(serviceId, updates)
}

// ============================================
// DOCUMENTS
// ============================================

export async function addTransactionDocument(docData: {
  transaction_id: string
  document_type: string
  document_name: string
  file_url?: string
  file_size?: number
  uploaded_by?: string
  requires_signature?: boolean
  notes?: string
}) {
  if (!isValidUUID(docData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addTransactionDocument(docData)
}

export async function updateDocumentStatus(documentId: string, status: string, signedAt?: string) {
  if (!isValidUUID(documentId)) return { success: false, error: "Invalid document ID" }
  return TransactionService.updateDocumentStatus(documentId, status, signedAt)
}

// ============================================
// TIMELINE
// ============================================

export async function addTimelineEntry(
  transactionId: string,
  activityType: string,
  description: string,
  performedBy?: string,
  metadata?: Record<string, unknown>,
) {
  if (!isValidUUID(transactionId)) return
  return TransactionService.addTimelineEntry(transactionId, activityType, description, performedBy, metadata)
}

export async function getTransactionTimeline(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.getTransactionTimeline(transactionId)
}

// ============================================
// DEADLINES
// ============================================

export async function addDeadline(deadlineData: {
  transaction_id: string
  deadline_type: string
  description: string
  due_date: string
  reminder_days_before?: number
  assigned_to?: string
  notes?: string
}) {
  if (!isValidUUID(deadlineData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addDeadline(deadlineData)
}

export async function updateDeadline(
  deadlineId: string,
  updates: Partial<{ status: string; due_date: string; description: string; completed_at: string; notes: string }>,
) {
  if (!isValidUUID(deadlineId)) return { success: false, error: "Invalid deadline ID" }
  return TransactionService.updateDeadline(deadlineId, updates)
}

export async function completeDeadline(deadlineId: string) {
  if (!isValidUUID(deadlineId)) return { success: false, error: "Invalid deadline ID" }
  return TransactionService.completeDeadline(deadlineId)
}

export async function getUpcomingDeadlines(agentId?: string, days = 7) {
  if (agentId && !isValidUUID(agentId)) return { success: false, error: "Invalid agent ID" }
  return TransactionService.getUpcomingDeadlines(agentId, days)
}

// ============================================
// COMMISSIONS
// ============================================

export async function addCommission(commissionData: {
  transaction_id: string
  recipient_type: string
  recipient_name: string
  recipient_id?: string
  commission_type: string
  rate_percentage?: number
  flat_amount?: number
  calculated_amount?: number
  split_percentage?: number
  notes?: string
}) {
  if (!isValidUUID(commissionData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.addCommission(commissionData)
}

export async function calculateCommissions(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.calculateCommissions(transactionId)
}

export async function markCommissionPaid(commissionId: string, paidDate: string, checkNumber?: string) {
  if (!isValidUUID(commissionId)) return { success: false, error: "Invalid commission ID" }
  return TransactionService.markCommissionPaid(commissionId, paidDate, checkNumber)
}

// ============================================
// REPAIR NEGOTIATIONS
// ============================================

export async function submitRepairRequest(requestData: {
  transaction_id: string
  requested_by: "buyer" | "seller"
  item_description: string
  estimated_cost?: number
  priority?: string
  notes?: string
}) {
  if (!isValidUUID(requestData.transaction_id)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.submitRepairRequest(requestData)
}

export async function respondToRepairRequest(
  requestId: string,
  response: "accepted" | "rejected" | "counter",
  counterOffer?: number,
  notes?: string,
) {
  if (!isValidUUID(requestId)) return { success: false, error: "Invalid request ID" }
  return TransactionService.respondToRepairRequest(requestId, response, counterOffer, notes)
}

export async function finalizeRepairNegotiation(
  requestId: string,
  resolution: "repair" | "credit" | "as_is",
  finalAmount?: number,
) {
  if (!isValidUUID(requestId)) return { success: false, error: "Invalid request ID" }
  return TransactionService.finalizeRepairNegotiation(requestId, resolution, finalAmount)
}

// ============================================
// DASHBOARD STATS
// ============================================

export async function getTransactionStats(agentId?: string) {
  if (agentId && !isValidUUID(agentId)) return { activeCount: 0, pendingDocsCount: 0, tasksToday: 0, closingThisMonth: 0 }
  return TransactionService.getTransactionStats(agentId)
}

export async function getPendingDocuments(transactionId?: string, limit = 20) {
  if (transactionId && !isValidUUID(transactionId)) return []
  return TransactionService.getPendingDocuments(transactionId, limit)
}

// ============================================
// TRANSPARENT TRANSACTION MANAGEMENT
// ============================================

export async function createTransparentTransaction(data: {
  property_address: string
  transaction_type: "buyer_side" | "seller_side" | "dual"
  primary_client_id: string
  agent_id: string
  purchase_price?: number
  financing_type?: string
  close_date?: string
}) {
  if (!data.property_address?.trim()) return { success: false, error: "Property address is required" }
  if (!isValidUUID(data.primary_client_id)) return { success: false, error: "Invalid client ID" }
  if (!isValidUUID(data.agent_id)) return { success: false, error: "Invalid agent ID" }
  return TransactionService.createTransparentTransaction(data)
}

export async function generateClientTimeline(transactionId: string, transactionType: string, financingType: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  return TransactionService.generateClientTimeline(transactionId, transactionType, financingType)
}

export async function generateCostBreakdown(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  return TransactionService.generateCostBreakdown(transactionId)
}

export async function generateStatusUpdate(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  return TransactionService.generateStatusUpdate(transactionId)
}

export async function generateSmartChecklist(transactionId: string, stage: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  return TransactionService.generateSmartChecklist(transactionId, stage)
}

export async function detectTransactionIssues(transactionId: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  return TransactionService.detectTransactionIssues(transactionId)
}

export async function deliverEducationalContent(transactionId: string, stage: string) {
  if (!isValidUUID(transactionId)) return { success: false, message: "Invalid transaction ID" }
  return TransactionService.deliverEducationalContent(transactionId, stage)
}

export async function monitorTransactionHealth(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  return TransactionService.monitorTransactionHealth(transactionId)
}

export async function detectTransactionDelays(transactionId: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  return TransactionService.detectTransactionDelays(transactionId)
}

export async function celebrateMilestone(transactionId: string, milestone: string) {
  if (!isValidUUID(transactionId)) return { success: false, message: "Invalid transaction ID" }
  return TransactionService.celebrateMilestone(transactionId, milestone)
}

export async function loadClientDashboard(transactionId: string, contactId?: string) {
  if (!isValidUUID(transactionId)) throw new Error("Invalid transaction ID")
  if (contactId && !isValidUUID(contactId)) throw new Error("Invalid contact ID")
  return TransactionService.loadClientDashboard(transactionId, contactId)
}

export async function loadAgentDashboard() {
  return TransactionService.loadAgentDashboard()
}

export async function getAgentTransactionKanban() {
  return TransactionService.getAgentTransactionKanban()
}

export async function updateTransactionStage(transactionId: string, targetStage: string, reason?: string) {
  if (!isValidUUID(transactionId)) return { success: false, error: "Invalid transaction ID" }
  return TransactionService.updateTransactionStage(transactionId, targetStage, reason)
}

export async function getClientTasks(transactionId: string) {
  if (!isValidUUID(transactionId)) return []
  return TransactionService.getClientTasks(transactionId)
}

export async function autoProgressMilestone(transactionId: string, completedMilestone: string) {
  if (!isValidUUID(transactionId)) return { success: false }
  return TransactionService.autoProgressMilestone(transactionId, completedMilestone)
}
