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
import { getRequiredDocPresetsForState, uncitedLegalClaims } from "@/lib/compliance/required-doc-presets"
import { authorizeRequiredDocsScope } from "@/app/actions/compliance/manage-required-docs"

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
  /**
   * Wave 145 (lane 145H): the seeded rules whose description claims a legal source WITHOUT a citation — each a human
   * compliance task (verify the official .gov/.us source, then re-save as a cited state requirement). They are seeded
   * as brokerage policy; the settings page lists them until a compliance approver resolves them.
   */
  citation_tasks?: string[]
  error?:         string
}

export async function seedRequiredDocsForBrokerage(
  params: SeedRequiredDocsParams,
): Promise<SeedRequiredDocsResult> {
  const { scope, scopeId, stateCode } = params
  const dealType = params.dealType ?? "buyer"

  if (!isValidUUID(params.brokerageId) || !isValidUUID(scopeId) || !isValidUUID(params.actorUserId)) {
    return { success: false, inserted_count: 0, skipped_count: 0, classifications_inserted: [], error: "Invalid IDs" }
  }
  if (!["brokerage","team","agent"].includes(scope)) {
    return { success: false, inserted_count: 0, skipped_count: 0, classifications_inserted: [], error: "Invalid scope" }
  }
  // Wave 139 (139G, P0): this public "use server" endpoint wrote compliance requirements into the
  // BODY's brokerage with the service client and no session gate. Gate first on the one required-docs
  // authority (survivor: app/actions/compliance/manage-required-docs.ts authorizeRequiredDocsScope);
  // the tenant and the recorded actor are the SESSION's — the body's brokerageId / actorUserId are ignored.
  const authz = await authorizeRequiredDocsScope(scope, scopeId)
  if (!authz.ok) {
    return { success: false, inserted_count: 0, skipped_count: 0, classifications_inserted: [], error: authz.error }
  }
  const brokerageId = authz.brokerageId
  const actorUserId = authz.userId
  return ledgered({ userId: actorUserId, brokerageId }, { action: "compliance.required_docs.seed", subject: { type: scope, id: scopeId }, riskClass: "LOW_RISK_WRITE", detail: { state_code: stateCode ?? null, deal_type: dealType } }, async () => {

  // Pass the deal type through. Without it this seeded the BUYER stack under a
  // seller deal_type — pre_approval_letter and proof_of_funds as blocking
  // requirements a seller has no way to produce, so every seller file would
  // have sat permanently blocked on paperwork that does not exist.
  const presets = getRequiredDocPresetsForState(stateCode ?? null, dealType)
  if (presets.length === 0) {
    return { success: true, inserted_count: 0, skipped_count: 0, classifications_inserted: [] }
  }

  const supabase = createServiceClient()

  // Pre-fetch existing rows at the same scope so we can skip duplicates. The error is READ (wave 145): a refused read
  // used to become "nothing exists", and the seed then wrote a second copy of every rule the scope already had.
  const { data: existing, error: existingErr } = await supabase
    .from("brokerage_required_documents")
    .select("classification")
    .eq("brokerage_id", brokerageId)
    .eq("scope_type", scope)
    .eq("scope_id", scopeId)
    .eq("deal_type", dealType)
  if (existingErr) {
    return { success: false, inserted_count: 0, skipped_count: 0, classifications_inserted: [], error: `could not check the rules already in this scope: ${existingErr.message} — nothing was seeded` }
  }
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
    citation_tasks:           uncitedLegalClaims(toInsert).map(r => `${r.classification}: ${r.description}`),
  }
  })
}

/**
 * WAVE 155 (lane 155R9, G12): ONE agent_action_ledger receipt per session write — ledgerSessionAction
 * (lib/kernel/action-ledger.ts) does the claim → run → settle. Who and which tenant come from the SESSION (CLAUDE.md §4);
 * "session" resolves them through getAgentContext. NO idempotency key: a person's second save runs again and leaves a
 * second receipt. The export's value comes back unchanged; a refused claim (only a malformed action name, caught by
 * test:action-ledger §14) throws instead of returning a value of another shape. No session tenant → the write runs exactly
 * as before, unrecorded (agent_action_ledger.brokerage_id is NOT NULL — there is no valid row to write).
 * @proofSeam scripts/ledger-receipts-transaction2-guard.ts
 */
async function ledgered<T>(
  who: { userId?: string | null; brokerageId?: string | null; agentId?: string | null } | null | undefined | "session",
  what: { action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const seat = who === "session" ? await (await import("@/lib/identity/get-agent-context")).getAgentContext() : who
  if (!seat?.userId || !seat.brokerageId) return run()
  const id = what.subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(what.subject.id) ? what.subject.id : null
  const subject = { type: what.subject.type, id, ref: id ? what.subject.ref ?? null : what.subject.ref ?? what.subject.id ?? null }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: seat.brokerageId, action: what.action, actor: { type: "user", userId: seat.userId, agentId: seat.agentId ?? null }, subject, riskClass: what.riskClass, reasonCode: "HUMAN_REQUESTED", detail: what.detail ?? null }, async () => { ran = true; return run() })
  if (!ran) throw new Error((r as { error?: string }).error ?? "action ledger refused the claim")
  return r as T
}
