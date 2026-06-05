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
  created_at:             string
}

export async function listDirectMailPresets(): Promise<
  | { success: true; presets: PresetRow[] }
  | { success: false; error: string }
> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("direct_mail_presets")
    .select("*")
    .eq("brokerage_id", access.brokerageScopeId)
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
}

export async function upsertDirectMailPreset(input: UpsertPresetInput): Promise<{
  success: boolean
  presetId?: string
  violations?: string[]
  error?: string
}> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
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

  // Find the compliance_events row the gate just emitted to stamp on
  // the preset.
  const { data: ceRow } = await svc
    .from("compliance_events")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("message_type", "direct_mail")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const complianceEventId = (ceRow?.id as string | undefined) ?? null

  const row = {
    brokerage_id:            brokerageId,
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
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  const { error } = await svc.from("direct_mail_presets")
    .update({ is_active: false })
    .eq("id", presetId)
    .eq("brokerage_id", access.brokerageScopeId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/direct-mail/presets")
  return { success: true }
}
