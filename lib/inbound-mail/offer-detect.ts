// lib/inbound-mail/offer-detect.ts
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL → OFFER detection (PURE). Outside agents email offers to the listing agent; the inbound-mail
// webhook drops any email whose sender isn't a known contact, so those offers vanish. This is the
// lookout: by ADDRESS MATCH + OFFER SIGNALS (not the sender), decide whether an inbound email is an
// offer for an in-house listing and how confident we are. The gate is conservative — auto-create only
// when we can FULLY populate the offer (the buyer = a known sender contact, since offers.contact_id is
// required); otherwise surface a one-tap "confirm" to the listing agent. Never fabricates an offer.

const OFFER_SIGNALS =
  /\b(offer to purchase|purchase agreement|purchase contract|residential purchase|sales? contract|counter[\s-]?offer|contract to (buy|purchase)|RPA\b|TAR\s?1601|FAR\/BAR|\boffer\b)/i

/** PURE. Does this email/attachment look like an offer (by subject, filename, body keywords)?
 *  Underscores/hyphens (common in filenames like CAR_RPA_signed.pdf) are normalized to spaces so
 *  word-boundary tokens still match. */
export function looksLikeOffer(subject: string | null, fileNames: string | null, body: string | null): boolean {
  const hay = [subject, fileNames, body].filter(Boolean).join(" \n ").replace(/[_\-]+/g, " ")
  return OFFER_SIGNALS.test(hay)
}

export interface ListingLite { id: string; address: string | null; agent_id?: string | null }

function normalize(s: string): string {
  return ` ${s.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim()} `
}

/**
 * PURE. Match the email text to an in-house listing by STREET NUMBER + first street-name word
 * (high precision: "123 Oak" must appear). Returns the first listing matched, or null.
 */
export function matchListingByAddress(text: string, listings: ListingLite[]): ListingLite | null {
  const hay = normalize(text)
  for (const l of listings) {
    if (!l.address) continue
    const a = l.address.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim()
    const m = a.match(/^(\d+)\s+([a-z0-9]+)/) // street number + first street word
    if (!m) continue
    if (hay.includes(` ${m[1]} ${m[2]} `)) return l
  }
  return null
}

export type OfferIntakeDecision = "auto" | "confirm" | "skip"

/**
 * PURE. The confidence gate. Auto only when it looks like an offer AND matches an in-house listing
 * AND we have the buyer (a known sender contact to fill the required contact_id). If it matches a
 * listing + looks like an offer but the buyer is unknown → "confirm" (the agent ingests + picks the
 * buyer). Anything else → "skip" (fall through to the generic inbound-document path).
 */
export function assessOfferIntake(input: {
  looksLikeOffer: boolean
  listingMatched: boolean
  senderIsKnownContact: boolean
}): OfferIntakeDecision {
  if (!input.listingMatched || !input.looksLikeOffer) return "skip"
  return input.senderIsKnownContact ? "auto" : "confirm"
}
