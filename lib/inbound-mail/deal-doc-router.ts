// lib/inbound-mail/deal-doc-router.ts
// ─────────────────────────────────────────────────────────────────────────────
// INBOUND DEAL-DOC ROUTER (PURE) — the generalization of the offer lookout: ANY outside party can
// email ANY deal document and the right MANAGER picks it up. Classify an inbound doc (by subject /
// filename / body signals) into a deal-doc TYPE, then route it to the manager who OWNS that stage of
// the deal — Listing Concierge for the offer/listing side, Deal Coordinator for transaction docs
// (signed contract, inspection, appraisal, lender clear-to-close), Shopping Agent for buyer-side.
// No competitor routes inbound docs to a multi-manager bus; this is the brain that does. Pure: no I/O.

export type DealDocType =
  | "offer" | "counteroffer" | "signed_contract" | "inspection" | "appraisal" | "lender" | "disclosure" | "unknown"

export type DealDocManager = "listing_concierge" | "deal_coordinator" | "shopping_agent"

interface Pattern { type: DealDocType; re: RegExp }

// Order matters — most specific first; the first match wins.
const PATTERNS: Pattern[] = [
  { type: "lender",          re: /\b(clear to close|loan commitment|underwriting approval|final loan approval|commitment letter|CTC)\b/i },
  { type: "appraisal",       re: /\b(appraisal report|appraised value|appraisal (came in|completed)|appraisal)\b/i },
  { type: "inspection",      re: /\b(inspection report|home inspection|inspection summary|inspection (findings|results))\b/i },
  { type: "counteroffer",    re: /\b(counter[\s]?offer|counter to (your|the) offer|seller counter|buyer counter)\b/i },
  { type: "signed_contract", re: /\b(fully executed|executed (contract|agreement)|ratified (contract|agreement)|signed (purchase )?(contract|agreement))\b/i },
  { type: "disclosure",      re: /\b(seller('s)? disclosure|property disclosure|lead[\s-]?(based[\s-]?)?paint|disclosure statement|TDS)\b/i },
  { type: "offer",           re: /\b(offer to purchase|purchase agreement|purchase contract|residential purchase|sales? contract|RPA|TAR\s?1601|FAR\/BAR|\boffer\b)/i },
]

/** PURE. Classify an inbound document by its signals. Returns "unknown" when nothing matches. */
export function classifyDealDoc(input: { subject: string | null; fileNames: string | null; body: string | null }): DealDocType {
  const hay = [input.subject, input.fileNames, input.body].filter(Boolean).join(" \n ").replace(/[_\-]+/g, " ")
  for (const p of PATTERNS) {
    if (p.re.test(hay)) return p.type
  }
  return "unknown"
}

export interface DealDocRoute {
  manager: DealDocManager
  /** plain-language stage label for the notification/handoff. */
  label: string
  /** offers + counteroffers can be auto-ingested (we have the offer pipeline); the rest are
   *  surfaced to the owning manager's agent to file (auto-creating transaction docs is riskier). */
  autoIngestable: boolean
}

/** PURE. Which manager owns this deal-doc type, and is it safe to auto-ingest? */
export function routeForDocType(type: DealDocType): DealDocRoute | null {
  switch (type) {
    case "offer":          return { manager: "listing_concierge", label: "a new offer",            autoIngestable: true }
    case "counteroffer":   return { manager: "listing_concierge", label: "a counteroffer",         autoIngestable: true }
    case "signed_contract":return { manager: "deal_coordinator",  label: "a signed contract",      autoIngestable: false }
    case "inspection":     return { manager: "deal_coordinator",  label: "an inspection report",   autoIngestable: false }
    case "appraisal":      return { manager: "deal_coordinator",  label: "an appraisal report",    autoIngestable: false }
    case "lender":         return { manager: "deal_coordinator",  label: "a lender clear-to-close",autoIngestable: false }
    case "disclosure":     return { manager: "listing_concierge", label: "a disclosure",           autoIngestable: false }
    case "unknown":
    default:               return null
  }
}
