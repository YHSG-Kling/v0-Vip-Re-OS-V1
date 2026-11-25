/**
 * lib/forms/form-read-apply.ts — the AI form reader's PURE half (wave 156, lane 156C round 2): the CDA detector and the reviewer's
 * accept step. No model, no zod — the FormWizard client imports it. lib/forms/form-document-reader.ts re-exports both.
 */

export interface ReadSuggestion { kind: string; target: string; value?: string | null; evidence: { page?: number | null; quote: string }; status?: string }

/** PURE: is this form a Commission Disbursement Authorization? (No AI reads it for prefill — the agent fills the CDA.) */
export function isCdaForm(meta: { name?: string | null; formCode?: string | null }): boolean {
  const s = `${meta.name ?? ""} ${meta.formCode ?? ""}`
  return /\bCDA\b/i.test(s) || /commission\s+disbursement/i.test(s)
}

/**
 * WAVE 156 (156C, round 2): A PERSON ACCEPTS, ONE SUGGESTION AT A TIME — the FormWizard's Step 3 fill fields receive ONLY the values a
 * reviewer accepted. PURE. A suggestion the reviewer rejected, or never decided, is never applied; a suggestion with no value, or
 * one that is not a field / legal-description prefill, is never a fill value; a CDA is refused outright (the agent fills the CDA).
 * The returned map is the CURRENT fill values plus the accepted ones — nothing the agent typed is overwritten unless they accepted a
 * suggestion for that very field.
 */
export function applyAcceptedSuggestions(
  current: Record<string, string>,
  suggestions: ReadonlyArray<ReadSuggestion>,
  decisions: Readonly<Record<number, "accept" | "reject">>,
  form: { name?: string | null; formCode?: string | null; fields: readonly string[] },
): { ok: true; values: Record<string, string>; applied: string[] } | { ok: false; refused: string } {
  if (isCdaForm(form)) return { ok: false, refused: "This is a Commission Disbursement Authorization — the agent fills the CDA; no AI suggestion is applied to it." }
  const fieldSet = new Set(form.fields)
  const values = { ...current }
  const applied: string[] = []
  suggestions.forEach((s, i) => {
    if (decisions[i] !== "accept") return
    if (s.status && s.status !== "pending_review") return
    if (s.kind !== "field" && s.kind !== "legal_description") return
    if (s.value == null || s.value === "" || !fieldSet.has(s.target)) return
    if ((s.evidence?.quote ?? "").trim().length < 4) return
    values[s.target] = String(s.value)
    applied.push(s.target)
  })
  return { ok: true, values, applied }
}
