// lib/enrichment/identifier-guard.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE, and deliberately free of `server-only` so the guard script can import it.
// Re-exported from lib/enrichment/contact-enrichment-core.ts, which is where
// callers should get it.
//
/**
 * Placeholder names the intake paths write when they have no real identity yet.
 * The social-DM webhooks (meta / whatsapp / twitter / linkedin) create a
 * `{ first_name: "Social", last_name: "Lead" }` stub so an inbound message has
 * somewhere to land — there is no email, no phone, and no actual name.
 */
const PLACEHOLDER_NAMES = new Set(["social", "lead", "unknown", "ad", "guest", "anonymous", ""])

/**
 * PURE. Is there enough here for a provider to match on?
 *
 * Both vendors key on identity: PeopleData needs a name, email or phone, and the
 * OSINT search builds its query from `${firstName} ${lastName}`. Sending
 * "Social Lead" with no email and no phone buys a PeopleData record that matches
 * nobody and six ZenRows scrapes of a search for a person who does not exist —
 * about $0.16 for a guaranteed miss, per stub, forever (the row never gets an
 * `enriched_at`, so the nightly sweep would retry it every single night).
 *
 * The queue drain already refuses on the same grounds ("No identifier
 * (first_name, phone, or email) available for skip trace"); this is the same
 * rule for the direct path, made stricter because a PLACEHOLDER first name is
 * not an identifier even though it is non-empty.
 */
export function hasUsableIdentifier(contact: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
}): boolean {
  if (contact.email?.trim()) return true
  if (contact.phone?.trim()) return true
  const first = (contact.first_name ?? "").trim().toLowerCase()
  const last = (contact.last_name ?? "").trim().toLowerCase()
  // A real name needs BOTH parts, and neither may be a known placeholder.
  if (!first || !last) return false
  return !PLACEHOLDER_NAMES.has(first) && !PLACEHOLDER_NAMES.has(last)
}

