// Single source of truth for the canonical "Lifetime Customer" contact type.
// Migration 433-rename-past-client-to-lifetime-customer.sql backfills all DB rows.
// This constant is now 'lifetime_customer' — the canonical value going forward.
export const LIFETIME_CUSTOMER_TYPE = "lifetime_customer" as const

// Audience-segment string used by app-layer filters (campaigns, automations, AI prompts).
// This is NOT a DB-enforced enum — safe to use the new term immediately.
export const LIFETIME_CUSTOMER_SEGMENT = "lifetime_customers" as const

/** Canonical test for "is this a lifetime / past client" by contact_type. Migration 433 renamed
 *  past_client → lifetime_customer; scattered `contact_type === 'lifetime'` checks drifted and silently
 *  treated canonical past clients as buyers (wrong reel/voicemail/portal persona). Use this everywhere a
 *  contact_type is mapped to a persona. Matches the canonical value + legacy aliases for un-migrated rows. */
export function isLifetimeCustomerType(contactType: string | null | undefined): boolean {
  switch ((contactType ?? "").toLowerCase()) {
    case "lifetime_customer":
    case "lifetime":
    case "past_client":
    case "past_seller":
      return true
    default:
      return false
  }
}
