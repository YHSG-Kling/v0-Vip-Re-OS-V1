"use server"

/**
 * app/actions/contacts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Server actions for the CRM / Contact OS.
 *
 * Ownership:
 *   - All dedup, enrichment queue, merge, and suppression logic lives in
 *     lib/kernel/crm.ts — never duplicated here.
 *   - This file validates the actor context and delegates to kernel commands.
 *
 * Schema facts used here:
 *   - contacts.agent_id → agents.id (FK corrected in migration 114)
 *   - contacts.phone_digits → normalized digits-only for dedup
 *   - contacts.source, source_family, source_channel, source_subtype — all exist
 *   - activities table (not activity_log) for notes/timeline
 *   - lead_enrichment_queue for enrichment pipeline
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { syncContactToCRM } from "@/lib/crm/sync"
import {
  createContactManually,
  updateContactRecord,
  archiveContactRecord,
} from "@/lib/kernel/crm"

// ─── getContacts ──────────────────────────────────────────────────────────────

export async function getContacts(params?: {
  status?: string
  contact_type?: string
  limit?: number
  search?: string
}) {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()
    const supabase = await createClient()

    if (!brokerageId) {
      return { success: true, contacts: [] }
    }

    let query = supabase
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, contact_type, contact_persona, buyer_stage, status, city, state, engagement_score, last_contacted_at, referral_potential, created_at, deleted_at, brokerage_id, agent_id, source, source_family, dnc_status, email_opt_out, sms_opt_out, phone_opt_out"
      )
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .order("last_contacted_at", { ascending: false, nullsFirst: false })

    // Agents only see their own contacts — contacts.agent_id → agents.id
    if (userType === "agent" && agentId) {
      query = query.eq("agent_id", agentId)
    }

    if (params?.status) {
      query = query.eq("status", params.status)
    }

    if (params?.contact_type) {
      query = query.eq("contact_type", params.contact_type)
    }

    if (params?.limit) {
      query = query.limit(params.limit)
    }

    const { data, error } = await query

    if (error) {
      return { success: false, error: error.message, contacts: [] }
    }

    return { success: true, contacts: data ?? [] }
  } catch (error: any) {
    return { success: false, error: error.message, contacts: [] }
  }
}

// ─── getContactById ───────────────────────────────────────────────────────────

export async function getContactById(contactId: string) {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()
    const supabase = await createClient()

    if (!brokerageId) {
      return { success: false, error: "No brokerage context", contact: null }
    }

    let query = supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)

    if (userType === "agent" && agentId) {
      query = query.eq("agent_id", agentId)
    }

    const { data, error } = await query.maybeSingle()

    if (error) {
      return { success: false, error: error.message, contact: null }
    }
    if (!data) {
      return { success: false, error: "Contact not found", contact: null }
    }

    return { success: true, contact: data }
  } catch (error: any) {
    return { success: false, error: error.message, contact: null }
  }
}

// ─── createContact ────────────────────────────────────────────────────────────
/**
 * Delegates to createContactManually() in lib/kernel/crm.ts.
 * Dedup, enrichment queue, activity creation, and agent notification are all
 * handled by the kernel — not duplicated here.
 *
 * contacts.agent_id must be agents.id — resolved from the agents table via user_id.
 */
export async function createContact(contactData: {
  first_name: string
  last_name: string
  email?: string
  phone?: string
  city?: string
  state?: string
  zip_code?: string
  contact_type?: "buyer" | "seller" | "both" | "investor"
  status?: string
  contact_persona?: string
  notes?: string
  preferred_channel?: string
  tcpa_consent?: boolean
  source?: string
  source_family?: string
  source_channel?: string
  source_subtype?: string
  }) {
  try {
    const { agentId, brokerageId, isAuthenticated, userId } = await getAgentContext()
    
    if (!isAuthenticated || !userId) {
      return { success: false, error: "Not authenticated" }
    }
    if (!brokerageId) {
      return { success: false, error: "No brokerage configured" }
    }
    
    // agentId from getAgentContext() is already agents.id (not users.id)
    // but verify it exists; if the context returned users.id as fallback, resolve it
    if (!agentId) {
      return { success: false, error: "No agent record found for this user" }
    }
    
    // Delegate to kernel — handles dedup, enrichment queue, activity, notification
    const result = await createContactManually({
      first_name:      contactData.first_name,
      last_name:       contactData.last_name,
      email:           contactData.email ?? null,
      phone:           contactData.phone ?? null,
      city:            contactData.city ?? null,
      state:           contactData.state ?? null,
      zip_code:        contactData.zip_code ?? null,
      contact_type:    contactData.contact_type ?? "buyer",
      status:          contactData.status ?? "new",
      contact_persona: contactData.contact_persona ?? null,
      notes:           contactData.notes ?? null,
      preferred_channel: contactData.preferred_channel ?? null,
      tcpa_consent:    contactData.tcpa_consent ?? false,
      agent_id:        agentId,   // agents.id — FK-correct
      brokerage_id:    brokerageId,
      source_label:    contactData.source ?? "manual",
    })

    if (!result.success || !result.contact) {
      return { success: false, error: result.error ?? "Failed to create contact" }
    }

    const data = result.contact

    // Non-blocking CRM sync (GHL/external CRM) — does not block the response
    void syncContactToCRM({
      firstName:   contactData.first_name,
      lastName:    contactData.last_name,
      email:       contactData.email,
      phone:       contactData.phone,
      tags:        [contactData.contact_type, contactData.status].filter(Boolean) as string[],
      source:      "kernel",
      brokerageId,
      agentId,
    }).catch(() => {})

    return { success: true, contact: data, isDuplicate: result.isDuplicate ?? false }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── updateContact ────────────────────────────────────────────────────────────

export async function updateContact(contactId: string, updates: Partial<{
  first_name: string
  last_name: string
  email: string
  phone: string
  contact_type: string
  status: string
  contact_persona: string
  buyer_stage: string
  notes: string
  preferred_channel: string
  tcpa_consent: boolean
}>) {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()

    if (!brokerageId) {
      return { success: false, error: "No brokerage context" }
    }

    const result = await updateContactRecord({
      contactId,
      brokerageId,
      agentId: agentId ?? undefined,
      userType: userType ?? undefined,
      updates,
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return { success: true, contact: result.contact }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── archiveContact ───────────────────────────────────────────────────────────

export async function archiveContact(contactId: string) {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()

    if (!brokerageId) {
      return { success: false, error: "No brokerage context" }
    }

    const result = await archiveContactRecord({
      contactId,
      brokerageId,
      agentId: agentId ?? undefined,
      userType: userType ?? undefined,
    })

    return result.success ? { success: true } : { success: false, error: result.error }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── addContactNote ───────────────────────────────────────────────────────────

export async function addContactNote(contactId: string, noteText: string) {
  try {
    const { agentId, brokerageId, isAuthenticated } = await getAgentContext()
    const supabase = await createClient()

    if (!isAuthenticated || !agentId || !brokerageId) {
      return { success: false, error: "Not authenticated" }
    }
    if (!noteText?.trim()) {
      return { success: false, error: "Note cannot be empty" }
    }

    const { error } = await supabase.from("activities").insert({
      brokerage_id:  brokerageId,
      agent_id:      agentId,     // agents.id — kernel-resolved
      contact_id:    contactId,
      activity_type: "note",
      title:         "Note",
      description:   noteText.trim(),
      entity_type:   "contact",
      status:        "completed",
    })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
