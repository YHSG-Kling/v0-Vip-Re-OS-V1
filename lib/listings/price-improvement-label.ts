/**
 * lib/listings/price-improvement-label.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PUBLIC NAME FOR A LOWERED LIST PRICE.
 *
 * Owner ruling: "we call price reduction for public price improvement."
 *
 * Read precisely, that is a RENDER-BOUNDARY ruling, not a rename:
 *
 *   PUBLIC  — anything a consumer, client, buyer, seller or the open market
 *             sees (client portal, buyer alert email, printed postcard, social
 *             caption, a rendered reel's cover frame, an outbound voice call) —
 *             says "Price Improvement" / "Price Improved".
 *   INTERNAL — identifiers, kernel event names, and above all the DATABASE
 *             vocabulary — are UNCHANGED. `price_reduction` is a live CHECK
 *             value on social_posts.post_type, lifecycle_promo_policy
 *             .event_type and lifecycle_mail_policy.event_type (see
 *             scripts/check-vocabularies.ts); `price_drop` / `price_changed`
 *             are live in-code situation kinds. Renaming any of those needs an
 *             applied migration plus a vocabulary-cache regeneration, which is
 *             NOT what this ruling asks for.
 *
 * So the translation happens HERE, at the boundary, in ONE place (§6). Every
 * consumer-facing writer imports this instead of typing the words, because two
 * spellings of one idea is a defect and this file is the survivor.
 *
 * Related survivors that already spoke the public word before this file existed
 * and now derive it from here instead:
 *   · lib/ads/listing-ad-producer.ts       — "Price Improved!" ad headline
 *   · lib/video/promo-composition.ts:promoEventLabel — the reel cover hook
 *
 * PURE. No I/O, no server-only import — a client component may import it.
 */

/** The noun. Campaign names, mode labels, prose. */
const PUBLIC_NOUN = "Price Improvement"

/** The past participle. Badges, cover hooks, headlines — parallel to the
 *  sibling public labels "Just Listed" / "Just Sold". */
const PUBLIC_BADGE = "Price Improved"

/**
 * Which shape of the public label a surface needs. Deliberately NOT exported:
 * callers pass a string literal, so there is no second name for this idea.
 *
 *   noun     "Price Improvement"  — campaign names, headings, prose labels
 *   badge    "Price Improved"     — UI badges, reel cover hooks, email chips
 *   print    "PRICE IMPROVED"     — the direct-mail status badge (printed caps)
 *   sentence "price improvement"  — mid-sentence prose (voice scripts, prompts)
 */
type PriceImprovementForm = "noun" | "badge" | "print" | "sentence"

/**
 * The one place the public words are spelled. Every other form is DERIVED from
 * the two roots above, so there is exactly one string to change if the owner
 * ever re-rules.
 */
export function priceImprovementLabel(form: PriceImprovementForm = "noun"): string {
  switch (form) {
    case "noun":     return PUBLIC_NOUN
    case "badge":    return PUBLIC_BADGE
    case "print":    return PUBLIC_BADGE.toUpperCase()
    case "sentence": return PUBLIC_NOUN.toLowerCase()
  }
}

/**
 * The INTERNAL values that mean "the list price came down". These stay exactly
 * as the database and the kernel spell them — this set is the lookup key, never
 * a proposal to rename anything.
 *
 *   price_reduction         DB CHECK — social_posts.post_type,
 *                           lifecycle_promo_policy.event_type,
 *                           lifecycle_mail_policy.event_type
 *   price_reduced           legacy/alias spelling on older ledger rows
 *   price_changed           listing_promo_videos.event_type
 *   price_drop              lib/video/video-director.ts SituationKind
 *   listing.price_reduced   kernel event name (lib/portal-stream)
 *   listing.price_reduction lib/events/types.ts LISTING_PRICE_REDUCTION
 */
const PRICE_IMPROVEMENT_INTERNAL_VALUES: ReadonlySet<string> = new Set([
  "price_reduction",
  "price_reduced",
  "price_changed",
  "price_drop",
  "listing.price_reduced",
  "listing.price_reduction",
])

/** True when an internal value denotes a lowered list price. */
export function isPriceImprovementEvent(internalValue: string | null | undefined): boolean {
  return internalValue != null && PRICE_IMPROVEMENT_INTERNAL_VALUES.has(internalValue)
}

/**
 * THE RENDER BOUNDARY. Hand it an internal value; get back the public label, or
 * null when the value means something else (so the caller keeps its own
 * mapping for the other events rather than being forced through this one).
 */
export function publicPriceEventLabel(
  internalValue: string | null | undefined,
  form: PriceImprovementForm = "badge",
): string | null {
  return isPriceImprovementEvent(internalValue) ? priceImprovementLabel(form) : null
}
