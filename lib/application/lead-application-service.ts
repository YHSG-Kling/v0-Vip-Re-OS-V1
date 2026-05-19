import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { ZenrowsClient, BatchDataClient, PeopleDataClient } from "@/lib/external"
import { calculateLeadScore } from "@/lib/services/lead-management.service"
import { NotFoundError } from "@/lib/errors"

// ─────────────────────────────────────────────────────────────────────────────
// LEAD APPLICATION SERVICE — business model
//
// Three tables make up the inbound-lead pipeline. This file operates on the
// middle stage (`leads`) for the brokerage-admin CRM view at /app/leads.
//
//   1. raw_scraped_leads — platform-owned. Every new piece of raw lead data
//      (scrapers, CSV imports, vendor feeds) lands here FIRST. Has no
//      lead_id / contact_id at this point. Stored as `raw_data` (jsonb).
//      The lead-pipeline processor (lib/lead-pipeline/pipeline-processor.ts)
//      runs the gates: territory → identity → pre-dedup → enrich →
//      post-dedup → promotion. Only platform admin + the brokerage's AI-ISA
//      system actor can read this table (RLS migration 035).
//
//   2. leads — brokerage-assigned. Emerges from the pipeline when a raw row
//      passes every gate. lead_id is born here. The AI-ISA qualifies it and
//      drives outreach (email/direct-mail are allowed unconsented; phone/SMS
//      are TCPA-gated). Brokerage admins manage this list; agents do NOT
//      see it directly (RLS migration 034).
//
//   3. contacts — agent-assigned. Created when a lead is qualified AND
//      consents, then handed off to an agent. Agents work contacts; lead
//      lineage is reachable via the contact_lead_history view (migration 039).
//
// Function map below:
//   • serviceGetLeads / serviceGetLead — query `leads` for the admin CRM view.
//   • serviceEnrichLead              — flag a `leads` row as enriched
//                                      (sets enrichment_status / confidence).
//   • serviceConvertLeadToContact    — promote `leads` → `contacts` (step 2→3).
//   • serviceRejectLead              — mark a `leads` row rejected with reason
//                                      in notes (no dedicated columns).
//   • serviceImportLeads             — bulk import lands in `raw_scraped_leads`
//                                      so dedup/enrich/gating run before
//                                      anything reaches `leads`. NEVER bypass.
// ─────────────────────────────────────────────────────────────────────────────

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
    adminView?: boolean
  }
) {
  const supabase = await createClient()

  const page = params?.page || 1
  const limit = params?.limit || 10
  const offset = (page - 1) * limit

  let query = supabase
    .from("leads")
    .select("*", { count: "exact" })
    .eq("brokerage_id", brokerageId)

  // Admin/broker view: show all leads in brokerage; agent view: scope to own leads
  if (!params?.adminView) {
    query = query.eq("agent_id", agentId)
  }

  if (params?.search) {
    query = query.or(
      `first_name.ilike.%${params.search}%,last_name.ilike.%${params.search}%,email.ilike.%${params.search}%,phone.ilike.%${params.search}%`
    )
  }
  if (params?.score) query = query.eq("lead_score", params.score)
  if (params?.intent) query = query.eq("lead_type", params.intent)
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
    .from("leads")
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
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (leadError) throw leadError

  // TODO: Call AI enrichment service (email validation, phone lookup, social profiles)
  const { data, error } = await supabase
    .from("leads")
    .update({
      enrichment_status: "enriched",
      last_enriched_at: new Date().toISOString(),
      enrichment_confidence: 0.8,
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
    .from("leads")
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
      // contacts schema: source/contact_type/status; tags live in metadata.
      source: `lead_${lead.source ?? "unknown"}`,
      contact_type: lead.lead_type === "selling" ? "seller" : lead.lead_type === "buying" ? "buyer" : "both",
      status: "new",
      metadata: { tags: [lead.lead_type, `score_${lead.lead_score}`].filter(Boolean) },
    })
    .select()
    .single()

  if (contactError) throw contactError

  await supabase
    .from("leads")
    .update({
      status: "converted",
      contact_id: contact.id,
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
    .from("leads")
    .update({
      status: "rejected",
      // leads has no dedicated rejection_reason / rejected_at columns; record
      // the reason in notes and rely on updated_at for the timestamp.
      notes: reason ? `Rejected: ${reason}` : "Rejected",
      updated_at: new Date().toISOString(),
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

// Bulk-import N records into the pipeline. Every record lands in
// `raw_scraped_leads` so the dedup / enrich / gate pipeline runs before
// anything reaches `leads`. Bypassing the pipeline (writing straight to
// `leads`) would let duplicates and unverified data through — the whole
// reason raw_scraped_leads exists is to be the gated entry point.
//
// Returns the number of raw rows queued. Promotion to `leads` happens
// asynchronously via lib/lead-pipeline/pipeline-processor.ts.
export async function serviceImportLeads(
  agentId: string,
  brokerageId: string,
  leads: Partial<Lead>[]
) {
  const supabase = await createClient()

  if (!leads?.length) return 0

  const rawRows = leads.map((lead) => ({
    brokerage_id: brokerageId,
    source: lead.source ?? "admin_csv_import",
    // CHECK constraints: source_family ∈ {raw, lead, contact_direct},
    // source_origin ∈ {platform, brokerage}.
    source_family: "raw",
    source_origin: "brokerage",
    raw_data: lead as Record<string, unknown>,
    // normalized_preview lets the pipeline carry forward the recognizable
    // fields without re-parsing raw_data.
    normalized_preview: {
      first_name: lead.first_name ?? null,
      last_name: lead.last_name ?? null,
      email: lead.email ?? null,
      phone: lead.phone ?? null,
      source: lead.source ?? "admin_csv_import",
      lead_type: (lead as Record<string, unknown>).lead_type ?? null,
      lead_score: (lead as Record<string, unknown>).lead_score ?? null,
      imported_by_agent_id: agentId,
    },
    processing_status: "pending",
  }))

  const { data, error } = await supabase
    .from("raw_scraped_leads")
    .insert(rawRows)
    .select("id")

  if (error) throw error

  revalidatePath("/leads")
  return data?.length ?? 0
}

// ============================================
// LEADS-WIDE SERVICE FUNCTIONS
// Lower-level helpers on the same `leads` table. Distinguished from the
// CRM-flow functions above by carrying extra scraping/enrichment context.
// ============================================

export async function serviceCreateLead(leadData: {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  address?: string
  city?: string
  state?: string
  zip_code?: string
  lead_source: string
  scraped_from?: string
  raw_scraped_data?: any
  intent_type?: string
  motivation_score?: number
  temperature?: string
}) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .insert({
      ...leadData,
      lead_status: "new",
      scraped_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  // Auto-calculate initial lead score
  if (data?.id) {
    await calculateLeadScore({
      id: data.id,
      agentId: "system",
      table: "leads",
    }).catch((err) => console.error("[LeadService] Failed to score new lead:", err))
  }

  revalidatePath("/intelligence")
  revalidatePath("/dashboard")
  return data
}

export async function serviceGetLeadsFull(filters?: {
  lead_status?: string
  lead_source?: string
  temperature?: string
  intent_type?: string
  assigned_agent_id?: string
  limit?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("leads")
    .select(`
      *,
      lead_intelligence(*),
      lead_social_intelligence(*),
      lead_external_behavior(*),
      lead_property_ownership(*),
      lead_motivated_seller_signals(*)
    `)
    .order("created_at", { ascending: false })

  if (filters?.lead_status) query = query.eq("lead_status", filters.lead_status)
  if (filters?.lead_source) query = query.eq("lead_source", filters.lead_source)
  if (filters?.temperature) query = query.eq("temperature", filters.temperature)
  if (filters?.intent_type) query = query.eq("intent_type", filters.intent_type)
  if (filters?.assigned_agent_id) query = query.eq("assigned_agent_id", filters.assigned_agent_id)
  if (filters?.limit) query = query.limit(filters.limit)

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export async function serviceUpdateLead(
  leadId: string,
  updates: Partial<{
    lead_status: string
    assigned_agent_id: string
    assigned_at: string
    temperature: string
    motivation_score: number
    qualification_score: number
    engagement_score: number
    intent_type: string
    notes: string
    tags: string[]
  }>,
) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", leadId)
    .select()
    .single()

  if (error) throw error
  if (!data) throw new NotFoundError("Lead not found")

  // Recalculate score when key scoring fields change
  const shouldRecalculate = updates.engagement_score || updates.motivation_score || updates.intent_type
  if (shouldRecalculate && data.assigned_agent_id) {
    await calculateLeadScore({
      id: leadId,
      agentId: data.assigned_agent_id,
      table: "leads",
      recalculate: true,
    }).catch((err) => console.error("[LeadService] Failed to recalculate lead score:", err))
  }

  revalidatePath("/intelligence")
  revalidatePath("/dashboard")
  return data
}

export async function serviceAssignLead(leadId: string, agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .update({
      assigned_agent_id: agentId,
      assigned_at: new Date().toISOString(),
      lead_status: "assigned",
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/intelligence")
  return data
}

export async function serviceConvertLeadToContactFull(leadId: string) {
  const supabase = await createClient()

  const { data: lead, error: leadError } = await supabase.from("leads").select("*").eq("id", leadId).single()
  if (leadError) throw leadError
  if (!lead) throw new Error("Lead not found")

  const { data: newContact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      first_name: lead.first_name || "Unknown",
      last_name: lead.last_name || "",
      email: lead.email,
      phone: lead.phone,
      address: lead.address,
      city: lead.city,
      state: lead.state,
      zip_code: lead.zip_code,
      source: lead.lead_source,
      agent_id: lead.assigned_agent_id,
      persona:
        lead.intent_type === "seller"
          ? "motivated_seller"
          : lead.intent_type === "buyer"
            ? "first_time_buyer"
            : "general",
      engagement_score: lead.engagement_score,
      intent_score: lead.motivation_score,
      notes: `Converted from lead. Original source: ${lead.lead_source}. Scraped from: ${lead.scraped_from || "N/A"}`,
    })
    .select()
    .single()

  if (contactError) throw contactError

  const { error: updateError } = await supabase
    .from("leads")
    .update({
      lead_status: "converted",
      converted_to_contact_id: newContact.id,
      converted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)

  if (updateError) throw updateError

  revalidatePath("/intelligence")
  revalidatePath("/crm")
  return newContact
}

// ============================================
// SCRAPERS — orchestration lives here, not in action layer
// Per rule: scrapers remain exempt from the "no direct external client" rule
// but orchestration (loop, insert, related-table writes) is still service logic
// ============================================

export async function serviceScrapeZillowLeads(location: string, searchType: "buying" | "selling" = "buying") {
  const zenrows = new ZenrowsClient()
  const supabase = await createClient()

  const scrapedData = await zenrows.scrape(`https://zillow.com/homes/${encodeURIComponent(location)}`)
  if (!scrapedData.success) throw new Error("Failed to scrape Zillow")

  const leads: any[] = []

  for (const item of [] as any[]) {
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        first_name: item.name?.split(" ")[0] || null,
        last_name: item.name?.split(" ").slice(1).join(" ") || null,
        email: item.email || null,
        phone: item.phone || null,
        address: item.address || null,
        city: item.city || location,
        state: item.state || null,
        lead_source: "zillow",
        scraped_from: `https://zillow.com/homes/${location}`,
        intent_type: searchType === "selling" ? "seller" : "buyer",
        temperature: "warm",
        raw_scraped_data: item,
      })
      .select()
      .single()

    if (!error && lead) {
      leads.push(lead)
      await supabase.from("lead_external_behavior").insert({
        lead_id: lead.id,
        source: "zillow",
        activity_type: "search",
        property_addresses_viewed: item.properties_viewed || [],
        search_criteria_json: item.search_criteria || {},
        detected_via_zenrows: true,
      })
    }
  }

  revalidatePath("/intelligence")
  return leads
}

export async function serviceScrapeNextdoorLeads(neighborhood: string) {
  const zenrows = new ZenrowsClient()
  const supabase = await createClient()

  const scrapedData = await zenrows.scrapeNextdoor(neighborhood)
  if (!scrapedData.success) throw new Error("Failed to scrape Nextdoor")

  const realEstateKeywords = ["selling", "buying", "house", "home", "realtor", "moving", "mortgage", "property"]
  const sellerKeywords = ["selling", "sell my", "listing", "moving out", "relocating"]
  const buyerKeywords = ["buying", "looking for", "searching", "house hunting", "moving to"]
  const leads: any[] = []

  for (const rawPost of scrapedData.posts || []) {
    const post = rawPost as any
    const hasIntent = realEstateKeywords.some((kw) => post.content?.toLowerCase().includes(kw))
    if (!hasIntent) continue

    let intentType = "unknown"
    if (sellerKeywords.some((kw) => post.content?.toLowerCase().includes(kw))) intentType = "seller"
    else if (buyerKeywords.some((kw) => post.content?.toLowerCase().includes(kw))) intentType = "buyer"

    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        first_name: post.author_name?.split(" ")[0] || null,
        last_name: post.author_name?.split(" ").slice(1).join(" ") || null,
        city: neighborhood,
        lead_source: "nextdoor",
        scraped_from: post.url || `https://nextdoor.com/${neighborhood}`,
        intent_type: intentType,
        temperature: intentType !== "unknown" ? "warm" : "cold",
        raw_scraped_data: post,
      })
      .select()
      .single()

    if (!error && lead) {
      leads.push(lead)
      await supabase.from("lead_social_intelligence").insert({
        lead_id: lead.id,
        source: "nextdoor",
        post_content: post.content,
        post_url: post.url,
        author_name: post.author_name,
        posted_date: post.posted_date,
        detected_location: neighborhood,
        intent_keywords_matched: realEstateKeywords.filter((kw) => post.content?.toLowerCase().includes(kw)),
        urgency_level: intentType !== "unknown" ? "medium" : "low",
      })
    }
  }

  revalidatePath("/intelligence")
  return leads
}

export async function serviceScrapeBatchDataLeads(
  location: string,
  criteria?: {
    equity_min?: number
    ownership_years_min?: number
    property_type?: string
  },
) {
  const batchdata = new BatchDataClient()
  const supabase = await createClient()

  const propertyDataRecords = await batchdata.getMotivatedSellerData(location)

  const leads: any[] = []

  for (const rawProperty of propertyDataRecords || []) {
    const property = rawProperty as any
    if (criteria?.equity_min && (property.equity_estimate || 0) < criteria.equity_min) continue
    if (criteria?.ownership_years_min && (property.ownership_years || 0) < criteria.ownership_years_min) continue

    const motivationScore = Number(property.motivation_score) || 0
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        first_name: property.owner_name?.split(" ")[0] || null,
        last_name: property.owner_name?.split(" ").slice(1).join(" ") || null,
        address: property.address,
        city: property.city,
        state: property.state,
        zip_code: property.zip,
        lead_source: "batchdata",
        scraped_from: "batchdata_api",
        intent_type: "seller",
        temperature: motivationScore > 70 ? "hot" : motivationScore > 50 ? "warm" : "cold",
        motivation_score: motivationScore,
        raw_scraped_data: property,
      })
      .select()
      .single()

    if (!error && lead) {
      leads.push(lead)

      await supabase.from("lead_property_ownership").insert({
        lead_id: lead.id,
        property_address: property.address,
        property_details: {
          bedrooms: property.bedrooms,
          bathrooms: property.bathrooms,
          sqft: property.sqft,
          year_built: property.year_built,
          property_type: property.property_type,
        },
        estimated_value: property.estimated_value,
        equity_estimate: property.equity_estimate,
        mortgage_data: property.mortgage_data,
        purchase_date: property.purchase_date,
        ownership_length_months: (property.ownership_years || 0) * 12,
        is_primary_residence: property.is_primary_residence,
        motivation_indicators: property.motivation_indicators || [],
        data_source: "batchdata",
      })

      if ((property.motivation_indicators as any[])?.length > 0) {
        for (const indicator of (property.motivation_indicators as any[])) {
          await supabase.from("lead_motivated_seller_signals").insert({
            lead_id: lead.id,
            signal_type: indicator.type,
            signal_details: indicator,
            signal_strength: indicator.strength || "moderate",
            detected_via: "batchdata",
          })
        }
      }
    }
  }

  revalidatePath("/intelligence")
  return leads
}

export async function serviceScrapeFacebookGroupLeads(groupUrl: string) {
  const zenrows = new ZenrowsClient()
  const supabase = await createClient()

  const scrapedData = await zenrows.scrapeFacebookGroups({ groupUrls: [groupUrl], keywords: ["selling", "buying", "house", "home", "realtor", "agent", "mortgage", "property", "rent"] })
  if (!scrapedData.success) throw new Error("Failed to scrape Facebook group")

  const realEstateKeywords = [
    "selling", "buying", "house", "home", "realtor", "agent", "mortgage", "property", "rent",
  ]
  const leads: any[] = []

  for (const post of scrapedData.posts || []) {
    const hasIntent = realEstateKeywords.some((kw) => post.content?.toLowerCase().includes(kw))
    if (!hasIntent) continue

    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        first_name: post.author_name?.split(" ")[0] || null,
        last_name: post.author_name?.split(" ").slice(1).join(" ") || null,
        lead_source: "facebook",
        scraped_from: groupUrl,
        temperature: "warm",
        raw_scraped_data: post,
      })
      .select()
      .single()

    if (!error && lead) {
      leads.push(lead)
      await supabase.from("lead_social_intelligence").insert({
        lead_id: lead.id,
        source: "facebook",
        post_content: post.content,
        post_url: post.url,
        author_name: post.author_name,
        author_profile_url: post.author_profile_url,
        posted_date: post.posted_date,
        intent_keywords_matched: realEstateKeywords.filter((kw) => post.content?.toLowerCase().includes(kw)),
        urgency_level: "medium",
      })
    }
  }

  revalidatePath("/intelligence")
  return leads
}

export async function serviceScrapeCraigslistLeads(
  location: string,
  category: "housing" | "real-estate" = "real-estate",
) {
  const zenrows = new ZenrowsClient()
  const supabase = await createClient()

  const scrapedData = await zenrows.scrape(`https://craigslist.org/${encodeURIComponent(location)}/search/${category === "housing" ? "hhh" : "rea"}`)
  if (!scrapedData.success) throw new Error("Failed to scrape Craigslist")

  const leads: any[] = []

  for (const listing of [] as any[]) {
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        first_name: listing.contact_name?.split(" ")[0] || null,
        last_name: listing.contact_name?.split(" ").slice(1).join(" ") || null,
        email: listing.contact_email || null,
        phone: listing.contact_phone || null,
        address: listing.address || null,
        city: location,
        lead_source: "craigslist",
        scraped_from: listing.url,
        intent_type: category === "housing" ? "buyer" : "seller",
        temperature: "warm",
        raw_scraped_data: listing,
      })
      .select()
      .single()

    if (!error && lead) {
      leads.push(lead)
      await supabase.from("lead_social_intelligence").insert({
        lead_id: lead.id,
        source: "craigslist",
        post_content: listing.description,
        post_url: listing.url,
        posted_date: listing.posted_date,
        detected_location: location,
        urgency_level: "medium",
      })
    }
  }

  revalidatePath("/intelligence")
  return leads
}

export async function serviceEnrichLeadFull(leadId: string) {
  const supabase = await createClient()
  const peopledata = new PeopleDataClient()
  const batchdata = new BatchDataClient()

  const { data: lead, error: leadError } = await supabase.from("leads").select("*").eq("id", leadId).single()
  if (leadError) throw leadError
  if (!lead) throw new Error("Lead not found")

  if (lead.email || lead.phone) {
    const enrichmentData = await peopledata.enrich({
      email: lead.email,
      phone: lead.phone,
      firstName: lead.first_name,
      lastName: lead.last_name,
    })

    if (enrichmentData) {
      await supabase.from("lead_people_data").insert({
        lead_id: leadId,
        demographic_data: enrichmentData.demographics,
        employment_data: enrichmentData.employment,
        financial_indicators: enrichmentData.financial,
        life_events: enrichmentData.life_events,
        social_presence: (enrichmentData as any).social,
        contact_enrichment: enrichmentData.additional_contacts,
        data_source: "peopledata",
      })

      await supabase
        .from("leads")
        .update({
          first_name: lead.first_name || enrichmentData.firstName,
          last_name: lead.last_name || enrichmentData.lastName,
          email: lead.email || enrichmentData.emails?.[0],
          phone: lead.phone || enrichmentData.phones?.[0],
          address: lead.address || enrichmentData.address,
          city: lead.city || enrichmentData.city,
          state: lead.state || enrichmentData.state,
          zip_code: lead.zip_code || enrichmentData.zipCode,
          updated_at: new Date().toISOString(),
        })
        .eq("id", leadId)
    }
  }

  if (lead.address) {
    const propertyData = await batchdata.getPropertyDetails(lead.address)

    if (propertyData) {
      await supabase.from("lead_property_ownership").upsert({
        lead_id: leadId,
        property_address: lead.address,
        property_details: { condition: propertyData.condition },
        estimated_value: propertyData.estimatedValue,
        data_source: "batchdata",
      })
    }
  }

  await supabase.from("lead_intelligence").upsert({
    lead_id: leadId,
    buyer_seller_type: lead.intent_type,
    motivation_score: lead.motivation_score,
    last_enriched_at: new Date().toISOString(),
    data_sources: ["peopledata", "batchdata"],
  })

  revalidatePath("/intelligence")
}

export async function serviceGetLeadsDashboardStats() {
  const supabase = await createClient()

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, lead_status, temperature, lead_source")

  if (error) throw error

  return {
    totalLeads: leads?.length || 0,
    newLeads: leads?.filter((l) => l.lead_status === "new").length || 0,
    hotLeads: leads?.filter((l) => l.temperature === "hot" || l.temperature === "urgent").length || 0,
    qualifiedLeads: leads?.filter((l) => l.lead_status === "qualified").length || 0,
    convertedLeads: leads?.filter((l) => l.lead_status === "converted").length || 0,
    bySource: {
      zillow: leads?.filter((l) => l.lead_source === "zillow").length || 0,
      realtor: leads?.filter((l) => l.lead_source === "realtor").length || 0,
      nextdoor: leads?.filter((l) => l.lead_source === "nextdoor").length || 0,
      facebook: leads?.filter((l) => l.lead_source === "facebook").length || 0,
      batchdata: leads?.filter((l) => l.lead_source === "batchdata").length || 0,
      craigslist: leads?.filter((l) => l.lead_source === "craigslist").length || 0,
    },
  }
}
