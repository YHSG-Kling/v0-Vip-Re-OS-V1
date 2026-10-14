/**
 * lib/contacts/card-classifier.ts
 *
 * BUSINESS-CARD SUBJECT CLASSIFIER — wave 48 (owner ruling 2026-09-10, verbatim):
 * "the kernel events scanned business card shouldn't be assumed contact since it
 * is a business card from an event, sphere of influence/other agent/potential
 * contact so should be a userid user type and card reader or agents notes can
 * determine." A card handed over at an open house or a conference is not a lead
 * by default — it might be someone the agent already knows (SPHERE), a fellow
 * agent at another shop (AGENT — a recruiting prospect, never a CRM contact), a
 * genuine prospective client (POTENTIAL_CONTACT), a vendor/trade (VENDOR), an
 * already-qualified CONTACT, or simply UNKNOWN until a human says otherwise.
 *
 * ONE VOCABULARY (§6): this REPLACES the earlier three-way CardTarget/
 * classifyCardTarget ('contact' | 'vendor' | 'recruit') — that classifier's
 * silent fallthrough to 'contact' whenever the reader had no signal is EXACTLY
 * the assumption the ruling forbids, and 'recruit' is renamed 'agent' to match
 * the owner's own words ("other agents are users"). TOMBSTONE: the old export
 * classifyCardTarget/CardTarget (3-way) is retired onto classifyCardSubject/
 * CardSubjectType (6-way) below — same file, same VENDOR_FAMILIES table, no
 * duplicate left behind. Every caller (app/actions/business-card/
 * business-card-actions.ts) was updated in the same change.
 *
 * DETERMINATION ORDER (pure half — the database-backed "existing match" tier
 * lives in the caller, which alone can query users/contacts/vendors):
 *   1. the card READER's own extracted fields (title/company) — objective,
 *      printed by the subject, outranks anything the scanning agent typed.
 *   2. the scanning agent's free-text NOTES on the card.
 *   3. (caller-only) an existing match against users/contacts/vendors by
 *      email/phone — the ONLY tier that can attach a real subject_user_id.
 *   4. an explicit PICKER on the card-review surface always wins outright,
 *      applied by the caller after this function returns.
 *   5. default: UNKNOWN — never 'contact'. See the note on the final return.
 *
 * PURE (no I/O) — simulator-driven (scripts/business-card-classification-
 * simulator.ts), not server-only.
 */

import type { VendorCategory } from "@/lib/kernel/vendor-categories"
// PURE (no imports of its own) — THE one provenance stamp shape (wave 100C). A card reading is
// evidence about a contact field; it carries the reader's confidence as the stamp's matchConfidence.
import { stampFieldProvenance, type FieldProvenance } from "@/lib/lead-pipeline/enrichment-column-map"

export type CardSubjectType = "sphere" | "agent" | "potential_contact" | "contact" | "vendor" | "unknown"

export interface CardSubjectClassification {
  subjectType: CardSubjectType
  /** vendors.category CHECK value — set only when subjectType === "vendor". */
  category: VendorCategory | null
  /** which determination tier decided it. 'match' (existing-user/contact/vendor
   *  lookup) and 'picker' (explicit review-surface override) are stamped by the
   *  caller — this pure function only ever returns 'reader' | 'notes' | 'default'. */
  source: "picker" | "reader" | "notes" | "match" | "default"
}

// These are STEMS, matched at a word boundary on the LEFT only — the way the
// Inspector family always was. A trailing \b broke every stem in the list: it
// requires the word to END there, so "photographer", "landscaper", "appraiser",
// "roofing", "electrician", "remodeling" and "moving company" all failed to
// match, and those cards silently fell through to the CRM contact path instead
// of the vendor book. The left boundary still prevents mid-word hits.
//
// ORDER IS THE CONTRACT: first match wins, so a NARROW trade must sit above the
// family that would also swallow it. "Roofing" has to reach `roofer` before the
// generic contractor pattern claims it, and "refinance" has to reach
// `refinance_lender` before "mortgage" claims it for `lender`.
//
// Until m304 this list could only emit six values, because the column only
// admitted six — so a photographer, a landscaper, a mover, an attorney and an
// insurance agent were all filed as "other" and the information on the card was
// thrown away. The column now holds 40 (m554 added `appraiser`, m562
// `surveyor`), and the classifier fills them: a scanned
// card lands on the trade it actually names, which is what makes the widened
// bench bookable rather than merely spellable.
const VENDOR_FAMILIES: Array<{ category: CardSubjectClassification["category"]; pattern: RegExp }> = [
  // ── transaction side ──
  { category: "refinance_lender", pattern: /\b(refinanc|refi\b)/ },
  { category: "lender", pattern: /\b(lender|mortgage|loan officer|nmls|home loans|lending)/ },
  { category: "inspector", pattern: /\b(inspect)/ },
  // m554 added `appraiser` to the column, and the classifier had to learn the
  // word in the same change or the widening would have been decorative: until
  // it did, "Certified Residential Appraiser" matched nothing and the card was
  // filed as `other`, throwing away the one fact printed on it. Sits above the
  // generic families for the usual reason — nothing else here matches the stem,
  // but the transaction block is where a reader looks for it.
  { category: "appraiser", pattern: /\b(apprais)/ },
  // m562 added `surveyor` to the column, for the same reason and with the same
  // consequence as `appraiser` at m554: until it did, "Smith Land Surveying, PLS"
  // matched only the catch-all stem at the bottom of this list and was filed as
  // `other`, throwing away the one fact printed on the card. `\b(survey)` is
  // safe above the generic families because no other trade here contains the
  // stem — "surveillance" is matched by the `security` family further down and
  // does not start with it.
  { category: "surveyor", pattern: /\b(survey)/ },
  { category: "title", pattern: /\b(title|escrow)/ },
  { category: "attorney", pattern: /\b(attorney|law firm|law office|law group|esq\b)/ },
  // ── listing prep + marketing ──
  { category: "drone_pilot", pattern: /\b(drone|aerial)/ },
  { category: "3d_tour", pattern: /\b(matterport|3d tour|virtual tour|3d scan)/ },
  { category: "photographer", pattern: /\b(photograph)/ },
  { category: "videographer", pattern: /\b(videograph|video production)/ },
  // Staging outranks interior design: a card reading "Home Staging & Interior
  // Design" is a stager who also decorates, and staging is the listing-prep
  // service the deal actually books. "Interior Designer" alone has no "stag" to
  // match, so it still reaches interior_design.
  { category: "stager", pattern: /\b(stag(er|ing))/ },
  { category: "interior_design", pattern: /\b(interior design|interior decorat)/ },
  // ── move + turnover ──
  // "real estate sales" contains "estate sale" — the lookbehind keeps an agent's
  // card out of the estate-sale trade.
  { category: "estate_sale", pattern: /(?<!real )\bestate (sale|liquidat)/ },
  { category: "organizer", pattern: /\b(professional organiz|home organiz|organizing service)/ },
  { category: "mover", pattern: /\b(mover|moving compan|moving service|relocation service)/ },
  { category: "cleaner", pattern: /\b(clean(er|ing)|maid service|janitorial)/ },
  // ── trades + home services (each above the generic contractor family) ──
  { category: "plumber", pattern: /\b(plumb)/ },
  { category: "roofer", pattern: /\b(roof)/ },
  { category: "hvac", pattern: /\b(hvac|heating|air conditioning|furnace)/ },
  { category: "electrician", pattern: /\b(electric)/ },
  { category: "painter", pattern: /\b(paint)/ },
  { category: "flooring", pattern: /\b(floor|carpet|hardwood|tile install)/ },
  { category: "landscaping", pattern: /\b(landscap|lawn care|lawn service|tree service|arborist)/ },
  { category: "pest_control", pattern: /\b(pest|exterminat|termite)/ },
  { category: "pool_service", pattern: /\b(pool service|pool clean|pool maint|swimming pool)/ },
  { category: "solar", pattern: /\b(solar)/ },
  { category: "smart_home", pattern: /\b(smart home|home automation)/ },
  { category: "security", pattern: /\b(security system|alarm|surveillance|home security)/ },
  { category: "appliance_repair", pattern: /\b(appliance)/ },
  { category: "window_treatment", pattern: /\b(window treatment|blinds|shutters|drapery)/ },
  { category: "garage_door", pattern: /\b(garage door)/ },
  { category: "handyman", pattern: /\b(handyman|handyperson)/ },
  { category: "contractor", pattern: /\b(contractor|builder|remodel|renovat|construction)/ },
  // ── ownership + advisory ──
  { category: "property_management", pattern: /\b(property manage|property mgmt)/ },
  { category: "home_warranty", pattern: /\b(home warranty)/ },
  { category: "insurance", pattern: /\b(insurance|insur(er|ance) agency)/ },
  { category: "tax_pro", pattern: /\b(cpa\b|accountant|accounting|tax (prep|advis|service|consult)|enrolled agent)/ },
  { category: "financial_advisor", pattern: /\b(financial advis|financial plan|wealth manage)/ },
  // ── the genuine long tail: real vendors the taxonomy still has no token for ──
  //
  // This list SHRINKS as the vocabulary grows, and both departures were already
  // UNREACHABLE by the time they were removed — first match wins, and each had
  // gained a real family above:
  //   `apprais`          dead since m554 added `appraiser` (matched at :57)
  //   `survey(or|ing)`   dead since m562 added `surveyor`  (matched above)
  // Leaving them here would have been worse than untidy: it would read as though
  // a scanned appraiser or surveyor card still lands on the catch-all, which is
  // exactly the "vocabulary looks complete while the information is lost" shape
  // m561 refused to create for `surveyor`. `locksmith` is the honest remainder —
  // a real trade the 40-value taxonomy still has no token for.
  { category: "other", pattern: /\b(locksmith)/ },
]

/** a fellow agent's card is AGENT — agents are USERS of this platform
 *  (owner rule: "other agents are users"), so their card is a recruiting
 *  prospect, never the client CRM and never the vendor book. */
const REAL_ESTATE_AGENT = /\b(realtor|real estate agent|broker associate|listing agent|buyer'?s agent|realty|brokerage)\b/

// ── notes free-text cues — priority-2 tier, only consulted when the reader's own
// fields (title/company) gave no signal. Order matters the same way the vendor
// table does: a narrower phrase sits above a looser one it would otherwise also
// match ("potential client" above the bare "client" stem).
const NOTES_SPHERE = /\b(sphere(\s+of\s+influence)?|personal (friend|contact)|old friend|family (friend|member)|\bfriend\b|neighbor|knew (them|him|her) (from|before)|social (contact|connection))\b/
const NOTES_AGENT = /\b(fellow agent|another agent|co-?op agent|competitor'?s? agent|works? (at|for) (a |another )?(different )?brokerage|other side'?s agent)\b/
const NOTES_VENDOR = /\b(vendor|service provider|trade (contact|professional))\b/
const NOTES_POTENTIAL = /\b(potential (client|buyer|seller|lead)|maybe (buying|selling)|interested in (buying|selling)|thinking (about|of) (buying|selling)|might (buy|sell)|prospect(ive)?)\b/
const NOTES_CONTACT = /\b(client|buyer|seller|ready to (buy|sell)|signed|under contract)\b/

/** PURE: what is this card, from the reader's fields and the agent's notes alone
 *  (the database-backed existing-match tier and any explicit picker are applied
 *  by the caller — see the module doc). */
export function classifyCardSubject(input: {
  title?: string | null
  company?: string | null
  notes?: string | null
}): CardSubjectClassification {
  const readerHay = [input.title ?? "", input.company ?? ""].join(" ").toLowerCase()

  // Priority 1 — the card reader's own printed fields.
  if (readerHay.trim()) {
    if (REAL_ESTATE_AGENT.test(readerHay)) return { subjectType: "agent", category: null, source: "reader" }
    for (const fam of VENDOR_FAMILIES) {
      if (fam.pattern.test(readerHay)) return { subjectType: "vendor", category: fam.category, source: "reader" }
    }
  }

  // Priority 2 — the scanning agent's free-text notes.
  const notesHay = (input.notes ?? "").toLowerCase()
  if (notesHay.trim()) {
    if (NOTES_SPHERE.test(notesHay)) return { subjectType: "sphere", category: null, source: "notes" }
    if (NOTES_AGENT.test(notesHay)) return { subjectType: "agent", category: null, source: "notes" }
    if (NOTES_VENDOR.test(notesHay)) return { subjectType: "vendor", category: null, source: "notes" }
    if (NOTES_POTENTIAL.test(notesHay)) return { subjectType: "potential_contact", category: null, source: "notes" }
    if (NOTES_CONTACT.test(notesHay)) return { subjectType: "contact", category: null, source: "notes" }
  }

  // Default: UNKNOWN, never 'contact'. Owner ruling 2026-09-10, verbatim: "the
  // kernel events scanned business card shouldn't be assumed contact since it
  // is a business card from an event, sphere of influence/other agent/
  // potential contact ... card reader or agents notes can determine." Before
  // this ruling the fallthrough here was 'contact' — the exact assumption the
  // ruling forbids — and every card where BOTH the reader and the notes were
  // silent (the common case: a stranger's card with just a name and a number)
  // was auto-filed as a CRM contact. The caller still gets one more chance (an
  // existing-user/contact/vendor match by email/phone) before settling here.
  return { subjectType: "unknown", category: null, source: "default" }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTION CONFIDENCE + FIELD-LEVEL MERGE RULE — wave 141, lane 141F
// (owner ruling, verbatim: "scan → AI vision extraction → confidence → human
// confirmation where needed → identity/dedup → canonical contact → attribution/
// source → follow-up. No second OCR system; never overwrite higher-confidence data
// with weak extraction.")
//
// What existed: ONE vision path (gatewayChat through the Vercel AI Gateway) whose
// "confidence" was `filled fields / 8` — a COMPLETENESS ratio, not a confidence:
// a card read as "Jhon Smlth / jhon@exmaple.com" with every field populated
// scored 100% and auto-created a contact. Nothing asked the reader how sure it
// was of each field, nothing held a doubtful reading back for a human, and the
// "Report extraction error" button on the review surface showed a toast and did
// nothing. These pure rules are the missing half; the action
// (app/actions/business-card/business-card-actions.ts) applies them and the
// proof (scripts/qr-and-card-scanner-guard.ts) holds them with positive controls.
// ═══════════════════════════════════════════════════════════════════════════════

/** The eight card fields the reader is asked for, in the order the surface lists them. */
export const CARD_FIELDS = ["first_name", "last_name", "email", "phone", "company", "title", "address", "website"] as const
export type CardField = (typeof CARD_FIELDS)[number]

/** The fields that IDENTIFY the person — a doubt here is what a human must confirm. */
const CARD_IDENTITY_FIELDS: readonly CardField[] = ["first_name", "last_name", "email", "phone"]

/** A reading below this per-field confidence is held back from every structured column and
 *  shown to the scanning agent to confirm. 0.75: vision readers report ~0.9+ for clean print,
 *  0.5–0.7 for glare, handwriting and ambiguous glyphs (0/O, 1/l, rn/m). */
export const CARD_FIELD_CONFIDENCE_FLOOR = 0.75

/** Contact columns a card field lands on (company / title / website ride notes — no column). */
export const CARD_FIELD_TO_CONTACT_COLUMN: Readonly<Partial<Record<CardField, string>>> = {
  first_name: "first_name", last_name: "last_name", email: "email", phone: "phone", address: "address",
}

/** The provenance `source` a reading / a human confirmation stamps (decideCardFieldWrite reads the
 *  `business_card` prefix). @proofSeam asserted by name in scripts/qr-and-card-scanner-guard.ts. */
export const CARD_PROVENANCE_SOURCE_VISION = "business_card_vision"
export const CARD_PROVENANCE_SOURCE_HUMAN = "business_card_confirmed"
const CARD_PROVENANCE_CAPABILITY = "contact.business_card_scan"

export interface CardExtraction {
  /** Trimmed values; "" when the reader saw nothing. Email lower-cased. */
  fields: Record<CardField, string>
  /** 0..1 per field; null when the reader stated no confidence (treated as BELOW the floor). */
  confidence: Record<CardField, number | null>
}

function emptyExtraction(): CardExtraction {
  const fields = {} as Record<CardField, string>
  const confidence = {} as Record<CardField, number | null>
  for (const f of CARD_FIELDS) { fields[f] = ""; confidence[f] = null }
  return { fields, confidence }
}

/** PURE — the value as it is compared and stored: email lower-cased, phone digits-only
 *  (last ten — a US card's dashes, dots, parentheses and +1 are formatting), others
 *  whitespace-collapsed. @proofSeam asserted directly; the product reaches it through
 *  parseCardExtraction / decideCardFieldWrite / cardStampsForContact. */
export function normalizeCardValue(field: CardField, value: unknown): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value)
  const collapsed = s.replace(/\s+/g, " ").trim()
  if (field === "email") return collapsed.toLowerCase()
  if (field === "phone") { const d = collapsed.replace(/\D/g, ""); return d.length > 10 ? d.slice(-10) : d }
  return collapsed
}

function clampConfidence(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(1, n))
}

/**
 * PURE — the reader's JSON → a CardExtraction. Accepts the per-field shape the prompt asks
 * for (`{ first_name: { value, confidence } }`) AND the legacy flat shape (`{ first_name: "x" }`)
 * an older model turn may still return — a flat value carries NO stated confidence (null), which
 * the floor treats as doubtful: an unstated confidence is never promoted to a sure one.
 */
export function parseCardExtraction(raw: unknown): CardExtraction {
  const out = emptyExtraction()
  if (!raw || typeof raw !== "object") return out
  const obj = raw as Record<string, unknown>
  for (const f of CARD_FIELDS) {
    const v = obj[f]
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as { value?: unknown; confidence?: unknown }
      out.fields[f] = normalizeCardValue(f, o.value)
      out.confidence[f] = out.fields[f] ? clampConfidence(o.confidence) : null
    } else {
      out.fields[f] = normalizeCardValue(f, v)
      out.confidence[f] = null
    }
  }
  return out
}

/** PURE — a human typed/confirmed these values: every non-empty field is confidence 1. */
export function humanConfirmedExtraction(fields: Partial<Record<CardField, unknown>>): CardExtraction {
  const out = emptyExtraction()
  for (const f of CARD_FIELDS) {
    out.fields[f] = normalizeCardValue(f, fields[f])
    out.confidence[f] = out.fields[f] ? 1 : null
  }
  return out
}

interface CardExtractionAssessment {
  /** A name AND a contact method were read (at any confidence) — the viability gate. */
  viable: boolean
  /** Viable, but at least one PRESENT identity field is below the floor (or unstated) — a human confirms before anything is written. */
  needsConfirmation: boolean
  /** Present fields below the floor, identity first. */
  lowFields: CardField[]
  /** Mean stated confidence over the present fields (unstated = 0); 0 when nothing was read. */
  overall: number
  filledFields: CardField[]
}

/** PURE — what the reading is worth. */
export function assessCardExtraction(x: CardExtraction, floor: number = CARD_FIELD_CONFIDENCE_FLOOR): CardExtractionAssessment {
  const filledFields = CARD_FIELDS.filter((f) => !!x.fields[f])
  const hasName = !!(x.fields.first_name || x.fields.last_name)
  const hasContact = !!(x.fields.email || x.fields.phone)
  const viable = hasName && hasContact
  const lowFields = filledFields.filter((f) => (x.confidence[f] ?? 0) < floor)
  const lowIdentity = lowFields.filter((f) => CARD_IDENTITY_FIELDS.includes(f))
  const overall = filledFields.length === 0 ? 0 : filledFields.reduce((s, f) => s + (x.confidence[f] ?? 0), 0) / filledFields.length
  return {
    viable,
    needsConfirmation: viable && lowIdentity.length > 0,
    lowFields: [...lowIdentity, ...lowFields.filter((f) => !CARD_IDENTITY_FIELDS.includes(f))],
    overall: Math.round(overall * 100) / 100,
    filledFields,
  }
}

/** PURE — only the readings a structured column may take: present AND at/above the floor. */
export function confidentCardFields(x: CardExtraction, floor: number = CARD_FIELD_CONFIDENCE_FLOOR): Partial<Record<CardField, string>> {
  const out: Partial<Record<CardField, string>> = {}
  for (const f of CARD_FIELDS) if (x.fields[f] && (x.confidence[f] ?? 0) >= floor) out[f] = x.fields[f]
  return out
}

/** PURE — the doubtful readings, as ONE notes line (nothing read is thrown away; nothing
 *  doubtful reaches a column). Empty string when every reading cleared the floor. */
export function unconfirmedCardNote(x: CardExtraction, floor: number = CARD_FIELD_CONFIDENCE_FLOOR): string {
  const parts = CARD_FIELDS.filter((f) => x.fields[f] && (x.confidence[f] ?? 0) < floor)
    .map((f) => `${f.replace(/_/g, " ")}: ${x.fields[f]} (${Math.round((x.confidence[f] ?? 0) * 100)}%)`)
  return parts.length ? `Unconfirmed from the card (below the ${Math.round(floor * 100)}% reading floor): ${parts.join("; ")}.` : ""
}

type CardFieldWriteReason =
  | "no_incoming" | "fill_empty" | "same_value" | "human_over_card" | "higher_confidence"
  | "not_higher_confidence" | "stronger_provenance" | "unknown_provenance" | "below_floor"

interface CardFieldWriteDecision {
  write: boolean
  reason: CardFieldWriteReason
}

/**
 * PURE — THE FIELD-LEVEL MERGE RULE ("never overwrite higher-confidence data with weak
 * extraction"), decided per contact column against the column's EXISTING provenance stamp
 * (enrichment_profile.field_provenance[column] — the one stamp shape every writer uses):
 *
 *   incoming empty                                    → keep (no_incoming)
 *   incoming below the floor (and not human)          → keep (below_floor)
 *   existing empty                                    → write (fill_empty)
 *   same value                                        → keep (same_value)
 *   existing stamped by a card reading (vision/human) → human incoming wins (human_over_card);
 *                                                       otherwise only a strictly HIGHER stated
 *                                                       confidence wins (higher_confidence /
 *                                                       not_higher_confidence)
 *   existing stamped by anything else (a provider match, a staff edit, the contact's own
 *   portal entry)                                     → keep (stronger_provenance) — a card never
 *                                                       overwrites a verified or human-entered value
 *   existing value with NO stamp (legacy / unknown)   → a human confirmation writes; a reading
 *                                                       keeps (unknown_provenance) — fail closed
 */
export function decideCardFieldWrite(input: {
  field: CardField
  existingValue: unknown
  existingStamp: Pick<FieldProvenance, "source" | "matchConfidence"> | null | undefined
  incomingValue: string
  incomingConfidence: number | null
  incomingHuman: boolean
  floor?: number
}): CardFieldWriteDecision {
  const floor = input.floor ?? CARD_FIELD_CONFIDENCE_FLOOR
  const incoming = normalizeCardValue(input.field, input.incomingValue)
  if (!incoming) return { write: false, reason: "no_incoming" }
  const incomingConf = input.incomingHuman ? 1 : (input.incomingConfidence ?? 0)
  if (!input.incomingHuman && incomingConf < floor) return { write: false, reason: "below_floor" }
  const existing = normalizeCardValue(input.field, input.existingValue)
  if (!existing) return { write: true, reason: "fill_empty" }
  if (existing === incoming) return { write: false, reason: "same_value" }
  const stamp = input.existingStamp ?? null
  if (!stamp) return input.incomingHuman ? { write: true, reason: "human_over_card" } : { write: false, reason: "unknown_provenance" }
  const fromCard = typeof stamp.source === "string" && stamp.source.startsWith("business_card")
  if (!fromCard) return { write: false, reason: "stronger_provenance" }
  if (input.incomingHuman) return { write: true, reason: "human_over_card" }
  const existingConf = clampConfidence(stamp.matchConfidence) ?? 0
  return incomingConf > existingConf ? { write: true, reason: "higher_confidence" } : { write: false, reason: "not_higher_confidence" }
}

/**
 * PURE — the provenance stamps a card reading earns on a contact row, by VALUE EQUALITY: a
 * column is stamped only when the contact now holds the card's reading (the capture filled it,
 * or it was already identical) AND carries no stamp yet (an existing stamp — a provider match,
 * a staff edit — is never overwritten by a reading). A human confirmation stamps as
 * staff_edit with the actor; a reading stamps as acquisition with the reader's confidence.
 */
export function cardStampsForContact(
  x: CardExtraction,
  contact: Record<string, unknown>,
  existingProvenance: Record<string, unknown>,
  opts: { human: boolean; actor: string | null; retrievedAt?: string },
): Record<string, FieldProvenance> {
  const out: Record<string, FieldProvenance> = {}
  for (const f of CARD_FIELDS) {
    const column = CARD_FIELD_TO_CONTACT_COLUMN[f]
    if (!column || !x.fields[f]) continue
    if (existingProvenance[column] && typeof existingProvenance[column] === "object") continue
    if (normalizeCardValue(f, contact[column]) !== x.fields[f]) continue
    const stamp = stampFieldProvenance([column], {
      source: opts.human ? CARD_PROVENANCE_SOURCE_HUMAN : CARD_PROVENANCE_SOURCE_VISION,
      capability: CARD_PROVENANCE_CAPABILITY,
      purpose: opts.human ? "staff_edit" : "acquisition",
      matchConfidence: opts.human ? 1 : x.confidence[f],
      actor: opts.human ? opts.actor : null,
      retrievedAt: opts.retrievedAt,
    })
    out[column] = stamp[column]
  }
  return out
}
