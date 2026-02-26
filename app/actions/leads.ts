"use server"

import { isValidUUID, validateEmail, validatePhone } from "@/lib/validations"
import { handleError, ValidationError } from "@/lib/errors"
import {
  serviceCreateLead,
  serviceGetLeadsFull,
  serviceUpdateLead,
  serviceAssignLead,
  serviceConvertLeadToContactFull,
  serviceScrapeZillowLeads,
  serviceScrapeNextdoorLeads,
  serviceScrapeBatchDataLeads,
  serviceScrapeFacebookGroupLeads,
  serviceScrapeCraigslistLeads,
  serviceEnrichLeadFull,
  serviceGetLeadsDashboardStats,
} from "@/lib/application"

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
    if (leadData.email && !validateEmail(leadData.email)) {
      throw new ValidationError("Invalid email format")
    }
    if (leadData.phone && !validatePhone(leadData.phone)) {
      throw new ValidationError("Invalid phone format")
    }

    const lead = await serviceCreateLead(leadData)
    return { success: true, lead }
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
    const leads = await serviceGetLeadsFull(filters)
    return { success: true, leads }
  } catch (error) {
    console.error("[LeadAction] Error getting leads:", error)
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

    const lead = await serviceUpdateLead(leadId, updates)
    return { success: true, lead }
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

    const lead = await serviceAssignLead(leadId, agentId)
    return { success: true, lead }
  } catch (error) {
    console.error("[LeadAction] Error assigning lead:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// LEAD TO CONTACT CONVERSION
// ============================================

export async function convertLeadToContact(leadId: string) {
  try {
    if (!isValidUUID(leadId)) {
      throw new ValidationError("Invalid lead ID")
    }

    const contact = await serviceConvertLeadToContactFull(leadId)
    return { success: true, contact }
  } catch (error) {
    console.error("[LeadAction] Error converting lead to contact:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// SCRAPING FUNCTIONS - CREATE NEW LEADS
// ============================================

export async function scrapeZillowLeads(location: string, searchType: "buying" | "selling" = "buying") {
  try {
    if (!location?.trim()) {
      throw new ValidationError("Location is required")
    }

    const leads = await serviceScrapeZillowLeads(location, searchType)
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[LeadAction] Error scraping Zillow leads:", error)
    return { success: false, error: String(error) }
  }
}

export async function scrapeNextdoorLeads(neighborhood: string) {
  try {
    if (!neighborhood?.trim()) {
      throw new ValidationError("Neighborhood is required")
    }

    const leads = await serviceScrapeNextdoorLeads(neighborhood)
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[LeadAction] Error scraping Nextdoor leads:", error)
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
    if (!location?.trim()) {
      throw new ValidationError("Location is required")
    }

    const leads = await serviceScrapeBatchDataLeads(location, criteria)
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[LeadAction] Error scraping BatchData leads:", error)
    return { success: false, error: String(error) }
  }
}

export async function scrapeFacebookGroupLeads(groupUrl: string) {
  try {
    if (!groupUrl?.trim()) {
      throw new ValidationError("Group URL is required")
    }

    const leads = await serviceScrapeFacebookGroupLeads(groupUrl)
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[LeadAction] Error scraping Facebook group leads:", error)
    return { success: false, error: String(error) }
  }
}

export async function scrapeCraigslistLeads(location: string, category: "housing" | "real-estate" = "real-estate") {
  try {
    if (!location?.trim()) {
      throw new ValidationError("Location is required")
    }

    const leads = await serviceScrapeCraigslistLeads(location, category)
    return { success: true, leads, count: leads.length }
  } catch (error) {
    console.error("[LeadAction] Error scraping Craigslist leads:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// LEAD ENRICHMENT
// ============================================

export async function enrichLead(leadId: string) {
  try {
    if (!isValidUUID(leadId)) {
      throw new ValidationError("Invalid lead ID")
    }

    await serviceEnrichLeadFull(leadId)
    return { success: true }
  } catch (error) {
    console.error("[LeadAction] Error enriching lead:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// DASHBOARD STATS
// ============================================

export async function getLeadsDashboardStats() {
  try {
    const stats = await serviceGetLeadsDashboardStats()
    return { success: true, stats }
  } catch (error) {
    console.error("[LeadAction] Error getting leads stats:", error)
    return { success: false, error: String(error), stats: null }
  }
}
