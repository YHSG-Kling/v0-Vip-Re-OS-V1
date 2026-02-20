"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export type LeadScore = 1 | 2 | 3 | 4 | 5
export type LeadIntent = "buying" | "selling" | "distress" | "investor"
export type LeadStatus = "new" | "enriched" | "qualified" | "converted" | "rejected"
export type LeadSource = "scraped" | "website_form" | "ghl" | "manual"

export interface Lead {
  id: string
  source: LeadSource
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  ai_score: LeadScore
  intent: LeadIntent | null
  status: LeadStatus
  created_at: string
  enriched_data?: any
  agent_id: string
}

// Get all leads with filters and pagination
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
    const supabase = await createClient()

    const page = params?.page || 1
    const limit = params?.limit || 10
    const offset = (page - 1) * limit

    let query = supabase
      .from("scraped_leads")
      .select("*", { count: "exact" })
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)

    // Apply filters
    if (params?.search) {
      query = query.or(
        `first_name.ilike.%${params.search}%,last_name.ilike.%${params.search}%,email.ilike.%${params.search}%,phone.ilike.%${params.search}%`
      )
    }

    if (params?.score) {
      query = query.eq("ai_score", params.score)
    }

    if (params?.intent) {
      query = query.eq("intent", params.intent)
    }

    if (params?.status) {
      query = query.eq("status", params.status)
    }

    if (params?.source) {
      query = query.eq("source", params.source)
    }

    // Apply sorting
    const sortBy = params?.sortBy || "created_at"
    const sortOrder = params?.sortOrder || "desc"
    query = query.order(sortBy, { ascending: sortOrder === "asc" })

    // Apply pagination
    query = query.range(offset, offset + limit - 1)

    const { data, error, count } = await query

    if (error) throw error

    return {
      success: true,
      leads: data || [],
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    }
  } catch (error) {
    console.error("[v0] Error fetching leads:", error)
    return {
      success: false,
      error: String(error),
      leads: [],
      total: 0,
      page: 1,
      limit: 10,
      totalPages: 0,
    }
  }
}

// Get a single lead by ID
export async function getLead(id: string) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("scraped_leads")
      .select("*")
      .eq("id", id)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (error) throw error

    return { success: true, lead: data }
  } catch (error) {
    console.error("[v0] Error fetching lead:", error)
    return { success: false, error: String(error), lead: null }
  }
}

// Enrich a lead with AI
export async function enrichLead(leadId: string) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    // Get lead
    const { data: lead, error: leadError } = await supabase
      .from("scraped_leads")
      .select("*")
      .eq("id", leadId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (leadError) throw leadError

    // TODO: Call AI enrichment service (email validation, phone lookup, social profiles)
    const enrichedData = {
      email_verified: true,
      phone_verified: true,
      linkedin_profile: null,
      facebook_profile: null,
      estimated_income: null,
      homeowner_status: null,
      enriched_at: new Date().toISOString(),
    }

    // Update lead
    const { data, error } = await supabase
      .from("scraped_leads")
      .update({
        status: "enriched",
        enriched_data: enrichedData,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/leads")
    return { success: true, lead: data }
  } catch (error) {
    console.error("[v0] Error enriching lead:", error)
    return { success: false, error: String(error) }
  }
}

// Convert lead to contact
export async function convertLeadToContact(leadId: string) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    // Get lead
    const { data: lead, error: leadError } = await supabase
      .from("scraped_leads")
      .select("*")
      .eq("id", leadId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (leadError) throw leadError

    // Create contact from lead
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        agent_id: user.id,
        first_name: lead.first_name || "Unknown",
        last_name: lead.last_name || "Lead",
        email: lead.email,
        phone: lead.phone,
        lead_source: `scraped_${lead.source}`,
        buyer_seller_status: lead.intent === "selling" ? "seller" : lead.intent === "buying" ? "buyer" : "both",
        lead_stage: "new",
        tags: [lead.intent, `score_${lead.ai_score}`].filter(Boolean),
      })
      .select()
      .single()

    if (contactError) throw contactError

    // Update lead status
    await supabase
      .from("scraped_leads")
      .update({
        status: "converted",
        converted_contact_id: contact.id,
        converted_at: new Date().toISOString(),
      })
      .eq("id", leadId)

    revalidatePath("/leads")
    revalidatePath("/crm")
    return { success: true, contact }
  } catch (error) {
    console.error("[v0] Error converting lead:", error)
    return { success: false, error: String(error) }
  }
}

// Reject a lead
export async function rejectLead(leadId: string, reason?: string) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("scraped_leads")
      .update({
        status: "rejected",
        rejection_reason: reason,
        rejected_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/leads")
    return { success: true, lead: data }
  } catch (error) {
    console.error("[v0] Error rejecting lead:", error)
    return { success: false, error: String(error) }
  }
}

// Import leads (bulk)
export async function importLeads(leads: Partial<Lead>[]) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error("Not authenticated")

    const leadsToInsert = leads.map((lead) => ({
      ...lead,
      agent_id: user.id,
      status: lead.status || "new",
      ai_score: lead.ai_score || 3,
      source: lead.source || "manual",
    }))

    const { data, error } = await supabase.from("scraped_leads").insert(leadsToInsert).select()

    if (error) throw error

    revalidatePath("/leads")
    return { success: true, imported: data?.length || 0 }
  } catch (error) {
    console.error("[v0] Error importing leads:", error)
    return { success: false, error: String(error), imported: 0 }
  }
}
