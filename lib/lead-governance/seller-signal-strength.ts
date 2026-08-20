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
 *   lib/external/permit-signals.ts:549     "strong" | "moderate" | "weak"
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

/** How many of these rows are strong. The shape the scorer actually wants. */
export function countStrongSellerSignals(rows: ReadonlyArray<{ signal_strength?: unknown }>): number {
  return rows.filter((r) => isStrongSellerSignal(r?.signal_strength)).length
}
