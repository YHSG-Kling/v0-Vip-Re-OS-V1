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
const VENDOR_FAMILIES: Array<{ category: CardClassification["category"]; pattern: RegExp }> = [
  { category: "Lender", pattern: /\b(lender|mortgage|loan officer|nmls|home loans|lending)/ },
  { category: "Inspector", pattern: /\b(inspect)/ },
  { category: "Title Company", pattern: /\b(title|escrow)/ },
  { category: "Contractor", pattern: /\b(contractor|plumb|roof|hvac|electric|handyman|builder|remodel|renovat|construction)/ },
  { category: "Stager", pattern: /\b(stag(er|ing)|interior design)/ },
  { category: "Other", pattern: /\b(photograph|videograph|clean(er|ing)|landscap|mover|moving compan|attorney|law firm|insurance|apprais|pest|survey(or|ing)|locksmith|organizer)/ },
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
