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
