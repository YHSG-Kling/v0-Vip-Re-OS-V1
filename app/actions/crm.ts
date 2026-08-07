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

/**
 * Move a contact to a new pipeline stage, and record that it happened.
 *
 * Relationship to `updateContact` (which is the same `updateContactService`
 * passthrough): the stage write itself is shared, so that part is a duplicate.
 * What is NOT duplicated — and is the reason this function survives rather than
 * folding into `updateContact` — is the **stage-change audit row**. A stage move
 * is the one contact edit that means something later (pipeline reporting,
 * conversion timing), so it gets an `activities` entry with the agent's note.
 *
 * THE AUDIT ROW HAD NEVER ONCE BEEN WRITTEN. The insert omitted `brokerage_id`,
 * which is NOT NULL with **no default** on `activities` — verified against the
 * live database, where the exact former payload fails with:
 *
 *   23502: null value in column "brokerage_id" of relation "activities"
 *          violates not-null constraint
 *
 * and the result was never destructured, so the error was discarded and the
 * function returned the successful stage update either way. Every stage change
 * ever made reported a note recorded that does not exist. Fixed rather than
 * ported as-is: the intent (audit the move) was right, the implementation was
 * not.
 *
 * `agentId` is no longer taken from the caller. This is a "use server" export,
 * i.e. a public endpoint, and the service's ownership check is
 * `.eq("agent_id", params.agentId)` — comparing the contact against whatever id
 * the caller supplied, which checks nothing. It now comes from the session.
 * `agents.id` and `users.id` are disjoint spaces here; `ctx.agentId` is
 * `agents.id`, which is what both `contacts.agent_id` and `activities.agent_id`
 * reference (confirmed against the live FKs).
 */
export async function updateContactStage(params: {
  contactId: string
  newStage: string
  /** Ignored — derived from the session. Kept so existing callers still typecheck. */
  agentId?: string
  notes?: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.agentId || !ctx.brokerageId) {
      return { success: false, error: "Not authenticated" }
    }

    // Update contact stage using consolidated service
    const result = await updateContactService({
      contactId: params.contactId,
      agentId: ctx.agentId,
      updates: { stage: params.newStage } as any
    })

    if (!result.success) {
      return result
    }

    if (params.notes) {
      const supabase = await createClient()
      const { error: activityError } = await supabase.from("activities").insert({
        brokerage_id:  ctx.brokerageId,   // NOT NULL, no default — the omission that broke this
        entity_type:   "contact",         // NOT NULL (defaults to 'unknown' — name it properly)
        entity_id:     params.contactId,
        agent_id:      ctx.agentId,       // agents.id
        contact_id:    params.contactId,
        activity_type: "stage_change",
        title:         `Stage changed to ${params.newStage}`,
        notes:         params.notes,
        outcome:       "completed",
        status:        "completed",
      })
      // The stage HAS moved at this point, so don't claim the whole operation
      // failed — but don't claim the note was recorded when it wasn't, either.
      if (activityError) {
        return {
          ...result,
          warning: `Stage updated, but the change note was not recorded: ${activityError.message}`,
        }
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// MERGE / DEDUPE
//
// COMPLETENESS VERDICT on the original lib/services/contact-management.service
// mergeContacts: it merged the contact ROW (phone/budget/cities/tags/notes,
// primary wins) and moved only TWO child tables (property_interactions,
// transactions.contact_id) before soft-deleting the duplicate — every other
// child row (activities, tasks, messages, notes, leads, conversations, portal
// invites/messages/access logs, showings, offers, property alerts, interests,
// segments, agent client messages, transactions' buyer/seller contact columns)
// stayed pointed at the soft-deleted duplicate: STRANDED history. The action
// below EXTENDS the merge — it moves the full child set FIRST with checked
// writes and honest per-table counters, then delegates the field merge +
// property_interactions/transactions.contact_id move + soft delete to the
// existing service, then audits via the activities idiom.
// ─────────────────────────────────────────────────────────────────────────────

/** Child tables re-pointed from the duplicate to the survivor before the
 *  service-level merge runs. Column named where it isn't contact_id. */
const MERGE_CHILD_TABLES: Array<{ table: string; column: string }> = [
  { table: "activities",                     column: "contact_id" },
  { table: "tasks",                          column: "contact_id" },
  { table: "messages",                       column: "contact_id" },
  { table: "contact_notes",                  column: "contact_id" },
  { table: "leads",                          column: "contact_id" },
  { table: "conversations",                  column: "contact_id" },
  { table: "client_portal_messages",         column: "contact_id" },
  { table: "portal_contact_invites",         column: "contact_id" },
  { table: "portal_access_logs",             column: "contact_id" },
  { table: "showings",                       column: "contact_id" },
  { table: "offers",                         column: "contact_id" },
  { table: "property_alerts",                column: "contact_id" },
  { table: "property_interests",             column: "contact_id" },
  { table: "contact_segments",               column: "contact_id" },
  { table: "agent_client_messages",          column: "recipient_contact_id" },
  { table: "smart_showing_recommendations",  column: "contact_id" },
  // The service moves transactions.contact_id; the side-specific columns are ours:
  { table: "transactions",                   column: "buyer_contact_id" },
  { table: "transactions",                   column: "seller_contact_id" },
]

/** Who may merge: the owning agent of BOTH contacts, or a brokerage manager. */
async function requireMergeAuthority(primaryContact: { agent_id: string | null; brokerage_id: string | null }, duplicateContact: { agent_id: string | null; brokerage_id: string | null }) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false as const, error: "Not authenticated" }
  if (primaryContact.brokerage_id !== ctx.brokerageId || duplicateContact.brokerage_id !== ctx.brokerageId) {
    return { ok: false as const, error: "Forbidden: cross-brokerage merge" }
  }
  const isManager = CRM_ADMIN_ROLES.has(ctx.role)
  const ownsBoth = !!ctx.agentId && primaryContact.agent_id === ctx.agentId && duplicateContact.agent_id === ctx.agentId
  if (!isManager && !ownsBoth) return { ok: false as const, error: "Forbidden: not your contacts" }
  return { ok: true as const, ctx }
}

export interface MergeContactsResult {
  success: boolean
  error?: string
  /** Per-table child rows re-pointed to the survivor (honest counts). */
  moved?: Record<string, number>
  /** Tables whose move FAILED — surfaced, never silent. */
  failed?: string[]
}

/**
 * mergeContacts — EXTENDED complete merge. Moves every known child row from
 * the duplicate to the survivor (checked writes, honest counters), then runs
 * the existing service merge (field union + property_interactions +
 * transactions.contact_id + soft delete of the duplicate), then audits.
 * A child-move failure ABORTS before the duplicate is deleted — we never
 * soft-delete a contact whose history didn't fully move.
 */
export async function mergeContacts(params: {
  primaryContactId: string
  duplicateContactId: string
  agentId: string
}): Promise<MergeContactsResult> {
  try {
    if (!isValidUUID(params.primaryContactId) || !isValidUUID(params.duplicateContactId)) {
      return { success: false, error: "Invalid contact IDs" }
    }
    if (params.primaryContactId === params.duplicateContactId) {
      return { success: false, error: "Pick two different contacts" }
    }

    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    const [{ data: primary }, { data: duplicate }] = await Promise.all([
      svc.from("contacts").select("id, agent_id, brokerage_id").eq("id", params.primaryContactId).maybeSingle(),
      svc.from("contacts").select("id, agent_id, brokerage_id").eq("id", params.duplicateContactId).maybeSingle(),
    ])
    if (!primary || !duplicate) return { success: false, error: "One or both contacts not found" }

    const auth = await requireMergeAuthority(primary as any, duplicate as any)
    if (!auth.ok) return { success: false, error: auth.error }

    // ── 1. Move ALL child rows first (checked writes — a failure aborts) ──
    const moved: Record<string, number> = {}
    const failed: string[] = []
    for (const { table, column } of MERGE_CHILD_TABLES) {
      const { count, error } = await svc
        .from(table)
        .update({ [column]: params.primaryContactId }, { count: "exact" })
        .eq(column, params.duplicateContactId)
      const key = column === "contact_id" ? table : `${table}.${column}`
      if (error) {
        console.error(`[mergeContacts] child move failed for ${key}:`, error.message)
        failed.push(key)
      } else if ((count ?? 0) > 0) {
        moved[key] = count ?? 0
      }
    }
    if (failed.length > 0) {
      // NEVER soft-delete a duplicate whose history didn't fully move.
      return {
        success: false,
        error: `Merge aborted — child rows could not be moved for: ${failed.join(", ")}. Nothing was deleted.`,
        moved,
        failed,
      }
    }

    // ── 2. Field merge + property_interactions + transactions.contact_id +
    //       soft delete — the existing service (survivor's fields win). The
    //       service checks agent_id, so pass the contacts' actual owner. ──
    const serviceRes = await mergeContactsService({
      primaryContactId: params.primaryContactId,
      duplicateContactId: params.duplicateContactId,
      agentId: (primary as any).agent_id ?? params.agentId,
    })
    if (!(serviceRes as any)?.success) {
      return {
        success: false,
        error: (serviceRes as any)?.error ?? "Field merge failed (child rows were already moved to the survivor — safe, nothing deleted)",
        moved,
      }
    }

    // ── 3. Audit — the activities idiom (same as updateContactStage) ──
    await svc.from("activities").insert({
      contact_id:    params.primaryContactId,
      brokerage_id:  (primary as any).brokerage_id,
      agent_id:      (primary as any).agent_id,
      activity_type: "contact_merged",
      title:         "Duplicate contact merged",
      description:   `Merged duplicate ${params.duplicateContactId} into this contact. Moved: ${
        Object.entries(moved).map(([t, n]) => `${t}(${n})`).join(", ") || "no child rows"
      }.`,
      status:        "completed",
      metadata:      { duplicate_contact_id: params.duplicateContactId, moved, by: auth.ctx.userId },
    }).then(() => {}, (e: unknown) => console.error("[mergeContacts] audit failed:", e))

    revalidatePath("/crm")
    revalidatePath("/dashboard/crm")
    return { success: true, moved }
  } catch (error) {
    return handleError(error, "mergeContacts") as MergeContactsResult
  }
}

export interface DuplicateCandidate {
  contactId: string
  name: string
  email: string | null
  phone: string | null
  createdAt: string | null
  score: number
  /** True only with a strong identifier (exact email/phone) — same rule the
   *  raw-lead pipeline enforces (lib/lead-pipeline/fuzzy-matcher). */
  confident: boolean
}

/**
 * findDuplicateContacts — candidate duplicates for one contact, scored with
 * the SAME fuzzy matcher the raw-lead dedup pipeline uses (name-only matches
 * are surfaced but never marked confident — no same-name PII conflation).
 */
export async function findDuplicateContacts(contactId: string): Promise<
  { success: true; candidates: DuplicateCandidate[] } | { success: false; error: string }
> {
  try {
    if (!isValidUUID(contactId)) return { success: false, error: "Invalid contact ID" }
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data: me } = await svc
      .from("contacts")
      .select("id, agent_id, brokerage_id, first_name, last_name, email, phone")
      .eq("id", contactId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (!me) return { success: false, error: "Contact not found" }
    const isManager = CRM_ADMIN_ROLES.has(ctx.role)
    if (!isManager && (!ctx.agentId || (me as any).agent_id !== ctx.agentId)) {
      return { success: false, error: "Forbidden: not your contact" }
    }

    // Candidates: same owning agent's live contacts (a merge is only allowed
    // within one book unless a manager runs it — and even a manager's picker
    // stays inside the same book to avoid cross-agent surprises).
    const { data: rows } = await svc
      .from("contacts")
      .select("id, first_name, last_name, email, phone, created_at")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_id", (me as any).agent_id)
      .neq("id", contactId)
      .neq("status", "deleted")
      .is("deleted_at", null)
      .limit(500)

    const { calculateFuzzyMatch, isConfidentMatch, DEDUP_MERGE_THRESHOLD } = await import("@/lib/lead-pipeline/fuzzy-matcher")
    const candidates: DuplicateCandidate[] = []
    for (const c of (rows ?? []) as any[]) {
      const match = calculateFuzzyMatch(
        { first_name: (me as any).first_name, last_name: (me as any).last_name, email: (me as any).email, phone: (me as any).phone },
        { first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone },
      )
      if (match.score < DEDUP_MERGE_THRESHOLD) continue
      candidates.push({
        contactId: c.id,
        name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Unnamed contact",
        email: c.email ?? null,
        phone: c.phone ?? null,
        createdAt: c.created_at ?? null,
        score: Math.round(match.score * 100) / 100,
        confident: isConfidentMatch(match),
      })
    }
    candidates.sort((a, b) => Number(b.confident) - Number(a.confident) || b.score - a.score)
    return { success: true, candidates: candidates.slice(0, 20) }
  } catch (error) {
    return handleError(error, "findDuplicateContacts") as { success: false; error: string }
  }
}

/**
 * @deprecated Use addContactNote from communications.ts which includes GHL sync
 * This is a thin wrapper for backward compatibility
 */
export async function addContactNote(contactId: string, note: string) {
  const { addContactNote: addNoteWithSync } = await import("./communications")
  return addNoteWithSync({ contactId, note })
}
