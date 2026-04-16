"use server"

import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
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

const ADMIN_ROLES = ["admin", "broker", "superadmin"] as const

export async function getLeadsAdmin(params?: {
  search?: string
  score?: LeadScore
  intent?: LeadIntent
  status?: LeadStatus
  source?: LeadSource
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: "asc" | "desc"
  adminView?: boolean
}) {
  try {
    const supabase = createServiceClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthenticated", leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }

    const { data: profile } = await supabase
      .from("users")
      .select("user_type, role")
      .eq("id", user.id)
      .single()

    const role = profile?.user_type ?? profile?.role ?? "agent"
    if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
      return { success: false, error: "Forbidden", leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
    }

    const { agentId, brokerageId } = await getAgentContext()
    const result = await serviceGetLeads(agentId ?? "", brokerageId ?? "", params as any)
    return { success: true, ...result }
  } catch (error) {
    return { success: false, error: String(error), leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
  }
}

export async function getLead(id: string) {
  try {
    if (!id) return { success: false, error: "ID is required", lead: null }
    const { agentId, brokerageId } = await getAgentContext()
    const lead = await serviceGetLead(agentId ?? "", brokerageId ?? "", id)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error), lead: null }
  }
}

export async function enrichLead(leadId: string) {
  try {
    if (!leadId) return { success: false, error: "Lead ID is required" }
    const { agentId, brokerageId } = await getAgentContext()
    const lead = await serviceEnrichLead(agentId ?? "", brokerageId ?? "", leadId)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function convertLeadToContact(params: { leadId: string; agentId?: string; brokerageId?: string }) {
  try {
    const { leadId, agentId: providedAgentId, brokerageId: providedBrokerageId } = params
    if (!leadId) return { success: false, error: "Lead ID is required" }
    
    const context = await getAgentContext()
    const agentId = providedAgentId || context.agentId
    const brokerageId = providedBrokerageId || context.brokerageId

    const contact = await serviceConvertLeadToContact(agentId ?? "", brokerageId ?? "", leadId)
    return { success: true, contact, contactId: contact?.id }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function rejectLead(leadId: string, reason?: string) {
  try {
    if (!leadId) return { success: false, error: "Lead ID is required" }
    const { agentId, brokerageId } = await getAgentContext()
    const lead = await serviceRejectLead(agentId ?? "", brokerageId ?? "", leadId, reason)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function importLeads(leads: Partial<Lead>[]) {
  try {
    if (!leads?.length) return { success: false, error: "No leads provided", imported: 0 }
    const { agentId, brokerageId } = await getAgentContext()
    const imported = await serviceImportLeads(agentId ?? "", brokerageId ?? "", leads as any)
    return { success: true, imported }
  } catch (error) {
    return { success: false, error: String(error), imported: 0 }
  }
}
