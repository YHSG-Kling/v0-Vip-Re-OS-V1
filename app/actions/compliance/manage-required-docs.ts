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
import { asChecklistStage, asContractSubtype, asFinancingKind, asRepresentation } from "@/lib/compliance/checklist-dimensions"
import { loadTenantVocabulary, vocabularyWriteValue, type TenantVocabulary } from "@/lib/compliance/adaptive-vocabulary"
import { isPrimarySourceUrl } from "@/lib/compliance-rules/law-rule-registry"
import { VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES } from "@/lib/compliance/vocabulary-healing"

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

/**
 * Wave 139 (lane 139G, P0): THE one authority for a required-docs write at (scope, scopeId), shared
 * with the preset seed door (app/actions/compliance/seed-required-docs.ts), which took brokerageId +
 * actorUserId from the BODY and wrote with the service client behind no session gate at all. The
 * tenant and the actor come from the SESSION here; the caller uses them, never its own arguments.
 */
export async function authorizeRequiredDocsScope(
  scope: Scope,
  scopeId: string,
): Promise<{ ok: true; userId: string; brokerageId: string } | { ok: false; error: string }> {
  const actor = await resolveActor()
  if ("error" in actor) return { ok: false, error: actor.error }
  if (!isValidUUID(scopeId)) return { ok: false, error: "Invalid scope id" }
  if (!canManage(actor, scope, scopeId)) return { ok: false, error: "Forbidden for your role/scope" }
  return { ok: true, userId: actor.userId, brokerageId: actor.brokerageId }
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
  /**
   * The m806 dimensions — each null/omitted = "any" (lib/compliance/checklist-dimensions.ts).
   * Validated against the ONE vocabulary below; a value outside it is refused here rather than
   * left for the database CHECK to refuse as a resolved-but-empty write.
   */
  requiredStage?:   string | null
  financingKind?:   string | null
  contractSubtype?: string | null
  representation?:  string | null
  /**
   * Wave 144A (owner ruling 1: "state-specific regulatory document rules need human compliance approval and
   * verified official sources — AI never invents binding legal requirements"). 'state_requirement' = this rule
   * says the STATE requires the document: it must name the state, cite an official (.gov / .us) source, and be
   * written by a compliance approver. Omitted / 'brokerage_policy' = the brokerage's own rule, written exactly
   * as before (no new columns named — m847 is WRITTEN, NOT APPLIED until the integrator applies it).
   */
  legalBasis?:      "brokerage_policy" | "state_requirement" | null
  sourceUrl?:       string | null
  sourceTitle?:     string | null
}

/**
 * The dimension columns a rule write may carry, validated, as the insert/filter shape. Columns are
 * included ONLY when set: m806 is WRITTEN, NOT APPLIED until the integrator applies it, and an insert
 * that names an absent column is refused WHOLE (PGRST204) — so a rule without dimensions must write
 * byte-for-byte what it wrote before.
 *
 * Wave 144A: a contract type / representation is validated against the brokerage's ADAPTIVE VOCABULARY
 * (platform values first — asContractSubtype / asRepresentation — then the brokerage's approved terms and
 * aliases). An alias is stored as its canonical key; a term retired for new work, or a state-scoped term a
 * compliance approver has not attested, is refused for a NEW rule (rules already naming it keep applying);
 * a state-scoped term on a rule for another state is refused.
 */
function ruleDimensions(
  input: Pick<AddRequiredDocInput, "requiredStage" | "financingKind" | "contractSubtype" | "representation" | "stateCode">,
  vocabulary: TenantVocabulary | null,
):
  | { ok: true; columns: Record<string, string> }
  | { ok: false; error: string } {
  const columns: Record<string, string> = {}
  const checks: Array<[string, string | null | undefined, (v: unknown) => unknown, string]> = [
    ["required_stage",   input.requiredStage,   asChecklistStage,   "stage"],
    ["financing_kind",   input.financingKind,   asFinancingKind,    "financing kind"],
    ["contract_subtype", input.contractSubtype, asContractSubtype,  "contract type"],
    ["representation",   input.representation,  asRepresentation,   "representation"],
  ]
  const ruleState = input.stateCode ? input.stateCode.toUpperCase() : null
  for (const [column, raw, narrow, label] of checks) {
    if (raw === null || raw === undefined || raw === "") continue
    if (narrow(raw)) { columns[column] = raw; continue }
    if (column !== "contract_subtype" && column !== "representation") return { ok: false, error: `"${raw}" is not a valid ${label}` }
    if (!vocabulary) return { ok: false, error: `"${raw}" is not a platform ${label}, and this brokerage's vocabulary could not be read — nothing was written` }
    const w = vocabularyWriteValue(column, raw, vocabulary)
    if (!w.value || !w.resolved) return { ok: false, error: `"${raw}" is not a ${label} here — report it as missing from Required documents → Vocabulary` }
    if (!w.resolved.usable) {
      return { ok: false, error: w.resolved.pendingAttestation
        ? `"${w.resolved.label}" waits for a compliance approver to attest its official source`
        : `"${w.resolved.label}" is retired for new rules (rules that already name it keep applying)` }
    }
    if (ruleState && w.resolved.stateCodes && !w.resolved.stateCodes.includes(ruleState)) {
      return { ok: false, error: `"${w.resolved.label}" applies in ${w.resolved.stateCodes.join(", ")}, not ${ruleState}` }
    }
    columns[column] = w.value
  }
  return { ok: true, columns }
}

/** The m847 citation columns for a STATE-REQUIREMENT rule, validated — or nothing for a brokerage-policy rule. */
function ruleLegalBasis(
  input: Pick<AddRequiredDocInput, "legalBasis" | "sourceUrl" | "sourceTitle" | "stateCode">,
  actor: Actor,
): { ok: true; columns: Record<string, string> } | { ok: false; error: string } {
  if (input.legalBasis !== "state_requirement") return { ok: true, columns: {} }
  if (!input.stateCode) return { ok: false, error: "A state requirement names its state." }
  if (!isPrimarySourceUrl(input.sourceUrl ?? null)) {
    return { ok: false, error: "A state requirement cites the official source that says so (a .gov / .us page). A commentary, vendor or association page is not one — save it as brokerage policy instead." }
  }
  if (!VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has(actor.userType)) {
    return { ok: false, error: `A state requirement is approved by a compliance approver (${[...VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES].join(", ")}). Save it as brokerage policy, or ask one of them to add it.` }
  }
  const now = new Date().toISOString()
  return {
    ok: true,
    columns: {
      legal_basis: "state_requirement",
      source_url: String(input.sourceUrl).trim(),
      ...(input.sourceTitle?.trim() ? { source_title: input.sourceTitle.trim().slice(0, 200) } : {}),
      source_verified_on: now.slice(0, 10),
      approved_by: actor.userId,
      approved_at: now,
    },
  }
}

/** The next policy_version for a row read with select('*'); undefined while m806 is unapplied (the column is absent). */
function nextPolicyVersion(row: Record<string, unknown>): { policy_version: number } | Record<string, never> {
  return typeof row.policy_version === "number" ? { policy_version: row.policy_version + 1 } : {}
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
  // The brokerage's vocabulary is read only when a value is not a platform one (the common case writes as before).
  const needsVocabulary = (!!input.contractSubtype && !asContractSubtype(input.contractSubtype)) || (!!input.representation && !asRepresentation(input.representation))
  const vocab = needsVocabulary ? await loadTenantVocabulary(svc, actor.brokerageId) : null
  const dims = ruleDimensions(input, vocab?.ok ? vocab.vocabulary : null)
  if (!dims.ok) return { ok: false, error: dims.error }
  const basis = ruleLegalBasis(input, actor)
  if (!basis.ok) return { ok: false, error: basis.error }

  const stateCode = input.stateCode ? input.stateCode.toUpperCase() : null

  // Idempotent per (brokerage, scope, scopeId, classification, deal_type, state, and — wave 143 —
  // each m806 dimension). state_code needs different PostgREST operators: .is(null) for the
  // US-baseline rows, .eq(value) for state-specific ones (.is() rejects a non-null string).
  // The dimensions are compared in code (sameDims) on a star select: a PostgREST filter that NAMES a
  // dimension column is refused whole while m806 is unapplied, and a rule that differs from the
  // generic one only by a dimension is NOT its duplicate.
  let dupQ = svc
    .from("brokerage_required_documents")
    .select("*")
    .eq("brokerage_id", actor.brokerageId)
    .eq("scope_type", input.scope)
    .eq("scope_id", input.scopeId)
    .eq("classification", input.classification)
    .eq("deal_type", input.dealType)
  dupQ = stateCode === null ? dupQ.is("state_code", null) : dupQ.eq("state_code", stateCode)
  const { data: candidates, error: dupErr } = await dupQ
  // A refused duplicate read must not become "no duplicate" — that is how a double rule is written.
  if (dupErr) return { ok: false, error: `could not check for an existing rule: ${dupErr.message}` }
  const sameDims = (row: Record<string, unknown>) =>
    (["required_stage", "financing_kind", "contract_subtype", "representation"] as const)
      .every((c) => ((row[c] as string | null | undefined) ?? null) === (dims.columns[c] ?? null))
  const existing = (candidates ?? []).find((r: Record<string, unknown>) => sameDims(r)) as { id?: string } | undefined
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
      ...dims.columns,
      ...basis.columns,
    })
    .select("id")
    .single()
  if (error || !inserted) {
    // PGRST204 on a state-requirement write = the m847 citation columns are not applied yet — say so, never retry it uncited.
    if (Object.keys(basis.columns).length && String((error as { code?: string } | null)?.code ?? "") === "PGRST204") {
      return { ok: false, error: "State-requirement citations are not available yet (migration m847 is not applied) — nothing was written." }
    }
    return { ok: false, error: error?.message ?? "Insert failed" }
  }

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
    .select("*")
    .eq("id", input.id)
    .maybeSingle()
  if (!row || row.brokerage_id !== actor.brokerageId) return { ok: false, error: "Not found in your brokerage" }
  if (!canManage(actor, row.scope_type as Scope, row.scope_id as string)) return { ok: false, error: "Forbidden for your role/scope" }

  if (input.formId) {
    // team_id (m853, wave 144 — lane 144C Outside-lane 2): a TEAM packet is shared with that one team only (owner ruling 3),
    // so it may be the template of THAT team's rule and of no brokerage-wide / other-team rule. The read error is READ: a
    // refused read is not "no such form".
    const { data: form, error: formErr } = await svc
      .from("brokerage_form_library")
      .select("id, brokerage_id, is_active, team_id")
      .eq("id", input.formId)
      .maybeSingle()
    if (formErr) return { ok: false, error: `Could not read the form: ${formErr.message}` }
    if (!form || form.brokerage_id !== actor.brokerageId) return { ok: false, error: "Form not found in your library" }
    if (!form.is_active) return { ok: false, error: "That form is inactive — reactivate it in Legal Forms first" }
    if (form.team_id && !(row.scope_type === "team" && row.scope_id === form.team_id)) return { ok: false, error: "That packet is shared with one team only — attach it to that team's rule" }
  }

  const { error } = await svc
    .from("brokerage_required_documents")
    .update({ template_form_id: input.formId, ...nextPolicyVersion(row) })
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
    .select("*")
    .eq("id", input.id)
    .maybeSingle()
  if (!row || row.brokerage_id !== actor.brokerageId) return { ok: false, error: "Not found in your brokerage" }
  if (!canManage(actor, row.scope_type as Scope, row.scope_id as string)) return { ok: false, error: "Forbidden for your role/scope" }

  const { error } = await svc
    .from("brokerage_required_documents")
    .update({ block_on_missing: input.blockOnMissing, ...nextPolicyVersion(row) })
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

  // A DELETE that matches nothing also resolves with no error (CLAUDE.md §3) — count what came back, so a
  // rule that was already gone, or refused by the tenant predicate, is not reported as removed.
  const { data: removed, error } = await svc
    .from("brokerage_required_documents")
    .delete()
    .eq("id", input.id)
    .eq("brokerage_id", actor.brokerageId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!removed || removed.length === 0) return { ok: false, error: "That rule was not removed — it no longer exists in your brokerage" }

  revalidatePath("/dashboard/settings/required-documents")
  return { ok: true }
}
