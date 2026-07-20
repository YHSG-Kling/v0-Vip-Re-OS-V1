// lib/lead-pipeline/parked-retention.ts
// ─────────────────────────────────────────────────────────────────────────────
// PARKED-LEAD RETENTION POSTURE (owner round 40, rec 5).
//
// Parked platform leads — leads.brokerage_id IS NULL, promoted by the platform
// pipeline with no owning tenant — sit untouched BY DESIGN (the distribution
// engine hands them to a subscriber when one claims the zip). Until now they
// sat with NO documented retention stance. This module is that governance:
//
//   TIER      AGE            DOCUMENTED POSTURE
//   fresh     < 90 days      keep + sweep — live inventory the distribution
//                            engine can still hand to a new subscriber.
//   aging     90–365 days    keep, FLAGGED on the superadmin coverage board —
//                            honest count of inventory going stale unclaimed.
//   stale     > 365 days     ELIGIBLE for anonymized archival: purge the PII
//                            (name / email / phone / notes / street address),
//                            KEEP the zip-level row (zip + state + timestamps +
//                            a purged_at marker) so coverage/marketplace stats
//                            stay honest. Archival is a PROPOSED action to the
//                            PLATFORM ADMIN — superadmin-gated, previewed
//                            (exact count + zips), audit-ledgered. NEVER an
//                            automatic deletion; rows are anonymized, not dropped.
//
// The purge marker lives in leads.enrichment_profile (jsonb, NOT NULL default
// '{}' — scripts/1096) under PURGED_MARKER_KEY, which BOTH stamps the purge
// time AND wipes any enriched PII in the same write — no new column, no
// migration required.
//
// Tier math + preview composition are PURE (simulator-driven, no I/O); the
// loaders/executor take a caller-supplied client. This module never contacts a
// lead and never dispatches anything — it only reads, and (superadmin action
// only) nulls PII columns in place.

// ─── Declared tier boundaries (named in every label — never implied) ─────────

export const PARKED_FRESH_MAX_DAYS = 90
export const PARKED_AGING_MAX_DAYS = 365
/** Bounded read for the board + purge batch — a hit cap is reported, never silent. */
export const PARKED_READ_CAP = 5000
/** Max rows anonymized per purge execution (re-run to continue; each run is audited). */
export const PARKED_PURGE_BATCH_CAP = 1000

export type ParkedTier = "fresh" | "aging" | "stale"

/** The jsonb key inside leads.enrichment_profile that marks an anonymized row. */
export const PURGED_MARKER_KEY = "pii_purged_at"

/** PII columns the archival nulls — name / email / phone / notes / street address. */
export const PARKED_PII_COLUMNS = [
  "first_name", "last_name", "email", "phone", "notes", "mailing_address",
] as const

/** What the anonymized row KEEPS — the zip-level stats the coverage board needs. */
export const PARKED_RETAINED_COLUMNS = [
  "zip_code", "state", "city", "source", "source_origin", "created_at", "updated_at",
] as const

/** The documented posture per tier — rendered verbatim on the coverage board. */
export const PARKED_RETENTION_POSTURE: Record<ParkedTier, { label: string; ageLabel: string; posture: string }> = {
  fresh: {
    label: "Fresh",
    ageLabel: `under ${PARKED_FRESH_MAX_DAYS} days`,
    posture: "Keep + sweep — live inventory; the distribution engine hands these to the first subscriber who claims the zip.",
  },
  aging: {
    label: "Aging",
    ageLabel: `${PARKED_FRESH_MAX_DAYS}–${PARKED_AGING_MAX_DAYS} days`,
    posture: "Keep, flagged here — unclaimed inventory going stale; an honest count, not an alarm.",
  },
  stale: {
    label: "Stale",
    ageLabel: `over ${PARKED_AGING_MAX_DAYS} days`,
    posture: "Eligible for anonymized archival — PII purged, zip-level row retained for coverage stats. Superadmin-proposed, previewed, audited; never automatic.",
  },
}

/** The compliance posture statement the coverage board renders (one honest paragraph). */
export const PARKED_RETENTION_STATEMENT =
  `Data-retention stance for parked platform leads (no owning tenant): fresh (<${PARKED_FRESH_MAX_DAYS}d) stay live for distribution; ` +
  `aging (${PARKED_FRESH_MAX_DAYS}–${PARKED_AGING_MAX_DAYS}d) stay but are flagged here; stale (>${PARKED_AGING_MAX_DAYS}d) become eligible for ` +
  `ANONYMIZED archival — PII (name/email/phone/notes/street address) purged, the zip-level row retained with a purged_at marker so coverage counts stay honest. ` +
  `Archival only ever runs as a superadmin-approved action with an exact preview (count + zips) and an audit-ledger entry — never an automatic deletion.`

// ─── Pure tier math ──────────────────────────────────────────────────────────

export function parkedLeadTier(createdAt: string | null | undefined, now: Date = new Date()): ParkedTier {
  const t = createdAt ? new Date(createdAt).getTime() : Number.NaN
  // An unparseable/missing created_at is treated as FRESH — never purge a row
  // whose age can't be proven (the conservative side of the policy).
  if (!Number.isFinite(t)) return "fresh"
  const ageDays = (now.getTime() - t) / 86_400_000
  if (ageDays < PARKED_FRESH_MAX_DAYS) return "fresh"
  if (ageDays <= PARKED_AGING_MAX_DAYS) return "aging"
  return "stale"
}

/** Pure: has this row already been anonymized (marker in enrichment_profile)? */
export function isPurgedParkedLead(enrichmentProfile: unknown): boolean {
  const ep = (enrichmentProfile ?? {}) as Record<string, unknown>
  return typeof ep === "object" && ep !== null && typeof ep[PURGED_MARKER_KEY] === "string" && (ep[PURGED_MARKER_KEY] as string).length > 0
}

export interface ParkedLeadRow {
  id: string
  created_at: string | null
  zip_code: string | null
  enrichment_profile?: unknown
  /** Safety guards — a row with an owner or a converted contact is never parked. */
  brokerage_id?: string | null
  contact_id?: string | null
}

export interface PurgePreview {
  /** Exactly how many rows the purge would anonymize. */
  count: number
  /** Zip-level breakdown of exactly those rows (unknown zips stated as such). */
  zips: Array<{ zip: string; count: number }>
  columnsPurged: string[]
  columnsRetained: string[]
}

export interface ParkedRetentionReport {
  tiers: Record<ParkedTier, number>
  /** Rows already anonymized (marker present) — counted separately, in no tier. */
  purged: number
  total: number
  /** The stale rows' purge preview — exactly what the archival action would touch. */
  stalePreview: PurgePreview
  posture: typeof PARKED_RETENTION_POSTURE
  statement: string
  /** True when the bounded read hit PARKED_READ_CAP — counts are floors, not totals. */
  capped: boolean
  honestNotes: string[]
  generatedAt: string
}

const UNKNOWN_ZIP = "(zip unknown)"

/** Pure: the purge preview over a set of stale, not-yet-purged rows — the count
 *  + zip breakdown MUST tally exactly (preview honesty is a simulator lock). */
export function composePurgePreview(staleRows: Array<Pick<ParkedLeadRow, "zip_code">>): PurgePreview {
  const byZip = new Map<string, number>()
  for (const r of staleRows) {
    const zip = (r.zip_code ?? "").trim() || UNKNOWN_ZIP
    byZip.set(zip, (byZip.get(zip) ?? 0) + 1)
  }
  return {
    count: staleRows.length,
    zips: [...byZip.entries()].map(([zip, count]) => ({ zip, count })).sort((a, b) => b.count - a.count || a.zip.localeCompare(b.zip)),
    columnsPurged: [...PARKED_PII_COLUMNS],
    columnsRetained: [...PARKED_RETAINED_COLUMNS],
  }
}

/** Pure: parked rows → the full retention report. Purged rows count in NO age
 *  tier (they're already anonymized — recounting them would double-book). */
export function summarizeParkedRetention(
  rows: ParkedLeadRow[],
  now: Date = new Date(),
  capped = false,
): ParkedRetentionReport {
  const tiers: Record<ParkedTier, number> = { fresh: 0, aging: 0, stale: 0 }
  let purged = 0
  const staleUnpurged: ParkedLeadRow[] = []
  for (const r of rows) {
    if (isPurgedParkedLead(r.enrichment_profile)) { purged += 1; continue }
    const tier = parkedLeadTier(r.created_at, now)
    tiers[tier] += 1
    if (tier === "stale") staleUnpurged.push(r)
  }
  return {
    tiers,
    purged,
    total: rows.length,
    stalePreview: composePurgePreview(staleUnpurged),
    posture: PARKED_RETENTION_POSTURE,
    statement: PARKED_RETENTION_STATEMENT,
    capped,
    honestNotes: [
      `Parked = leads.brokerage_id IS NULL (promoted platform leads no tenant owns) — real rows, never an estimate.`,
      `Tier boundaries: fresh <${PARKED_FRESH_MAX_DAYS}d · aging ${PARKED_FRESH_MAX_DAYS}–${PARKED_AGING_MAX_DAYS}d · stale >${PARKED_AGING_MAX_DAYS}d, by created_at; a row without a provable age counts as fresh (never purged on a guess).`,
      `${purged} row${purged === 1 ? "" : "s"} already anonymized (PII purged, zip retained) — counted separately, in no age tier.`,
      `Read bounded at ${PARKED_READ_CAP} rows${capped ? " — CAP HIT: counts are floors, not totals, and the purge preview covers only the rows read." : "."}`,
      "Anonymized archival keeps the row (zip + timestamps + purged_at marker) — coverage and marketplace stats never lose zip-level history.",
    ],
    generatedAt: now.toISOString(),
  }
}

// ─── IO: bounded loader + the purge executor (caller-supplied client) ────────

type AnyClient = { from: (table: string) => any }

const PARKED_SELECT = "id, created_at, zip_code, enrichment_profile, brokerage_id, contact_id"

/** Load the parked population (bounded) → the retention report + the concrete
 *  stale row ids the purge action would touch. Read-only. */
export async function loadParkedRetention(
  supabase: AnyClient,
  opts?: { now?: Date },
): Promise<{ report: ParkedRetentionReport | null; staleIds: string[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from("leads")
      .select(PARKED_SELECT)
      .is("brokerage_id", null)
      .order("created_at", { ascending: true })
      .limit(PARKED_READ_CAP)
    if (error) return { report: null, staleIds: [], error: `leads: ${error.message}` }
    const rows = (data ?? []) as ParkedLeadRow[]
    const now = opts?.now ?? new Date()
    const report = summarizeParkedRetention(rows, now, rows.length >= PARKED_READ_CAP)
    const staleIds = rows
      .filter((r) => !isPurgedParkedLead(r.enrichment_profile) && !r.contact_id && parkedLeadTier(r.created_at, now) === "stale")
      .map((r) => r.id)
    return { report, staleIds, error: null }
  } catch (e) {
    return { report: null, staleIds: [], error: e instanceof Error ? e.message : "parked retention load failed" }
  }
}

export interface PurgeExecutionResult {
  ok: boolean
  purged: number
  /** The zip breakdown of exactly the rows anonymized (the honest receipt). */
  zips: Array<{ zip: string; count: number }>
  /** True when more stale rows remain beyond this batch (re-run to continue). */
  moreRemaining: boolean
  error?: string
}

/**
 * Execute the anonymized archival over the CURRENT stale set: null the PII
 * columns, stamp the purged_at marker (which also wipes enrichment_profile PII
 * in the same write). The row survives — zip + timestamps intact. Batch-capped;
 * re-selects its own targets (never trusts a stale preview) so the receipt is
 * exact. Caller (the superadmin action) owns the gate + the audit-ledger entry.
 */
export async function executeStaleParkedPurge(
  supabase: AnyClient,
  opts?: { now?: Date; batchCap?: number },
): Promise<PurgeExecutionResult> {
  try {
    const now = opts?.now ?? new Date()
    const cap = Math.min(opts?.batchCap ?? PARKED_PURGE_BATCH_CAP, PARKED_PURGE_BATCH_CAP)
    const cutoffIso = new Date(now.getTime() - PARKED_AGING_MAX_DAYS * 86_400_000).toISOString()

    // Re-derive the target set at execution time — parked, provably stale,
    // never converted, not already purged. +1 over the cap detects a remainder.
    const { data, error } = await supabase
      .from("leads")
      .select("id, zip_code, enrichment_profile")
      .is("brokerage_id", null)
      .is("contact_id", null)
      .lt("created_at", cutoffIso)
      .order("created_at", { ascending: true })
      .limit(cap + 1)
    if (error) return { ok: false, purged: 0, zips: [], moreRemaining: false, error: `select: ${error.message}` }

    const candidates = ((data ?? []) as ParkedLeadRow[]).filter((r) => !isPurgedParkedLead(r.enrichment_profile))
    const moreRemaining = candidates.length > cap
    const batch = candidates.slice(0, cap)
    if (batch.length === 0) return { ok: true, purged: 0, zips: [], moreRemaining: false }

    const marker = {
      [PURGED_MARKER_KEY]: now.toISOString(),
      purge_reason: "parked_stale_archival",
      purged_columns: [...PARKED_PII_COLUMNS],
    }
    const piiNulls: Record<string, null> = {}
    for (const col of PARKED_PII_COLUMNS) piiNulls[col] = null

    let purged = 0
    const purgedRows: Array<Pick<ParkedLeadRow, "zip_code">> = []
    for (let i = 0; i < batch.length; i += 500) {
      const chunk = batch.slice(i, i + 500)
      const { error: upErr } = await supabase
        .from("leads")
        .update({ ...piiNulls, enrichment_profile: marker })
        .in("id", chunk.map((r) => r.id))
      if (upErr) return { ok: false, purged, zips: composePurgePreview(purgedRows).zips, moreRemaining, error: `update: ${upErr.message}` }
      purged += chunk.length
      purgedRows.push(...chunk)
    }

    return { ok: true, purged, zips: composePurgePreview(purgedRows).zips, moreRemaining }
  } catch (e) {
    return { ok: false, purged: 0, zips: [], moreRemaining: false, error: e instanceof Error ? e.message : "purge failed" }
  }
}
