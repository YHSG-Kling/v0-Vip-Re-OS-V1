// lib/data-steward/field-steward.ts
//
// The Data Steward owns ONE rule: data moves through the raw -> leads -> contacts spine
// (and across dedup merges and CSV imports) WITHOUT silent loss. Every boundary that today
// hand-maps fields is a place a value can vanish; this module is the canonical, pure, testable
// core the Steward enforces with:
//
//   - CANONICAL_CONTACT_FIELDS  : the protected identity/address/reachability field set.
//   - mergeIdentityFields()     : lossless merge for dedup (`mergeLeads`) — most-complete value
//                                 wins, and a real conflict is preserved in notes, never dropped.
//   - routeUnknownToNotes()     : ingress mapper (CSV/portal import) — known fields map straight
//                                 through, everything else is captured in notes (per the business
//                                 rule: "match their field to the best matching, anything else
//                                 goes in as notes").
//
// No server/gateway imports — runs under plain tsx for the simulator.

/** Protected fields that must never be silently dropped on a merge or promotion. */
export const CANONICAL_CONTACT_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'phone_secondary',
  'address', 'city', 'state', 'zip_code',
  'mailing_address', 'mailing_city', 'mailing_state', 'mailing_zip',
] as const

export type CanonicalContactField = (typeof CANONICAL_CONTACT_FIELDS)[number]

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

export interface MergeResult<T> {
  merged: T
  /** Human-readable lines describing values that conflicted and were preserved rather than lost. */
  conflicts: string[]
}

/**
 * Lossless merge of an incoming record into a primary record over the canonical fields.
 * Rules:
 *   - primary keeps its non-empty value (it is the surviving row of the merge);
 *   - an empty primary field is filled from incoming;
 *   - when BOTH are present and DIFFER, primary wins BUT the incoming value is recorded as a
 *     conflict line (so the caller can append it to notes) — nothing is ever silently discarded.
 *
 * `fields` defaults to the canonical contact set; pass a subset (e.g. lead fields) to scope it.
 */
export function mergeIdentityFields<T extends Record<string, any>>(
  primary: T,
  incoming: Partial<T>,
  fields: readonly string[] = CANONICAL_CONTACT_FIELDS,
): MergeResult<T> {
  const merged: T = { ...primary }
  const conflicts: string[] = []

  for (const f of fields) {
    const pv = (primary as any)[f]
    const iv = (incoming as any)[f]
    if (isEmpty(iv)) continue
    if (isEmpty(pv)) {
      ;(merged as any)[f] = iv
      continue
    }
    // both present
    if (`${pv}`.trim().toLowerCase() !== `${iv}`.trim().toLowerCase()) {
      conflicts.push(`${f}: kept "${pv}", also saw "${iv}"`)
    }
  }
  return { merged, conflicts }
}

export interface RouteResult {
  /** Known canonical fields pulled from the payload (only non-empty values). */
  mapped: Record<string, unknown>
  /** Unmapped keys rendered as a notes block, or '' when everything mapped. */
  notes: string
  /** The raw unmapped key/value pairs (for structured storage if desired). */
  unmapped: Record<string, unknown>
}

/**
 * Ingress mapper for imports / external sources. `aliases` lets a source's column name map to a
 * canonical field (e.g. {'Home Phone':'phone'}). Anything not recognized is preserved in notes so
 * an import can never drop a column on the floor.
 */
export function routeUnknownToNotes(
  payload: Record<string, unknown>,
  opts?: { fields?: readonly string[]; aliases?: Record<string, string> },
): RouteResult {
  const fields = new Set(opts?.fields ?? CANONICAL_CONTACT_FIELDS)
  const aliases = opts?.aliases ?? {}
  const mapped: Record<string, unknown> = {}
  const unmapped: Record<string, unknown> = {}

  for (const [rawKey, value] of Object.entries(payload)) {
    if (isEmpty(value)) continue
    const canonical = fields.has(rawKey) ? rawKey : aliases[rawKey]
    if (canonical && fields.has(canonical)) {
      mapped[canonical] = value
    } else {
      unmapped[rawKey] = value
    }
  }

  const notes = Object.keys(unmapped).length
    ? 'Imported fields (unmapped): ' +
      Object.entries(unmapped).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ')
    : ''

  return { mapped, notes, unmapped }
}
