"use server"
// Compatibility shim — logic has moved to lib/security/authorization
// TOMBSTONE: requireSubscriptionAdmin / isSubscriptionAdmin /
// getSubscriptionAdmin / getCurrentUserSubscriptionContext are deleted, and the
// SubscriptionContext type with them. This file is `"use server"`, so each of
// those was a PUBLIC HTTP ENDPOINT (CLAUDE.md §4) with zero callers.
// Survivor: app/actions/billing.ts:46 requireTenantBillingAdmin.
// Reasoning + the live RLS reader: lib/security/authorization.ts:39.
// TOMBSTONE (ruling 1, 2026-08-24): the requireSuperAdmin / isSuperAdmin
// re-exports are gone with the functions themselves — zero callers, and a value
// re-export from a `"use server"` file is a public HTTP endpoint.
// Survivor: lib/auth/platform-guard.ts:63 requireSuperadmin, over the one
// definition at lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity.
// Reasoning: lib/security/authorization.ts:3.
export type { AuthorizedUser } from '@/lib/security'
