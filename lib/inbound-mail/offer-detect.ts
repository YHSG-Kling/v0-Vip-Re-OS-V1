// lib/inbound-mail/offer-detect.ts
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL → OFFER detection (PURE). Outside agents email offers to the listing agent; the inbound-mail
// webhook drops any email whose sender isn't a known contact, so those offers vanish. This is the
// lookout: by MAILBOX + ADDRESS MATCH + OFFER SIGNALS, decide whether an inbound email is an offer for
// an in-house listing and how confident we are. Never fabricates an offer.
//
// ── WHOSE MAILBOX IT ARRIVED IN IS THE AUTHORITY (wave 12, R1) ──────────────
//
// Owner's ruling: "an outside buyers agent snding in an offer on an inside
// listing, should not be scanned on inbound emials by sender since we wont have
// that agents's email hooked to our listing. you can monitor the agent assigned
// to the listing (listing agent)'s email for an emial with the listing's
// address/offer."
//
// An outside buyer's agent is BY DEFINITION not one of our contacts, so keying
// anything off the sender keys it off a value that is absent on the exact
// scenario this lane exists for. What we DO have is the mailbox the message
// arrived in: the webhook resolves a per-user credential and therefore knows
// whose inbox it is. The listing agent's inbox + the listing's address + offer
// signals is the whole of the decision.
//
// The sender did not become worthless — it became a different thing. It decides
// whether we can FILL `offers.contact_id` (NOT NULL: an unknown sender means we
// have no buyer row, so "confirm", never "auto"). It is no longer what makes the
// detection trustworthy.

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
// WAVE 11 GROUPED BY THE SENDER. The refusal it built around that grouping is
// correct and is kept exactly as it is: when nothing identifies a group, NOTHING
// is linked and the ambiguity is reported. Only the KEY changes, because the
// sender is the one identifier this lane does not reliably have.
//
// THE KEY IS NOW THE MAILBOX PLUS THE CONVERSATION.
//
//   · MAILBOX — the boundary the owner named, and the only one with a security
//     property attached: paperwork that arrived in agent A's inbox may never be
//     linked to an offer keyed to agent B's. That is a HARD FILTER here, not a
//     tie-breaker, and the rows it excludes are COUNTED rather than dropped
//     silently.
//   · CONVERSATION — mailbox + sender + normalized subject, together. Finer than
//     wave 11's sender alone, and deliberately so: SPLITTING one deal into two
//     groups fails SAFELY (ambiguous → link nothing → a human is told), while
//     MERGING two deals fails invisibly and passes a gate. When the two error
//     directions are not symmetric, the key must be the finest one available.
//     Subject alone would have been the merging direction — two outside agents
//     both write "Offer on 123 Oak" — so it is never used on its own.
//
// The listing itself is not part of the key because it is the caller's SCOPE:
// `offer-intake.ts:linkInboundDocumentsToOffer` only ever hands this function
// rows already filtered to one listing.

/** `documents.metadata` keys this lane writes and reads. Named, not spelled. */
export const AWAITING_OFFER_LINK_KEY = "awaiting_offer_link"
export const LINKED_OFFER_ID_KEY     = "linked_offer_id"
/** metadata key carrying WHOSE mailbox an inbound row arrived in (a `users.id`). */
export const MAILBOX_USER_ID_KEY     = "mailbox_user_id"
/** metadata key carrying the mailbox address, for humans reading a notification. */
export const MAILBOX_ADDRESS_KEY     = "mailbox_address"

export interface PendingInboundDocument {
  id: string
  /** metadata.file_name — what the attachment was called in the email. */
  fileName:      string | null
  /** metadata.from_email — no longer the deal boundary; still part of the conversation key. */
  fromEmail:     string | null
  /** metadata.mailbox_user_id — WHOSE inbox it arrived in. Null on the unkeyed lane. */
  mailboxKey?:   string | null
  /** metadata.subject — the rest of the conversation key. */
  subject?:      string | null
  /** metadata.linked_offer_id — non-null means this row is already spoken for. */
  linkedOfferId: string | null
}

export interface InboundOfferLinkPlan {
  /** documents.id to stamp with this offer. Empty when nothing may be linked. */
  link:      string[]
  /** Label of the group whose paperwork was chosen (null when none). */
  sender:    string | null
  /** One label per group still awaiting a link — what a human must tell apart. */
  senders:   string[]
  /** Rows EXCLUDED because they arrived in a different mailbox. Never silent. */
  foreignMailbox: number
  /**
   * Eligible rows in OTHER groups that were left behind by this plan.
   *
   * The conversation key is finer than wave 11's sender key, and the whole
   * argument for that is that SPLITTING fails safely while MERGING fails
   * invisibly. "Safely" only holds if the split is VISIBLE: if one group links
   * and a second group from the same agent stays behind, those pages sit on
   * `awaiting_offer_link` forever and never reach the offer's compliance count —
   * which is precisely the defect wave 11 closed, reappearing in a narrower
   * case. A non-zero value here is the caller's obligation to report.
   */
  remaining: number
  /** More than one group waiting and nothing identified which — link NOTHING. */
  ambiguous: boolean
  reason:
    | "no_pending"               // nothing is waiting
    | "foreign_mailbox_only"     // everything waiting arrived in someone else's inbox
    | "matched_conversation"     // the caller's mail thread is one of the waiting groups
    | "conversation_not_pending" // the caller's mail thread is NOT waiting
    | "matched_sender"           // the caller knew the sender and that sender is waiting
    | "sender_not_pending"       // the caller knew the sender and they are NOT waiting
    | "matched_file"             // the uploaded file is one of the emailed attachments
    | "only_group"               // exactly one group waiting, so there is nothing to confuse
    | "ambiguous_groups"         // several waiting, nothing to choose between them
}

const normalizeKey = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase()

/**
 * PURE. A mail subject reduced to the conversation it belongs to: reply and
 * forward prefixes stripped (repeatedly — "Re: Fwd: Re:" is one thread), bracket
 * tags dropped, whitespace collapsed. Exported because the webhook has to derive
 * the SAME key for the message in hand that the stored rows were keyed by.
 */
function normalizeSubjectKey(subject: string | null | undefined): string {
  let s = normalizeKey(subject)
  let prev = ""
  while (s !== prev) {
    prev = s
    s = s.replace(/^\s*(re|fw|fwd|aw|antwort|tr)\s*(\[\d+\])?\s*:\s*/i, "")
    s = s.replace(/^\s*\[[^\]]*\]\s*/, "")
  }
  return s.replace(/\s+/g, " ").trim()
}

const FIELD_SEP = "␟"

/** PURE. The conversation a row belongs to: mailbox + sender + normalized subject. */
function conversationKeyOf(row: {
  mailboxKey?: string | null
  fromEmail?:  string | null
  subject?:    string | null
}): string {
  return [
    normalizeKey(row.mailboxKey),
    normalizeKey(row.fromEmail),
    normalizeSubjectKey(row.subject),
  ].join(FIELD_SEP)
}

/**
 * PURE. Decide WHICH pending inbound documents belong to the offer just created.
 *
 *   · `mailboxKey` is a HARD FILTER when supplied. A row that arrived in a
 *     DIFFERENT mailbox is another agent's deal and can never be linked here,
 *     even if it is the only thing waiting. Rows with no mailbox on them are
 *     from the unkeyed transactional lane and stay eligible — refusing them
 *     would delete a working path and strand every row written before this key
 *     existed.
 *   · `conversationSubject` + `preferFromEmail` SELECT a group. Supplying either
 *     narrows; supplying both narrows to one conversation.
 *   · `preferFileName` identifies the group when the agent uploads the very PDF
 *     that arrived by email (the confirm notification tells them to).
 *   · A single waiting group is unambiguous on its own.
 *   · Otherwise NOTHING is linked and `ambiguous` says so.
 */
export function planInboundOfferLink(
  pending: PendingInboundDocument[],
  opts: {
    mailboxKey?:          string | null
    conversationSubject?: string | null
    preferFromEmail?:     string | null
    preferFileName?:      string | null
  } = {},
): InboundOfferLinkPlan {
  const unlinked = pending.filter(p => !p.linkedOfferId)

  const wantedMailbox = normalizeKey(opts.mailboxKey)
  const candidates = wantedMailbox === ""
    ? unlinked
    : unlinked.filter(r => {
        const own = normalizeKey(r.mailboxKey)
        return own === "" || own === wantedMailbox
      })
  const foreignMailbox = unlinked.length - candidates.length

  const groups = new Map<string, PendingInboundDocument[]>()
  for (const row of candidates) {
    const key = conversationKeyOf(row)
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }

  // What a human has to tell apart. One entry per GROUP (not per address): the
  // sender is the readable half, and a second conversation from the same sender
  // carries its subject so the two are distinguishable on a notification.
  const labelCounts = new Map<string, number>()
  for (const rows of groups.values()) {
    const who = normalizeKey(rows[0].fromEmail) || "(unknown sender)"
    labelCounts.set(who, (labelCounts.get(who) ?? 0) + 1)
  }
  const labelOf = (rows: PendingInboundDocument[]): string => {
    const who = normalizeKey(rows[0].fromEmail) || "(unknown sender)"
    if ((labelCounts.get(who) ?? 0) <= 1) return who
    const subj = normalizeSubjectKey(rows[0].subject)
    return subj === "" ? who : `${who} · ${subj}`
  }
  const senders = Array.from(groups.values()).map(labelOf)

  const done = (
    key: string | null,
    reason: InboundOfferLinkPlan["reason"],
    ambiguous = false,
  ): InboundOfferLinkPlan => {
    const rows = key === null ? [] : (groups.get(key) ?? [])
    return {
      link:      rows.map(r => r.id),
      sender:    rows.length > 0 ? labelOf(rows) : null,
      senders,
      foreignMailbox,
      // Everything eligible that this plan did NOT take. Counted here rather
      // than left for each caller to recompute, so "some of it stayed behind"
      // cannot be silently skipped by one of them.
      remaining: candidates.length - rows.length,
      ambiguous,
      reason,
    }
  }

  if (unlinked.length === 0) return done(null, "no_pending")
  if (groups.size === 0) return done(null, "foreign_mailbox_only")

  // SELECT by whichever components of the conversation the caller knows.
  const wantedSender  = normalizeKey(opts.preferFromEmail)
  const wantedSubject = normalizeSubjectKey(opts.conversationSubject)
  if (wantedSender !== "" || wantedSubject !== "") {
    const matched = Array.from(groups.entries()).filter(([, rows]) => {
      const r = rows[0]
      if (wantedSender !== "" && normalizeKey(r.fromEmail) !== wantedSender) return false
      if (wantedSubject !== "" && normalizeSubjectKey(r.subject) !== wantedSubject) return false
      return true
    })
    const identifiedBy: InboundOfferLinkPlan["reason"] =
      wantedSubject !== "" ? "matched_conversation" : "matched_sender"
    const absent: InboundOfferLinkPlan["reason"] =
      wantedSubject !== "" ? "conversation_not_pending" : "sender_not_pending"
    if (matched.length === 1) return done(matched[0][0], identifiedBy)
    if (matched.length === 0) return done(null, absent)
    // Several conversations still satisfy what the caller knew. The uploaded
    // file can still settle it; nothing else may.
    const narrowedFile = normalizeKey(opts.preferFileName)
    if (narrowedFile !== "") {
      const hit = matched.find(([, rows]) => rows.some(r => normalizeKey(r.fileName) === narrowedFile))
      if (hit) return done(hit[0], "matched_file")
    }
    return done(null, "ambiguous_groups", true)
  }

  const wantedFile = normalizeKey(opts.preferFileName)
  if (wantedFile !== "") {
    const hit = candidates.find(r => normalizeKey(r.fileName) === wantedFile)
    if (hit) return done(conversationKeyOf(hit), "matched_file")
  }

  if (groups.size === 1) return done(Array.from(groups.keys())[0], "only_group")

  return done(null, "ambiguous_groups", true)
}

export type OfferIntakeDecision = "auto" | "confirm" | "skip"

/**
 * PURE. The intake gate, re-expressed in the terms the owner named.
 *
 * DETECTION is: the mailbox belongs to the listing's agent, AND the listing's
 * address is in the mail, AND it looks like an offer. `mailboxOwnsListing` is
 * deliberately THREE-VALUED, because the honest answer has three cases:
 *
 *   true  — the message arrived in the inbox of the agent assigned to the
 *           matched listing. This is the owner's scenario.
 *   false — it arrived in someone else's inbox. SKIP. An email in agent A's
 *           mailbox must not be able to open an offer on agent B's listing, and
 *           before this that was exactly what a 300-listing brokerage-wide sweep
 *           allowed.
 *   null / omitted — there is no mailbox key at all. The transactional provider
 *           lane (postmark/sendgrid/mailgun/resend) resolves its credential from
 *           the To: address and frequently yields no agent. That path WORKS
 *           today on a brokerage-wide address match, so it is kept — and the
 *           caller records in the provenance that the match was UNKEYED.
 *
 * The sender decides only whether we can FILL the offer: `offers.contact_id` is
 * NOT NULL, so an unknown sender means "confirm" (the agent picks the buyer),
 * never a fabricated contact. It is no longer the detection authority.
 */
export function assessOfferIntake(input: {
  looksLikeOffer: boolean
  listingMatched: boolean
  /** true = the mailbox owner IS the matched listing's agent; false = someone else's inbox. */
  mailboxOwnsListing?: boolean | null
  senderIsKnownContact: boolean
}): OfferIntakeDecision {
  if (!input.listingMatched || !input.looksLikeOffer) return "skip"
  if (input.mailboxOwnsListing === false) return "skip"
  return input.senderIsKnownContact ? "auto" : "confirm"
}

// ─── THE OUTBOUND RECIPROCAL (wave 12, R2) ──────────────────────────────────
//
// Owner's ruling: "if we send an offer out to an outsdie listing agents property
// listing for our buyers, you can check for the returned email from that listing
// agent."
//
// R1 watches OUR listing agent's inbox for an outside BUYER's agent. This is the
// mirror: our BUYER's agent sends a packet out to an outside LISTING agent, and
// the counter / acceptance / signed contract comes back to that same inbox.
//
// Nowhere in the tree was the outside listing agent's address recorded when we
// sent, and on an outside listing `offers.listing_id` is NULL — there is no
// `listings` row, so R1's address match CANNOT fire. The recorded counterparty
// address is therefore the ONLY key this deal's mail will ever have, which is
// exactly why recording it is the whole of the work.
//
// `offers.metadata` is a live jsonb column and is where it goes. No column is
// invented, and the write MERGES — the wholesale metadata assignment that
// destroyed `linked_offer_id` is the load-bearing defect of wave 9 and does not
// come back.

/** `offers.metadata` keys the outbound watch writes and the inbound lane reads. */
export const OUTSIDE_LISTING_AGENT_EMAIL_KEY = "outside_listing_agent_email"
export const OUTSIDE_LISTING_AGENT_NAME_KEY  = "outside_listing_agent_name"
export const OUTBOUND_WATCH_ARMED_AT_KEY     = "outbound_watch_armed_at"
/** Stamped when a reply from the recorded counterparty is routed back to the offer. */
export const COUNTERPARTY_REPLY_AT_KEY       = "counterparty_last_reply_at"

/** The signer roles this lane understands. `listing_agent` is the counterparty. */
export type OutboundSignerRole = "buyer" | "co_buyer" | "agent" | "listing_agent" | "seller"

export interface OutboundWatchPlan {
  /** true = we know who to watch for and the offer may be stamped. */
  armed: boolean
  /** Lower-cased counterparty address — the key a reply will be matched on. */
  email: string | null
  name:  string | null
  /** Non-null ⇒ the watch was REFUSED, and this says exactly what is missing. */
  refusal: string | null
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * PURE. Decide whether an outbound offer can be watched for a reply, and refuse
 * out loud when it cannot.
 *
 *   · An IN-HOUSE listing (`listingId` non-null) needs no watch: the reply lands
 *     on our own listing and R1's mailbox + address match owns it. Not armed,
 *     not a refusal — there is nothing missing.
 *   · An OUTSIDE listing with a `listing_agent` signer arms the watch on that
 *     address.
 *   · An OUTSIDE listing with NO such signer REFUSES, naming what is missing.
 *     Nothing is fabricated and nothing is guessed from the other signers: our
 *     own buyer's agent is also role `agent`, so picking "an agent" would record
 *     OUR side as the counterparty and route our own mail back into the deal.
 */
export function planOutboundWatch(input: {
  /** offers.listing_id — non-null means the listing is ours. */
  listingId: string | null
  signers: Array<{ name?: string | null; email?: string | null; role: OutboundSignerRole | string }>
}): OutboundWatchPlan {
  if (input.listingId) {
    return { armed: false, email: null, name: null, refusal: null }
  }

  const counterparty = input.signers.find(
    s => s.role === "listing_agent" && normalizeKey(s.email) !== "",
  )
  if (!counterparty) {
    return {
      armed: false, email: null, name: null,
      refusal:
        "This offer is on an outside listing, so a reply from the listing agent is the only way it can "
      + "come back to us — and no listing-agent email was supplied with the signers. Add the listing "
      + "agent (role 'listing_agent') with their email so their counter, acceptance or signed contract "
      + "is routed to this offer instead of landing unfiled in the inbox.",
    }
  }

  const email = normalizeKey(counterparty.email)
  if (!EMAIL_SHAPE.test(email)) {
    return {
      armed: false, email: null, name: null,
      refusal: `The listing agent's address on this offer ("${counterparty.email}") is not a usable email address, `
             + "so a reply from them cannot be matched back to this offer. Correct it and re-send.",
    }
  }

  return {
    armed: true,
    email,
    name: (counterparty.name ?? "").trim() || null,
    refusal: null,
  }
}
