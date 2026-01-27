"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { ZenrowsClient } from "@/lib/zenrows-client"
import { BatchDataClient } from "@/lib/batchdata-client"
import { PeopleDataClient } from "@/lib/peopledata-client"
import { isValidUUID, validateEmail, validatePhone } from "@/lib/validations"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
import { calculateLeadScore } from "@/lib/services/lead-management.service"

// ===========================================
// LEADS = External scraped data NOT in our system yet
// CONTACTS = People already in our database
// ===========================================

// ============================================
// LEAD CRUD OPERATIONS
// ============================================

export async function createLead(leadData: {
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
  try {
    console.log("[v0] Creating lead from source:", leadData.lead_source)

    // Validate email and phone if provided
    if (leadData.email && !validateEmail(leadData.email)) {
      throw new ValidationError("Invalid email format")
    }
    if (leadData.phone && !validatePhone(leadData.phone)) {
      throw new ValidationError("Invalid phone format")
    }

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

    // Auto-calculate initial lead score for the new lead
    if (data?.id) {
      await calculateLeadScore({
        id: data.id,
        agentId: "system",
        table: "leads",
      }).catch((err) => console.error("[v0] Failed to score new lead:", err))
    }

    revalidatePath("/intelligence")
    revalidatePath("/dashboard")
    return { success: true, lead: data }
  } catch (error) {
    return handleError(error, "createLead")
  }
}

export async function getLeads(filters?: {
  lead_status?: string
  lead_source?: string
  temperature?: string
  intent_type?: string
  assigned_agent_id?: string
  limit?: number
}) {
  try {
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

    if (filters?.lead_status) {
      query = query.eq("lead_status", filters.lead_status)
    }
    if (filters?.lead_source) {
      query = query.eq("lead_source", filters.lead_source)
    }
    if (filters?.temperature) {
      query = query.eq("temperature", filters.temperature)
    }
    if (filters?.intent_type) {
      query = query.eq("intent_type", filters.intent_type)
    }
    if (filters?.assigned_agent_id) {
      query = query.eq("assigned_agent_id", filters.assigned_agent_id)
    }
    if (filters?.limit) {
      query = query.limit(filters.limit)
    }

    const { data, error } = await query

    if (error) throw error

    return { success: true, leads: data || [] }
  } catch (error) {
    console.error("[v0] Error getting leads:", error)
    return { success: false, error: String(error), leads: [] }
  }
}

export async function updateLead(
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
  try {
    if (!isValidUUID(leadId)) {
      throw new ValidationError("Invalid lead ID")
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("leads")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .select()
      .single()

    if (error) throw error
    if (!data) throw new NotFoundError("Lead not found")

    // Recalculate score if key fields changed
    const shouldRecalculate = updates.engagement_score || updates.motivation_score || updates.intent_type
    if (shouldRecalculate && data.assigned_agent_id) {
      await calculateLeadScore({
        id: leadId,
        agentId: data.assigned_agent_id,
        table: "leads",
        recalculate: true,
      }).catch((err) => console.error("[v0] Failed to recalculate lead score:", err))
    }

    revalidatePath("/intelligence")
    revalidatePath("/dashboard")
    return { success: true, lead: data }
  } catch (error) {
    return handleError(error, "updateLead")
  }
}

export async function assignLead(leadId: string, agentId: string) {
  try {
    if (!isValidUUID(leadId)) {
      throw new ValidationError("Invalid lead ID")
    }
    if (!isValidUUID(agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

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
    return { success: true, lead: data }
  } catch (error) {
    console.error("[v0] Error assigning lead:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// LEAD TO CONTACT CONVERSION
// ============================================

export async function convertLeadToContact(leadId: string) {
  try {
    const supabase = await createClient()

    // Get the lead data
    const { data: lead, error: leadError } = await supabase.from("leads").select("*").eq("id", leadId).single()

    if (leadError) throw leadError
    if (!lead) throw new Error("Lead not found")

    // Create new contact from lead data
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

    // Update lead to mark as converted
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

    return { success: true, contact: newContact }
  } catch (error) {
    console.error("[v0] Error converting lead to contact:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// SCRAPING FUNCTIONS - CREATE NEW LEADS
// ============================================

export async function scrapeZillowLeads(location: string, searchType: "buying" | "selling" = "buying") {
  try {
    const zenrows = new ZenrowsClient()
    const supabase = await createClient()

    // Scrape Zillow for leads
    const scrapedData = await zenrows.scrapeRealEstateSite("zillow", location)

    if (!scrapedData.success || !scrapedData.data) {
      return { success: false, error: "Failed to scrape Zillow" }
    }

    const leads: any[] = []

    // Process scraped data and create leads
    for (const item of scrapedData.data.users || []) {
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

        // Store external behavior
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
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[v0] Error scraping Zillow leads:", error)
    return { success: false, error: String(error) }
  }
}

export async function scrapeNextdoorLeads(neighborhood: string) {
  try {
    const zenrows = new ZenrowsClient()
    const supabase = await createClient()

    // Scrape Nextdoor for real estate related posts
    const scrapedData = await zenrows.scrapeNextdoor(neighborhood)

    if (!scrapedData.success || !scrapedData.data) {
      return { success: false, error: "Failed to scrape Nextdoor" }
    }

    const leads: any[] = []

    // Process scraped posts and create leads
    for (const post of scrapedData.data.posts || []) {
      // Check if post contains real estate intent
      const realEstateKeywords = ["selling", "buying", "house", "home", "realtor", "moving", "mortgage", "property"]
      const hasIntent = realEstateKeywords.some((kw) => post.content?.toLowerCase().includes(kw))

      if (!hasIntent) continue

      // Determine intent type
      const sellerKeywords = ["selling", "sell my", "listing", "moving out", "relocating"]
      const buyerKeywords = ["buying", "looking for", "searching", "house hunting", "moving to"]

      let intentType = "unknown"
      if (sellerKeywords.some((kw) => post.content?.toLowerCase().includes(kw))) {
        intentType = "seller"
      } else if (buyerKeywords.some((kw) => post.content?.toLowerCase().includes(kw))) {
        intentType = "buyer"
      }

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

        // Store social intelligence
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
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[v0] Error scraping Nextdoor leads:", error)
    return { success: false, error: String(error) }
  }
}

export async function scrapeBatchDataLeads(
  location: string,
  criteria?: {
    equity_min?: number
    ownership_years_min?: number
    property_type?: string
  },
) {
  try {
    const batchdata = new BatchDataClient()
    const supabase = await createClient()

    // Get motivated seller data from BatchData
    const propertyData = await batchdata.getMotivatedSellerData(location)

    if (!propertyData.success || !propertyData.data) {
      return { success: false, error: "Failed to get BatchData" }
    }

    const leads: any[] = []

    for (const property of propertyData.data.properties || []) {
      // Apply filters
      if (criteria?.equity_min && (property.equity_estimate || 0) < criteria.equity_min) continue
      if (criteria?.ownership_years_min && (property.ownership_years || 0) < criteria.ownership_years_min) continue

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
          temperature: property.motivation_score > 70 ? "hot" : property.motivation_score > 50 ? "warm" : "cold",
          motivation_score: property.motivation_score || 0,
          raw_scraped_data: property,
        })
        .select()
        .single()

      if (!error && lead) {
        leads.push(lead)

        // Store property ownership data
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

        // Store motivated seller signals
        if (property.motivation_indicators?.length > 0) {
          for (const indicator of property.motivation_indicators) {
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
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[v0] Error scraping BatchData leads:", error)
    return { success: false, error: String(error) }
  }
}

export async function scrapeFacebookGroupLeads(groupUrl: string) {
  try {
    const zenrows = new ZenrowsClient()
    const supabase = await createClient()

    // Scrape Facebook group for real estate related posts
    const scrapedData = await zenrows.scrapeFacebookGroup(groupUrl)

    if (!scrapedData.success || !scrapedData.data) {
      return { success: false, error: "Failed to scrape Facebook group" }
    }

    const leads: any[] = []

    for (const post of scrapedData.data.posts || []) {
      // Check for real estate intent
      const realEstateKeywords = [
        "selling",
        "buying",
        "house",
        "home",
        "realtor",
        "agent",
        "mortgage",
        "property",
        "rent",
      ]
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

        // Store social intelligence
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
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[v0] Error scraping Facebook group leads:", error)
    return { success: false, error: String(error) }
  }
}

export async function scrapeCraigslistLeads(location: string, category: "housing" | "real-estate" = "real-estate") {
  try {
    const zenrows = new ZenrowsClient()
    const supabase = await createClient()

    // Scrape Craigslist
    const scrapedData = await zenrows.scrapeCraigslist(location, category)

    if (!scrapedData.success || !scrapedData.data) {
      return { success: false, error: "Failed to scrape Craigslist" }
    }

    const leads: any[] = []

    for (const listing of scrapedData.data.listings || []) {
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

        // Store social intelligence
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
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[v0] Error scraping Craigslist leads:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// LEAD ENRICHMENT
// ============================================

export async function enrichLead(leadId: string) {
  try {
    const supabase = await createClient()
    const peopledata = new PeopleDataClient()
    const batchdata = new BatchDataClient()

    // Get current lead data
    const { data: lead, error: leadError } = await supabase.from("leads").select("*").eq("id", leadId).single()

    if (leadError) throw leadError
    if (!lead) throw new Error("Lead not found")

    // Enrich with PeopleData if we have email or phone
    if (lead.email || lead.phone) {
      const enrichmentData = await peopledata.enrichPerson({
        email: lead.email,
        phone: lead.phone,
        name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
      })

      if (enrichmentData.success && enrichmentData.data) {
        await supabase.from("lead_people_data").insert({
          lead_id: leadId,
          demographic_data: enrichmentData.data.demographics,
          employment_data: enrichmentData.data.employment,
          financial_indicators: enrichmentData.data.financial,
          life_events: enrichmentData.data.life_events,
          social_presence: enrichmentData.data.social,
          contact_enrichment: enrichmentData.data.additional_contacts,
          data_source: "peopledata",
        })

        // Update lead with enriched data
        await supabase
          .from("leads")
          .update({
            first_name: lead.first_name || enrichmentData.data.first_name,
            last_name: lead.last_name || enrichmentData.data.last_name,
            email: lead.email || enrichmentData.data.email,
            phone: lead.phone || enrichmentData.data.phone,
            address: lead.address || enrichmentData.data.address,
            city: lead.city || enrichmentData.data.city,
            state: lead.state || enrichmentData.data.state,
            zip_code: lead.zip_code || enrichmentData.data.zip,
            updated_at: new Date().toISOString(),
          })
          .eq("id", leadId)
      }
    }

    // Enrich with BatchData property data if we have address
    if (lead.address) {
      const propertyData = await batchdata.lookupPropertyOwnership(lead.address)

      if (propertyData.success && propertyData.data) {
        await supabase.from("lead_property_ownership").upsert({
          lead_id: leadId,
          property_address: lead.address,
          property_details: propertyData.data.property_details,
          estimated_value: propertyData.data.estimated_value,
          equity_estimate: propertyData.data.equity_estimate,
          mortgage_data: propertyData.data.mortgage,
          purchase_date: propertyData.data.purchase_date,
          ownership_length_months: propertyData.data.ownership_months,
          is_primary_residence: propertyData.data.is_primary,
          motivation_indicators: propertyData.data.motivation_indicators,
          data_source: "batchdata",
        })

        // Store any motivated seller signals
        if (propertyData.data.motivation_indicators?.length > 0) {
          for (const indicator of propertyData.data.motivation_indicators) {
            await supabase.from("lead_motivated_seller_signals").upsert({
              lead_id: leadId,
              signal_type: indicator.type,
              signal_details: indicator,
              signal_strength: indicator.strength || "moderate",
              detected_via: "batchdata",
            })
          }
        }

        // Update lead scores
        const motivationScore = Math.min(100, (lead.motivation_score || 0) + (propertyData.data.motivation_score || 0))
        await supabase
          .from("leads")
          .update({
            motivation_score: motivationScore,
            temperature: motivationScore > 70 ? "hot" : motivationScore > 50 ? "warm" : "cold",
            updated_at: new Date().toISOString(),
          })
          .eq("id", leadId)
      }
    }

    // Update lead intelligence record
    await supabase.from("lead_intelligence").upsert({
      lead_id: leadId,
      buyer_seller_type: lead.intent_type,
      motivation_score: lead.motivation_score,
      last_enriched_at: new Date().toISOString(),
      data_sources: ["peopledata", "batchdata"],
    })

    revalidatePath("/intelligence")
    return { success: true }
  } catch (error) {
    console.error("[v0] Error enriching lead:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// DASHBOARD STATS
// ============================================

export async function getLeadsDashboardStats() {
  try {
    const supabase = await createClient()

    const { data: leads, error } = await supabase.from("leads").select("id, lead_status, temperature, lead_source")

    if (error) throw error

    const stats = {
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

    return { success: true, stats }
  } catch (error) {
    console.error("[v0] Error getting leads stats:", error)
    return { success: false, error: String(error), stats: null }
  }
}
