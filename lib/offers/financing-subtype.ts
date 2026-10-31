// lib/offers/financing-subtype.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE FINANCING SUBTYPE — the brokerage's own financing term, beside its platform roll-up (wave 145, lane 145Z; lane 145C
// requirement 7 decided the typed column, m871; lane 144A Outside-lane 1 named the writers).
//
// A brokerage term ("FHA 203(k)") rolls up to ONE platform key (`fha`) through the adaptive vocabulary
// (lib/compliance/adaptive-vocabulary.ts vocabularyWriteValue). `financing_type` keeps the roll-up — the column offer
// strength, the government-loan addendum and financingKindFor read — and `financing_subtype` keeps the term itself.
//
//   financingWriteValues(raw, vocab)        PURE — { financing_type, financing_subtype } for a writer.
//   resolveFinancingWrite(svc, b, raw)      loads the brokerage vocabulary (fail-soft to the platform list, said).
//   persistFinancingSubtype(svc, …)         the column's ONE writer: its own UPDATE, tenant-pinned, row-counted;
//                                           42703 / PGRST204 = m871 not applied (reported, never thrown).
//   readFinancingSubtype(svc, …)            the column's ONE reader: a star select (an absent column is simply absent,
//                                           so a database without m871 reads null — never a refused query).
//
// Not server-only: every read is behind an injected client.

import type { SupabaseClient } from "@supabase/supabase-js"
import { EMPTY_TENANT_VOCABULARY, loadTenantVocabulary, vocabularyWriteValue, type TenantVocabulary } from "@/lib/compliance/adaptive-vocabulary"

type Svc = SupabaseClient<any, any, any>

const MISSING_COLUMN = new Set(["42703", "PGRST204"])

/**
 * PURE — what a writer stores for a financing value the person (or an extraction) gave. A value the vocabulary resolves
 * is stored as its PLATFORM roll-up with the brokerage term as the subtype; a value it cannot interpret is kept as
 * written (the historical behaviour — never silently nulled) with no subtype.
 */
export function financingWriteValues(raw: unknown, vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY): { financing_type: string | null; financing_subtype: string | null } {
  if (typeof raw !== "string" || !raw.trim()) return { financing_type: null, financing_subtype: null }
  const w = vocabularyWriteValue("financing_type", raw, vocab)
  if (!w.value) return { financing_type: raw.trim(), financing_subtype: null }
  return { financing_type: w.value, financing_subtype: w.subtype }
}

/** The brokerage's vocabulary is read with the caller's client; an unreadable vocabulary falls back to the platform list
 *  (a brokerage term then stays as written, without a subtype) and says so in `blindSpot`. */
export async function resolveFinancingWrite(svc: Svc, brokerageId: string, raw: unknown): Promise<{ financing_type: string | null; financing_subtype: string | null; blindSpot: string | null }> {
  if (typeof raw !== "string" || !raw.trim()) return { financing_type: null, financing_subtype: null, blindSpot: null }
  let vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY
  let blindSpot: string | null = null
  try {
    const v = await loadTenantVocabulary(svc, brokerageId)
    if (v.ok) vocab = v.vocabulary
    else blindSpot = v.error
  } catch (err) {
    blindSpot = `the brokerage vocabulary could not be read: ${(err as Error)?.message ?? err}`
  }
  return { ...financingWriteValues(raw, vocab), blindSpot }
}

export type PersistFinancingSubtypeResult = { ok: true; written: number } | { ok: false; notApplied?: true; error: string }

/** The column's ONE writer. Tenant-pinned; a write that matches no row is an error (a DELETE/UPDATE that matches
 *  nothing RESOLVES — CLAUDE.md §3), and a database without m871 is reported as not applied. */
export async function persistFinancingSubtype(
  svc: Svc,
  input: { table: "offers" | "transactions"; id: string; brokerageId: string; subtype: string | null },
): Promise<PersistFinancingSubtypeResult> {
  const { data, error } = await svc.from(input.table).update({ financing_subtype: input.subtype })
    .eq("id", input.id).eq("brokerage_id", input.brokerageId).select("id")
  if (error) {
    const code = String((error as { code?: string }).code ?? "")
    if (MISSING_COLUMN.has(code)) return { ok: false, notApplied: true, error: `${input.table}.financing_subtype does not exist yet (m871 not applied)` }
    return { ok: false, error: `${input.table}.financing_subtype could not be written: ${error.message}` }
  }
  const n = (data ?? []).length
  if (n === 0) return { ok: false, error: `${input.table} ${input.id} matched no row in this brokerage — the financing subtype was not written` }
  return { ok: true, written: n }
}

/** The column's ONE reader (star select: a database without m871 reads null, never a refused query). */
export async function readFinancingSubtype(
  svc: Svc,
  input: { table: "offers" | "transactions"; id: string; brokerageId: string },
): Promise<{ ok: true; subtype: string | null; financingType: string | null } | { ok: false; error: string }> {
  const { data, error } = await svc.from(input.table).select("*").eq("id", input.id).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `${input.table} could not be read: ${error.message}` }
  const row = (data ?? null) as { financing_subtype?: unknown; financing_type?: unknown } | null
  const subtype = typeof row?.financing_subtype === "string" && row.financing_subtype.trim() ? row.financing_subtype : null
  const financingType = typeof row?.financing_type === "string" && row.financing_type.trim() ? row.financing_type : null
  return { ok: true, subtype, financingType }
}
