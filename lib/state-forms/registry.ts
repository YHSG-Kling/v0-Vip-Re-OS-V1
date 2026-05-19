/**
 * lib/state-forms/registry.ts
 *
 * Canonical real estate forms registry — covers all 50 US states.
 * The state on the PROPERTY ADDRESS dictates which forms apply,
 * NOT a default. There is no fallback "DEFAULT" set — every state
 * is explicit.
 *
 * Two form bundles per state:
 *   - offer            buyer-side purchase agreement + standard addenda
 *   - listing          listing agreement + seller disclosure + brokerage disclosure
 *
 * Form IDs use the official MLS/Association form numbers where known
 * (TAR for Texas, CAR for California, FAR/BAR for Florida, GAR for Georgia, etc.).
 *
 * Used by:
 *   - draft_document workflow adapter (offer + listing_agreement document_type)
 *   - send_for_esign workflow adapter (form selection routed to Dotloop)
 *   - app/actions/ai-offer-creation.ts:generateOfferDraft()
 *   - app/actions/ai-listing-intake.ts:generateListingAgreement()
 */

export interface StateFormBundle {
  /** Forms required for every transaction in this state */
  required: string[]
  /** Optional addenda commonly used */
  addenda:  string[]
  /** Brokerage representation / agency disclosure form (separate signature flow) */
  brokerageRepresentation: string
}

export interface StateFormSet {
  offer:   StateFormBundle
  listing: StateFormBundle
}

/**
 * 50-state forms registry. Each state is fully defined — no DEFAULT key.
 * Where a specific Association form ID isn't yet known, the entry uses
 * a generic-but-state-named placeholder so the agent sees the right
 * geography and can update the exact number in the form library UI.
 */
export const STATE_FORMS: Record<string, StateFormSet> = {
  AL: {
    offer:   { required: ["AL Residential Sales Contract", "AL Property Disclosure", "AL Lead-Based Paint Disclosure"], addenda: ["AL Inspection Contingency", "AL Financing Contingency", "AL Appraisal Contingency"], brokerageRepresentation: "AL Real Estate Consumer's Agency Disclosure" },
    listing: { required: ["AL Exclusive Right to Sell Listing Agreement", "AL Seller Property Disclosure", "AL Lead-Based Paint Disclosure"], addenda: ["AL Listing Price Reduction", "AL Listing Extension"], brokerageRepresentation: "AL Real Estate Consumer's Agency Disclosure" },
  },
  AK: {
    offer:   { required: ["AK Residential Real Estate Purchase and Sale Agreement", "AK Property Disclosure"], addenda: ["AK Inspection Contingency", "AK Financing Contingency"], brokerageRepresentation: "AK Real Estate Disclosure of Agency" },
    listing: { required: ["AK Exclusive Listing Agreement", "AK Seller Property Disclosure"], addenda: [], brokerageRepresentation: "AK Real Estate Disclosure of Agency" },
  },
  AZ: {
    offer:   { required: ["AAR Residential Resale Real Estate Purchase Contract", "AAR SPDS - Seller's Property Disclosure", "AZ Lead-Based Paint Disclosure"], addenda: ["AAR Loan Contingency", "AAR Buyer Contingency for Sale"], brokerageRepresentation: "AAR Real Estate Agency Disclosure and Election" },
    listing: { required: ["AAR Exclusive Right to Sell-Exchange-Lease Listing Contract", "AAR SPDS"], addenda: ["AAR Listing Extension"], brokerageRepresentation: "AAR Real Estate Agency Disclosure and Election" },
  },
  AR: {
    offer:   { required: ["AR Real Estate Contract", "AR Seller Property Disclosure"], addenda: ["AR Loan Contingency", "AR Inspection Addendum"], brokerageRepresentation: "AR Agency Disclosure" },
    listing: { required: ["AR Exclusive Right to Sell Listing Agreement", "AR Seller Disclosure"], addenda: [], brokerageRepresentation: "AR Agency Disclosure" },
  },
  CA: {
    offer:   { required: ["CAR RPA - Residential Purchase Agreement", "CAR AD - Disclosure Regarding Real Estate Agency Relationship", "CAR PRDS - Property Disclosure", "CAR LPA - Lead-Based Paint Disclosure"], addenda: ["CAR RIPA - Residential Income Property PA", "CAR COP - Contingency for Sale of Buyer's Property", "CAR SBSA - Short Sale Addendum"], brokerageRepresentation: "CAR AD - Disclosure Regarding Real Estate Agency Relationship" },
    listing: { required: ["CAR RLA - Residential Listing Agreement", "CAR SS - Seller's Property Questionnaire", "CAR AD - Agency Disclosure", "CAR TDS - Transfer Disclosure Statement"], addenda: ["CAR RLAA - Listing Agreement Amendment"], brokerageRepresentation: "CAR AD - Agency Disclosure" },
  },
  CO: {
    offer:   { required: ["CREC Contract to Buy and Sell Real Estate (Residential)", "CO Seller's Property Disclosure", "CO Source of Water Addendum"], addenda: ["CO Inspection Resolution", "CO Loan Approval"], brokerageRepresentation: "CREC Brokerage Disclosure to Buyer" },
    listing: { required: ["CREC Exclusive Right-to-Sell Listing Contract", "CO Seller's Property Disclosure"], addenda: ["CO Counterproposal"], brokerageRepresentation: "CREC Brokerage Disclosure to Seller" },
  },
  CT: {
    offer:   { required: ["CT Real Estate Sales Contract", "CT Residential Property Condition Disclosure"], addenda: ["CT Lead Paint Disclosure", "CT Mortgage Contingency"], brokerageRepresentation: "CT Real Estate Agency Disclosure" },
    listing: { required: ["CT Exclusive Right to Sell Listing Agreement", "CT Property Disclosure"], addenda: [], brokerageRepresentation: "CT Real Estate Agency Disclosure" },
  },
  DE: {
    offer:   { required: ["DE Agreement of Sale - Residential", "DE Seller's Disclosure of Real Property Condition"], addenda: ["DE Inspection Contingency", "DE Mortgage Contingency"], brokerageRepresentation: "DE Real Estate Consumer Information" },
    listing: { required: ["DE Exclusive Right to Sell", "DE Property Disclosure"], addenda: [], brokerageRepresentation: "DE Real Estate Consumer Information" },
  },
  FL: {
    offer:   { required: ["FAR/BAR Residential Contract for Sale and Purchase", "FAR Seller's Property Disclosure - Residential", "FL Lead-Based Paint Disclosure"], addenda: ["FAR AS-IS Addendum", "FAR Inspection Contingency", "FAR Financing Contingency"], brokerageRepresentation: "FL Single Agent Notice / Transaction Broker Notice" },
    listing: { required: ["FAR Exclusive Right of Sale Listing Agreement", "FAR Seller's Property Disclosure"], addenda: ["FL Property Tax Disclosure"], brokerageRepresentation: "FL Single Agent Notice / Transaction Broker Notice" },
  },
  GA: {
    offer:   { required: ["GAR Purchase and Sale Agreement", "GA Seller's Property Disclosure Statement", "GA Lead-Based Paint Disclosure"], addenda: ["GAR Inspection and Due Diligence Exhibit", "GAR Mortgage Loan Contingency"], brokerageRepresentation: "GA Brokerage Engagement Agreement" },
    listing: { required: ["GAR Exclusive Seller Brokerage Engagement Agreement", "GA Seller's Property Disclosure"], addenda: [], brokerageRepresentation: "GA Brokerage Engagement Agreement" },
  },
  HI: {
    offer:   { required: ["HI DROA - Purchase Contract Addendum", "HI Seller's Real Property Disclosure Statement"], addenda: ["HI Termite Inspection Addendum", "HI Condominium Disclosure"], brokerageRepresentation: "HI Real Estate Brokerage Services Disclosure" },
    listing: { required: ["HI Exclusive Right to Sell", "HI Seller's Disclosure"], addenda: [], brokerageRepresentation: "HI Real Estate Brokerage Services Disclosure" },
  },
  ID: {
    offer:   { required: ["ID RE-21 - Real Estate Purchase and Sale Agreement", "ID Seller's Property Disclosure Form"], addenda: ["ID Inspection Contingency", "ID Loan Contingency"], brokerageRepresentation: "ID RE-1 Agency Disclosure Brochure" },
    listing: { required: ["ID Exclusive Seller Representation Agreement", "ID Seller Property Disclosure"], addenda: [], brokerageRepresentation: "ID RE-1 Agency Disclosure Brochure" },
  },
  IL: {
    offer:   { required: ["IL Multi-Board Residential Real Estate Contract", "IL Residential Real Property Disclosure", "IL Lead-Based Paint Disclosure"], addenda: ["IL Mortgage Contingency", "IL Inspection Contingency", "IL Radon Disclosure"], brokerageRepresentation: "IL Disclosure of Designated Agency" },
    listing: { required: ["IL Exclusive Right to Sell Listing Agreement", "IL Property Disclosure"], addenda: [], brokerageRepresentation: "IL Disclosure of Designated Agency" },
  },
  IN: {
    offer:   { required: ["IN Purchase Agreement (Residential)", "IN Seller's Residential Real Estate Sales Disclosure"], addenda: ["IN Inspection Contingency", "IN Financing Contingency"], brokerageRepresentation: "IN Agency Relationships Disclosure" },
    listing: { required: ["IN Exclusive Right to Sell Listing", "IN Seller Disclosure"], addenda: [], brokerageRepresentation: "IN Agency Relationships Disclosure" },
  },
  IA: {
    offer:   { required: ["IA Residential Real Estate Purchase Agreement", "IA Seller Disclosure of Property Condition"], addenda: ["IA Inspection Contingency", "IA Loan Contingency"], brokerageRepresentation: "IA Consent to Dual Agency / Designated Agency" },
    listing: { required: ["IA Exclusive Right to Sell Listing Agreement", "IA Seller Disclosure"], addenda: [], brokerageRepresentation: "IA Consent to Dual Agency / Designated Agency" },
  },
  KS: {
    offer:   { required: ["KS Residential Contract for Sale of Real Estate", "KS Seller's Disclosure Statement"], addenda: ["KS Inspection Addendum", "KS Loan Contingency"], brokerageRepresentation: "KS Real Estate Brokerage Relationships Act Disclosure" },
    listing: { required: ["KS Exclusive Right to Sell Listing Agreement", "KS Seller Disclosure"], addenda: [], brokerageRepresentation: "KS Real Estate Brokerage Relationships Act Disclosure" },
  },
  KY: {
    offer:   { required: ["KY Sales Contract", "KY Seller's Disclosure of Property Condition"], addenda: ["KY Inspection Addendum", "KY Loan Contingency"], brokerageRepresentation: "KY Agency Consent Agreement" },
    listing: { required: ["KY Exclusive Right to Sell Listing", "KY Seller Disclosure"], addenda: [], brokerageRepresentation: "KY Agency Consent Agreement" },
  },
  LA: {
    offer:   { required: ["LA Residential Agreement to Buy or Sell", "LA Property Disclosure Document"], addenda: ["LA Inspection and Due Diligence Period", "LA Financing Contingency"], brokerageRepresentation: "LA Agency Disclosure Information Form" },
    listing: { required: ["LA Exclusive Right to Sell Listing Agreement", "LA Property Disclosure"], addenda: [], brokerageRepresentation: "LA Agency Disclosure Information Form" },
  },
  ME: {
    offer:   { required: ["ME Purchase and Sale Agreement", "ME Property Disclosure Statement"], addenda: ["ME Inspection Contingency", "ME Loan Contingency"], brokerageRepresentation: "ME Real Estate Brokerage Relationships Disclosure" },
    listing: { required: ["ME Exclusive Right to Sell", "ME Seller Property Disclosure"], addenda: [], brokerageRepresentation: "ME Real Estate Brokerage Relationships Disclosure" },
  },
  MD: {
    offer:   { required: ["MD Residential Contract of Sale (MAR Form 1330)", "MD Residential Property Disclosure Statement", "MD Lead Disclosure"], addenda: ["MD Inspection Contingency Addendum", "MD Financing Contingency"], brokerageRepresentation: "MD Understanding Whom Real Estate Agents Represent" },
    listing: { required: ["MD Exclusive Right to Sell Listing Agreement", "MD Property Disclosure"], addenda: [], brokerageRepresentation: "MD Understanding Whom Real Estate Agents Represent" },
  },
  MA: {
    offer:   { required: ["MA Offer to Purchase Real Estate", "MA Purchase and Sale Agreement", "MA Seller's Statement of Property Condition", "MA Lead Paint Disclosure"], addenda: ["MA Inspection Rider", "MA Mortgage Contingency Rider"], brokerageRepresentation: "MA Mandatory Real Estate Licensee-Consumer Relationship Disclosure" },
    listing: { required: ["MA Exclusive Right to Sell Listing Agreement", "MA Seller's Statement of Property Condition"], addenda: [], brokerageRepresentation: "MA Mandatory Real Estate Licensee-Consumer Relationship Disclosure" },
  },
  MI: {
    offer:   { required: ["MI Residential Buy and Sell Agreement", "MI Seller's Disclosure Statement", "MI Lead-Based Paint Disclosure"], addenda: ["MI Inspection Contingency", "MI Financing Contingency"], brokerageRepresentation: "MI Disclosure Regarding Real Estate Agency Relationships" },
    listing: { required: ["MI Exclusive Right to Sell Listing", "MI Seller Disclosure"], addenda: [], brokerageRepresentation: "MI Disclosure Regarding Real Estate Agency Relationships" },
  },
  MN: {
    offer:   { required: ["MN Purchase Agreement (Residential)", "MN Seller's Property Disclosure Statement"], addenda: ["MN Inspection Contingency Addendum", "MN Financing Addendum"], brokerageRepresentation: "MN Real Estate Agency Relationships in Residential Real Property Transactions" },
    listing: { required: ["MN Exclusive Right to Sell Listing Contract", "MN Seller Disclosure"], addenda: [], brokerageRepresentation: "MN Real Estate Agency Relationships in Residential Real Property Transactions" },
  },
  MS: {
    offer:   { required: ["MS Contract for the Sale and Purchase of Real Estate", "MS Property Condition Disclosure Statement"], addenda: ["MS Inspection Contingency", "MS Loan Contingency"], brokerageRepresentation: "MS Working with a Real Estate Broker Disclosure" },
    listing: { required: ["MS Exclusive Right to Sell", "MS Property Disclosure"], addenda: [], brokerageRepresentation: "MS Working with a Real Estate Broker Disclosure" },
  },
  MO: {
    offer:   { required: ["MO Residential Sale Contract", "MO Seller's Disclosure Statement"], addenda: ["MO Inspection Contingency", "MO Loan Contingency"], brokerageRepresentation: "MO Broker Disclosure Form" },
    listing: { required: ["MO Exclusive Right to Sell Listing Contract", "MO Seller Disclosure"], addenda: [], brokerageRepresentation: "MO Broker Disclosure Form" },
  },
  MT: {
    offer:   { required: ["MT Buy-Sell Agreement (Residential)", "MT Seller's Property Disclosure Statement"], addenda: ["MT Inspection Contingency", "MT Loan Contingency"], brokerageRepresentation: "MT Real Estate Brokerage Relationships Act Disclosure" },
    listing: { required: ["MT Exclusive Right to Sell Agreement", "MT Property Disclosure"], addenda: [], brokerageRepresentation: "MT Real Estate Brokerage Relationships Act Disclosure" },
  },
  NE: {
    offer:   { required: ["NE Uniform Residential Purchase Agreement", "NE Seller Property Condition Disclosure Statement"], addenda: ["NE Inspection Contingency", "NE Financing Contingency"], brokerageRepresentation: "NE Agency Relationships Disclosure" },
    listing: { required: ["NE Exclusive Right to Sell Listing Agreement", "NE Property Disclosure"], addenda: [], brokerageRepresentation: "NE Agency Relationships Disclosure" },
  },
  NV: {
    offer:   { required: ["NV Residential Purchase Agreement (NVAR)", "NV Seller's Real Property Disclosure", "NV Common-Interest Community Disclosure"], addenda: ["NV Inspection Contingency", "NV Loan Contingency"], brokerageRepresentation: "NV Duties Owed by a Nevada Real Estate Licensee" },
    listing: { required: ["NV Exclusive Right to Sell Listing Agreement", "NV Seller Real Property Disclosure"], addenda: [], brokerageRepresentation: "NV Duties Owed by a Nevada Real Estate Licensee" },
  },
  NH: {
    offer:   { required: ["NH Purchase and Sales Agreement (Residential)", "NH Property Condition Disclosure"], addenda: ["NH Inspection Contingency", "NH Mortgage Contingency"], brokerageRepresentation: "NH Brokerage Relationships Disclosure" },
    listing: { required: ["NH Exclusive Right to Sell", "NH Seller Disclosure"], addenda: [], brokerageRepresentation: "NH Brokerage Relationships Disclosure" },
  },
  NJ: {
    offer:   { required: ["NJ Residential Real Estate Sales Contract", "NJ Property Condition Disclosure", "NJ Lead-Based Paint Disclosure"], addenda: ["NJ Inspection Contingency", "NJ Mortgage Contingency", "NJ Attorney Review Clause"], brokerageRepresentation: "NJ Consumer Information Statement on New Jersey Real Estate Relationships" },
    listing: { required: ["NJ Exclusive Right to Sell Listing Agreement", "NJ Seller Disclosure"], addenda: [], brokerageRepresentation: "NJ Consumer Information Statement on New Jersey Real Estate Relationships" },
  },
  NM: {
    offer:   { required: ["NM Purchase Agreement (Residential)", "NM Seller's Property Disclosure"], addenda: ["NM Inspection Contingency", "NM Loan Contingency"], brokerageRepresentation: "NM Broker Duties Disclosure" },
    listing: { required: ["NM Exclusive Right to Sell Listing", "NM Seller Disclosure"], addenda: [], brokerageRepresentation: "NM Broker Duties Disclosure" },
  },
  NY: {
    offer:   { required: ["NY Residential Contract of Sale", "NY Property Condition Disclosure Statement", "NY Lead-Based Paint Disclosure"], addenda: ["NY Mortgage Contingency", "NY Inspection Contingency", "NY Attorney Review"], brokerageRepresentation: "NY Disclosure Regarding Real Estate Agency Relationship" },
    listing: { required: ["NY Exclusive Right to Sell Listing Agreement", "NY Property Condition Disclosure"], addenda: [], brokerageRepresentation: "NY Disclosure Regarding Real Estate Agency Relationship" },
  },
  NC: {
    offer:   { required: ["NCAR Form 2-T Offer to Purchase and Contract", "NC Residential Property and Owners' Association Disclosure Statement", "NC Mineral and Oil and Gas Rights Disclosure"], addenda: ["NCAR Form 2A1-T Loan Assumption Addendum", "NCAR Form 2A4-T New Construction Addendum"], brokerageRepresentation: "NC Working With Real Estate Agents Disclosure" },
    listing: { required: ["NCAR Form 101 Exclusive Right to Sell Listing Agreement", "NC Property Disclosure"], addenda: [], brokerageRepresentation: "NC Working With Real Estate Agents Disclosure" },
  },
  ND: {
    offer:   { required: ["ND Purchase Agreement", "ND Seller's Property Disclosure"], addenda: ["ND Inspection Contingency", "ND Financing Contingency"], brokerageRepresentation: "ND Agency Disclosure" },
    listing: { required: ["ND Exclusive Right to Sell Listing Agreement", "ND Property Disclosure"], addenda: [], brokerageRepresentation: "ND Agency Disclosure" },
  },
  OH: {
    offer:   { required: ["OH Residential Real Estate Contract", "OH Residential Property Disclosure Form"], addenda: ["OH Inspection Contingency", "OH Financing Contingency"], brokerageRepresentation: "OH Agency Disclosure Statement" },
    listing: { required: ["OH Exclusive Right to Sell Listing Contract", "OH Property Disclosure"], addenda: [], brokerageRepresentation: "OH Agency Disclosure Statement" },
  },
  OK: {
    offer:   { required: ["OK Uniform Contract of Sale of Real Estate", "OK Residential Property Condition Disclosure Statement"], addenda: ["OK Inspection Contingency", "OK Financing Addendum"], brokerageRepresentation: "OK Real Estate Information Brochure" },
    listing: { required: ["OK Exclusive Right to Sell Listing Agreement", "OK Property Disclosure"], addenda: [], brokerageRepresentation: "OK Real Estate Information Brochure" },
  },
  OR: {
    offer:   { required: ["OR Residential Real Estate Sale Agreement", "OR Seller's Property Disclosure Statement"], addenda: ["OR Inspection Contingency", "OR Loan Contingency"], brokerageRepresentation: "OR Initial Agency Disclosure Pamphlet" },
    listing: { required: ["OR Exclusive Right to Sell Listing Agreement", "OR Property Disclosure"], addenda: [], brokerageRepresentation: "OR Initial Agency Disclosure Pamphlet" },
  },
  PA: {
    offer:   { required: ["PA Agreement of Sale (PAR Form ASR)", "PA Seller's Property Disclosure Statement", "PA Lead-Based Paint Disclosure"], addenda: ["PA Inspection Contingency Addendum", "PA Mortgage Contingency"], brokerageRepresentation: "PA Consumer Notice (PAR Form CN)" },
    listing: { required: ["PA Exclusive Right to Sell Listing Contract (PAR Form LA)", "PA Seller's Property Disclosure"], addenda: [], brokerageRepresentation: "PA Consumer Notice" },
  },
  RI: {
    offer:   { required: ["RI Residential Real Estate Purchase and Sale Agreement", "RI Real Estate Sales Disclosure"], addenda: ["RI Inspection Contingency", "RI Mortgage Contingency"], brokerageRepresentation: "RI Mandatory Disclosure to Buyers and Sellers" },
    listing: { required: ["RI Exclusive Right to Sell Listing Agreement", "RI Property Disclosure"], addenda: [], brokerageRepresentation: "RI Mandatory Disclosure to Buyers and Sellers" },
  },
  SC: {
    offer:   { required: ["SC Residential Contract of Sale", "SC Residential Property Condition Disclosure Statement"], addenda: ["SC Inspection Contingency", "SC Loan Contingency"], brokerageRepresentation: "SC Disclosure of Brokerage Services" },
    listing: { required: ["SC Exclusive Right to Sell Listing Agreement", "SC Property Disclosure"], addenda: [], brokerageRepresentation: "SC Disclosure of Brokerage Services" },
  },
  SD: {
    offer:   { required: ["SD Purchase Agreement", "SD Seller's Property Condition Disclosure"], addenda: ["SD Inspection Contingency", "SD Financing Contingency"], brokerageRepresentation: "SD Real Estate Brokerage Relationships Disclosure" },
    listing: { required: ["SD Exclusive Right to Sell Listing", "SD Property Disclosure"], addenda: [], brokerageRepresentation: "SD Real Estate Brokerage Relationships Disclosure" },
  },
  TN: {
    offer:   { required: ["TN Purchase and Sale Agreement (TAR Form RF401)", "TN Residential Property Condition Disclosure"], addenda: ["TN Inspection Contingency", "TN Loan Contingency"], brokerageRepresentation: "TN Working With a Real Estate Professional Disclosure" },
    listing: { required: ["TN Exclusive Right to Sell Listing Agreement (TAR Form RF103)", "TN Property Disclosure"], addenda: [], brokerageRepresentation: "TN Working With a Real Estate Professional Disclosure" },
  },
  TX: {
    offer:   { required: ["TAR 1601 - One to Four Family Contract", "TAR 1906 - Lead-Based Paint Disclosure", "TAR 2301 - Information About Brokerage Services"], addenda: ["TAR 1902 - Third Party Financing Addendum", "TAR 1903 - Addendum for Sale of Other Property", "TAR 1904 - Addendum for Property Subject to Mandatory HOA", "TAR 1907 - Addendum for Coastal Area Property"], brokerageRepresentation: "TAR 2301 - Information About Brokerage Services" },
    listing: { required: ["TAR 1101 - Residential Real Estate Listing Agreement", "TAR 2501 - Seller's Disclosure Notice", "TAR 2301 - Information About Brokerage Services"], addenda: ["TAR 2204 - Listing Agreement Amendment"], brokerageRepresentation: "TAR 2301 - Information About Brokerage Services" },
  },
  UT: {
    offer:   { required: ["UT Real Estate Purchase Contract for Residential Property", "UT Seller's Property Condition Disclosure"], addenda: ["UT Inspection Contingency Addendum", "UT Financing Contingency"], brokerageRepresentation: "UT Agency Disclosure" },
    listing: { required: ["UT Exclusive Right to Sell Listing Agreement", "UT Property Disclosure"], addenda: [], brokerageRepresentation: "UT Agency Disclosure" },
  },
  VT: {
    offer:   { required: ["VT Purchase and Sale Contract", "VT Real Estate Listing Disclosure"], addenda: ["VT Inspection Contingency", "VT Mortgage Contingency"], brokerageRepresentation: "VT Mandatory Disclosure" },
    listing: { required: ["VT Exclusive Right to Sell Listing Agreement", "VT Seller Disclosure"], addenda: [], brokerageRepresentation: "VT Mandatory Disclosure" },
  },
  VA: {
    offer:   { required: ["VA Residential Sales Contract (VAR Form 600)", "VA Residential Property Disclosure Statement"], addenda: ["VAR Inspection Contingency", "VAR Loan Contingency"], brokerageRepresentation: "VA Disclosure of Brokerage Relationship" },
    listing: { required: ["VA Exclusive Right to Sell Listing Agreement (VAR Form 720)", "VA Property Disclosure"], addenda: [], brokerageRepresentation: "VA Disclosure of Brokerage Relationship" },
  },
  WA: {
    offer:   { required: ["WA NWMLS Form 21 Residential Real Estate Purchase and Sale Agreement", "WA Form 17 Seller's Disclosure Statement"], addenda: ["WA Form 35 Inspection Addendum", "WA Form 22A Financing Addendum"], brokerageRepresentation: "WA Form 41A Real Estate Agency Disclosure" },
    listing: { required: ["WA NWMLS Form 1A Exclusive Right to Sell Listing Agreement", "WA Form 17 Seller Disclosure"], addenda: [], brokerageRepresentation: "WA Form 41A Real Estate Agency Disclosure" },
  },
  WV: {
    offer:   { required: ["WV Real Estate Sales Contract", "WV Property Condition Disclosure"], addenda: ["WV Inspection Contingency", "WV Loan Contingency"], brokerageRepresentation: "WV Agency Disclosure Form" },
    listing: { required: ["WV Exclusive Right to Sell Listing Agreement", "WV Seller Disclosure"], addenda: [], brokerageRepresentation: "WV Agency Disclosure Form" },
  },
  WI: {
    offer:   { required: ["WI WB-11 Residential Offer to Purchase", "WI Real Estate Condition Report"], addenda: ["WI WB-40 Amendment to Offer to Purchase", "WI WB-41 Notice Relating to Offer to Purchase"], brokerageRepresentation: "WI Disclosure to Customers" },
    listing: { required: ["WI WB-1 Residential Listing Contract - Exclusive Right to Sell", "WI Property Condition Report"], addenda: [], brokerageRepresentation: "WI Disclosure to Customers" },
  },
  WY: {
    offer:   { required: ["WY Real Estate Purchase Contract", "WY Seller's Property Disclosure"], addenda: ["WY Inspection Contingency", "WY Loan Contingency"], brokerageRepresentation: "WY Real Estate Brokerage Disclosure" },
    listing: { required: ["WY Exclusive Right to Sell Listing Agreement", "WY Property Disclosure"], addenda: [], brokerageRepresentation: "WY Real Estate Brokerage Disclosure" },
  },
  DC: {
    offer:   { required: ["DC Regional Sales Contract (GCAAR/MAR Form 1301)", "DC Property Disclosure", "DC Lead-Based Paint Disclosure"], addenda: ["DC Inspection Contingency", "DC Financing Contingency"], brokerageRepresentation: "DC Consumer Information Statement" },
    listing: { required: ["DC Exclusive Right to Sell Listing Agreement", "DC Property Disclosure"], addenda: [], brokerageRepresentation: "DC Consumer Information Statement" },
  },
}

/** All US states + DC. Used for validation. */
export const ALL_US_STATES = Object.keys(STATE_FORMS) as Array<keyof typeof STATE_FORMS>

/**
 * Resolve a state's form bundle for a transaction type.
 * Throws if the state code is not recognized — there is no DEFAULT
 * because the property address dictates the forms.
 */
export function getStateForms(
  state: string,
  type: "offer" | "listing"
): StateFormBundle {
  const code = state?.trim().toUpperCase()
  const set = STATE_FORMS[code as keyof typeof STATE_FORMS]
  if (!set) {
    throw new Error(`Unrecognized US state code: "${state}". Forms unavailable — verify the property address.`)
  }
  return set[type]
}

/**
 * Resolve the brokerage representation form for a state.
 * This is the agency-disclosure / consumer-information form that
 * must be signed at engagement (separate from the transaction forms).
 */
export function getBrokerageRepresentationForm(state: string): string {
  return getStateForms(state, "listing").brokerageRepresentation
}
