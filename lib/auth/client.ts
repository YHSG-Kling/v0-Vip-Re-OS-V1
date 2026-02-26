/**
 * lib/auth/client.ts — CLIENT-ONLY barrel.
 *
 * Safe to import in Client Components ("use client").
 * Do NOT import from this file in Server Components or Route Handlers.
 *
 * For server-side auth utilities (getUserBrokerages, hasCapability, etc.)
 * import from "@/lib/auth" instead.
 *
 * Canonical import paths for auth in Client Components:
 *   import { useAuth }      from "@/lib/auth/client"  — hook
 *   import { AuthProvider } from "@/lib/auth/client"  — provider (for providers.tsx)
 */

// ─── CANONICAL HOOK ───────────────────────────────────────────────────────────
export { useAuth } from "./useAuth"
export type { AuthState } from "./useAuth"

// ─── PROVIDER ─────────────────────────────────────────────────────────────────
// AuthProvider lives in contexts/AuthContext.tsx as a thin wrapper that uses
// the canonical useAuth hook. Once migration is complete it can be inlined here.
export { AuthProvider } from "@/contexts/AuthContext"

// ─── CLIENT-SIDE PERMISSIONS ──────────────────────────────────────────────────
export type { UserRole } from "./permissions-client"
export { getClientUserRole, clientHasCapability, clientIsAdmin } from "./permissions-client"
