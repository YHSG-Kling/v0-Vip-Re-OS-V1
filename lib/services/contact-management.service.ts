

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID, validateEmail, validatePhone, validateContact } from "@/lib/validations"
import { LEAD_SOURCES } from "@/lib/constants"
import { handleError, ValidationError, NotFoundError, DatabaseError } from "@/lib/errors"
import { calculateLeadScore } from "./lead-management.service"
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.

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

    // Resolve the owning brokerage from the agent. contacts has no
    // brokerage_id auto-denorm trigger, so it must be stamped explicitly
    // (business rule: brokerage_id required on every contact row).
    const { data: agentRow } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("id", params.agentId)
      .maybeSingle()
    if (!agentRow?.brokerage_id) {
      throw new ValidationError("Agent is not associated with a brokerage")
    }

    // Create contact. NOTE: contacts has no full_name/lead_score/
    // preferred_cities/tags columns — those are intentionally omitted.
    const { data: contact, error } = await supabase
      .from("contacts")
      .insert({
        agent_id: params.agentId,
        brokerage_id: agentRow.brokerage_id,
        first_name: params.firstName,
        last_name: params.lastName,
        email: params.email,
        phone: params.phone,
        source: params.source || "manual",
        status: params.status || "active",
        lead_temperature: "cold",
        budget_min: params.budgetMin,
        budget_max: params.budgetMax,
        notes: params.notes,
        created_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) {
      throw new DatabaseError("Failed to create contact", error)
    }

    // ENRICH AS SOON AS THE CONTACT COMES IN (owner's ruling). This is the CRM
    // manual-add service and it emits no CONTACT_CREATED, so the event-reactor
    // lane never saw an agent-typed contact. Voided — the add must not fail
    // because of enrichment. Live-deal suppression, the freshness check and the
    // already-pending check are all inside queueContactEnrichment.
    //
    // Queued rather than enriched inline: enrichment makes two paid vendor calls
    // and this runs on the request path. app/api/contacts/create/route.ts used
    // to fire an un-awaited enrichContact() here, which on a serverless runtime
    // is a coin-flip — the response returns, the function freezes, and the work
    // may never finish. A queue row survives that.
    void import("@/lib/enrichment/contact-enrichment-core")
      .then((m) =>
        m.queueContactEnrichment({
          contactId: contact.id,
          brokerageId: agentRow.brokerage_id as string,
          triggerType: "crm_manual_add",
        }),
      )
      .catch(() => {})

    // Calculate initial lead score
    await calculateLeadScore({
      id: contact.id,
      agentId: params.agentId,
    })

    revalidatePath("/dashboard/crm")
    revalidatePath("/crm/contacts")

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
        id: params.contactId,
        agentId: params.agentId,
        recalculate: true,
      })
    }

    revalidatePath("/dashboard/crm")
    revalidatePath("/crm/contacts")
    revalidatePath(`/crm/contacts/${params.contactId}`)

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
    revalidatePath("/crm/contacts")

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
