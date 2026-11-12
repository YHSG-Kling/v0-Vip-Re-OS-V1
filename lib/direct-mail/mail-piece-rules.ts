// lib/direct-mail/mail-piece-rules.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PURE DIRECT-MAIL RULES — formats, the blank layout library, the handwriting-style typeface, what a Lob tracking
// event proves, and the six delivery truths. CLIENT-SAFE BY CONSTRUCTION: this module imports nothing, so a "use client"
// screen (the mail piece preview, the tracking tab) may read the vocabulary without reaching `server-only`
// (scripts/client-server-only-guard.ts follows dynamic imports too, and lib/direct-mail/piece-type.ts — the router, the
// sender-address resolver, the send gate, returned-mail handling — reaches the service client and the brand cascade).
// piece-type.ts RE-EXPORTS everything here, so every server importer keeps its one home (wave 151, integrator split
// after lane 151H; no definition is duplicated — each lives here once).
// WAVE 152 (lane 152C): the one import is the PURE QR contract (it imports nothing either), for the quiet zone the
// optional QR region of every layout prints with — still client-safe by construction.
import { QR_RENDER_DEFAULTS } from "@/lib/marketing/qr-contract"

export const MAIL_FORMATS = ["letter", "personal_letter", "postcard", "handwritten_card"] as const
export type MailFormat = (typeof MAIL_FORMATS)[number]

export type LobTemplateSlot = "letter" | "personal_letter" | "postcard_front" | "postcard_back"

/**
 * The honest name of each format. A personal letter is PRINTED: its note is set in a handwriting-STYLE
 * typeface by the printer, and the word "handwritten" is reserved for a card a person or a pen robot actually
 * writes. Owner, wave 151 (verbatim): "handwritten font by computer can be a substitute"; directive 151H:
 * "Describe it as handwriting-style printed mail, not physically handwritten." (This supersedes the wave-150
 * "personal-note typeface" wording: the owner's own term is handwriting-style, and PRINTED stays in the label.)
 */
export const MAIL_FORMAT_LABELS: Readonly<Record<MailFormat, string>> = {
  letter:           "Letter (printed, in an envelope)",
  personal_letter:  "Handwriting-style printed note (a letter in an envelope, set in a handwriting-style typeface — printed, not pen-written)",
  postcard:         "Postcard (printed front and back)",
  handwritten_card: "Handwritten card (written with a pen by a handwriting provider)",
}

/** The computer-generated handwriting-STYLE typeface the personal-note layout sets its body in. A layout property
 *  (like the letter layout's serif), not a brand property — the tenant's approved brand font still sets the
 *  letterhead and footer. Google-hosted so Lob can fetch it through @font-face (help.lob.com: Google web fonts and
 *  hosted TTF render; OTF / Typekit are refused). Described everywhere as handwriting-STYLE and PRINTED. */
export const HANDWRITING_STYLE_TYPEFACE = Object.freeze({
  kind: "handwriting_style" as const,
  family: "Caveat",
  cssUrl: "https://fonts.googleapis.com/css2?family=Caveat:wght@400;600&display=swap",
  /** Substitutes a tenant may choose later (all Google-hosted script families); the first is the default. */
  families: ["Caveat", "Kalam", "Patrick Hand", "Homemade Apple"] as readonly string[],
  description: "handwriting-style printed mail — a computer-generated handwriting-style font set by the printer, not pen-written",
})

interface MailLayout {
  /** The Lob template slot this layout is configured in (LOB_TEMPLATE_ENV), or null when no provider prints it. */
  slot: LobTemplateSlot | null
  format: MailFormat | "notecard"
  pieceType: "letter" | "postcard" | null
  label: string
  /** What the blank layout IS — structure only. */
  layout: string
  /** The merge-variable names the layout declares (every one a key buildMailMergeVariables emits — derived in the proof). */
  mergeVariables: readonly string[]
  /** The body typeface the layout sets: the tenant's brand font, or the handwriting-style printed typeface. */
  typeface: "brand_font" | "handwriting_style"
  /** Provider support. `unsupported_by_provider` layouts are EVALUATED—NOT IMPLEMENTED (no Lob product exists). */
  status: "lob_global_template" | "unsupported_by_provider"
  /** For an unsupported layout: the layout that stands in for it. */
  substitute?: MailFormat
  /** WAVE 152 (152C) — the layout's OPTIONAL reusable QR region (null = the layout has none). Owner (verbatim): "all mail
   *  including letters can have a section that can use a qr bar code." The region prints the campaign's REGISTERED code
   *  (`qr_destination_url`, a /api/qr/scan?slug=<token> link) or stays blank; it never blocks the piece. */
  qrRegion: MailQrRegion | null
}

interface MailQrRegion {
  /** Always optional — a piece mails with or without a code. */
  optional: true
  /** Where the region sits in the blank layout (structure only — no brand, no address). */
  anchor: string
  /** The printed edge of the symbol INCLUDING its quiet zone, in inches. */
  sizeIn: number
  /** Below this a phone camera at arm's length misreads a URL-length code. */
  minSizeIn: number
  /** The quiet zone in modules — the one encoding contract's (lib/marketing/qr-contract.ts, ISO/IEC 18004: 4). */
  quietZoneModules: number
}

const QR_QUIET = QR_RENDER_DEFAULTS.margin

const LAYOUT_COMMON = ["brand_display_name", "brand_legal_name", "brand_logo_url", "brand_primary_color", "brand_secondary_color", "brand_accent_color", "brand_font_family", "brand_font_css_url", "brand_tagline", "brand_website", "brand_phone", "agent_name", "agent_license_line", "sender_legal_identity", "creator_attribution", "return_name", "return_address_line1", "return_address_line2", "return_city", "return_state", "return_zip", "recipient_name", "recipient_first_name", "qr_destination_url", "disclosure_short"] as const

/** THE library: five format-specific blank layouts (letter, personal note, postcard front, postcard back, notecard).
 *  Distinct slots by NAME; the router (routeMailFormat) refuses two formats sharing one id. */
export const MAIL_LAYOUT_LIBRARY: Readonly<Record<"letter" | "personal_letter" | "postcard_front" | "postcard_back" | "notecard", MailLayout>> = Object.freeze({
  letter: {
    slot: "letter", format: "letter", pieceType: "letter", label: MAIL_FORMAT_LABELS.letter,
    layout: "8.5×11 letter: letterhead strip (logo, display name, tagline), #10 window address block at 0.94in/0.5in, date, body grid, signature block with creator attribution and license line, footer with the verbatim long disclosure. No brand, address or name is in the layout itself.",
    mergeVariables: [...LAYOUT_COMMON, "copy_text", "agent_photo_url", "disclosure_long"], typeface: "brand_font", status: "lob_global_template",
    qrRegion: { optional: true, anchor: "bottom-right of the page beside the signature block, above the footer disclosure, clear of the #10 window", sizeIn: 1, minSizeIn: 0.8, quietZoneModules: QR_QUIET },
  },
  personal_letter: {
    slot: "personal_letter", format: "personal_letter", pieceType: "letter", label: MAIL_FORMAT_LABELS.personal_letter,
    layout: "8.5×11 note: generous margins, a short body set in the handwriting-style printed typeface (note_font_family / note_font_css_url), a first-name salutation, a signature line in the same typeface with the sender's printed name, a small letterhead and footer in the brand font with the verbatim short disclosure. Printed in color. Labeled handwriting-style printed, never handwritten.",
    mergeVariables: [...LAYOUT_COMMON, "note_body", "note_font_family", "note_font_css_url", "agent_photo_url"], typeface: "handwriting_style", status: "lob_global_template",
    qrRegion: { optional: true, anchor: "bottom-right of the page beside the handwriting-style signature, above the footer — the symbol prints black on white whatever the note's ink color", sizeIn: 0.9, minSizeIn: 0.8, quietZoneModules: QR_QUIET },
  },
  postcard_front: {
    slot: "postcard_front", format: "postcard", pieceType: "postcard", label: "Postcard front (printed)",
    layout: "4×6 / 6×9 front: full-bleed art zone (front_art_url or picture_url), headline, logo lockup, QR with its destination URL. No address zone on the front.",
    mergeVariables: [...LAYOUT_COMMON, "front_art_url", "picture_url", "copy_text"], typeface: "brand_font", status: "lob_global_template",
    qrRegion: { optional: true, anchor: "lower-right of the art zone inside the logo lockup band, on a white plate the size of the quiet zone", sizeIn: 1, minSizeIn: 0.8, quietZoneModules: QR_QUIET },
  },
  postcard_back: {
    slot: "postcard_back", format: "postcard", pieceType: "postcard", label: "Postcard back (printed)",
    layout: "4×6 / 6×9 back: left 48% message zone (body, signoff, agent photo, opt-out line), right 52% left EMPTY for Lob's address block, indicia and postal markings (the return address Lob prints there is the tenant's `from`, never the platform's). Verbatim short disclosure and license line along the bottom.",
    mergeVariables: [...LAYOUT_COMMON, "back_art_url", "copy_text", "agent_photo_url"], typeface: "brand_font", status: "lob_global_template",
    qrRegion: { optional: true, anchor: "message zone (left 48%) under the body, above the opt-out line — never in the right 52% reserved for the address block and postal markings", sizeIn: 0.8, minSizeIn: 0.8, quietZoneModules: QR_QUIET },
  },
  notecard: {
    slot: null, format: "notecard", pieceType: null, label: "Folded notecard (no Lob product)",
    layout: "EVALUATED—NOT IMPLEMENTED: Lob prints postcards, letters, self-mailers, snap packs, booklets and checks — no folded notecard product (docs.lob.com products, read 2026-11-06 in §12). The handwriting-style printed note (personal_letter) is the substitute; a printed greeting-card provider (AMcards) stays dormant in OPTIONAL_MAIL_PROVIDERS.",
    mergeVariables: [], typeface: "handwriting_style", status: "unsupported_by_provider", substitute: "personal_letter",
    // No provider prints a notecard, so there is no region to print into; its substitute (personal_letter) carries one.
    qrRegion: null,
  },
})

/** Tokens a BLANK layout — and a TENANT's rendered piece — must never carry: the platform's own identity (a layout
 *  prints the sending tenant, and a tenant mailing never prints the platform), a saved Lob address id, or a hard-coded
 *  street address (every address is merge data). */
const LAYOUT_FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /vip\s?agents(?:\.ai)?/i, why: "the platform's name (the sender is the tenant)" },
  { re: /\badr_[a-z0-9]{6,}\b/i, why: "a saved Lob address id (the platform account's return address)" },
  { re: /\b\d{2,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Parkway)\b\.?,?\s+(?:[A-Z][a-z]+\s?){1,2},?\s+[A-Z]{2}\s+\d{5}\b/, why: "a hard-coded street address (every address is merge data)" },
]

/** PURE — the forbidden content a layout or rendered tenant piece carries (empty = clean). Used by the in-repo letter
 *  layout (lib/direct-mail/render-letter.ts) on its output and by the proof on the layout skeletons. */
export function layoutContentViolations(text: string): string[] {
  const out: string[] = []
  for (const f of LAYOUT_FORBIDDEN) {
    const m = f.re.exec(text)
    if (m) out.push(`${f.why}: "${m[0].slice(0, 60)}"`)
  }
  return out
}

// ─── 2b. THE OPTIONAL QR REGION (wave 152, lane 152C) ─────────────────────────

export type MailLayoutKey = keyof typeof MAIL_LAYOUT_LIBRARY

/** A registered code's tracking link — the only thing a mail QR region may encode (never a typed destination URL). */
const REGISTERED_SCAN_LINK_RE = /^https?:\/\/[^/\s?#]+\/api\/qr\/scan\?slug=([a-z0-9-]{1,120})$/i

export type MailQrRegionDecision =
  | { print: true; layout: MailLayoutKey; scanUrl: string; token: string; sizeIn: number; quietZoneModules: number; anchor: string }
  | { print: false; layout: MailLayoutKey; reason: "not_requested" | "layout_has_no_region" | "not_a_registered_code" | "code_not_active"; note: string }

/**
 * PURE — does THIS piece print a QR code in its layout's region? It answers for the REGION only: every "no" says the
 * piece mails without a code and nothing else changes — an unconfigured or unusable code never blocks the mailing
 * (directive 152C: "A blank/unconfigured destination must block QR printing, not the whole unrelated mail capability").
 * The token it returns is the code's own (printed under the symbol, and the key the scan maps back to its campaign).
 */
export function decideMailQrRegion(input: { layout: MailLayoutKey; scanUrl?: string | null; codeState?: string | null }): MailQrRegionDecision {
  const layout = input.layout
  const region = MAIL_LAYOUT_LIBRARY[layout]?.qrRegion ?? null
  if (!region) return { print: false, layout, reason: "layout_has_no_region", note: "This format has no QR area (no provider prints it); the piece mails without a code." }
  const url = (input.scanUrl ?? "").trim()
  if (!url) return { print: false, layout, reason: "not_requested", note: "No QR code on this piece — its QR area stays blank and the piece mails as usual." }
  const m = REGISTERED_SCAN_LINK_RE.exec(url)
  if (!m) return { print: false, layout, reason: "not_a_registered_code", note: "Only a code from your QR codes list can print here, so this one was left off; the piece mails without it." }
  if (input.codeState && input.codeState !== "active") {
    return { print: false, layout, reason: "code_not_active", note: `This campaign's QR code is ${input.codeState}, so the piece mails without it. Resume or replace the code on the QR codes page to print it.` }
  }
  return { print: true, layout, scanUrl: url, token: m[1], sizeIn: region.sizeIn, quietZoneModules: region.quietZoneModules, anchor: region.anchor }
}

// ─── 3. What a Lob tracking event proves ──────────────────────────────────────

/** The per-piece outcome vocabulary on direct_mail_recipients.delivery_outcome (m985 CHECK). There is
 *  deliberately NO "received" / "read": a carrier scan is evidence about the PIECE, never about the
 *  household (owner: "never treat mail scanner data as proof of household receipt"). */
export const MAIL_DELIVERY_OUTCOMES = [
  "accepted", "rendered", "mailed", "in_transit", "in_local_area", "processed_for_delivery",
  "delivered_per_carrier_scan", "re_routed", "returned_to_sender", "cancelled", "unknown",
] as const
export type MailDeliveryOutcome = (typeof MAIL_DELIVERY_OUTCOMES)[number]

export interface MailOutcomeReading {
  outcome: MailDeliveryOutcome
  /** Terminal for this piece (no later event is expected to change it). */
  terminal: boolean
  /** Always false: no Lob / USPS event proves a person received or read the piece. */
  householdReceiptProven: false
  /** The direct_mail_recipients.delivery_status (live CHECK: pending | mailed | delivered | returned | failed)
   *  this outcome supports, or null to leave the row's status alone. */
  deliveryStatus: "mailed" | "delivered" | "returned" | "failed" | null
}

/**
 * PURE — map a Lob webhook event type ("postcard.in_transit", "letter.delivered", …) to what it proves.
 * Lob's own help page (help.lob.com …/tracking-your-mail, read 2026-11-06): "Delivered" is generated
 * "when the carrier's GPS unit leaves the delivery area" and "USPS does not guarantee every event";
 * "Processed for Delivery is more reliable". So `delivered` reads as delivered PER CARRIER SCAN.
 */
export function mailOutcomeFromLobEvent(eventType: string): MailOutcomeReading {
  const e = String(eventType ?? "").toLowerCase().split(".").pop() ?? ""
  const read = (outcome: MailDeliveryOutcome, terminal: boolean, deliveryStatus: MailOutcomeReading["deliveryStatus"]): MailOutcomeReading =>
    ({ outcome, terminal, householdReceiptProven: false, deliveryStatus })
  switch (e) {
    case "created":                return read("accepted", false, null)
    case "rendered_pdf":
    case "rendered_thumbnails":    return read("rendered", false, null)
    case "mailed":                 return read("mailed", false, "mailed")
    case "in_transit":             return read("in_transit", false, "mailed")
    case "in_local_area":          return read("in_local_area", false, "mailed")
    case "processed_for_delivery": return read("processed_for_delivery", false, "mailed")
    case "delivered":              return read("delivered_per_carrier_scan", true, "delivered")
    case "re-routed":
    case "re_routed":              return read("re_routed", false, "mailed")
    case "returned_to_sender":     return read("returned_to_sender", true, "returned")
    case "deleted":                return read("cancelled", true, "failed")
    default:                       return read("unknown", false, null)
  }
}

// ─── 4c. DELIVERY TRUTH (wave 151, lane 151H) ─────────────────────────────────

/** Six separate truths about one piece. A successful HTTP response from Lob is `apiAccepted` and NOTHING else. */
export interface MailPieceTruth {
  /** Lob accepted the create call (an id came back). */
  apiAccepted: boolean
  /** The ledger's settlement: `estimated` at dispatch (the one Lob price, booked on accept), `settled` once the action
   *  ledger row settled with its cost, `unknown` with no ledger row. Never read as proof of printing or delivery. */
  chargeSettled: "estimated" | "settled" | "unknown"
  /** Lob reports no print event; "mailed" implies the piece was printed first. Said as implied, never as proven. */
  printed: "not_reported_by_provider" | "implied_by_mailed"
  mailed: boolean
  /** Only the carrier's scan — never household receipt. */
  delivered: "no" | "carrier_scan"
  returned: boolean
  outcome: MailDeliveryOutcome
}

/** PURE — read the six truths off the piece's latest outcome (+ its ledger settlement when the caller has it). */
export function mailPieceTruth(outcome: MailDeliveryOutcome | null | undefined, ledger?: { settledAt?: string | null; costUsd?: number | null } | null): MailPieceTruth {
  const o: MailDeliveryOutcome = outcome ?? "unknown"
  const mailedSet = new Set<MailDeliveryOutcome>(["mailed", "in_transit", "in_local_area", "processed_for_delivery", "delivered_per_carrier_scan", "re_routed", "returned_to_sender"])
  const mailed = mailedSet.has(o)
  return {
    // Every recorded outcome but "unknown" began with Lob accepting the create call (a cancelled piece was accepted, then deleted).
    apiAccepted: o !== "unknown",
    chargeSettled: ledger ? (ledger.settledAt ? "settled" : "estimated") : "unknown",
    printed: mailed ? "implied_by_mailed" : "not_reported_by_provider",
    mailed,
    delivered: o === "delivered_per_carrier_scan" ? "carrier_scan" : "no",
    returned: o === "returned_to_sender",
    outcome: o,
  }
}
