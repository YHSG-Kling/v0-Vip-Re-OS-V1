

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID, validateEmail, validatePhone, validateContact } from "@/lib/validations"
import { LEAD_SOURCES, LEAD_TEMPERATURES } from "@/lib/constants"
import { handleError, ValidationError, NotFoundError, DatabaseError } from "@/lib/errors"
import { calculateLeadScore } from "./lead-management.service"

// ============================================
// UNIFIED CONTACT MANAGEMENT SERVICE
// Consolidates all contact CRUD operations
// Replaces duplicates in: crm.ts, portal-settings.ts, credit-copilot.ts
// ============================================

export interface CreateContactParams {
  agentId: string
  firstName: string
  lastName?: string
  email: string
  phone?: string
  source?: string
  status?: string
  budgetMin?: number
  budgetMax?: number
  preferredCities?: string[]
  notes?: string
  tags?: string[]
}

export interface UpdateContactParams {
  contactId: string
  agentId: string
  updates: Partial<CreateContactParams>
}

/**
 * Create a new contact
 */
export async function createContact(params: CreateContactParams) {
  try {


    // Validate inputs
    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    if (!validateEmail(params.email)) {
      throw new ValidationError("Invalid email address")
    }

    if (params.phone && !validatePhone(params.phone)) {
      throw new ValidationError("Invalid phone number")
    }

    const supabase = await createClient()

    // Check for duplicates
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("agent_id", params.agentId)
      .eq("email", params.email)
      .maybeSingle()

    if (existing) {
      throw new ValidationError("Contact with this email already exists")
    }

    // Create contact
    const { data: contact, error } = await supabase
      .from("contacts")
      .insert({
        agent_id: params.agentId,
        first_name: params.firstName,
        last_name: params.lastName,
        full_name: `${params.firstName} ${params.lastName || ""}`.trim(),
        email: params.email,
        phone: params.phone,
        source: params.source || "manual",
        status: params.status || "active",
        lead_temperature: "cool",
        lead_score: 50,
        budget_min: params.budgetMin,
        budget_max: params.budgetMax,
        preferred_cities: params.preferredCities,
        notes: params.notes,
        tags: params.tags,
        created_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) {
      throw new DatabaseError("Failed to create contact", error)
    }

    // Calculate initial lead score
    await calculateLeadScore({
      contactId: contact.id,
      agentId: params.agentId,
    })

    revalidatePath("/dashboard/crm")
    revalidatePath("/dashboard/contacts")

    return { success: true, contact }
  } catch (error) {
    return handleError(error, "createContact")
  }
}

/**
 * Update an existing contact
 */
export async function updateContact(params: UpdateContactParams) {
  try {
    console.log("[v0] Updating contact:", params.contactId)

    if (!isValidUUID(params.contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    // Validate email if updating
    if (params.updates.email && !validateEmail(params.updates.email)) {
      throw new ValidationError("Invalid email address")
    }

    // Validate phone if updating
    if (params.updates.phone && !validatePhone(params.updates.phone)) {
      throw new ValidationError("Invalid phone number")
    }

    const supabase = await createClient()

    // Verify ownership
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", params.contactId)
      .eq("agent_id", params.agentId)
      .single()

    if (!existing) {
      throw new NotFoundError("Contact not found or access denied")
    }

    // Build update object
    const updateData: any = {
      ...params.updates,
      updated_at: new Date().toISOString(),
    }

    // Update full_name if first or last name changed
    if (params.updates.firstName || params.updates.lastName) {
      const { data: current } = await supabase.from("contacts").select("first_name, last_name").eq("id", params.contactId).single()

      updateData.full_name = `${params.updates.firstName || current?.first_name} ${params.updates.lastName || current?.last_name || ""}`.trim()
    }

    // Update contact
    const { data: contact, error } = await supabase
      .from("contacts")
      .update(updateData)
      .eq("id", params.contactId)
      .select()
      .single()

    if (error) {
      throw new DatabaseError("Failed to update contact", error)
    }

    // Recalculate lead score if significant fields changed
    const significantFields = ["budget_min", "budget_max", "status", "preferred_cities"]
    const hasSignificantChanges = significantFields.some((field) => field in params.updates)

    if (hasSignificantChanges) {
      await calculateLeadScore({
        contactId: params.contactId,
        agentId: params.agentId,
        recalculate: true,
      })
    }

    revalidatePath("/dashboard/crm")
    revalidatePath("/dashboard/contacts")
    revalidatePath(`/dashboard/contacts/${params.contactId}`)

    return { success: true, contact }
  } catch (error) {
    return handleError(error, "updateContact")
  }
}

/**
 * Delete a contact (soft delete)
 */
export async function deleteContact(contactId: string, agentId: string) {
  try {
    console.log("[v0] Deleting contact:", contactId)

    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    if (!isValidUUID(agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    const supabase = await createClient()

    // Verify ownership
    const { data: existing } = await supabase.from("contacts").select("id").eq("id", contactId).eq("agent_id", agentId).single()

    if (!existing) {
      throw new NotFoundError("Contact not found or access denied")
    }

    // Soft delete
    const { error } = await supabase
      .from("contacts")
      .update({
        status: "deleted",
        deleted_at: new Date().toISOString(),
      })
      .eq("id", contactId)

    if (error) {
      throw new DatabaseError("Failed to delete contact", error)
    }

    revalidatePath("/dashboard/crm")
    revalidatePath("/dashboard/contacts")

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteContact")
  }
}

/**
 * Get a single contact by ID
 */
export async function getContact(contactId: string, agentId: string) {
  try {
    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    if (!isValidUUID(agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    const supabase = await createClient()

    const { data: contact, error } = await supabase
      .from("contacts")
      .select(`
        *,
        lead_intelligence(*),
        lead_behavioral_data(*),
        buyer_persona(*),
        property_interactions(*, listings(*)),
        transactions(*)
      `)
      .eq("id", contactId)
      .eq("agent_id", agentId)
      .single()

    if (error) {
      throw new NotFoundError("Contact not found")
    }

    return { success: true, contact }
  } catch (error) {
    return handleError(error, "getContact")
  }
}

/**
 * Get all contacts for an agent
 */
export async function getContacts(agentId: string, filters?: { status?: string; temperature?: string; search?: string }) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: true, contacts: [] }
    }

    const supabase = await createClient()

    let query = supabase
      .from("contacts")
      .select(`
        *,
        lead_intelligence(*),
        buyer_persona(*)
      `)
      .eq("agent_id", agentId)
      .is("deleted_at", null)

    // Apply filters
    if (filters?.status) {
      query = query.eq("status", filters.status)
    }

    if (filters?.temperature) {
      query = query.eq("lead_temperature", filters.temperature)
    }

    if (filters?.search) {
      query = query.or(`full_name.ilike.%${filters.search}%,email.ilike.%${filters.search}%`)
    }

    const { data: contacts, error } = await query.order("lead_score", { ascending: false })

    if (error) {
      throw new DatabaseError("Failed to fetch contacts", error)
    }

    return { success: true, contacts: contacts || [] }
  } catch (error) {
    return handleError(error, "getContacts")
  }
}

/**
 * Add tags to a contact
 */
export async function addContactTags(contactId: string, agentId: string, tags: string[]) {
  try {
    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    const supabase = await createClient()

    const { data: contact } = await supabase.from("contacts").select("tags").eq("id", contactId).eq("agent_id", agentId).single()

    if (!contact) {
      throw new NotFoundError("Contact not found")
    }

    const existingTags = contact.tags || []
    const newTags = [...new Set([...existingTags, ...tags])]

    const { error } = await supabase.from("contacts").update({ tags: newTags }).eq("id", contactId)

    if (error) {
      throw new DatabaseError("Failed to add tags", error)
    }

    revalidatePath("/dashboard/crm")
    return { success: true, tags: newTags }
  } catch (error) {
    return handleError(error, "addContactTags")
  }
}

/**
 * Remove tags from a contact
 */
export async function removeContactTags(contactId: string, agentId: string, tags: string[]) {
  try {
    if (!isValidUUID(contactId)) {
      throw new ValidationError("Invalid contact ID")
    }

    const supabase = await createClient()

    const { data: contact } = await supabase.from("contacts").select("tags").eq("id", contactId).eq("agent_id", agentId).single()

    if (!contact) {
      throw new NotFoundError("Contact not found")
    }

    const newTags = (contact.tags || []).filter((tag: string) => !tags.includes(tag))

    const { error } = await supabase.from("contacts").update({ tags: newTags }).eq("id", contactId)

    if (error) {
      throw new DatabaseError("Failed to remove tags", error)
    }

    revalidatePath("/dashboard/crm")
    return { success: true, tags: newTags }
  } catch (error) {
    return handleError(error, "removeContactTags")
  }
}

/**
 * Merge duplicate contacts
 */
export async function mergeContacts(params: { primaryContactId: string; duplicateContactId: string; agentId: string }) {
  try {
    if (!isValidUUID(params.primaryContactId) || !isValidUUID(params.duplicateContactId)) {
      throw new ValidationError("Invalid contact IDs")
    }

    const supabase = await createClient()

    // Get both contacts
    const { data: primary } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.primaryContactId)
      .eq("agent_id", params.agentId)
      .single()

    const { data: duplicate } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.duplicateContactId)
      .eq("agent_id", params.agentId)
      .single()

    if (!primary || !duplicate) {
      throw new NotFoundError("One or both contacts not found")
    }

    // Merge data (prefer primary, but take non-null from duplicate)
    const merged = {
      phone: primary.phone || duplicate.phone,
      budget_min: primary.budget_min || duplicate.budget_min,
      budget_max: primary.budget_max || duplicate.budget_max,
      preferred_cities: [...new Set([...(primary.preferred_cities || []), ...(duplicate.preferred_cities || [])])],
      tags: [...new Set([...(primary.tags || []), ...(duplicate.tags || [])])],
      notes: [primary.notes, duplicate.notes].filter(Boolean).join("\n\n---MERGED---\n\n"),
    }

    // Update primary contact
    await supabase.from("contacts").update(merged).eq("id", params.primaryContactId)

    // Transfer relationships to primary
    await supabase.from("property_interactions").update({ contact_id: params.primaryContactId }).eq("contact_id", params.duplicateContactId)

    await supabase.from("transactions").update({ contact_id: params.primaryContactId }).eq("contact_id", params.duplicateContactId)

    // Soft delete duplicate
    await deleteContact(params.duplicateContactId, params.agentId)

    revalidatePath("/dashboard/crm")

    return { success: true }
  } catch (error) {
    return handleError(error, "mergeContacts")
  }
}
