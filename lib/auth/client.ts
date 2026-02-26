/**
 * lib/auth/client.ts — CLIENT-ONLY barrel.
 *
 * Safe to import in Client Components ("use client").
 * Do NOT import from this file in Server Components or Route Handlers.
 *
 * For server-side auth utilities (getUserBrokerages, hasCapability, etc.)
 * import from "@/lib/auth" instead.
 */

// ─── CLIENT HOOK ──────────────────────────────────────────────────────────────
export { useAuth } from "./useAuth"

// ─── CLIENT-SIDE PERMISSIONS ──────────────────────────────────────────────────
export type { UserRole } from "./permissions-client"
export { getClientUserRole, clientHasCapability, clientIsAdmin } from "./permissions-client"
