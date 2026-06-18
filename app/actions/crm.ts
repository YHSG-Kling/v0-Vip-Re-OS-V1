"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import {
  createContact as createContactService,
  updateContact as updateContactService,
  deleteContact as deleteContactService,
  getContact,
  getContacts as getContactsService,
  mergeContacts as mergeContactsService
} from "@/lib/services/contact-management.service"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"

/**
 * CRM-specific actions - uses consolidated contact service
 * Maintains backward compatibility for existing components
 */

export async function updateContactStage(params: {
  contactId: string
  newStage: string
  agentId: string
  notes?: string
}) {
  try {
    // Update contact stage using consolidated service
    const result = await updateContactService({
      contactId: params.contactId,
      agentId: params.agentId,
      updates: { stage: params.newStage } as any
    })

    if (!result.success) {
      return result
    }

    if (params.notes) {
      const supabase = await createClient()
      await supabase.from("activities").insert({
        contact_id:    params.contactId,
        activity_type: "stage_change",
        title:         `Stage changed to ${params.newStage}`,
        notes:         params.notes,
        outcome:       "completed",
        status:        "completed",
      })
    }

    revalidatePath("/crm/contacts")
    revalidatePath(`/crm/contacts/${params.contactId}`)
    revalidatePath("/dashboard")

    return result
  } catch (error) {
    return handleError(error, "updateContactStage")
  }
}

// Re-export consolidated service functions for backward compatibility
export async function updateContact(contactId: string, agentId: string, updates: any) {
  return updateContactService({
    contactId,
    agentId,
    updates
  })
}

export async function createContact(contact: {
  first_name: string
  last_name: string
  email?: string
  phone?: string
  contact_type?: string
  contact_persona?: string
  source?: string
  agent_id: string
}) {
  return createContactService({
    agentId: contact.agent_id,
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || '',
    phone: contact.phone,
    source: contact.source || 'manual',
    status: 'active'
  })
}

/**
 * Soft-delete a contact. Verifies ownership (agent_id) or admin role before
 * delegating to the service layer (which uses the admin client and would
 * otherwise blindly trust the IDs passed from the client).
 */
const CRM_ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export async function deleteContact(contactId: string, agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  // Resolve who actually owns the contact + the caller's role.
  const [{ data: contact }, { data: callerRow }, { data: callerAgent }] = await Promise.all([
    supabase.from("contacts").select("id, agent_id, brokerage_id").eq("id", contactId).maybeSingle(),
    supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle(),
    supabase.from("agents").select("id").eq("user_id", user.id).maybeSingle(),
  ])
  if (!contact) return { success: false, error: "Contact not found" }

  const isAdmin = callerRow && CRM_ADMIN_ROLES.has((callerRow.user_type ?? "") as string)
  const isOwner = callerAgent?.id && callerAgent.id === contact.agent_id
  const sameBrokerage = callerRow?.brokerage_id === contact.brokerage_id

  if (!sameBrokerage) return { success: false, error: "Forbidden: cross-brokerage" }
  if (!isOwner && !isAdmin) return { success: false, error: "Forbidden: not your contact" }

  return deleteContactService(contactId, agentId)
}

export async function getContacts(agentId: string, filters?: { status?: string; temperature?: string; search?: string }) {
  return getContactsService(agentId, filters)
}

export async function getContactById(contactId: string) {
  const { agentId } = await getAgentContext()
  if (!agentId) return { success: false, error: "Not authenticated" }
  return getContact(contactId, agentId)
}

export async function searchContacts(params: { agentId: string; query: string }) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", params.agentId)
      .or(`first_name.ilike.%${params.query}%,last_name.ilike.%${params.query}%,email.ilike.%${params.query}%,phone.ilike.%${params.query}%`)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) throw error

    return { success: true, contacts: data || [] }
  } catch (error) {
    return handleError(error, "searchContacts")
  }
}

export async function getContactTimeline(contactId: string) {
  try {
    const supabase = await createClient()

    const [interactions, tasks, communications, notes] = await Promise.all([
      supabase
        .from("activities")
        .select("id, activity_type, title, description, notes, outcome, channel, status, created_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
      supabase
        .from("tasks")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
      supabase
        .from("messages")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
    ])

    // Combine all timeline events
    const timeline = [
      ...(interactions.data || []).map((i: any) => ({ ...i, type: "interaction", date: i.created_at })),
      ...(tasks.data || []).map((t: any) => ({ ...t, type: "task", date: t.created_at })),
      ...(communications.data || []).map((c: any) => ({ ...c, type: "communication", date: c.created_at })),
      ...(notes.data || []).map((n: any) => ({ ...n, type: "note", date: n.created_at }))
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

    return { success: true, timeline }
  } catch (error) {
    return handleError(error, "getContactTimeline")
  }
}

export async function mergeContacts(params: { primaryContactId: string; duplicateContactId: string; agentId: string }) {
  return mergeContactsService(params)
}

/**
 * @deprecated Use addContactNote from communications.ts which includes GHL sync
 * This is a thin wrapper for backward compatibility
 */
export async function addContactNote(contactId: string, note: string) {
  const { addContactNote: addNoteWithSync } = await import("./communications")
  return addNoteWithSync({ contactId, note })
}
