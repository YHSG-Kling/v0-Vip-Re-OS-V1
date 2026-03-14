"use server"

import { getAgentContext } from "@/lib/identity"
import {
  serviceGetLeads,
  serviceGetLead,
  serviceEnrichLead,
  serviceConvertLeadToContact,
  serviceRejectLead,
  serviceImportLeads,
} from "@/lib/application/lead-application-service"
import type { LeadScore, LeadIntent, LeadStatus, LeadSource, Lead } from "@/app/types/lead-management"

// Types are now exported from @/app/types/lead-management

export async function getLeads(params?: {
  search?: string
  score?: LeadScore
  intent?: LeadIntent
  status?: LeadStatus
  source?: LeadSource
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: "asc" | "desc"
}) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const result = await serviceGetLeads(agentId, brokerageId, params)
    return { success: true, ...result }
  } catch (error) {
    return { success: false, error: String(error), leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
  }
}

export async function getLead(id: string) {
  try {
    if (!id) return { success: false, error: "ID is required", lead: null }
    const { agentId, brokerageId } = await getAgentContext()
    const lead = await serviceGetLead(agentId, brokerageId, id)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error), lead: null }
  }
}

export async function enrichLead(leadId: string) {
  try {
    if (!leadId) return { success: false, error: "Lead ID is required" }
    const { agentId, brokerageId } = await getAgentContext()
    const lead = await serviceEnrichLead(agentId, brokerageId, leadId)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function convertLeadToContact(leadId: string) {
  try {
    if (!leadId) return { success: false, error: "Lead ID is required" }
    const { agentId, brokerageId } = await getAgentContext()
    const contact = await serviceConvertLeadToContact(agentId, brokerageId, leadId)
    return { success: true, contact }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function rejectLead(leadId: string, reason?: string) {
  try {
    if (!leadId) return { success: false, error: "Lead ID is required" }
    const { agentId, brokerageId } = await getAgentContext()
    const lead = await serviceRejectLead(agentId, brokerageId, leadId, reason)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function importLeads(leads: Partial<Lead>[]) {
  try {
    if (!leads?.length) return { success: false, error: "No leads provided", imported: 0 }
    const { agentId, brokerageId } = await getAgentContext()
    const imported = await serviceImportLeads(agentId, brokerageId, leads)
    return { success: true, imported }
  } catch (error) {
    return { success: false, error: String(error), imported: 0 }
  }
}
