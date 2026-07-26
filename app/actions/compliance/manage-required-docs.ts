"use server"

/**
 * Manage individual brokerage_required_documents rows — the CRUD the settings
 * page was missing (it could only bulk-seed presets, never add a custom rule,
 * flip blocking↔warning, or remove one). These drive the compliance
 * file-completeness gate in submitOfferToCompliance (auditOfferDocuments).
 *
 * Authorization (in addition to belonging to the brokerage):
 *   - broker / broker_admin / admin / superadmin / compliance_* → any scope
 *   - team_lead → team rows for THEIR team, or their own agent rows
 *   - agent     → only their own agent-scope rows
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"
import type { DocumentClassification } from "@/lib/compliance/required-documents"

const PRINCIPAL_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "compliance_manager", "compliance_officer",
])

type Scope = "brokerage" | "team" | "agent"

interface Actor {
  userId: string
  brokerageId: string
  teamId: string | null
  userType: string
}

async function resolveActor(): Promise<Actor | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Unauthenticated" }
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, team_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return { error: "No brokerage on your profile" }
  return {
    userId: user.id,
    brokerageId: profile.brokerage_id as string,
    teamId: (profile.team_id as string | null) ?? null,
    userType: (profile.user_type as string) ?? "",
  }
}

/** Whether this actor may create/edit/delete a rule at (scope, scopeId). */
function canManage(actor: Actor, scope: Scope, scopeId: string): boolean {
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
  const { data: existing } = await svc
    .from("brokerage_required_documents")
    .select("id")
    .eq("brokerage_id", actor.brokerageId)
    .eq("scope_type", input.scope)
    .eq("scope_id", input.scopeId)
    .eq("classification", input.classification)
    .eq("deal_type", input.dealType)
    .is("state_code", stateCode as any)
    .maybeSingle()
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
