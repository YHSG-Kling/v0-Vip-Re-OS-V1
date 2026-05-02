// Single source of truth for the canonical "Lifetime Customer" contact type.
// The DB enum currently still says 'past_client' until the Phase 1B migration
// flips it to 'lifetime_customer'. Application code should reference this
// constant instead of inlining the literal so the DB rename is a one-line change here.
export const LIFETIME_CUSTOMER_TYPE = "past_client" as const

// Audience-segment string used by app-layer filters (campaigns, automations, AI prompts).
// This is NOT a DB-enforced enum — safe to use the new term immediately.
export const LIFETIME_CUSTOMER_SEGMENT = "lifetime_customers" as const
