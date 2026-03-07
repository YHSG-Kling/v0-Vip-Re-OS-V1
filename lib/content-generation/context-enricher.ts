"use server"

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

// ============================================
// CONTEXT ENRICHMENT
// Gathers context from existing database tables
// Reads from: contacts, listings, transactions (ONLY)
// ============================================

export interface EnrichedContext {
  listing?: ListingContext
  contact?: ContactContext
  transaction?: TransactionContext
}

export interface ListingContext {
  id: string
  address: string
  city: string
  state: string
  zip: string
  list_price: number
  bedrooms: number
  bathrooms: number
  sqft: number
  status: string
  features?: string
}

export interface ContactContext {
  id: string
  first_name: string
  last_name: string
  full_name: string
  email: string
  phone: string
  contact_type: string
  contact_persona?: string
  timeline?: string
  notes?: string
}

export interface TransactionContext {
  id: string
  deal_name: string
  deal_type: string
  status: string
  stage: string
  purchase_price?: number
  close_date?: string
  listing?: ListingContext
  contact?: ContactContext
}

/**
 * Gather context data for content generation
 * Only reads from approved tables: contacts, listings, transactions
 */
export async function gatherContext(params: {
  listing_id?: string
  contact_id?: string
  transaction_id?: string
}): Promise<EnrichedContext> {
  const supabase = await createClient()
  const context: EnrichedContext = {}

  // Get listing context
  if (params.listing_id && isValidUUID(params.listing_id)) {
    const { data: listing } = await supabase
      .from("listings")
      .select("id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, status")
      .eq("id", params.listing_id)
      .maybeSingle()

    if (listing) {
      context.listing = {
        id: listing.id,
        address: listing.address || "",
        city: listing.city || "",
        state: listing.state || "",
        zip: listing.zip || "",
        list_price: listing.list_price || 0,
        bedrooms: listing.bedrooms || 0,
        bathrooms: listing.bathrooms || 0,
        sqft: listing.sqft || 0,
        status: listing.status || "",
      }
    }
  }

  // Get contact context
  if (params.contact_id && isValidUUID(params.contact_id)) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, contact_type, contact_persona, timeline, notes")
      .eq("id", params.contact_id)
      .maybeSingle()

    if (contact) {
      context.contact = {
        id: contact.id,
        first_name: contact.first_name || "",
        last_name: contact.last_name || "",
        full_name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(),
        email: contact.email || "",
        phone: contact.phone || "",
        contact_type: contact.contact_type || "",
        contact_persona: contact.contact_persona,
        timeline: contact.timeline,
        notes: contact.notes,
      }
    }
  }

  // Get transaction context
  if (params.transaction_id && isValidUUID(params.transaction_id)) {
    const { data: transaction } = await supabase
      .from("transactions")
      .select(
        `
        id,
        deal_name,
        deal_type,
        status,
        stage,
        purchase_price,
        close_date,
        listing_id,
        contact_id
      `
      )
      .eq("id", params.transaction_id)
      .maybeSingle()

    if (transaction) {
      context.transaction = {
        id: transaction.id,
        deal_name: transaction.deal_name || "",
        deal_type: transaction.deal_type || "",
        status: transaction.status || "",
        stage: transaction.stage || "",
        purchase_price: transaction.purchase_price,
        close_date: transaction.close_date,
      }

      // Enrich transaction with listing
      if (transaction.listing_id && isValidUUID(transaction.listing_id)) {
        const { data: listing } = await supabase
          .from("listings")
          .select("id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, status")
          .eq("id", transaction.listing_id)
          .maybeSingle()

        if (listing) {
          context.transaction.listing = {
            id: listing.id,
            address: listing.address || "",
            city: listing.city || "",
            state: listing.state || "",
            zip: listing.zip || "",
            list_price: listing.list_price || 0,
            bedrooms: listing.bedrooms || 0,
            bathrooms: listing.bathrooms || 0,
            sqft: listing.sqft || 0,
            status: listing.status || "",
          }
        }
      }

      // Enrich transaction with contact
      if (transaction.contact_id && isValidUUID(transaction.contact_id)) {
        const { data: contact } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, email, phone, contact_type, contact_persona, timeline, notes")
          .eq("id", transaction.contact_id)
          .maybeSingle()

        if (contact) {
          context.transaction.contact = {
            id: contact.id,
            first_name: contact.first_name || "",
            last_name: contact.last_name || "",
            full_name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(),
            email: contact.email || "",
            phone: contact.phone || "",
            contact_type: contact.contact_type || "",
            contact_persona: contact.contact_persona,
            timeline: contact.timeline,
            notes: contact.notes,
          }
        }
      }
    }
  }

  return context
}

/**
 * Build enhanced prompt with context data
 */
export async function enrichPromptWithContext(basePrompt: string, context: EnrichedContext): Promise<string> {
  let enrichedPrompt = basePrompt + "\n\n"

  if (context.listing) {
    enrichedPrompt += `PROPERTY DETAILS:\n`
    enrichedPrompt += `- Address: ${context.listing.address}, ${context.listing.city}, ${context.listing.state} ${context.listing.zip}\n`
    enrichedPrompt += `- Price: $${context.listing.list_price.toLocaleString()}\n`
    enrichedPrompt += `- ${context.listing.bedrooms}BR / ${context.listing.bathrooms}BA\n`
    enrichedPrompt += `- ${context.listing.sqft.toLocaleString()} sqft\n`
    enrichedPrompt += `- Status: ${context.listing.status}\n\n`
  }

  if (context.contact) {
    enrichedPrompt += `CONTACT DETAILS:\n`
    enrichedPrompt += `- Name: ${context.contact.full_name}\n`
    if (context.contact.contact_persona) {
      enrichedPrompt += `- Persona: ${context.contact.contact_persona}\n`
    }
    if (context.contact.timeline) {
      enrichedPrompt += `- Timeline: ${context.contact.timeline}\n`
    }
    if (context.contact.contact_type) {
      enrichedPrompt += `- Type: ${context.contact.contact_type}\n`
    }
    enrichedPrompt += `\n`
  }

  if (context.transaction) {
    enrichedPrompt += `TRANSACTION DETAILS:\n`
    enrichedPrompt += `- Deal: ${context.transaction.deal_name}\n`
    enrichedPrompt += `- Type: ${context.transaction.deal_type}\n`
    enrichedPrompt += `- Stage: ${context.transaction.stage}\n`
    enrichedPrompt += `- Status: ${context.transaction.status}\n`
    if (context.transaction.purchase_price) {
      enrichedPrompt += `- Price: $${context.transaction.purchase_price.toLocaleString()}\n`
    }
    if (context.transaction.close_date) {
      enrichedPrompt += `- Close Date: ${context.transaction.close_date}\n`
    }
    enrichedPrompt += `\n`
  }

  return enrichedPrompt
}
