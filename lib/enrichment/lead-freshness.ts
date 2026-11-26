// lib/enrichment/lead-freshness.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE, and deliberately free of `server-only` so the guard script can import it
// (same reason ./deal-vocabulary and ./identifier-guard are split out).
// Consumed by lib/enrichment/lead-enrichment-core.ts (the I/O side, which IS
// server-only) and imported DIRECTLY by
// scripts/enrichment-suppression-simulator.ts — a plain-tsx guard cannot reach it
// through the core, which is the whole point of the split.
//
// ── WHY THE LEAD LANE CANNOT REUSE THE CONTACT FRESHNESS TEST ────────────────
// queueContactEnrichment answers "has this been enriched recently?" by reading
// two timestamps (contacts.enriched_at and contacts.last_enriched_at). On the
// CONTACT side that is honest: both stamps are written by an executor that has
// already succeeded.
//
// On the LEAD side the same test is a trap, because a lead is stamped as enriched
// at INSERT time, before anything is known:
//
//   lib/lead-pipeline/pipeline-processor.ts:486   enrichment_status: 'completed',
//                                                 last_enriched_at:  now
//   lib/lead-promotion/lead-promoter.ts:107       enrichment_status: 'completed',
//                                                 last_enriched_at:  now
//
// pipeline-processor calls `enrichWithPeopleData(...).catch(() => ({ data: null }))`
// and, when the provider misses or throws, falls through to a base object with
// `enrichmentConfidence: 0.3` and no provider data at all — then writes those two
// fields anyway. So a lead PeopleData never matched is born reading "enriched,
// completed, just now". A freshness gate gate keyed on `last_enriched_at` alone
// would refuse to queue it today, tomorrow, and forever: the exact "too broad →
// enrichment never runs" failure the contact lane's terminal-set trap describes,
// arrived at from the opposite direction.
//
// ── THE HONEST TEST ──────────────────────────────────────────────────────────
// `leads.enrichment_profile` is jsonb NOT NULL defaulting to `{}` (verified live,
// project hrvaqgvukzxfskkcrwbt). NEITHER create door writes it. The ONLY writer
// is a real drain success — lib/lead-pipeline/enrichment-orchestrator.ts:301
// sets `enrichment_profile: profile` inside the `if (enriched)` branch, i.e. only
// when the provider actually returned a record.
//
// So "this lead has really been enriched" is exactly: the profile blob is a
// non-empty object. The timestamp then answers the separate question "and was it
// recent enough that re-buying would be waste".
//
// Deliberately NOT used as the evidence column:
//   · enrichment_status  — both create doors write 'completed' while the drain
//     writes 'complete' (enrichment-orchestrator.ts:297), and the two governance
//     gates that read it (lead-governance/promotion-readiness.ts:37 and
//     routing-evaluator.ts:70) test for 'complete'. The vocabulary is split; a
//     freshness rule must not be built on a value that already disagrees with
//     itself. There is no CHECK constraint on the column to settle it.
//   · enrichment_confidence — the miss path writes 0.3, a real match can also be
//     low. It does not distinguish "we asked and got nothing" from "we never asked".

/** Default re-buy window for a lead. Matches queueContactEnrichment's default. */
export const LEAD_ENRICHMENT_FRESHNESS_DAYS = 7

/**
 * PURE. Has this lead actually been enriched, by evidence rather than by stamp?
 *
 * A non-empty plain object in `enrichment_profile` is the evidence. An array, a
 * string, `null` and `{}` all mean "no provider record ever landed here" — the
 * column is NOT NULL, so `{}` is what an untouched row holds.
 */
export function leadHasEnrichmentEvidence(row: { enrichment_profile?: unknown }): boolean {
  const p = row.enrichment_profile
  if (!p || typeof p !== "object" || Array.isArray(p)) return false
  return Object.keys(p as Record<string, unknown>).length > 0
}

/**
 * PURE. Should the lead lane SKIP this lead as recently and genuinely enriched?
 *
 * Both halves must hold. Evidence without a readable timestamp is not fresh (we
 * cannot date it, so we re-check); a timestamp without evidence is the create-door
 * lie described above and is never fresh.
 */
export function leadEnrichmentIsFresh(
  row: { last_enriched_at?: string | null; enrichment_profile?: unknown },
  opts?: { now?: number; freshnessDays?: number },
): boolean {
  if (!leadHasEnrichmentEvidence(row)) return false

  const stamp = row.last_enriched_at ? new Date(row.last_enriched_at).getTime() : Number.NaN
  if (Number.isNaN(stamp)) return false

  const now = opts?.now ?? Date.now()
  const windowMs = (opts?.freshnessDays ?? LEAD_ENRICHMENT_FRESHNESS_DAYS) * 24 * 60 * 60 * 1000
  // A stamp in the FUTURE is clock skew or a bad write, not freshness. `now - stamp`
  // would be negative and pass the window test, pinning the lead as fresh until the
  // future catches up; requiring a non-negative age refuses that.
  const age = now - stamp
  return age >= 0 && age < windowMs
}
