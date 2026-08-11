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

// ─── COMPLETING THE LINK THE CONFIRM BRANCH OPENS ───────────────────────────
//
// The CONFIRM branch files an outside agent's paperwork against the LISTING and
// marks it `metadata.awaiting_offer_link`, because at that moment no offer row
// exists to key it to. NOTHING EVER COMPLETED THAT LINK. The rows counted
// toward the listing forever and never toward the offer whose compliance gate
// needs them — `auditOfferDocuments` reads `metadata.linked_offer_id`, and the
// buyer-signature attestation refuses without a document on file FOR THE OFFER.
//
// The link is completed by whichever surface turns the confirmed email into an
// offer row. There are exactly two (`docs/wave11-slice-listing.md` names them):
// `app/api/offers/upload/route.ts` (the agent picks the buyer and uploads the
// contract — the surface the `offer_intake_review` notification asks for) and
// the AUTO branch of `offer-intake.ts` (the sender was already a known contact).
//
// WHICH ROWS. This is the whole difficulty, and it is why the decision is a
// pure function with a proof rather than a WHERE clause: two outside agents can
// both email offers on the SAME listing, and both sets sit there awaiting a
// link. Stamping every pending row on the listing with the first offer created
// would count ANOTHER DEAL'S PAPERWORK toward this one — a worse failure than
// the one being fixed, because it is invisible and it passes a gate.
//
// So the rows are grouped by the SENDER, which is the deal boundary an email
// lane actually has, and a group is chosen only when something identifies it.
// When more than one sender is waiting and nothing picks between them, NOTHING
// is linked and the ambiguity is reported — never guessed.

/** `documents.metadata` keys this lane writes and reads. Named, not spelled. */
export const AWAITING_OFFER_LINK_KEY = "awaiting_offer_link"
export const LINKED_OFFER_ID_KEY     = "linked_offer_id"

export interface PendingInboundDocument {
  id: string
  /** metadata.file_name — what the attachment was called in the email. */
  fileName:      string | null
  /** metadata.from_email — WHO sent it. The deal boundary. */
  fromEmail:     string | null
  /** metadata.linked_offer_id — non-null means this row is already spoken for. */
  linkedOfferId: string | null
}

export interface InboundOfferLinkPlan {
  /** documents.id to stamp with this offer. Empty when nothing may be linked. */
  link:      string[]
  /** The sender whose paperwork was chosen (null when none / unknown sender). */
  sender:    string | null
  /** Every distinct sender still awaiting a link on this listing. */
  senders:   string[]
  /** More than one sender waiting and nothing identified which — link NOTHING. */
  ambiguous: boolean
  reason:
    | "no_pending"           // nothing is waiting
    | "matched_sender"       // the caller knew the sender and that sender is waiting
    | "sender_not_pending"   // the caller knew the sender and they are NOT waiting
    | "matched_file"         // the uploaded file is one of the emailed attachments
    | "only_sender"          // exactly one sender waiting, so there is nothing to confuse
    | "ambiguous_senders"    // several senders waiting, nothing to choose between them
}

const normalizeKey = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase()

/**
 * PURE. Decide WHICH pending inbound documents belong to the offer just created.
 *
 *   · `preferFromEmail` is AUTHORITATIVE when supplied: the caller knows who
 *     sent this deal's paperwork, so a different sender's pending rows are a
 *     different deal and are left alone even if they are the only ones waiting.
 *   · `preferFileName` identifies the group when the agent uploads the very PDF
 *     that arrived by email (the confirm notification tells them to).
 *   · A single waiting sender is unambiguous on its own.
 *   · Otherwise NOTHING is linked and `ambiguous` says so.
 */
export function planInboundOfferLink(
  pending: PendingInboundDocument[],
  opts: { preferFromEmail?: string | null; preferFileName?: string | null } = {},
): InboundOfferLinkPlan {
  const unlinked = pending.filter(p => !p.linkedOfferId)
  const groups = new Map<string, PendingInboundDocument[]>()
  for (const row of unlinked) {
    const key = normalizeKey(row.fromEmail)
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  const senders = Array.from(groups.keys()).map(k => (k === "" ? "(unknown sender)" : k))

  const done = (
    key: string | null,
    reason: InboundOfferLinkPlan["reason"],
    ambiguous = false,
  ): InboundOfferLinkPlan => ({
    link:      key === null ? [] : (groups.get(key) ?? []).map(r => r.id),
    sender:    key === null || key === "" ? null : key,
    senders,
    ambiguous,
    reason,
  })

  if (unlinked.length === 0) return done(null, "no_pending")

  const wanted = normalizeKey(opts.preferFromEmail)
  if (wanted !== "") {
    return groups.has(wanted) ? done(wanted, "matched_sender") : done(null, "sender_not_pending")
  }

  const wantedFile = normalizeKey(opts.preferFileName)
  if (wantedFile !== "") {
    const hit = unlinked.find(r => normalizeKey(r.fileName) === wantedFile)
    if (hit) return done(normalizeKey(hit.fromEmail), "matched_file")
  }

  if (groups.size === 1) return done(Array.from(groups.keys())[0], "only_sender")

  return done(null, "ambiguous_senders", true)
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
