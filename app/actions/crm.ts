"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import {
  deleteContact as deleteContactService,
  mergeContacts as mergeContactsService
} from "@/lib/services/contact-management.service"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { bestEffort } from "@/lib/db/best-effort"

/**
 * CRM-specific actions - uses consolidated contact service
 * Maintains backward compatibility for existing components
 */

// ── DELETED: updateContactStage ─────────────────────────────────────────────
//
// IT COULD NEVER HAVE WORKED, AND THE FUNCTIONALITY LIVES ELSEWHERE.
//
// It called updateContactService with `{ stage: params.newStage }`. THERE IS NO
// `stage` COLUMN ON `contacts` — verified against the live database, whose
// stage-ish columns are buyer_stage, lifecycle_state, status, nurture_status
// and credit_pipeline_stage, and none of them is `stage`. The write therefore
// failed PGRST204 ("column contacts.stage does not exist") on every call, which
// updateContactService turns into a thrown DatabaseError, so this action's only
// possible outcomes were the catch block and an error result. No contact stage
// has ever moved through it. The `as any` on the updates object is what let it
// compile.
//
// WHERE THE JOB LIVES NOW:
//   · MOVING a contact through the lifecycle:
//     lib/buyer-lifecycle/lifecycle-logger.ts:53 `emitLifecycleTransition`
//     → transitionLifecycle → lifecycle_events. That is this function's exact
//     stated purpose ("move a contact to a new pipeline stage, AND record that
//     it happened") against tables that exist, and it does it better: from-state
//     and to-state, actor + authority role, source system, override reason, and
//     it returns the activity id of the audit row it wrote. Its reader
//     (getCurrentBuyerState / buyer_lifecycle_current_states) is live.
//   · EDITING any other contact field: `updateContact` immediately below, the
//     same updateContactService passthrough this wrapped.
//
// NOTHING WAS MERGED FORWARD, because nothing here worked to merge: the stage
// write was impossible, and the `activities` audit row it wrote alongside is a
// strictly poorer version of the lifecycle_events row emitLifecycleTransition
// already writes (which additionally carries from_state and the actor's
// authority). The free-text `notes` argument has an equivalent in that path's
// `metadata` / `overrideReason`.
//
// Deliberately NOT touched on the way out: nothing here read or wrote
// `contacts.timeline`, so no timeline vocabulary moved with it.

// ── DELETED: updateContact (wave 57, Task B duplicates round 2) ────────────
//
// SURVIVOR: app/actions/contacts.ts:333 updateContact (session-derived
// tenancy, delegates to lib/kernel/crm.ts updateContactRecord).
//
// This was a thin re-export of lib/services/contact-management.service.ts's
// updateContact (deleted the same wave, tombstone there names the same
// survivor) — that implementation took agentId directly from the caller
// with no session check, the exact body-supplied-identity IDOR shape
// CLAUDE.md §4 names. Zero live callers: every product import of
// updateContact already named "@/app/actions/contacts".

// ── DELETED: createContact (wave 56, lane OC, Task C duplicates sweep) ──────
//
// SURVIVOR: app/actions/contacts.ts:211 createContact (delegates to
// createContactManually in lib/kernel/crm.ts).
//
// This was a SECOND, THINNER parallel implementation. It delegated to
// lib/services/contact-management.service.ts:createContact, which: (a) took
// agent_id DIRECTLY FROM THE REQUEST BODY with no session-derived tenant
// check — the exact body-supplied-identity IDOR shape CLAUDE.md §4 names
// ("Body-supplied brokerageId on a service client is the IDOR shape found
// repeatedly here" — here it is agent_id, same category); (b) enforced no
// lead-source vocabulary (the survivor's normalizeLeadSource gate, added
// after quick-capture's `lead_source`→`source` field-mismatch defect —
// see manager-registry.ts vendor_tenancy_lead_source — did not exist here);
// (c) ran no dedup/enrichment-queue/activity-creation/agent-notification —
// the kernel-level side effects the survivor's createContactManually
// performs and this comment block below it (line ~203) already documents
// were "not duplicated here" for a REASON: the kernel does it once.
//
// Zero live callers: every product import of createContact (app/crm/page.tsx,
// app/crm/contacts/new/page.tsx, app/dashboard/acquisition/acquisition-quick-capture.tsx)
// already named "@/app/actions/contacts", never "@/app/actions/crm". Nothing
// repointed because nothing pointed here.
//
// lib/services/contact-management.service.ts:createContact (the function this
// wrapper called) is left in place — it is still named by the lib/services
// barrel (lib/services/index.ts) and is not itself the duplicate; only this
// thinner "use server" wrapper is retired. Its remaining direct callers in
// this file (updateContact/deleteContact/getContacts/mergeContacts →
// contact-management.service.ts) are untouched.

/**
 * Soft-delete a contact. Verifies ownership (agent_id) or admin role before
 * delegating to the service layer (which uses the admin client and would
 * otherwise blindly trust the IDs passed from the client).
 */
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

  const isAdmin = callerRow && isAdminOrBroker({ user_type: (callerRow.user_type ?? "") as string })
  const isOwner = callerAgent?.id && callerAgent.id === contact.agent_id
  const sameBrokerage = callerRow?.brokerage_id === contact.brokerage_id

  if (!sameBrokerage) return { success: false, error: "Forbidden: cross-brokerage" }
  if (!isOwner && !isAdmin) return { success: false, error: "Forbidden: not your contact" }

  return deleteContactService(contactId, agentId)
}

// TOMBSTONE (§1 orphan doctrine, DUPLICATES ROUND 3, 2026-09-11): getContacts
// used to live here as a thin "use server" wrapper over
// lib/services/contact-management.service.ts's getContacts(agentId, filters)
// — zero in-tree callers (the tombstone at this file's top already flagged it
// as one of the "remaining direct callers... untouched" siblings of the
// createContact wrapper removed in that pass). The SURVIVOR is
// app/actions/contacts.ts:94's getContacts(params) — session-derived
// brokerage_id (never an agentId parameter, per CLAUDE.md §4: tenant comes
// from the session), pagination, search and contact_type filtering, and it is
// the getContacts every live page imports (app/crm/page.tsx,
// app/credit-pipeline/page.tsx, app/dashboard/forms/FormsLibraryClient.tsx).
// This file's other service delegates (getContactById, mergeContacts) are
// untouched — only the exact-duplicate name/purpose pair is resolved here.
// TOMBSTONE (§1 orphan doctrine, DUPLICATES ROUND 5, lane 59C, 2026-09-12):
// getContactById DELETED — zero in-tree callers (a thin "use server" wrapper
// over lib/services/contact-management.service.ts's getContact). SURVIVOR:
// app/actions/contacts.ts:170's getContactById (session-derived brokerage_id
// + agent scoping per CLAUDE.md §4, the getContactById every live page
// imports). The rich derived enrichment `getContact` computed — transaction
// rollup, referral_count, vendor rating/service_areas — was itself orphaned
// by this deletion (its only caller was this wrapper), so it was BUILT into
// the survivor rather than lost: app/actions/contacts.ts:170 now calls
// lib/services/contact-management.service.ts's getContact keyed on the
// contact's own agent_id after its own tenant check passes.

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

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getContactTimeline` deleted.
// SURVIVOR: app/actions/contact-details.ts:getContactActivity (wired at
// app/crm/page.tsx:417), which is the gated, tenant-checked, error-honest
// contact timeline. What this twin had that the survivor lacked — the
// `contact_notes` source — was merged onto the survivor first. This copy had
// no auth gate at all (a bare contact uuid returned another tenant's history
// up to RLS), and a stripped-source census found zero callers outside the
// the actions barrel (app/actions/index, deleted this wave) barrel, which itself has zero importers.

// ─────────────────────────────────────────────────────────────────────────────
// MERGE / DEDUPE
//
// COMPLETENESS VERDICT on the original lib/services/contact-management.service
// mergeContacts: it merged the contact ROW (phone/budget/cities/tags/notes,
// primary wins) and moved only TWO child tables (buyer_behavior_log,
// transactions.contact_id — the behavior re-key was property_interactions until
// m598 retired that zero-writer twin onto buyer_behavior_log, the live table
// carrying the per-contact behavior trail) before soft-deleting the duplicate —
// every other child row (activities, tasks, messages, notes, leads, conversations,
// portal invites/messages/access logs, showings, offers, property alerts,
// interests, segments, agent client messages, transactions' buyer/seller contact
// columns) stayed pointed at the soft-deleted duplicate: STRANDED history. The
// action below EXTENDS the merge — it moves the full child set FIRST with checked
// writes and honest per-table counters, then delegates the field merge +
// buyer_behavior_log/transactions.contact_id move + soft delete to the
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
  const isManager = isAdminOrBroker({ user_type: ctx.role })
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
 * the existing service merge (field union + buyer_behavior_log +
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

    // ── 2. Field merge + buyer_behavior_log + transactions.contact_id +
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
    await bestEffort(
      svc.from("activities").insert({
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
      }),
      "the merge is already done and irreversible by the time this runs — child rows moved, fields merged; failing the caller here would report a rollback that did not happen. The old rejection handler could not see a REFUSED row at all; bestEffort logs both.",
    )

    revalidatePath("/crm")
    // TOMBSTONE (§1.1): revalidatePath("/dashboard/crm") deleted — no page.tsx at
    // that path, so the call was a no-op. Survivor: the /crm line above.
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
    const isManager = isAdminOrBroker({ user_type: ctx.role })
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

/**
 * Record an explicit FUTURE-INTENT re-contact date on a contact.
 *
 * "Call me after the school year." Until now the platform had nowhere to put
 * that: `lib/lead-pipeline/schedule-followup.ts:setEntityFollowup` is the only
 * writer of `contacts.next_followup_at` / `next_followup_reason` outside the
 * demo seed, and it had NO CALLER. The READ side has always been live —
 * `lib/lead-pipeline/reactivation-enroller.ts` calls `followupSuppresses(
 * c.next_followup_at, now)` on every contact and lead before enrolling them in
 * a reactivation cadence — so the suppression check ran against a column
 * nothing could ever set, and a stated future timeline could not stop the
 * nurture drip from nagging.
 *
 * This is the contact-side entry point for it. Gated: the caller must be
 * authenticated and the contact must be in the caller's brokerage, proved
 * through the cookie client so RLS applies to the check itself — setEntityFollowup
 * runs on the service client and filters on `id` alone, so this is the only
 * tenant boundary on the write.
 *
 * The lead-side equivalent is deliberately NOT exposed here: agents work
 * contacts, not raw leads.
 */
export async function scheduleContactFollowup(params: {
  contactId: string
  /** ISO timestamp to next reach out. */
  at: string
  /** What they said, in their words — shown to the agent when the date comes round. */
  reason?: string | null
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(params.contactId)) {
      return { success: false, error: "Invalid contact id" }
    }

    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Not authenticated" }
    }

    const supabase = await createClient()
    const { data: contact, error: scopeError } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", params.contactId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    // supabase-js RESOLVES a refused query, so an unchecked error here would be
    // indistinguishable from "no such contact" — and both must refuse.
    if (scopeError) return { success: false, error: "Could not verify that contact" }
    if (!contact) return { success: false, error: "Contact not found" }

    const { setEntityFollowup } = await import("@/lib/lead-pipeline/schedule-followup")
    const result = await setEntityFollowup({
      entity: "contact",
      id:     params.contactId,
      at:     params.at,
      reason: params.reason ?? null,
    })
    if (!result.ok) return { success: false, error: result.error ?? "Follow-up not saved" }

    revalidatePath(`/crm/contacts/${params.contactId}`)
    revalidatePath("/crm")
    return { success: true }
  } catch (error) {
    return handleError(error, "scheduleContactFollowup") as { success: boolean; error?: string }
  }
}
