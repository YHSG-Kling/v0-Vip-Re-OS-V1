/**
 * lib/enrichment/life-event-vocabulary.ts — THE ONE VOCABULARY for `contacts.life_events[]` (CLAUDE.md §6).
 *
 * WAVE 147, LANE 147Z (convergence; lane 147B "Still open" 5). The life-event writers and the scorers that read them had drifted
 * onto two spellings of the same event, so the scorers could not match the writers:
 *   · the WRITERS — lib/osint-client.ts (`divorce`, `death_in_family`) and lib/enrichment/web-mention-search.ts (same two);
 *   · the READERS — lib/predictive-listing/signal-generators.ts LIFE_EVENT_CONFIDENCE and lib/sphere-resonance/run-resonance-scan.ts
 *     (`divorce_filing`, `death_in_household`) — so a divorce or a death the enrichment found NEVER scored as a predictive seller
 *     signal and never reached the sphere's careful-timing rule.
 * SURVIVOR SPELLINGS: the readers' (`divorce_filing`, `death_in_household`) — they are the scoring vocabulary, they already match
 * the follow-up arbiter's signal_type spelling for a divorce (lib/ai-isa/followup-arbiter.ts LIFE_CHANGE_SIGNAL_KINDS
 * `divorce_filing`) and `foreclosure_filing` is already shared by both sides. The writers now write the survivor spellings.
 *
 * LEGACY_LIFE_EVENT_ALIASES is NOT a second spelling in use: no writer produces those tokens any more (test:movement-signals §J
 * asserts it over stripped source, with a positive control). It reads the rows ALREADY STORED under the retired spelling until the
 * owner/integrator backfill (one UPDATE over contacts.life_events — the SQL is in lane 147Z's notes) rewrites them; then the alias
 * table is deleted with a tombstone here.
 *
 * The element KEY drifted too: the OSINT rung stores `{ event }`, the life-change check (lib/enrichment/contact-enrichment-core.ts)
 * stores `{ type }`. Every reader reads the element through lifeEventTypeOf (type, else event) — one reader rule, both stored shapes.
 *
 * PURE — no imports, safe in any graph (page, proof, cron).
 */

export const LIFE_EVENT_TYPES = Object.freeze([
  "job_change", "job_change_to_non_local", "marriage", "new_baby", "kids_graduated", "empty_nester", "retirement",
  "divorce_filing", "foreclosure_filing", "death_in_household", "inheritance", "bankruptcy", "relocation",
] as const)
export type LifeEventType = (typeof LIFE_EVENT_TYPES)[number]

const CANONICAL: ReadonlySet<string> = new Set(LIFE_EVENT_TYPES)

/** Retired spelling → survivor. Reads stored history only (see the header); never written. */
export const LEGACY_LIFE_EVENT_ALIASES: Readonly<Record<string, LifeEventType>> = Object.freeze({
  divorce: "divorce_filing",
  death_in_family: "death_in_household",
})

/** PURE. A raw stored / written token → the survivor spelling, or null when it is not a life event of this vocabulary. */
export function canonicalLifeEventType(raw: unknown): LifeEventType | null {
  const t = String(raw ?? "").trim().toLowerCase()
  if (!t) return null
  if (CANONICAL.has(t)) return t as LifeEventType
  return LEGACY_LIFE_EVENT_ALIASES[t] ?? null
}

/** PURE. A contacts.life_events element (either stored shape: `{ type }` or `{ event }`) → its survivor spelling. */
export function lifeEventTypeOf(el: { type?: unknown; event?: unknown } | null | undefined): LifeEventType | null {
  if (!el || typeof el !== "object") return null
  return canonicalLifeEventType(el.type ?? el.event)
}
