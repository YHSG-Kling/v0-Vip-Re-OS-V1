"use client"

/**
 * contexts/AuthContext.tsx — BACKWARD-COMPAT SHIM.
 *
 * This file is a thin wrapper kept alive so that existing imports of
 *   import { useAuth }      from "@/contexts/AuthContext"
 *   import { AuthProvider } from "@/contexts/AuthContext"
 * continue to work without changes during incremental migration.
 *
 * DO NOT add new logic here.
 * Canonical auth lives in: lib/auth/useAuth.ts
 * Canonical import path:   "@/lib/auth/client"
 *
 * Migration checklist (update each consumer and delete this file when done):
 *   - app/components/providers.tsx          ✓ migrated to @/lib/auth/client
 *   - app/components/AI/*                   → migrate to @/lib/auth/client
 *   - app/components/features/ai/*          → migrate to @/lib/auth/client
 *   - app/components/utilities/voice/*      → migrate to @/lib/auth/client
 *   - app/components/shared/compliance/*    → migrate to @/lib/auth/client
 *   - app/dashboard/**                      → migrate to @/lib/auth/client
 *   - hooks/use-contact-dashboard.ts        → migrate to @/lib/auth/client
 */

import type React from "react"
import { createContext, useContext } from "react"
// Import directly from the hook file to avoid a circular barrel reference.
import { useAuth as useCanonicalAuth } from "../lib/auth/useAuth"
import type { AuthState } from "../lib/auth/useAuth"

// ─── Context (thin pass-through) ─────────────────────────────────────────────
// The context is kept solely to allow AuthProvider to wrap the tree and satisfy
// any consumers that call useAuth() via context rather than the hook directly.
// Its value is populated by the canonical hook.
const AuthContext = createContext<AuthState | undefined>(undefined)

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const auth = useCanonicalAuth()
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}

/**
 * @deprecated Import from "@/lib/auth/client" instead.
 * Kept for backward compatibility during incremental migration.
 */
export const useAuth = (): AuthState => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
