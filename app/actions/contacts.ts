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
import { revalidatePath } from "next/cache"
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
  offset?: number
  search?: string
}) {
  try {
    const { agentId, brokerageId, userType } = await getAgentContext()
    const supabase = await createClient()

    // ABSORBED (wave 16) from the retired /api/dashboard/data `contacts` branch:
    // a caller who may not be told anything is REFUSED, never handed a
    // successful empty list. This used to return `{ success: true, contacts: [] }`,
    // which renders "you have no contacts" for a session that has no tenant at
    // all — and pre-rollout that is indistinguishable from the truth.
    if (!brokerageId) {
      return {
        success: false,
        error: "Your account is not linked to a brokerage yet.",
        contacts: [] as any[],
      }
    }

    const limit = Math.min(Math.max(Math.floor(params?.limit ?? 100), 1), 500)
    const offset = Math.max(Math.floor(params?.offset ?? 0), 0)

    let query = supabase
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, contact_type, contact_persona, buyer_stage, status, city, state, engagement_score, last_contacted_at, referral_potential, created_at, deleted_at, brokerage_id, agent_id, source, source_family, dnc_status, email_opt_out, sms_opt_out, phone_opt_out"
      )
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .order("last_contacted_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })

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

    // Server-side search across name, email, and phone — avoids the 100-record client cap
    if (params?.search && params.search.trim().length > 0) {
      const term = params.search.trim()
      // Strip PostgREST-breaking chars; escape SQL LIKE wildcards
      const safeTerm = term.replace(/[(),%]/g, "").replace(/_/g, "\\_")
      query = query.or(
        `first_name.ilike.%${safeTerm}%,last_name.ilike.%${safeTerm}%,email.ilike.%${safeTerm}%,phone.ilike.%${safeTerm}%`
      )
    }

    query = query.range(offset, offset + limit - 1)

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
      contact_persona: contactData.contact_persona ?? undefined,
      notes:           contactData.notes ?? undefined,
      preferred_channel: contactData.preferred_channel ?? undefined,
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

    // Non-blocking portal invite creation — contact gets a portal slot immediately
    if (data.id && data.email) {
      void (async () => {
        const { createPortalInviteForContact } = await import("@/app/actions/portal-invites")
        await createPortalInviteForContact({
          contactId: data.id as string,
          brokerageId,
          invitedByUserId: userId,
          sendMagicLink: false,
        }).catch(() => {})
      })()
    }

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

/**
 * Soft-delete (archive) a contact — the ONE contact-removal door.
 *
 * WIRED (w4s1) — `app/crm/page.tsx` (contact detail header → Archive). Until now
 * the CRM had no way to remove a contact at all: this action had no caller, and
 * neither did the kernel command behind it.
 *
 * DUPLICATE — survivor is THIS function. The loser is
 * `app/actions/crm.ts:deleteContact` →
 * `lib/services/contact-management.service.ts:deleteContact`, which also soft-deletes
 * a contact by stamping `deleted_at`. That lane is kept for its barrel exports but
 * must not be used, because it is broken for the admin case and weaker throughout:
 *   · it takes a CALLER-SUPPLIED `agentId` and the service re-verifies ownership with
 *     `.eq("agent_id", agentId)`. A broker/admin archiving another agent's contact
 *     passes the gate in `app/actions/crm.ts` and is then rejected by the service —
 *     so the admin path can never succeed. This lane resolves the agent id
 *     SERVER-side from `getAgentContext()` and applies the agent predicate ONLY for
 *     `userType === "agent"`, so leadership works.
 *   · it scopes by agent, not by brokerage. This lane puts `brokerage_id` on the
 *     UPDATE predicate.
 *   · it has no `.is("deleted_at", null)` guard, so re-archiving rewrites the
 *     original archive timestamp.
 *   · it writes no lifecycle event; this lane writes CONTACT_ARCHIVED.
 * The one capability it had that this lacked — cache revalidation of the CRM
 * surfaces — is PORTED below. Its `status: 'deleted'` write is deliberately NOT
 * ported: `contacts.status` has no CHECK constraint (verified live) and every
 * reader already filters on `deleted_at IS NULL`, so a second, unconstrained
 * deletion flag is a divergence waiting to happen, not a capability.
 */
export async function archiveContact(contactId: string) {
  try {
    const { agentId, brokerageId, userType, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated || !brokerageId) {
      return { success: false, error: "Not authenticated" }
    }
    if (!contactId) {
      return { success: false, error: "contactId required" }
    }

    const result = await archiveContactRecord({
      contactId,
      brokerageId,
      agentId: agentId ?? undefined,
      userType: userType ?? undefined,
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    // PORTED from the losing lane: without these the archived contact stays on the
    // cached CRM lists until the next full reload, so the UI keeps showing a record
    // the user was just told is gone.
    revalidatePath("/crm")
    revalidatePath("/dashboard/crm")

    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─── addContactNote ───────────────────────────────────────────────────────────

/**
 * Canonical contact-note writer. Owner ruling: contact_notes is the store of
 * record — it carries is_private and author_user_id, which `activities` has no
 * column for. Every note path (CRM note box, GHL-sync path, voice assistant)
 * lands here so a note has exactly ONE row and the timeline cannot double-count.
 *
 * agentId is deliberately NOT required: contact_notes attributes to
 * author_user_id, so brokers/admins with no `agents` row can leave notes too.
 */
export async function addContactNote(contactId: string, noteText: string, isPrivate = false) {
  try {
    const { userId, brokerageId, isAuthenticated } = await getAgentContext()
    const supabase = await createClient()

    if (!isAuthenticated || !brokerageId) {
      return { success: false, error: "Not authenticated" }
    }
    if (!noteText?.trim()) {
      return { success: false, error: "Note cannot be empty" }
    }

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        brokerage_id:   brokerageId,
        contact_id:     contactId,
        author_user_id: userId,
        body:           noteText.trim(),
        is_private:     isPrivate,
      })
      .select("id")
      .maybeSingle()

    if (error) {
      return { success: false, error: error.message }
    }

    revalidatePath("/crm")
    revalidatePath("/dashboard")

    return { success: true, noteId: data?.id ?? null }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
