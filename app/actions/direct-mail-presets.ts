"use server"

/**
 * app/actions/direct-mail-presets.ts
 *
 * Wave 36 final — CRUD for direct_mail_presets + dispatch. Brokerage-
 * admin gated. The compliance gate fires ONCE on save (against the
 * locked copy) and the resulting compliance_event_id is stored on the
 * preset, so every future dispatch from the preset inherits the audit
 * without re-running the AI gate.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { revalidatePath } from "next/cache"

export interface PresetRow {
  id:                     string
  name:                   string
  piece_type:             "postcard" | "letter"
  postcard_size:          "4x6" | "6x9" | null
  composition_id:         string | null
  locked_headline:        string | null
  locked_body:            string | null
  locked_cta:             string | null
  status_badge:           string | null
  property_photo_url:     string | null
  pull_quote:             string | null
  locked_letter_greeting: string | null
  locked_letter_body:     string | null
  locked_letter_signoff:  string | null
  fallback_template_id:   string | null
  compliance_event_id:    string | null
  is_active:              boolean
  scope_type:             "agent" | "team" | "brokerage"
  scope_id:               string
  created_at:             string
}

/** List presets accessible to the caller across every tier they can
 *  read. An agent sees their own + their team's + their brokerage's;
 *  a team lead sees team + brokerage; an admin sees brokerage. */
export async function listDirectMailPresets(): Promise<
  | { success: true; presets: PresetRow[] }
  | { success: false; error: string }
> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditAgent && !access.canEditTeam && !access.canEditBrokerage) {
    return { success: false, error: "No edit scope available" }
  }
  if (!access.brokerageScopeId) {
    return { success: false, error: "Brokerage scope unresolved" }
  }
  const svc = createServiceClient()

  // Build the scope OR filter — every (scope_type, scope_id) tuple
  // the caller can see across the cascade.
  const scopeFilters: string[] = []
  if (access.canEditAgent     && access.agentScopeId)     scopeFilters.push(`and(scope_type.eq.agent,scope_id.eq.${access.agentScopeId})`)
  for (const teamId of access.teamScopeIds)               scopeFilters.push(`and(scope_type.eq.team,scope_id.eq.${teamId})`)
  if (access.canEditBrokerage)                            scopeFilters.push(`and(scope_type.eq.brokerage,scope_id.eq.${access.brokerageScopeId})`)
  if (scopeFilters.length === 0) {
    return { success: true, presets: [] }
  }

  const { data, error } = await svc
    .from("direct_mail_presets")
    .select("*")
    .eq("brokerage_id", access.brokerageScopeId)
    .or(scopeFilters.join(","))
    .order("created_at", { ascending: false })
  if (error) return { success: false, error: error.message }
  return { success: true, presets: (data ?? []) as PresetRow[] }
}

export interface UpsertPresetInput {
  id?:                     string
  name:                    string
  piece_type:              "postcard" | "letter"
  postcard_size?:          "4x6" | "6x9" | null
  composition_id?:         string | null
  locked_headline?:        string | null
  locked_body?:            string | null
  locked_cta?:             string | null
  status_badge?:           string | null
  property_photo_url?:     string | null
  pull_quote?:             string | null
  locked_letter_greeting?: string | null
  locked_letter_body?:     string | null
  locked_letter_signoff?:  string | null
  fallback_template_id?:   string | null
  /** Wave 37 tier scope. Defaults to "brokerage" when omitted. */
  scope_type?:             "agent" | "team" | "brokerage"
  /** When scope_type='team', the team id. When 'agent', the agent id.
   *  When 'brokerage', the brokerage id (defaults to the resolved
   *  brokerage scope). */
  scope_id?:               string
}

export async function upsertDirectMailPreset(input: UpsertPresetInput): Promise<{
  success: boolean
  presetId?: string
  violations?: string[]
  error?: string
}> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditAgent && !access.canEditTeam && !access.canEditBrokerage) {
    return { success: false, error: "No edit scope available" }
  }
  if (!access.brokerageScopeId) {
    return { success: false, error: "Brokerage scope unresolved" }
  }

  // Resolve target tier — caller can write to any tier they have
  // edit-access for. Defaults to brokerage when the caller is a
  // brokerage admin; otherwise defaults to the highest-permission
  // tier they can edit.
  const requestedScope = input.scope_type ?? (
    access.canEditBrokerage ? "brokerage" :
    access.canEditTeam      ? "team"      :
    "agent"
  )
  let targetScopeId: string | null = null
  if (requestedScope === "agent") {
    if (!access.canEditAgent) return { success: false, error: "agent_scope_forbidden" }
    targetScopeId = input.scope_id ?? access.agentScopeId ?? null
    if (!targetScopeId) return { success: false, error: "agent_scope_unresolved" }
  } else if (requestedScope === "team") {
    if (!access.canEditTeam) return { success: false, error: "team_scope_forbidden" }
    // Default only when the caller has exactly one team (team-lead).
    // Brokerage admins see every team and MUST pick explicitly so the
    // preset doesn't land on an unintended team.
    targetScopeId = input.scope_id ?? null
    if (!targetScopeId) {
      if (access.teamScopeIds.length === 1) targetScopeId = access.teamScopeIds[0]
      else return { success: false, error: "team_scope_id_required" }
    }
    if (!access.teamScopeIds.includes(targetScopeId)) {
      return { success: false, error: "team_not_in_your_scope" }
    }
  } else {
    if (!access.canEditBrokerage) return { success: false, error: "brokerage_scope_forbidden" }
    targetScopeId = input.scope_id ?? access.brokerageScopeId
  }
  if (!input.name?.trim()) return { success: false, error: "name required" }
  if (input.piece_type === "postcard") {
    if (!input.locked_headline?.trim() || !input.locked_body?.trim() || !input.locked_cta?.trim()) {
      return { success: false, error: "postcard preset needs locked_headline + locked_body + locked_cta" }
    }
    if (!input.composition_id?.trim()) {
      return { success: false, error: "postcard preset needs composition_id (PostcardFront4x6 or PostcardFront6x9)" }
    }
    if (input.postcard_size && !["4x6", "6x9"].includes(input.postcard_size)) {
      return { success: false, error: "postcard_size must be '4x6' or '6x9'" }
    }
  } else if (input.piece_type === "letter") {
    if (!input.locked_letter_body?.trim()) {
      return { success: false, error: "letter preset needs locked_letter_body" }
    }
  } else {
    return { success: false, error: "piece_type must be postcard or letter" }
  }

  const brokerageId = access.brokerageScopeId
  const svc = createServiceClient()

  // Run the compliance gate ONCE against the concatenated locked copy.
  // The gate is the platform's canonical Fair Housing / Them-First /
  // brand-voice check; same chokepoint draftPostcardCopy uses.
  const copyForGate = input.piece_type === "postcard"
    ? [input.locked_headline, input.locked_body, input.locked_cta].filter(Boolean).join("\n")
    : [input.locked_letter_greeting, input.locked_letter_body, input.locked_letter_signoff].filter(Boolean).join("\n")
  const gateResult = await evaluateOutbound({
    actorContext: { brokerageId, role: "agent", userId: brokerageId },
    messageType:  "direct_mail",
    journeyType:  "buyer",   // presets default to buyer journey; lifecycle presets may need separate buckets later
    persona:      "other",
    content:      copyForGate,
  })
  if (!gateResult.allowed) {
    return { success: false, violations: gateResult.violations, error: "compliance_gate_blocked" }
  }
  // evaluateOutbound returns the compliance_events.id it just inserted.
  // Stamp that directly — re-querying by (brokerage_id, message_type)
  // is race-prone under concurrent saves.
  const complianceEventId = gateResult.complianceEventId ?? null

  const row = {
    brokerage_id:            brokerageId,
    scope_type:              requestedScope,
    scope_id:                targetScopeId,
    name:                    input.name.trim(),
    piece_type:              input.piece_type,
    postcard_size:           input.postcard_size ?? null,
    composition_id:          input.composition_id ?? null,
    locked_headline:         input.locked_headline ?? null,
    locked_body:             input.locked_body ?? null,
    locked_cta:              input.locked_cta ?? null,
    status_badge:            input.status_badge ?? null,
    property_photo_url:      input.property_photo_url ?? null,
    pull_quote:              input.pull_quote ?? null,
    locked_letter_greeting:  input.locked_letter_greeting ?? null,
    locked_letter_body:      input.locked_letter_body ?? null,
    locked_letter_signoff:   input.locked_letter_signoff ?? null,
    fallback_template_id:    input.fallback_template_id ?? null,
    compliance_event_id:     complianceEventId,
    is_active:               true,
    updated_at:              new Date().toISOString(),
  }

  if (input.id) {
    const { data: existing } = await svc.from("direct_mail_presets")
      .select("brokerage_id").eq("id", input.id).maybeSingle()
    if (!existing) return { success: false, error: "preset_not_found" }
    if ((existing.brokerage_id as string) !== brokerageId) {
      return { success: false, error: "tenant_mismatch" }
    }
    const { error } = await svc.from("direct_mail_presets").update(row).eq("id", input.id)
    if (error) return { success: false, error: error.message }
    revalidatePath("/settings/direct-mail/presets")
    return { success: true, presetId: input.id }
  }
  const { data, error } = await svc.from("direct_mail_presets").insert(row).select("id").single()
  if (error) {
    if (error.code === "23505") return { success: false, error: `A preset named "${row.name}" already exists.` }
    return { success: false, error: error.message }
  }
  revalidatePath("/settings/direct-mail/presets")
  return { success: true, presetId: data.id as string }
}

export async function deactivatePreset(presetId: string): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditAgent && !access.canEditTeam && !access.canEditBrokerage) {
    return { success: false, error: "No edit scope available" }
  }
  if (!access.brokerageScopeId) {
    return { success: false, error: "Brokerage scope unresolved" }
  }
  const svc = createServiceClient()

  // Verify the preset is in a scope the caller can edit before flipping.
  const { data: row } = await svc
    .from("direct_mail_presets")
    .select("scope_type, scope_id")
    .eq("id", presetId)
    .eq("brokerage_id", access.brokerageScopeId)
    .maybeSingle()
  const r = row as { scope_type: string; scope_id: string } | null
  if (!r) return { success: false, error: "preset_not_found" }
  const canEditScope =
    (r.scope_type === "agent"     && access.canEditAgent     && r.scope_id === access.agentScopeId) ||
    (r.scope_type === "team"      && access.canEditTeam      && access.teamScopeIds.includes(r.scope_id)) ||
    (r.scope_type === "brokerage" && access.canEditBrokerage && r.scope_id === access.brokerageScopeId)
  if (!canEditScope) return { success: false, error: "scope_forbidden" }

  const { error } = await svc.from("direct_mail_presets")
    .update({ is_active: false })
    .eq("id", presetId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/direct-mail/presets")
  return { success: true }
}
