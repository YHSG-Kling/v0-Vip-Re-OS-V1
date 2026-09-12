"use server"

/**
 * Seed brokerage_required_documents from per-state presets.
 *
 * Called by the broker / team lead / sole agent during onboarding (or any
 * time later) to one-click load the baseline + state-specific required
 * documents into their scope.
 *
 * Subscription tier maps to scope:
 *   - Sole-agent subscription → scope='agent', scopeId=userId
 *   - Team subscription       → scope='team',  scopeId=teamId
 *   - Brokerage subscription  → scope='brokerage', scopeId=brokerageId
 *
 * Idempotent: existing rows with the same (scope, classification, deal_type,
 * state_code) tuple are SKIPPED (not overwritten). Brokers who already
 * customized their list won't have their edits clobbered.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { getRequiredDocPresetsForState } from "@/lib/compliance/required-doc-presets"

export interface SeedRequiredDocsParams {
  brokerageId:   string
  /** "brokerage" — seeds at brokerage scope (most common); "team" — team
   *  lead seeds for their team; "agent" — sole-agent seeds for themselves. */
  scope:         "brokerage" | "team" | "agent"
  /** Which scope id the rows go under. Must match the scope. */
  scopeId:       string
  /** Two-letter state code. Drives which preset stack to use. Pass null /
   *  empty for the US baseline only. */
  stateCode?:    string | null
  /** users.id of whoever is seeding — recorded on created_by for audit. */
  actorUserId:   string
  /** Default 'buyer'. Sellers / dual scopes can be seeded separately. */
  dealType?:     "buyer" | "seller" | "dual"
}

export interface SeedRequiredDocsResult {
  success:        boolean
  inserted_count: number
  skipped_count:  number
  classifications_inserted: string[]
  error?:         string
}

export async function seedRequiredDocsForBrokerage(
  params: SeedRequiredDocsParams,
): Promise<SeedRequiredDocsResult> {
  const { brokerageId, scope, scopeId, stateCode, actorUserId } = params
  const dealType = params.dealType ?? "buyer"

  if (!isValidUUID(brokerageId) || !isValidUUID(scopeId) || !isValidUUID(actorUserId)) {
    return { success: false, inserted_count: 0, skipped_count: 0, classifications_inserted: [], error: "Invalid IDs" }
  }
  if (!["brokerage","team","agent"].includes(scope)) {
    return { success: false, inserted_count: 0, skipped_count: 0, classifications_inserted: [], error: "Invalid scope" }
  }

  // Pass the deal type through. Without it this seeded the BUYER stack under a
  // seller deal_type — pre_approval_letter and proof_of_funds as blocking
  // requirements a seller has no way to produce, so every seller file would
  // have sat permanently blocked on paperwork that does not exist.
  const presets = getRequiredDocPresetsForState(stateCode ?? null, dealType)
  if (presets.length === 0) {
    return { success: true, inserted_count: 0, skipped_count: 0, classifications_inserted: [] }
  }

  const supabase = createServiceClient()

  // Pre-fetch existing rows at the same scope so we can skip duplicates.
  const { data: existing } = await supabase
    .from("brokerage_required_documents")
    .select("classification")
    .eq("brokerage_id", brokerageId)
    .eq("scope_type", scope)
    .eq("scope_id", scopeId)
    .eq("deal_type", dealType)
  const existingSet = new Set((existing ?? []).map((r: any) => r.classification))

  const toInsert = presets
    .filter(p => !existingSet.has(p.classification))
    .map(p => ({
      brokerage_id:     brokerageId,
      scope_type:       scope,
      scope_id:         scopeId,
      classification:   p.classification,
      deal_type:        dealType,
      state_code:       stateCode ? stateCode.toUpperCase() : null,
      is_required:      true,
      block_on_missing: p.block_on_missing,
      description:      p.description,
      created_by:       actorUserId,
    }))

  if (toInsert.length === 0) {
    return { success: true, inserted_count: 0, skipped_count: presets.length, classifications_inserted: [] }
  }

  const { error: insertErr } = await supabase
    .from("brokerage_required_documents")
    .insert(toInsert)
  if (insertErr) {
    return { success: false, inserted_count: 0, skipped_count: 0, classifications_inserted: [], error: insertErr.message }
  }

  return {
    success:                  true,
    inserted_count:           toInsert.length,
    skipped_count:            presets.length - toInsert.length,
    classifications_inserted: toInsert.map(r => r.classification),
  }
}
