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
 *   import { useAuth }      from "@/lib/auth/client"  — context-backed hook
 *   import { AuthProvider } from "@/lib/auth/client"  — provider
 */

// ─── CANONICAL CONTEXT ────────────────────────────────────────────────────────
// AuthProvider owns the single canonical auth subscription for the app.
// Consumers must read from that provider instead of instantiating lib/auth/useAuth
// directly; otherwise every component creates its own Supabase auth listener and
// session resolver, which can cascade into repeated renders/auth loops.
export { AuthProvider, useAuth } from "@/contexts/AuthContext"
export type { AuthState } from "./useAuth"

// ─── CLIENT-SIDE PERMISSIONS ──────────────────────────────────────────────────
export type { UserRole } from "./permissions-client"
export { getClientUserRole, clientHasCapability, clientIsAdmin } from "./permissions-client"
