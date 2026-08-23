"use server"
// Compatibility shim — logic has moved to lib/security/authorization
// TOMBSTONE: requireSubscriptionAdmin / isSubscriptionAdmin /
// getSubscriptionAdmin / getCurrentUserSubscriptionContext are deleted, and the
// SubscriptionContext type with them. This file is `"use server"`, so each of
// those was a PUBLIC HTTP ENDPOINT (CLAUDE.md §4) with zero callers.
// Survivor: app/actions/billing.ts:46 requireTenantBillingAdmin.
// Reasoning + the live RLS reader: lib/security/authorization.ts:39.
export {
  requireSuperAdmin,
  isSuperAdmin,
} from '@/lib/security'
export type { AuthorizedUser } from '@/lib/security'
