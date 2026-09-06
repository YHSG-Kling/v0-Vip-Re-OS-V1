/**
 * lib/contacts/card-classifier.ts
 *
 * BUSINESS-CARD TARGET CLASSIFIER — a scanned card is not always a lead:
 * the inspector at the open house, the stager, the lender rep hand out
 * cards too, and those belong in the VENDOR book (owner directive: "scan
 * business cards and pull in as new vendor contact"). PURE keyword
 * classifier over the card's extracted title/company; the category maps
 * ONTO the live vendors.category CHECK vocabulary (Lender / Inspector /
 * Title Company / Contractor / Stager / Other — verified live). A fellow
 * REAL-ESTATE AGENT'S card stays a contact (a co-op agent is a
 * relationship, not a vendor). Default: contact — when in doubt, the CRM
 * path (which a human reviews) is the safe landing. The scanner UI can
 * override either way. NOT server-only (simulator-driven).
 */

import type { VendorCategory } from "@/lib/kernel/vendor-categories"

export type CardTarget = "contact" | "vendor" | "recruit"

export interface CardClassification {
  target: CardTarget
  /** vendors.category CHECK value — set only when target is vendor. */
  category: VendorCategory | null
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
const VENDOR_FAMILIES: Array<{ category: CardClassification["category"]; pattern: RegExp }> = [
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

/** a fellow agent's card is a RECRUIT — agents are USERS of this platform
 *  (owner rule), so their card lands in the recruiting pipeline, never the
 *  client CRM and never the vendor book. */
const REAL_ESTATE_AGENT = /\b(realtor|real estate agent|broker associate|listing agent|buyer'?s agent|realty|brokerage)\b/

/** PURE: where does this card belong? */
export function classifyCardTarget(input: { title?: string | null; company?: string | null }): CardClassification {
  const hay = [input.title ?? "", input.company ?? ""].join(" ").toLowerCase()
  if (!hay.trim()) return { target: "contact", category: null }
  if (REAL_ESTATE_AGENT.test(hay)) return { target: "recruit", category: null }
  for (const fam of VENDOR_FAMILIES) {
    if (fam.pattern.test(hay)) return { target: "vendor", category: fam.category }
  }
  return { target: "contact", category: null }
}
