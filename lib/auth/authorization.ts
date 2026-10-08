// NO DIRECTIVE (2026-09-03, lane R3-A). The module-level "use server" that stood
// here published nothing: this shim's only export is a TYPE (below), erased at
// compile time, and its sole importer — lib/auth/index.ts:29 — is type-only
// too. A `"use server"` module with no session gate is the shape
// scripts/lib-use-server-census.ts counts, so the directive is dropped rather
// than left reading as a server-action module. The tombstones below are kept
// VERBATIM: their "This file is `"use server"`" describes the file as it was
// when those deletions were ruled, which is what a tombstone is for.
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
