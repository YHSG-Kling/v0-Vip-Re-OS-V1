"use server"

/**
 * Manage individual brokerage_required_documents rows — the CRUD the settings
 * page was missing (it could only bulk-seed presets, never add a custom rule,
 * flip blocking↔warning, or remove one). These drive the compliance
 * file-completeness gate in submitOfferToCompliance (auditOfferDocuments).
 *
 * Authorization (in addition to belonging to the brokerage):
 *   - tc / broker / broker_owner / broker_admin / admin / compliance_* → any scope
 *   - platform staff (users.platform_role) → any scope
 *   - team_lead → team rows for THEIR team, or their own agent rows
 *   - agent     → only their own agent-scope rows
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"
import { isPlatformStaffRole } from "@/lib/platform/platform-staff-roster"
import type { DocumentClassification } from "@/lib/compliance/required-documents"

/**
 * WHO ADMINISTERS THE REQUIRED-DOCUMENT LIST.
 *
 * Owner's ruling, verbatim: "the required document list is in the settings for
 * the transaction coordinator or admin."
 *
 * THE TRANSACTION COORDINATOR WAS NOT ON THIS LIST. `tc` is a LIVE
 * users.user_type (the compliance-transaction-auto-create chain resolves TCs by
 * exactly that value, with the note "the TC role is 'tc'"), and it is the role
 * the owner names FIRST — yet the one person the ruling puts in charge of the
 * checklist was refused by every write in this file. Added, not invented: the
 * value is read off the live roster, not guessed.
 *
 * `broker_owner` added for the same reason in the other direction — the settings
 * PAGE has always admitted it (required-documents/page.tsx:ADMIN_ROLES) while
 * this action did not, so a broker_owner could open the screen and be refused by
 * every control on it.
 *
 * `superadmin` REMOVED as a user_type. SURVIVOR: users.platform_role, checked
 * below via lib/platform/platform-staff-roster.ts:isPlatformStaffRole — no live
 * row has user_type='superadmin' (CLAUDE.md §4), so the old member admitted
 * nobody while the real platform staff were being refused.
 */
const PRINCIPAL_ROLES = new Set([
  "tc", "broker", "broker_owner", "broker_admin", "admin",
  "compliance_manager", "compliance_officer",
])

type Scope = "brokerage" | "team" | "agent"

interface Actor {
  userId: string
  brokerageId: string
  teamId: string | null
  userType: string
  /** users.platform_role — where platform STAFF live (never user_type). */
  platformRole: string | null
}

async function resolveActor(): Promise<Actor | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Unauthenticated" }
  // `error` is read: supabase-js RESOLVES a refused read, and a refused profile
  // read must not render as "no brokerage on your profile".
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id, team_id, user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { error: `Could not read your profile: ${profileError.message}` }
  if (!profile?.brokerage_id) return { error: "No brokerage on your profile" }
  return {
    userId: user.id,
    brokerageId: profile.brokerage_id as string,
    teamId: (profile.team_id as string | null) ?? null,
    userType: (profile.user_type as string) ?? "",
    platformRole: (profile.platform_role as string | null) ?? null,
  }
}

/** Whether this actor may create/edit/delete a rule at (scope, scopeId). */
function canManage(actor: Actor, scope: Scope, scopeId: string): boolean {
  if (isPlatformStaffRole(actor.platformRole)) return true
  if (PRINCIPAL_ROLES.has(actor.userType)) return true
  if (actor.userType === "team_lead") {
    if (scope === "team")  return !!actor.teamId && scopeId === actor.teamId
    if (scope === "agent") return scopeId === actor.userId
    return false
  }
  if (actor.userType === "agent") {
    return scope === "agent" && scopeId === actor.userId
  }
  return false
}

// ── ADD ───────────────────────────────────────────────────────────────────────

export interface AddRequiredDocInput {
  scope:          Scope
  scopeId:        string
  classification: DocumentClassification
  dealType:       "buyer" | "seller" | "dual"
  stateCode?:     string | null
  blockOnMissing: boolean
  description?:   string | null
}

export async function addRequiredDocument(
  input: AddRequiredDocInput,
): Promise<{ ok: boolean; error?: string; id?: string; duplicate?: boolean }> {
  const actor = await resolveActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  if (!isValidUUID(input.scopeId)) return { ok: false, error: "Invalid scope id" }
  if (!canManage(actor, input.scope, input.scopeId)) return { ok: false, error: "Forbidden for your role/scope" }
  if (!input.classification) return { ok: false, error: "Pick a document classification" }

  const svc = createServiceClient()
  const stateCode = input.stateCode ? input.stateCode.toUpperCase() : null

  // Idempotent per (brokerage, scope, scopeId, classification, deal_type, state).
  // state_code needs different PostgREST operators: .is(null) for the US-baseline
  // rows, .eq(value) for state-specific ones (.is() rejects a non-null string).
  let dupQ = svc
    .from("brokerage_required_documents")
    .select("id")
    .eq("brokerage_id", actor.brokerageId)
    .eq("scope_type", input.scope)
    .eq("scope_id", input.scopeId)
    .eq("classification", input.classification)
    .eq("deal_type", input.dealType)
  dupQ = stateCode === null ? dupQ.is("state_code", null) : dupQ.eq("state_code", stateCode)
  const { data: existing } = await dupQ.maybeSingle()
  if (existing?.id) return { ok: true, id: existing.id as string, duplicate: true }

  const { data: inserted, error } = await svc
    .from("brokerage_required_documents")
    .insert({
      brokerage_id:     actor.brokerageId,
      scope_type:       input.scope,
      scope_id:         input.scopeId,
      classification:   input.classification,
      deal_type:        input.dealType,
      state_code:       stateCode,
      is_required:      true,
      block_on_missing: input.blockOnMissing,
      description:      input.description?.trim() || null,
      created_by:       actor.userId,
    })
    .select("id")
    .single()
  if (error || !inserted) return { ok: false, error: error?.message ?? "Insert failed" }

  revalidatePath("/dashboard/settings/required-documents")
  return { ok: true, id: inserted.id as string }
}

// ── TEMPLATE FORM link (keep-one: brokerage_form_library is the ONE upload path) ──

/**
 * Attach (or detach with formId null) a brokerage_form_library template to a
 * required-doc rule — the agent-facing checklist can then hand out the exact
 * blank form the brokerage requires. Same authz as edits; the form must belong
 * to the caller's brokerage and be active.
 */
export async function setRequiredDocTemplate(
  input: { id: string; formId: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const actor = await resolveActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  if (!isValidUUID(input.id)) return { ok: false, error: "Invalid id" }
  if (input.formId !== null && !isValidUUID(input.formId)) return { ok: false, error: "Invalid form id" }

  const svc = createServiceClient()
  const { data: row } = await svc
    .from("brokerage_required_documents")
    .select("id, brokerage_id, scope_type, scope_id")
    .eq("id", input.id)
    .maybeSingle()
  if (!row || row.brokerage_id !== actor.brokerageId) return { ok: false, error: "Not found in your brokerage" }
  if (!canManage(actor, row.scope_type as Scope, row.scope_id as string)) return { ok: false, error: "Forbidden for your role/scope" }

  if (input.formId) {
    const { data: form } = await svc
      .from("brokerage_form_library")
      .select("id, brokerage_id, is_active")
      .eq("id", input.formId)
      .maybeSingle()
    if (!form || form.brokerage_id !== actor.brokerageId) return { ok: false, error: "Form not found in your library" }
    if (!form.is_active) return { ok: false, error: "That form is inactive — reactivate it in Transaction Forms first" }
  }

  const { error } = await svc
    .from("brokerage_required_documents")
    .update({ template_form_id: input.formId })
    .eq("id", input.id)
    .eq("brokerage_id", actor.brokerageId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/settings/required-documents")
  return { ok: true }
}

// TOMBSTONE: `listTemplateFormOptions()` — DELETED as a duplicate.
// SURVIVOR: app/dashboard/settings/required-documents/page.tsx:54 — the same
// `brokerage_form_library` read (same brokerage_id + is_active predicate, same
// `.order("name").limit(200)`), mapped at page.tsx:63 into the identical
// `{ id, name, state, packetType }` shape and passed to RequiredDocRowActions as
// `formOptions`. That page is the ONE consumer the template picker has.
//
// NOTHING WAS MERGED because the survivor is a strict superset: it also selects
// `pdf_url`, which the page needs to render the attached template as a link
// (page.tsx:112) and which this export never returned. It runs on the RLS-scoped
// client rather than the service client, and setRequiredDocTemplate above still
// re-validates the chosen form (brokerage + is_active) server-side before writing,
// so the picker's option list is never the authorization.
//
// It was also one more `"use server"` export — a public HTTP endpoint listing a
// brokerage's form library — kept alive for a caller that never existed.

// ── TOGGLE blocking ↔ warning ──────────────────────────────────────────────────

export async function setRequiredDocBlocking(
  input: { id: string; blockOnMissing: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const actor = await resolveActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  if (!isValidUUID(input.id)) return { ok: false, error: "Invalid id" }

  const svc = createServiceClient()
  const { data: row } = await svc
    .from("brokerage_required_documents")
    .select("id, brokerage_id, scope_type, scope_id")
    .eq("id", input.id)
    .maybeSingle()
  if (!row || row.brokerage_id !== actor.brokerageId) return { ok: false, error: "Not found in your brokerage" }
  if (!canManage(actor, row.scope_type as Scope, row.scope_id as string)) return { ok: false, error: "Forbidden for your role/scope" }

  const { error } = await svc
    .from("brokerage_required_documents")
    .update({ block_on_missing: input.blockOnMissing })
    .eq("id", input.id)
    .eq("brokerage_id", actor.brokerageId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/settings/required-documents")
  return { ok: true }
}

// ── REMOVE ──────────────────────────────────────────────────────────────────────

export async function removeRequiredDoc(
  input: { id: string },
): Promise<{ ok: boolean; error?: string }> {
  const actor = await resolveActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  if (!isValidUUID(input.id)) return { ok: false, error: "Invalid id" }

  const svc = createServiceClient()
  const { data: row } = await svc
    .from("brokerage_required_documents")
    .select("id, brokerage_id, scope_type, scope_id")
    .eq("id", input.id)
    .maybeSingle()
  if (!row || row.brokerage_id !== actor.brokerageId) return { ok: false, error: "Not found in your brokerage" }
  if (!canManage(actor, row.scope_type as Scope, row.scope_id as string)) return { ok: false, error: "Forbidden for your role/scope" }

  const { error } = await svc
    .from("brokerage_required_documents")
    .delete()
    .eq("id", input.id)
    .eq("brokerage_id", actor.brokerageId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/settings/required-documents")
  return { ok: true }
}
