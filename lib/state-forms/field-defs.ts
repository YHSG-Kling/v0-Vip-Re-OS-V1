/**
 * lib/state-forms/field-defs.ts
 *
 * Field-level metadata for the canonical voice-intake shapes (Offer / BBA /
 * Listing). Every field carries:
 *   - label              human-readable name the AI says aloud
 *   - hint               what the AI says when asking the agent for this field
 *   - type               value type (drives validation + display)
 *   - suggested_default  the value to use when the agent says "default"
 *   - enum_values        allowed values for enum types (so AI can guide)
 *   - required           must be filled before a packet can dispatch
 *   - category           grouping for AI-walk-aloud
 *
 * Why this module exists:
 *   The AI cockpit's `fill_form_field` and `next_unfilled_field` voice tools
 *   read this registry so the AI can teach itself the form: "Next field is
 *   Inspection Days — the typical default is 10. Want default, or specify?"
 *   When the agent says "default", the tool resolves to suggested_default and
 *   fills the intake. Without this, the AI has no idea what fields mean or
 *   what reasonable values look like.
 *
 * Why TS constants instead of a DB table:
 *   These are the SHAPES the intake extractors target. They're versioned with
 *   the code. A future migration could surface them in a DB-driven editor for
 *   brokerages to override per-tenant defaults, but the shape itself is part
 *   of the kernel contract — not user data.
 *
 * State-aware defaults:
 *   Some defaults vary by state (TX option period is 10 days, CA inspection
 *   contingency is 17 days). For v1 we use the most common national-average
 *   defaults; the agent can always override by speaking a specific value.
 *   A future enhancement would key suggested_default by state_code.
 */

export type FieldType =
  | "text"        // free-form string
  | "number"      // integer or float
  | "money"       // dollar amount (number; rendered with $)
  | "percent"     // 0-100 number
  | "date"        // ISO YYYY-MM-DD
  | "enum"        // one-of from enum_values
  | "boolean"     // true / false
  | "party"       // legal name of a party (text + identity validation)
  | "address"     // street address (text)
  | "list"        // array of strings (e.g. contingencies, addenda)

export interface FieldDef {
  /** Stable canonical name — matches the IntakeField key */
  id: string
  /** Human-readable label the AI reads aloud */
  label: string
  /** What the AI says when asking the agent for this field */
  hint: string
  /** Value type — drives default rendering + validation */
  type: FieldType
  /**
   * The value the tool uses when the agent says "default".
   * `null` (or absent) means the field has no safe default — the agent
   * MUST provide a value. We never invent a value for these.
   */
  suggested_default?: string | number | boolean | string[] | null
  /** For enum types, the allowed values */
  enum_values?: readonly string[]
  /** When true, the packet cannot dispatch until this is filled */
  required?: boolean
  /** Grouping for the AI-walk-aloud experience */
  category?:
    | "property"
    | "buyer"
    | "seller"
    | "terms"
    | "timing"
    | "concessions"
    | "marketing"
    | "disclosures"
    | "commission"
    | "scope"
    | "notes"
}

// ─── Offer fields ───────────────────────────────────────────────────────────

export const OFFER_FIELD_DEFS: Record<string, FieldDef> = {
  // ── Property ──
  propertyAddress: {
    id: "propertyAddress", label: "Property address", category: "property",
    hint: "What's the street address of the property?",
    type: "address", required: true,
  },
  propertyCity: {
    id: "propertyCity", label: "City", category: "property",
    hint: "Which city?", type: "text", required: true,
  },
  propertyState: {
    id: "propertyState", label: "State", category: "property",
    hint: "Which state? Two-letter code like TX or CA.", type: "text", required: true,
  },
  propertyZip: {
    id: "propertyZip", label: "ZIP code", category: "property",
    hint: "ZIP code?", type: "text",
  },
  listingId: {
    id: "listingId", label: "Listing ID (if in-house)", category: "property",
    hint: "Is this one of our listings? If yes, give me the listing ID.", type: "text",
  },

  // ── Buyer ──
  buyerLegalName: {
    id: "buyerLegalName", label: "Buyer's legal name", category: "buyer",
    hint: "Buyer's legal full name as it appears on their driver's license.",
    type: "party", required: true,
  },
  buyerEmail: {
    id: "buyerEmail", label: "Buyer's email", category: "buyer",
    hint: "Buyer's email for the e-sign envelope.", type: "text", required: true,
  },
  buyerPhone: {
    id: "buyerPhone", label: "Buyer's phone", category: "buyer",
    hint: "Buyer's phone number?", type: "text",
  },
  coBuyerLegalName: {
    id: "coBuyerLegalName", label: "Co-buyer's legal name", category: "buyer",
    hint: "Is there a co-buyer or spouse on the offer? If yes, their legal name.",
    type: "party",
  },
  buyerEntity: {
    id: "buyerEntity", label: "Buyer entity type", category: "buyer",
    hint: "Buying as an individual, jointly, an LLC, or a trust?",
    type: "enum", enum_values: ["individual", "joint", "llc", "trust"] as const,
    suggested_default: "individual",
  },

  // ── Offer terms ──
  offerPrice: {
    id: "offerPrice", label: "Offer price", category: "terms",
    hint: "What's the offer price?", type: "money", required: true,
  },
  earnestMoneyAmount: {
    id: "earnestMoneyAmount", label: "Earnest money amount", category: "terms",
    hint: "Earnest money deposit — typical is 1% of offer price.", type: "money",
  },
  earnestMoneyPercent: {
    id: "earnestMoneyPercent", label: "Earnest money %", category: "terms",
    hint: "Or earnest money as a percentage — typical default is 1%.",
    type: "percent", suggested_default: 1,
  },
  downPaymentPercent: {
    id: "downPaymentPercent", label: "Down payment %", category: "terms",
    hint: "Down payment percentage — conventional standard is 20%.",
    type: "percent", suggested_default: 20,
  },
  financingType: {
    id: "financingType", label: "Financing type", category: "terms",
    hint: "Conventional, FHA, VA, USDA, or cash?",
    type: "enum",
    enum_values: ["conventional", "fha", "va", "cash", "usda", "other"] as const,
    suggested_default: "conventional", required: true,
  },
  contractType: {
    id: "contractType", label: "Contract type", category: "terms",
    hint: "Standard residential, as-is, new construction, land, or commercial?",
    type: "enum",
    enum_values: ["residential", "as_is", "new_construction", "land", "commercial"] as const,
    suggested_default: "residential", required: true,
  },

  // ── Timing ──
  closeDate: {
    id: "closeDate", label: "Closing date", category: "timing",
    hint: "Target closing date — typical default is 45 days from today.",
    type: "date", suggested_default: "+45d",
  },
  inspectionDays: {
    id: "inspectionDays", label: "Inspection period (days)", category: "timing",
    hint: "Inspection period in days — TX option period is typically 10; other states use 14-17.",
    type: "number", suggested_default: 10,
  },
  appraisalDays: {
    id: "appraisalDays", label: "Appraisal contingency (days)", category: "timing",
    hint: "Appraisal contingency in days — typical is 21.",
    type: "number", suggested_default: 21,
  },
  financingDays: {
    id: "financingDays", label: "Financing contingency (days)", category: "timing",
    hint: "Financing contingency in days — typical is 30.",
    type: "number", suggested_default: 30,
  },

  // ── Concessions + escalation ──
  sellerConcessionAmount: {
    id: "sellerConcessionAmount", label: "Seller concession", category: "concessions",
    hint: "Seller concession — dollar amount toward buyer's closing costs. Default is 0.",
    type: "money", suggested_default: 0,
  },
  escalationEnabled: {
    id: "escalationEnabled", label: "Escalation clause?", category: "concessions",
    hint: "Add an escalation clause to beat other offers? Default no.",
    type: "boolean", suggested_default: false,
  },
  escalationCap: {
    id: "escalationCap", label: "Escalation cap", category: "concessions",
    hint: "If escalating, the max we'll go to.", type: "money",
  },
  escalationIncrement: {
    id: "escalationIncrement", label: "Escalation increment", category: "concessions",
    hint: "How much above competing offers — typically $1,000 to $5,000.", type: "money",
  },
  contingencies: {
    id: "contingencies", label: "Contingencies", category: "concessions",
    hint: "Which contingencies — inspection, financing, appraisal? Default is all three.",
    type: "list", suggested_default: ["inspection", "financing", "appraisal"],
  },
  addendaRequested: {
    id: "addendaRequested", label: "Addenda", category: "concessions",
    hint: "Any specific addenda — HOA, lead-paint, home warranty, etc.?",
    type: "list", suggested_default: [],
  },

  // ── Notes ──
  agentNotes: {
    id: "agentNotes", label: "Agent notes", category: "notes",
    hint: "Anything else you want noted on the offer?", type: "text",
  },
}

// ─── BBA fields ─────────────────────────────────────────────────────────────

export const BBA_FIELD_DEFS: Record<string, FieldDef> = {
  buyerLegalName: {
    id: "buyerLegalName", label: "Buyer's legal name", category: "buyer",
    hint: "Buyer's legal full name as on their driver's license.",
    type: "party", required: true,
  },
  agreementType: {
    id: "agreementType", label: "Agreement type", category: "scope",
    hint: "Exclusive, non-exclusive, showing-only, or open?",
    type: "enum",
    enum_values: ["exclusive", "non_exclusive", "showing_only", "open"] as const,
    suggested_default: "exclusive", required: true,
  },
  commissionPercentage: {
    id: "commissionPercentage", label: "Commission %", category: "commission",
    hint: "Commission percentage — typical is 2.5% to 3%.",
    type: "percent", suggested_default: 2.5,
  },
  commissionFlatAmount: {
    id: "commissionFlatAmount", label: "Commission flat amount", category: "commission",
    hint: "Or a flat dollar amount if you're charging flat.", type: "money",
  },
  commissionPayer: {
    id: "commissionPayer", label: "Commission payer", category: "commission",
    hint: "Who pays the buyer broker — seller, buyer, split, or either party?",
    type: "enum",
    enum_values: ["seller", "buyer", "split", "either"] as const,
    suggested_default: "seller", required: true,
  },
  commissionNotes: {
    id: "commissionNotes", label: "Commission notes", category: "commission",
    hint: "Any commission notes — concessions, gaps, or special terms?", type: "text",
  },
  geographicScope: {
    id: "geographicScope", label: "Geographic scope", category: "scope",
    hint: "Geographic scope — county, city, or specific area.", type: "text",
  },
  propertyTypeScope: {
    id: "propertyTypeScope", label: "Property type scope", category: "scope",
    hint: "Which property types — residential, condo, land, commercial, multi-family?",
    type: "list", suggested_default: ["residential"],
  },
  effectiveDate: {
    id: "effectiveDate", label: "Effective date", category: "scope",
    hint: "Effective date — default is today.",
    type: "date", suggested_default: "today",
  },
  expirationDate: {
    id: "expirationDate", label: "Expiration date", category: "scope",
    hint: "Expiration date — most BBAs are 90 days.",
    type: "date", suggested_default: "+90d",
  },
  agentNotes: {
    id: "agentNotes", label: "Agent notes", category: "notes",
    hint: "Anything else worth noting?", type: "text",
  },
}

// ─── Listing fields ─────────────────────────────────────────────────────────

export const LISTING_FIELD_DEFS: Record<string, FieldDef> = {
  // Property
  propertyAddress: {
    id: "propertyAddress", label: "Property address", category: "property",
    hint: "What's the street address?", type: "address", required: true,
  },
  propertyCity: {
    id: "propertyCity", label: "City", category: "property",
    hint: "City?", type: "text", required: true,
  },
  propertyState: {
    id: "propertyState", label: "State", category: "property",
    hint: "Two-letter state code?", type: "text", required: true,
  },
  propertyZip: {
    id: "propertyZip", label: "ZIP code", category: "property",
    hint: "ZIP code?", type: "text",
  },
  propertyType: {
    id: "propertyType", label: "Property type", category: "property",
    hint: "Single-family, condo, townhouse, multi-family, or land?",
    type: "enum",
    enum_values: ["single_family", "condo", "townhouse", "multi_family", "land"] as const,
    suggested_default: "single_family",
  },
  bedrooms:  { id: "bedrooms",  label: "Bedrooms",  category: "property", hint: "Bedrooms?",  type: "number" },
  bathrooms: { id: "bathrooms", label: "Bathrooms", category: "property", hint: "Bathrooms?", type: "number" },
  sqft:      { id: "sqft",      label: "Square feet", category: "property", hint: "Square footage?", type: "number" },
  yearBuilt: { id: "yearBuilt", label: "Year built", category: "property", hint: "Year built?", type: "number" },

  // Seller
  sellerLegalName: {
    id: "sellerLegalName", label: "Seller's legal name", category: "seller",
    hint: "Seller's legal full name as on the deed.", type: "party", required: true,
  },
  coSellerLegalName: {
    id: "coSellerLegalName", label: "Co-seller's legal name", category: "seller",
    hint: "Co-seller if any.", type: "party",
  },
  sellerEmail: { id: "sellerEmail", label: "Seller's email", category: "seller", hint: "Seller's email?", type: "text" },
  sellerPhone: { id: "sellerPhone", label: "Seller's phone", category: "seller", hint: "Seller's phone?", type: "text" },
  sellerEntity: {
    id: "sellerEntity", label: "Seller entity", category: "seller",
    hint: "Listing as individual, jointly, LLC, or trust?",
    type: "enum",
    enum_values: ["individual", "joint", "llc", "trust"] as const,
    suggested_default: "individual",
  },
  sellerMotivation: {
    id: "sellerMotivation", label: "Seller motivation", category: "seller",
    hint: "What's driving the sale — relocation, upsize, downsize, investment exit, estate, or other?",
    type: "enum",
    enum_values: ["relocation", "upsize", "downsize", "investment_exit", "estate", "other"] as const,
  },

  // Terms
  listPrice: {
    id: "listPrice", label: "List price", category: "terms",
    hint: "Target list price?", type: "money", required: true,
  },
  commissionTotalPercent: {
    id: "commissionTotalPercent", label: "Total commission %", category: "commission",
    hint: "Total commission percentage — typical is 5% to 6%.",
    type: "percent", suggested_default: 6, required: true,
  },
  commissionToBuyerAgent: {
    id: "commissionToBuyerAgent", label: "Commission to buyer agent %", category: "commission",
    hint: "Split to buyer's agent — typical is half of total, around 2.5% to 3%.",
    type: "percent", suggested_default: 3,
  },
  listingTermDays: {
    id: "listingTermDays", label: "Listing term (days)", category: "terms",
    hint: "Listing term in days — typical is 90 or 180.",
    type: "number", suggested_default: 90, required: true,
  },
  goLiveDate: {
    id: "goLiveDate", label: "Go-live date", category: "timing",
    hint: "When goes live on MLS — default is today.",
    type: "date", suggested_default: "today",
  },
  expirationDate: {
    id: "expirationDate", label: "Listing expiration", category: "timing",
    hint: "Listing expiration date.", type: "date", suggested_default: "+90d",
  },

  // Marketing
  professionalPhotos: {
    id: "professionalPhotos", label: "Professional photos", category: "marketing",
    hint: "Will we order professional photos? Default yes.",
    type: "boolean", suggested_default: true,
  },
  videoTour: {
    id: "videoTour", label: "Video tour", category: "marketing",
    hint: "Video tour? Default no — agent decides per listing.",
    type: "boolean", suggested_default: false,
  },
  openHousePlan: {
    id: "openHousePlan", label: "Open house plan", category: "marketing",
    hint: "Open house plan in plain words — e.g. 'first weekend after MLS live'.",
    type: "text",
  },
  comingSoonPeriod: {
    id: "comingSoonPeriod", label: "Coming-soon period (days)", category: "marketing",
    hint: "Days in coming-soon status before MLS live — typical 7.",
    type: "number", suggested_default: 7,
  },
  stagingPlan: {
    id: "stagingPlan", label: "Staging plan", category: "marketing",
    hint: "Existing furniture, professional stager, virtual, vacant, or owner decluttering?",
    type: "enum",
    enum_values: ["existing", "professional_stager", "virtual", "vacant", "owner_decluttering"] as const,
    suggested_default: "existing",
  },

  // Disclosures
  knownDefects:  { id: "knownDefects",  label: "Known defects",       category: "disclosures", hint: "Any known defects to disclose?",   type: "list", suggested_default: [] },
  recentRepairs: { id: "recentRepairs", label: "Recent repairs",      category: "disclosures", hint: "Any recent repairs to disclose?",  type: "list", suggested_default: [] },
  hoaInfo:       { id: "hoaInfo",       label: "HOA info",            category: "disclosures", hint: "HOA info — name, dues, rules?",     type: "text" },
  septicSystem:  { id: "septicSystem",  label: "Septic system?",      category: "disclosures", hint: "Septic system on site?",            type: "boolean", suggested_default: false },
  solarLeased:   { id: "solarLeased",   label: "Solar leased?",       category: "disclosures", hint: "Solar panels leased (not owned)?",  type: "boolean", suggested_default: false },
  leadPaintEra:  { id: "leadPaintEra",  label: "Built before 1978?",  category: "disclosures", hint: "Built before 1978? Triggers lead-paint disclosure.", type: "boolean" },
  showingInstructions: {
    id: "showingInstructions", label: "Showing instructions", category: "marketing",
    hint: "Showing instructions — lockbox, appointment-only, etc.", type: "text",
  },

  agentNotes: {
    id: "agentNotes", label: "Agent notes", category: "notes",
    hint: "Anything else worth noting?", type: "text",
  },
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a "default" sentinel into a concrete value at fill-time.
 *   - "today"  → today's ISO date
 *   - "+Nd"    → today + N days, ISO date (e.g. "+45d", "+90d")
 *   - anything else → returned as-is
 *
 * This indirection means the registry can encode relative dates without
 * having stale values at module-load.
 */
export function resolveSuggestedDefault(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (value === "today") return new Date().toISOString().slice(0, 10)
  const m = value.match(/^\+(\d+)d$/)
  if (m) {
    const days = parseInt(m[1], 10)
    return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10)
  }
  return value
}

/**
 * Lookup the field def for a given (mode, fieldName) pair.
 * Returns undefined when unknown.
 */
export function getFieldDef(
  mode: "offer" | "bba" | "listing",
  fieldName: string,
): FieldDef | undefined {
  const registry =
    mode === "offer"   ? OFFER_FIELD_DEFS :
    mode === "bba"     ? BBA_FIELD_DEFS :
    mode === "listing" ? LISTING_FIELD_DEFS : undefined
  return registry?.[fieldName]
}
