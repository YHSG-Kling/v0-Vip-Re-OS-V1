import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
// Types inlined here — canonical home for lead domain types (no upward imports)
export type LeadScore = 'hot' | 'warm' | 'cold' | 'unqualified'
export type LeadIntent = 'buying' | 'selling' | 'both' | 'renting' | 'investing' | 'unknown'
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'nurturing' | 'converted' | 'lost' | 'inactive'
export type LeadSource = 'website' | 'referral' | 'social_media' | 'paid_ads' | 'open_house' | 'cold_call' | 'zillow' | 'realtor' | 'other'
export type Lead = {
  id: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  score?: LeadScore
  intent?: LeadIntent
  status?: LeadStatus
  source?: LeadSource
  agent_id?: string
  brokerage_id?: string
  created_at?: string
  updated_at?: string
  [key: string]: any
}

export async function serviceGetLeads(
  agentId: string,
  brokerageId: string,
  params?: {
    search?: string
    score?: LeadScore
    intent?: LeadIntent
    status?: LeadStatus
    source?: LeadSource
    page?: number
    limit?: number
    sortBy?: string
    sortOrder?: "asc" | "desc"
  }
) {
  const supabase = await createClient()

  const page = params?.page || 1
  const limit = params?.limit || 10
  const offset = (page - 1) * limit

  let query = supabase
    .from("scraped_leads")
    .select("*", { count: "exact" })
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (params?.search) {
    query = query.or(
      `first_name.ilike.%${params.search}%,last_name.ilike.%${params.search}%,email.ilike.%${params.search}%,phone.ilike.%${params.search}%`
    )
  }
  if (params?.score) query = query.eq("ai_score", params.score)
  if (params?.intent) query = query.eq("intent", params.intent)
  if (params?.status) query = query.eq("status", params.status)
  if (params?.source) query = query.eq("source", params.source)

  const sortBy = params?.sortBy || "created_at"
  const sortOrder = params?.sortOrder || "desc"
  query = query.order(sortBy, { ascending: sortOrder === "asc" })
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) throw error

  return {
    leads: data || [],
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit),
  }
}

export async function serviceGetLead(agentId: string, brokerageId: string, id: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("scraped_leads")
    .select("*")
    .eq("id", id)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (error) throw error
  return data
}

export async function serviceEnrichLead(agentId: string, brokerageId: string, leadId: string) {
  const supabase = await createClient()

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
  return data
}

export async function serviceConvertLeadToContact(agentId: string, brokerageId: string, leadId: string) {
  const supabase = await createClient()

  const { data: lead, error: leadError } = await supabase
    .from("scraped_leads")
    .select("*")
    .eq("id", leadId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (leadError) throw leadError

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      agent_id: agentId,
      brokerage_id: brokerageId,
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
  return contact
}

export async function serviceRejectLead(
  agentId: string,
  brokerageId: string,
  leadId: string,
  reason?: string
) {
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
  return data
}

export async function serviceImportLeads(
  agentId: string,
  brokerageId: string,
  leads: Partial<Lead>[]
) {
  const supabase = await createClient()

  const leadsToInsert = leads.map((lead) => ({
    ...lead,
    agent_id: agentId,
    brokerage_id: brokerageId,
    status: lead.status || "new",
    ai_score: lead.ai_score || 3,
    source: lead.source || "manual",
  }))

  const { data, error } = await supabase.from("scraped_leads").insert(leadsToInsert).select()

  if (error) throw error

  revalidatePath("/leads")
  return data?.length || 0
}
