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

// ─── WHAT OF AN INBOUND EMAIL GETS FILED, AND AS WHAT ───────────────────────
//
// Lives here, with the rest of this lane's PURE half, for two reasons: it is
// I/O-free like everything else in this file, and the properties below have to
// be provable without a storage bucket or a database. `offer-intake.ts` is the
// only caller.
//
// THE DEFECT IT CLOSES (obligation 4 of the owner's ruling — "some documents
// won't be one of ours and submitted from the outside buyer and need to be read
// and counted in the transaction paperwork"): intake wrote the PDF to storage,
// set `offers.offer_document_url` and created NO `documents` row, so
// `auditOfferDocuments` — which counts only `documents` — could not see the most
// important paper in the deal. And it only ever touched `pdfs[0]`, so the
// addenda, disclosures and pre-approval travelling with an outside agent's
// contract were dropped entirely.

/**
 * The `documents.document_type` that means "a STAGED PACKET" — the key
 * `lib/workflow/intelligence/scan-offer-packet.ts` finds an offer's packet by.
 * Named so the rule below is a comparison against the real thing rather than a
 * promise in a comment.
 */
export const STAGED_PACKET_DOCUMENT_TYPE = "offer"

/**
 * `document_type` hints for inbound paper. Free-form strings (the column has no
 * CHECK — verified against the live schema); the CLASSIFIER is what produces the
 * `classification` the compliance audit actually counts.
 */
export const INBOUND_CONTRACT_DOCUMENT_TYPE   = "inbound_offer_contract"
export const INBOUND_ATTACHMENT_DOCUMENT_TYPE = "inbound_offer_attachment"

export interface InboundFilingPlanEntry {
  index:        number
  fileName:     string
  role:         "contract" | "attachment"
  documentType: string
}

/**
 * PURE. One plan entry per inbound PDF.
 *
 *   1. EVERY attachment is filed — never just the first.
 *   2. NOTHING is filed as the staged-packet type. An inbound PDF has no
 *      `content.filledPacket`, and since wave 9 a staged document that carries
 *      no packet is an explicit FAULT at the compliance gate — so filing one
 *      under that type would have refused every inbound offer.
 */
export function planInboundFiling(
  pdfs: Array<{ fileName: string }>,
): InboundFilingPlanEntry[] {
  return pdfs.map((pdf, index) => ({
    index,
    fileName:     pdf.fileName,
    role:         index === 0 ? "contract" : "attachment",
    documentType: index === 0 ? INBOUND_CONTRACT_DOCUMENT_TYPE : INBOUND_ATTACHMENT_DOCUMENT_TYPE,
  }))
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
