"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { syncContactToCRM } from "@/lib/crm/sync"

export async function getContacts(params?: {
  status?: string
  contact_type?: string
  limit?: number
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
        "id, first_name, last_name, email, phone, contact_type, contact_persona, buyer_stage, status, city, state, engagement_score, last_contacted_at, created_at, deleted_at, brokerage_id, agent_id"
      )
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null) // exclude archived contacts
      .order("last_contacted_at", { ascending: false, nullsFirst: false })

    // Agents only see their own contacts; broker/admin sees all brokerage contacts
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

    return { success: true, contacts: data || [] }
  } catch (error: any) {
    return { success: false, error: error.message, contacts: [] }
  }
}

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

    // Agents can only read their own contacts
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

export async function createContact(contactData: {
  first_name: string
  last_name: string
  email?: string
  phone?: string
  contact_type?: "buyer" | "seller" | "both" | "investor"
  status?: string
}) {
  try {
    const supabase = await createClient()
    const { agentId, brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated || !agentId) {
      return { success: false, error: "Not authenticated" }
    }
    if (!brokerageId) {
      return { success: false, error: "No brokerage configured" }
    }

    const { data, error } = await supabase
      .from("contacts")
      .insert({
        first_name: contactData.first_name,
        last_name: contactData.last_name,
        email: contactData.email ?? null,
        phone: contactData.phone ?? null,
        contact_type: contactData.contact_type ?? "buyer",
        status: contactData.status ?? "new",
        agent_id: agentId,
        brokerage_id: brokerageId,
      })
      .select()
      .single()

    if (error) {
      return { success: false, error: error.message }
    }

    // Non-blocking CRM sync
    void syncContactToCRM({
      firstName: data.first_name,
      lastName: data.last_name,
      email: data.email ?? undefined,
      phone: data.phone ?? undefined,
      tags: [data.contact_type, data.status].filter(Boolean) as string[],
      source: "kernel",
      brokerageId: brokerageId,
      agentId: agentId,
    }).catch(() => {})

    return { success: true, contact: data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

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
}>) {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()
    const supabase = await createClient()

    if (!brokerageId) {
      return { success: false, error: "No brokerage context" }
    }

    let query = supabase
      .from("contacts")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)

    // Agents can only update their own contacts
    if (userType === "agent" && agentId) {
      query = query.eq("agent_id", agentId)
    }

    const { data, error } = await query.select().maybeSingle()

    if (error) {
      return { success: false, error: error.message }
    }
    if (!data) {
      return { success: false, error: "Contact not found or no access" }
    }

    return { success: true, contact: data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/** Soft-archive a contact: sets deleted_at, preserves all history. */
export async function archiveContact(contactId: string) {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()
    const supabase = await createClient()

    if (!brokerageId) {
      return { success: false, error: "No brokerage context" }
    }

    let query = supabase
      .from("contacts")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", contactId)
      .eq("brokerage_id", brokerageId)

    if (userType === "agent" && agentId) {
      query = query.eq("agent_id", agentId)
    }

    const { error } = await query

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/** Add a note for a contact, written to the activities table. */
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
      brokerage_id: brokerageId,
      agent_id: agentId,
      contact_id: contactId,
      activity_type: "note",
      title: "Note",
      description: noteText.trim(),
      entity_type: "contact",
      status: "completed",
    })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
