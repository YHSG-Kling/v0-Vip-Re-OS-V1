/**
 * lib/lead-governance/seller-signal-strength.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE VOCABULARY FOR `motivated_seller_signals.signal_strength`, AND THE ONE
 * PLACE THAT DECIDES WHAT COUNTS AS A STRONG SIGNAL.
 *
 * WHY THIS FILE EXISTS. The column is TEXT and every writer in the tree stores a
 * WORD into it:
 *
 *   app/actions/lead-intelligence.ts:1187  "moderate"
 *   app/actions/lead-intelligence.ts:1203  "strong" | "moderate"   (equity)
 *   app/actions/lead-intelligence.ts:1218  "weak"
 *   app/actions/lead-intelligence.ts:1236  "strong" | "moderate"   (life event)
 *   app/actions/lead-intelligence.ts:2394  "urgent" | "strong" | "moderate"
 *   lib/external/permit-signals.ts:408     "strong" | "moderate" | "weak"  (permit)
 *   lib/external/permit-signals.ts:448     "strong" | "moderate" | "weak"  (violation)
 *
 * The ONE reader that scores them did this:
 *
 *   const strongSignals = sellerSignals.filter((s) => s.signal_strength > 0.7).length
 *   score += Math.min(strongSignals * 15, 30)
 *
 * `"strong" > 0.7` is a string-to-number comparison: JavaScript coerces the
 * string, gets NaN, and NaN > 0.7 is FALSE. For EVERY word in the vocabulary.
 * So the motivated-seller component of the lead score has always contributed
 * exactly ZERO of its possible 30 points — a permit for a demolition, a divorce
 * filing and an absentee owner all scored the same as no signal at all.
 *
 * This is the SECOND time this component has been structurally zero and the
 * second time for a different reason. lib/services/lead-management.service.ts:173
 * records the first: the scorer read `lead_motivated_seller_signals`, a retired
 * twin with no writer. That repoint made the ROWS reachable; the comparison
 * meant the rows still could not score. Fixing where you read from does not help
 * if you then compare the value against the wrong type.
 *
 * That twin is now GONE FROM THE DATABASE, not merely unread: m519 dropped it
 * (0 rows, 0 inbound FKs, 0 production `.from()` access, survivor
 * `motivated_seller_signals` verified live). The repoint had landed in the CODE
 * only, so for months the retired table sat beside the survivor with a name
 * plausible enough to be repointed onto by mistake — and supabase-js resolves
 * rather than throws, so that mistake would have read as an empty result, not an
 * error. Exactly the failure this file was written about, one layer down.
 *
 * TWO OTHER TABLES CARRY A COLUMN OF THE SAME NAME AND A DIFFERENT MEANING, and
 * they are deliberately NOT governed here — naming them so nobody "unifies" them
 * by accident:
 *   · intelligence_signals_log.signal_strength — a 0-10 NUMBER
 *     (lead-intelligence.ts:243 and :1954)
 *   · signal_reactivations.signal_strength     — a NUMBER
 *     (lib/ai-isa/long-term-nurture.ts:174)
 * Same word, different unit, different table. One vocabulary per FUNCTION, not
 * per column name.
 */

/**
 * Ordered weakest → strongest. The order IS the ranking: `RANK` below is derived
 * from it, so adding a level in the right position is the whole edit.
 */
export const SELLER_SIGNAL_STRENGTHS = ["weak", "moderate", "strong", "urgent"] as const

export type SellerSignalStrength = (typeof SELLER_SIGNAL_STRENGTHS)[number]

/** Position in the ladder, 0-based. Unknown/NULL never appears here — see rankOf. */
const RANK: Record<SellerSignalStrength, number> = SELLER_SIGNAL_STRENGTHS.reduce(
  (acc, level, i) => ({ ...acc, [level]: i }),
  {} as Record<SellerSignalStrength, number>,
)

export function isSellerSignalStrength(value: unknown): value is SellerSignalStrength {
  return typeof value === "string" && (SELLER_SIGNAL_STRENGTHS as readonly string[]).includes(value)
}

/**
 * Rank of a stored value, or -1 for anything this vocabulary does not contain.
 *
 * -1 RATHER THAN 0, deliberately: a row whose strength is NULL, empty, or some
 * spelling nobody registered is NOT a weak signal — it is an unreadable one, and
 * scoring it as the bottom of the ladder would quietly launder bad data into a
 * real (if small) score. Callers that want to count unreadable rows can compare
 * against -1 and say so.
 */
export function rankOf(value: unknown): number {
  return isSellerSignalStrength(value) ? RANK[value] : -1
}

/**
 * Does this signal count as STRONG for lead scoring?
 *
 * 'strong' and 'urgent' only. The threshold is stated as a named level rather
 * than a magic number so that the scorer and any future reader cannot drift
 * apart — which is the drift that produced `> 0.7` against a text column.
 */
export const STRONG_SELLER_SIGNAL_THRESHOLD: SellerSignalStrength = "strong"

export function isStrongSellerSignal(value: unknown): boolean {
  const r = rankOf(value)
  return r >= 0 && r >= RANK[STRONG_SELLER_SIGNAL_THRESHOLD]
}

/**
 * SIGNAL TYPES THAT ARE A REASON *NOT* TO ACT, filed in the same table as the
 * reasons TO act.
 *
 * WHY A SUPPRESSION KIND EXISTS AT ALL. `motivated_seller_signals` is the one
 * place this OS records "something about this property says a sale is coming".
 * The provider also publishes the exact opposite fact — the property is ALREADY
 * on the market with a listing broker. That is not noise to be dropped: an agent
 * needs to SEE it, because soliciting a seller who is already subject to an
 * exclusive representation agreement with another broker is an NAR Code of
 * Ethics Article 16 problem, not merely a wasted call. So the fact is stored,
 * and the SCORER is taught to leave it out of the motivation count.
 *
 * A suppression row must therefore never be able to move the motivated-seller
 * score UP. If it could, "this person already has an agent" would read as "this
 * person is ready to sell" — which is true, and is precisely the wrong
 * conclusion to hand a prospecting queue.
 *
 * NOT A SECOND VOCABULARY. These values are `signal_type` values from the same
 * namespace every other writer uses (CLAUDE.md §6); this set only says which of
 * them point the other way. lib/external/batchdata-seller-signals.ts declares
 * `active_listing` through the same `defineSellerSignalSources` gate as every
 * other type.
 */
export const SUPPRESSION_SELLER_SIGNAL_TYPES: readonly string[] = ["active_listing"]

/**
 * PURE. Is this row a reason NOT to prospect rather than a reason to?
 *
 * A row with NO `signal_type` (the shape older callers pass — see
 * `countStrongSellerSignals` below) reads FALSE: absence of a type is not
 * evidence of suppression, and treating it as suppression would silently zero
 * the whole component for every caller that selects only `signal_strength`.
 */
export function isSuppressionSellerSignal(row: { signal_type?: unknown } | null | undefined): boolean {
  const t = row?.signal_type
  return typeof t === "string" && SUPPRESSION_SELLER_SIGNAL_TYPES.includes(t)
}

/** Does this record carry a live "already represented / already listed" flag? */
export function hasRepresentationSuppression(
  rows: ReadonlyArray<{ signal_type?: unknown }>,
): boolean {
  return rows.some((r) => isSuppressionSellerSignal(r))
}

/**
 * How many of these rows are strong. The shape the scorer actually wants.
 *
 * SUPPRESSION ROWS ARE EXCLUDED. A row whose `signal_type` is in
 * `SUPPRESSION_SELLER_SIGNAL_TYPES` is a fact that argues AGAINST prospecting,
 * so counting it as a strong motivation signal would invert its meaning. Rows
 * that carry no `signal_type` at all are counted exactly as before — every
 * pre-existing caller selects `id, signal_strength` only, and changing what
 * those callers measure was not the intent of adding a suppression kind.
 */
export function countStrongSellerSignals(
  rows: ReadonlyArray<{ signal_strength?: unknown; signal_type?: unknown }>,
): number {
  return rows.filter((r) => !isSuppressionSellerSignal(r) && isStrongSellerSignal(r?.signal_strength)).length
}
