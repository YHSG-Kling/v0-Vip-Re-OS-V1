"use server"

/**
 * app/actions/compliance-phrases.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A BROKERAGE'S OWN PROHIBITED WORDS — the tenant half of the compliance gate.
 *
 * Owner's ruling: "the users can also add in their settings prohibited words."
 *
 * `prohibited_phrases` carries 25 FEDERAL Fair Housing / RESPA / UDAAP phrases
 * (m450, asserted by m451) on rows with `brokerage_id IS NULL`, and, since m454,
 * a brokerage's own additions on rows carrying its id. RLS decides which is
 * which:
 *
 *   SELECT  brokerage_id IS NULL OR has_brokerage_access(brokerage_id)
 *   I/U/D   is_platform_admin() OR (brokerage_id IS NOT NULL
 *             AND has_brokerage_access(brokerage_id)
 *             AND (is_brokerage_admin() OR is_compliance_officer_role()))
 *
 * so a tenant READS the federal catalogue and its own words, and WRITES only its
 * own. The screens this file feeds never offer a federal row for editing — RLS
 * refuses it regardless, but a button that cannot work should not be drawn.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 * (a) NO `.eq("brokerage_id", …)` ON THE LIST. `NULL = <uuid>` is NULL, never
 *     true, so that filter would hide every federal row — reopening the gate
 *     m450 closed, from a settings page, silently. RLS already unions the two
 *     scopes; the split into "federal" and "ours" happens in code, below, on
 *     `brokerage_id === null`.
 *
 * (b) EVERY QUERY DESTRUCTURES `error`. supabase-js RESOLVES a failed query, so
 *     an undestructured `data` reports a permission denial as an empty list. A
 *     broker refused by RLS must not be told "you have no phrases".
 *
 * (c) AN RLS REFUSAL ON UPDATE/DELETE IS ZERO ROWS WITH `error: null`. Both
 *     writers `.select("id")` and check the returned length, and say plainly
 *     that nothing changed rather than reporting a save that never happened.
 *
 * The RLS-respecting session client is used deliberately — NOT createServiceClient.
 * The database is the final authority on who may write; the role gate below only
 * exists so the refusal arrives as a sentence instead of a silent no-op, and it
 * is a mirror of the DB predicate, never a superset of it.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { revalidatePath } from "next/cache"
import {
  isPhraseSeverity,
  validateEffectivePhrasePattern,
  DEFAULT_PHRASE_SEVERITY,
  PHRASE_SEVERITIES,
  type PhraseSeverity,
} from "@/lib/compliance/phrase-vocabulary"

/** One row as the settings screen sees it. `scope` is the whole point. */
export interface CompliancePhraseView {
  id: string
  phrase: string
  phrasePattern: string | null
  category: string | null
  severity: string
  suggestedAlternative: string | null
  notes: string | null
  isActive: boolean
  updatedAt: string | null
  /** "federal" rows are read-only to every tenant. */
  scope: "federal" | "brokerage"
}

export interface CompliancePhraseListResult {
  ok: boolean
  /** brokerage_id IS NULL — the platform catalogue. Read-only here, always. */
  federal: CompliancePhraseView[]
  /** brokerage_id = this session's brokerage — the tenant's own additions. */
  own: CompliancePhraseView[]
  /** Whether THIS caller may add/edit/remove. Drives whether the UI draws controls. */
  canManage: boolean
  error?: string
}

export interface CompliancePhraseWriteResult {
  ok: boolean
  id?: string
  error?: string
}

/**
 * The DB write predicate, mirrored. is_brokerage_admin() reads
 * users.user_type IN ('admin','broker','broker_owner'); is_compliance_officer_role()
 * reads users.user_type IN ('compliance_officer','compliance_manager'). Kept as
 * one list so the two cannot drift apart in this file.
 */
const PHRASE_WRITE_ROLES = [
  "admin",
  "broker",
  "broker_owner",
  "compliance_officer",
  "compliance_manager",
  // is_platform_admin() — platform staff may also write the federal catalogue,
  // though this action only ever writes tenant rows.
  "superadmin",
  "super_admin",
]

type SessionGate =
  | { ok: true; brokerageId: string; canManage: boolean }
  | { ok: false; error: string }

/** Identity and tenant come from the SESSION. Neither is ever an argument. */
async function resolveSession(): Promise<SessionGate> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not signed in." }
  if (!ctx.brokerageId) {
    return {
      ok: false,
      error: "This account is not attached to a brokerage yet, so it has no phrase list to manage.",
    }
  }
  const userType = ctx.userType ?? ""
  return {
    ok: true,
    brokerageId: ctx.brokerageId,
    canManage: PHRASE_WRITE_ROLES.includes(userType),
  }
}

function toView(row: Record<string, unknown>): CompliancePhraseView {
  const brokerageId = (row.brokerage_id as string | null) ?? null
  return {
    id: row.id as string,
    phrase: (row.phrase as string) ?? "",
    phrasePattern: (row.phrase_pattern as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    severity: (row.severity as string) ?? DEFAULT_PHRASE_SEVERITY,
    suggestedAlternative: (row.suggested_alternative as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    isActive: (row.is_active as boolean) ?? true,
    updatedAt: (row.updated_at as string | null) ?? null,
    // The ONLY thing that separates the platform catalogue from a tenant's own
    // words. Not a role check, not a category — the column.
    scope: brokerageId === null ? "federal" : "brokerage",
  }
}

/**
 * Every phrase this session is allowed to see, split by scope.
 *
 * ONE query. RLS already returns federal ∪ own; adding a brokerage filter here
 * would drop the federal catalogue on the floor (see (a) above). Inactive rows
 * are included on purpose — a paused word is a word the broker turned off and
 * may want back, and hiding it would look like it was deleted.
 */
export async function listCompliancePhrases(): Promise<CompliancePhraseListResult> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, federal: [], own: [], canManage: false, error: gate.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("prohibited_phrases")
    .select(
      "id, phrase, phrase_pattern, category, severity, suggested_alternative, notes, is_active, updated_at, brokerage_id",
    )
    .order("severity", { ascending: true })
    .order("phrase", { ascending: true })

  if (error) {
    // A refusal is NOT an empty catalogue, and must never be shown as one.
    return {
      ok: false,
      federal: [],
      own: [],
      canManage: gate.canManage,
      error: `Could not read the prohibited-phrase catalogue: ${error.message}`,
    }
  }

  const rows = (data ?? []).map((r) => toView(r as Record<string, unknown>))
  return {
    ok: true,
    federal: rows.filter((r) => r.scope === "federal"),
    own: rows.filter((r) => r.scope === "brokerage"),
    canManage: gate.canManage,
  }
}

export interface CompliancePhraseInput {
  phrase: string
  phrasePattern?: string | null
  category?: string | null
  severity?: string
  suggestedAlternative?: string | null
  notes?: string | null
  isActive?: boolean
}

function normaliseInput(
  input: CompliancePhraseInput,
):
  | { ok: true; value: {
      phrase: string
      phrase_pattern: string | null
      category: string | null
      severity: PhraseSeverity
      suggested_alternative: string | null
      notes: string | null
      is_active: boolean
    } }
  | { ok: false; error: string } {
  const phrase = (input.phrase ?? "").trim()
  if (!phrase) return { ok: false, error: "Enter the word or phrase to prohibit." }

  const severity = input.severity ?? DEFAULT_PHRASE_SEVERITY
  if (!isPhraseSeverity(severity)) {
    // The column's CHECK would answer this with a bare 23514. Answer it here in
    // words, and name the three values the constraint actually admits.
    return {
      ok: false,
      error: `"${severity}" is not a severity. Choose one of: ${PHRASE_SEVERITIES.join(", ")}.`,
    }
  }

  // COMPILE WHAT THE SCANNER WILL COMPILE, BEFORE IT REACHES THE TABLE.
  // scanForProhibitedPhrases does `new RegExp(phrase_pattern || phrase, "gi")`
  // inside a loop over the whole catalogue and deliberately does not catch, so a
  // single uncompilable row aborts EVERY scan — including scans of content that
  // has nothing to do with this phrase. Note the fallback: with no pattern, the
  // PHRASE ITSELF is compiled, so "**reduced**" is as dangerous as a bad pattern.
  const patternCheck = validateEffectivePhrasePattern(phrase, input.phrasePattern)
  if (!patternCheck.ok) return { ok: false, error: patternCheck.error }

  const trim = (v: string | null | undefined) => {
    const t = (v ?? "").trim()
    return t.length > 0 ? t : null
  }

  return {
    ok: true,
    value: {
      phrase,
      phrase_pattern: trim(input.phrasePattern),
      category: trim(input.category),
      severity,
      // Rendered to agents on submit-content-form.tsx and pending-approvals-list.tsx,
      // so it is worth offering even though it is optional.
      suggested_alternative: trim(input.suggestedAlternative),
      notes: trim(input.notes),
      is_active: input.isActive ?? true,
    },
  }
}

/**
 * Add a phrase for the CALLER'S OWN brokerage.
 *
 * `brokerage_id` is set from the session and is not an argument. A client that
 * could name the brokerage could name NULL and write the federal catalogue —
 * RLS refuses that (`brokerage_id IS NOT NULL` is in the INSERT predicate), but
 * the parameter should not exist in the first place.
 */
export async function addCompliancePhrase(
  input: CompliancePhraseInput,
): Promise<CompliancePhraseWriteResult> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.canManage) {
    return {
      ok: false,
      error:
        "Only a broker, an admin or a compliance officer can change the brokerage's prohibited words.",
    }
  }

  const parsed = normaliseInput(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("prohibited_phrases")
    .insert({ ...parsed.value, brokerage_id: gate.brokerageId })
    .select("id")

  if (error) {
    // 23505: the per-scope unique index (brokerage_id, phrase) WHERE brokerage_id
    // IS NOT NULL. Adding a word the FEDERAL list already carries is allowed and
    // does not land here — the two scopes have separate indexes.
    if (error.code === "23505") {
      return { ok: false, error: `"${parsed.value.phrase}" is already on this brokerage's list.` }
    }
    return { ok: false, error: `Could not add the phrase: ${error.message}` }
  }
  if (!data || data.length === 0) {
    // Belt and braces: an insert refused by RLS normally errors, but a zero-row
    // return must not be reported as a save.
    return {
      ok: false,
      error: "The phrase was not added — the database returned no row. Nothing was changed.",
    }
  }

  revalidatePath("/dashboard/settings")
  revalidatePath("/compliance/settings")
  return { ok: true, id: data[0].id as string }
}

/**
 * Edit one of the caller's OWN phrases.
 *
 * The `.eq("brokerage_id", …)` here is the opposite case from the list: this
 * write must be confined to the tenant's rows, and a federal row (brokerage_id
 * NULL) can never match a uuid — which is exactly the behaviour wanted. RLS
 * refuses it too; this makes the refusal deterministic rather than incidental.
 */
export async function updateCompliancePhrase(
  id: string,
  input: CompliancePhraseInput,
): Promise<CompliancePhraseWriteResult> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.canManage) {
    return {
      ok: false,
      error:
        "Only a broker, an admin or a compliance officer can change the brokerage's prohibited words.",
    }
  }
  if (!id) return { ok: false, error: "No phrase was identified to update." }

  const parsed = normaliseInput(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("prohibited_phrases")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId)
    .select("id")

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `"${parsed.value.phrase}" is already on this brokerage's list.` }
    }
    return { ok: false, error: `Could not update the phrase: ${error.message}` }
  }
  // AN RLS REFUSAL ARRIVES AS ZERO ROWS AND `error: null`. Saying "saved" here
  // would be a lie the user has no way to detect.
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        "Nothing was changed. That phrase is either not on this brokerage's list — the federal " +
        "Fair Housing entries cannot be edited by a brokerage — or this account is not permitted " +
        "to change it.",
    }
  }

  revalidatePath("/dashboard/settings")
  revalidatePath("/compliance/settings")
  return { ok: true, id }
}

/** Remove one of the caller's OWN phrases. Same zero-row honesty as update. */
export async function deleteCompliancePhrase(
  id: string,
): Promise<CompliancePhraseWriteResult> {
  const gate = await resolveSession()
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.canManage) {
    return {
      ok: false,
      error:
        "Only a broker, an admin or a compliance officer can change the brokerage's prohibited words.",
    }
  }
  if (!id) return { ok: false, error: "No phrase was identified to remove." }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("prohibited_phrases")
    .delete()
    .eq("id", id)
    .eq("brokerage_id", gate.brokerageId)
    .select("id")

  if (error) return { ok: false, error: `Could not remove the phrase: ${error.message}` }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        "Nothing was removed. That phrase is either not on this brokerage's list — the federal " +
        "Fair Housing entries cannot be removed by a brokerage — or this account is not permitted " +
        "to change it.",
    }
  }

  revalidatePath("/dashboard/settings")
  revalidatePath("/compliance/settings")
  return { ok: true, id }
}
