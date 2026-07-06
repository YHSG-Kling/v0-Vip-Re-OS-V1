// lib/privacy/contact-pii-redaction.ts
// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE contact PII redaction for a right-to-be-forgotten (CCPA §1798.105 / GDPR Art. 17)
// erasure. The original anonymization redacted only first/last/email/phone/notes — leaving
// HIGHLY sensitive PII intact: the driver's-license IMAGE (dl_image_url), legal name, full
// mailing address, financial bands, court/public records, social handles, and enrichment blobs.
// A de-identification that leaves the DL image + legal name is not compliant. This is the ONE
// canonical PII column set for a contact so the erasure and any future audit can't drift.
//
// KEPT (lawful retention / referential integrity): id, brokerage_id, agent_id, created_at,
// contact_type/buyer_stage/status (de-identified state), transaction linkage, privacy_anonymized_*.

/** Columns nulled on erasure (nullable PII — addresses, financial, social, enrichment, identifiers). */
export const CONTACT_PII_NULL_COLUMNS = [
  // extended names
  "legal_first_name", "legal_middle_name", "legal_last_name", "legal_name_source", "legal_name_verified_at",
  // secondary contact
  "phone_secondary", "phone_digits", "phone_secondary_type", "avatar_url", "dl_image_url",
  // addresses
  "address", "city", "state", "zip_code", "mailing_address", "mailing_city", "mailing_state", "mailing_zip",
  // demographics / sensitive
  "birthday", "home_anniversary", "gender", "marital_status", "occupation", "education_level",
  "household_income", "age_range", "credit_score_band", "credit_status",
  // records / enrichment (free-form PII)
  "court_records", "public_records", "enrichment_profile", "property_records", "social_handles", "metadata",
  "qualification_summary", "isa_handoff_brief", "referral_approach",
  // social profiles
  "facebook_url", "instagram_url", "linkedin_url", "twitter_url",
  // external identifiers linking back to the person
  "ghl_contact_id", "peopledata_id", "embed_widget_id",
] as const

/** Build the full redaction patch. Names become non-null redaction markers (the column is often
 *  NOT NULL); everything in CONTACT_PII_NULL_COLUMNS is nulled; privacy_anonymized_* is stamped. */
export function contactRedactionPatch(auditHash: string, requestId: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    first_name: auditHash,
    last_name: "[deleted]",
    email: `${auditHash}@deleted.local`,
    phone: null,
    notes: null,
    privacy_anonymized_at: new Date().toISOString(),
    privacy_anonymized_reason: "DSAR " + requestId,
  }
  for (const col of CONTACT_PII_NULL_COLUMNS) patch[col] = null
  return patch
}

/** The full set of PII fields an erasure MUST clear (for the completeness test). */
export function redactedContactFields(): string[] {
  return Array.from(new Set(["first_name", "last_name", "email", "phone", "notes", ...CONTACT_PII_NULL_COLUMNS]))
}
