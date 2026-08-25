

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID, validateEmail, validatePhone, validateContact } from "@/lib/validations"
// `LEAD_SOURCES` was imported here and NEVER USED — a dead import that made the
// vocabulary look enforced at this write seam while `source: params.source ||
// "manual"` below let any string through. It is now genuinely used, via
// normalizeLeadSource: the same fold the other contacts.source writer uses
// (app/actions/contacts.ts createContact), so the two writers cannot disagree.
import { LEAD_SOURCES, normalizeLeadSource } from "@/lib/constants"
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


    // Validate inputs.
    //
    // PRESENCE first, then FORMAT through the shared validator. validateContact
    // (lib/validations/index.ts:133) runs the same three checks this function
    // used to inline one by one — uuid on agent_id, format on email, format on
    // phone — but it collects EVERY failure instead of throwing on the first, so
    // a caller who got both the email and the phone wrong is told both times
    // instead of being sent round the loop twice. It was imported here and never
    // called; the inline trio was the second spelling of it (CLAUDE.md §6).
    //
    // The required-email rule is NOT delegated: validateContact treats email as
    // optional (`if (data.email && …)`), so folding the presence check into it
    // would have let a contact through with no email at all — the field this
    // function immediately dedupes on.
    if (!params.email) {
      throw new ValidationError("Email is required")
    }

    const contactCheck = validateContact({
      email: params.email,
      phone: params.phone,
      agent_id: params.agentId,
    })
    if (!contactCheck.valid) {
      throw new ValidationError(contactCheck.errors.join("; "))
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

    // Lead-source vocabulary, enforced at the write rather than by the type.
    // contacts.source carries NO CHECK constraint (measured live 2026-08-25), so
    // an unrecognised value would otherwise persist verbatim and no scorer could
    // match it (§6). "manual" is the canonical default and is IN the vocabulary.
    const source = normalizeLeadSource(params.source ?? "manual")
    if (!source) {
      throw new ValidationError(
        `Unknown lead source "${params.source}". Expected one of: ${LEAD_SOURCES.join(", ")}.`
      )
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
        source,   // canonical — see the vocabulary gate above
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

    // THIS READ NAMED THREE RELATIONSHIPS POSTGREST CANNOT EMBED. Any ONE of them
    // refuses the WHOLE query, so this has never returned a contact — and the
    // `throw` below rendered that refusal as "Contact not found".
    //   · `buyer_persona(*)` — there is NO public.buyer_persona table and no such
    //     column on contacts. It is a phantom; do not restore it. The per-contact
    //     persona that DOES exist is client_detailed_personas
    //     (client_detailed_personas.contact_id -> contacts.id, one row per contact,
    //     written by lib/contacts/persona-builder.ts). Nothing here consumed the
    //     persona, so it is dropped rather than repointed.
    //   · `lead_intelligence` / `lead_behavioral_data` — both are keyed on `lead_id`
    //     and declare NO foreign key to contacts (pg_constraint carries brokerage_id
    //     only). PostgREST embeds on DECLARED relationships, so each raised PGRST200.
    //     Nothing here read either one; both are dropped. Where they ARE consumed
    //     they must be fetched by their lead_id link, never embedded on contacts —
    //     see lead-management.service.ts and app/actions/ai-chat.ts.
    // `transactions` has THREE foreign keys to contacts (contact_id, buyer_contact_id,
    // seller_contact_id), so the bare `transactions(*)` embed was ambiguous (PGRST201)
    // and would have failed on its own; it is now named by constraint, which picks the
    // side meant here — the deals this contact is the client on.
    // property_interactions IS a declared relationship (contact_id -> contacts.id) and
    // stays. Columns are named explicitly — never `*` inside an embed, which hides
    // drift from the schema guard (defect #214).
    const { data: contact, error } = await supabase
      .from("contacts")
      .select(`
        *,
        property_interactions(
          id,
          interaction_type,
          created_at,
          listings(id, address, city, state, list_price, status)
        ),
        transactions!transactions_contact_id_fkey(
          id,
          deal_name,
          property_address,
          status,
          close_date,
          purchase_price
        )
      `)
      .eq("id", contactId)
      .eq("agent_id", agentId)
      .single()

    if (error) {
      // A refused query and an absent row arrive here identically, and answering a
      // refusal with "not found" is how the broken embeds stayed invisible. Say which.
      console.error("[getContact] contacts read failed:", error.message)
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

    // `buyer_persona(*)` named a relation that DOES NOT EXIST (no public.buyer_persona
    // table, no such column on contacts), and `lead_intelligence` is keyed on lead_id
    // with NO foreign key to contacts. Either one refuses the WHOLE query (PGRST200),
    // so this list has never returned a contact — the caller rendered the refusal as an
    // empty CRM. Nothing read either embed off this result, so both are dropped rather
    // than repointed; the real per-contact persona is client_detailed_personas
    // (contact_id -> contacts.id) and can be embedded if a consumer ever needs it.
    let query = supabase
      .from("contacts")
      .select("*")
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
      // `full_name` is NOT a column on contacts (the live table carries first_name /
      // last_name separately). A bad column in a filter refuses the query exactly the
      // way a bad embed does, so every searched list came back as "no matches". Matched
      // the way crm.ts:searchContacts already does it, against columns that exist.
      const term = filters.search
      query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
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

    // Merge data (prefer primary, but take non-null from duplicate).
    //
    // `preferred_cities` USED TO BE MERGED HERE AND IS GONE ON PURPOSE. There is no
    // such column on `contacts` (scripts/schema-snapshot.ts; the same fact is already
    // written down at the insert path above: "contacts has no full_name/lead_score/
    // preferred_cities/tags columns"). Naming it made PostgREST refuse this UPDATE
    // ENTIRELY (PGRST204) — so phone, budgets, tags and the merged notes were never
    // written either. And because the refusal was never destructured, supabase-js
    // RESOLVED it: the merge reported success, the relationship transfers below ran,
    // and the duplicate was then soft-deleted — losing every field this function
    // claims to preserve. Nothing is lost by dropping the key: the column does not
    // exist, so `primary.preferred_cities` was always undefined and the merge of two
    // undefineds was always [].
    const merged = {
      phone: primary.phone || duplicate.phone,
      budget_min: primary.budget_min || duplicate.budget_min,
      budget_max: primary.budget_max || duplicate.budget_max,
      tags: [...new Set([...(primary.tags || []), ...(duplicate.tags || [])])],
      notes: [primary.notes, duplicate.notes].filter(Boolean).join("\n\n---MERGED---\n\n"),
    }

    // Update primary contact. The error is READ: a refused merge must not be followed
    // by transferring relationships off the duplicate and soft-deleting it.
    const { error: mergeError } = await supabase.from("contacts").update(merged).eq("id", params.primaryContactId)
    if (mergeError) {
      throw new DatabaseError("Failed to merge contact fields onto primary", mergeError)
    }

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
