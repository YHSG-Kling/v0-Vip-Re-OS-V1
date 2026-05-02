// Single source of truth for the canonical "Lifetime Customer" contact type.
// Migration 433-rename-past-client-to-lifetime-customer.sql backfills all DB rows.
// This constant is now 'lifetime_customer' — the canonical value going forward.
export const LIFETIME_CUSTOMER_TYPE = "lifetime_customer" as const

// Audience-segment string used by app-layer filters (campaigns, automations, AI prompts).
// This is NOT a DB-enforced enum — safe to use the new term immediately.
export const LIFETIME_CUSTOMER_SEGMENT = "lifetime_customers" as const
