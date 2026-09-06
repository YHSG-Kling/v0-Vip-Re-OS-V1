'use client'

/**
 * lib/auth/useAuth.ts — CANONICAL auth hook.
 *
 * Single source of truth for client-side authentication state.
 * Import via "@/lib/auth/client" in Client Components.
 *
 * Returns a unified shape that satisfies all existing consumers:
 *   - `user`        — raw Supabase auth user (or demo User shape for non-Supabase flows)
 *   - `role`        — active canonical UserRole string (e.g. 'agent', 'broker', 'tc')
 *   - `userContext` — rich UserContext for permission checks (lib/security)
 *   - `loading`     — async loading state (alias: `isLoading`)
 *   - `isLoading`   — same as `loading` (backward compat for AuthContext consumers)
 *   - `error`       — any auth error
 *   - `userPersona` — contact-only persona string (e.g. 'buyer', 'seller')
 *   - `signIn`      — demo sign-in (email + role)
 *   - `signOut`     — sign out
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isSupabaseConfigured } from '@/services/supabase'
import { toCanonicalRoleOrDefault } from '@/lib/security'
import type { UserContext, UserRole } from '@/lib/security'
import { resolvePlatformRoleIdentity } from '@/lib/platform/platform-staff-roster'
import type { User } from '@/types'

export interface AuthState {
  /** Raw Supabase auth user, or a demo User object when Supabase is not configured. */
  user: User | null
  /** Active canonical role for the signed-in user. Defaults to 'agent'. */
  role: UserRole
  /** Rich context object used by permission guards. Null when not signed in. */
  userContext: UserContext | null
  /** True while session is being resolved on mount. */
  loading: boolean
  /** Alias for `loading` — kept for backward compatibility with AuthContext consumers. */
  isLoading: boolean
  /** Any error that occurred during session resolution. */
  error: Error | null
  /** Contact-only persona string (e.g. 'buyer', 'seller'). Null for non-contact roles. */
  userPersona: string | null
  /** Demo sign-in — sets user + role locally without a real session. */
  signIn: (email: string, role: UserRole) => Promise<void>
  /** Sign out — calls Supabase signOut when configured, then clears local state. */
  signOut: () => Promise<void>
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<UserRole>('agent')
  const [userContext, setUserContext] = useState<UserContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [userPersona, setUserPersona] = useState<string | null>(null)

  // Stable supabase client reference
  const supabase = useRef(isSupabaseConfigured() ? createClient() : null)

  // ─── Build UserContext from a Supabase session ────────────────────────────
  const resolveSession = useCallback(async () => {
    const client = supabase.current
    if (!client) {
      setLoading(false)
      return
    }

    // 8-second hard timeout — guarantees loading always terminates.
    const timeoutId = setTimeout(() => {
      setError(new Error('Auth session timed out. Please try again.'))
      setLoading(false)
    }, 8000)

    try {
      const { data: { user: authUser } } = await client.auth.getUser()

      if (!authUser) {
        setUser(null)
        setUserContext(null)
        setLoading(false)
        return
      }

      // Fetch specific columns only (not *) to avoid pulling sensitive fields.
      // Use maybeSingle() so a missing `users` row returns null (no PGRST116 throw).
      // Source priority: users.user_type > role_assignments.role > agents row > auth metadata > 'agent'
      const [{ data: userData }, { data: rolesData }] = await Promise.all([
        // platform_role: the ONLY column that identifies platform staff on the
        // live database (CLAUDE.md §4 — user_type='superadmin' has no live row).
        // Without it the client could never tell staff from the tenant seat
        // they were created as; L3's upstream flag, wave 18-19.
        client.from('users')
          .select('id, first_name, last_name, brokerage_id, user_type, platform_role, team_id')
          .eq('id', authUser.id)
          .maybeSingle(),
        client.from('user_role_assignments')
          .select('role, brokerage_id, team_id, agent_id, vendor_id')
          .eq('user_id', authUser.id),
      ])

      // If users row is missing, check the agents table as a fallback
      let agentFallback: { id: string; brokerage_id: string } | null = null
      if (!userData) {
        const { data: agentRow } = await client
          .from('agents')
          .select('id, brokerage_id')
          .eq('user_id', authUser.id)
          .maybeSingle()
        agentFallback = agentRow
      }

      // Source priority:
      //  1. users.user_type   (DB — most authoritative, but requires RLS to allow read)
      //  2. user_role_assignments.role (DB — explicit role grant)
      //  3. auth.user_metadata.user_type (set at invite/signup time — no RLS needed)
      //  4. agents row exists → 'agent'
      //  5. hard fallback → 'agent'
      const metaRole = (authUser.user_metadata?.user_type as string | undefined)
        || (authUser.user_metadata?.role as string | undefined)

      const rawRole: string =
        userData?.user_type ||
        rolesData?.[0]?.role ||
        metaRole ||
        (agentFallback ? 'agent' : null) ||
        'agent'
      
      const canonicalRole = toCanonicalRoleOrDefault(rawRole, 'agent')
      const persona: string | null = authUser.user_metadata?.contact_persona ?? null

      // THE UNION, not a replacement.
      //
      // This used to be "grants if any, ELSE user_type" — so the moment a user
      // was given a single role grant, the role on their users row STOPPED
      // counting. An account whose user_type is 'admin' and who is then granted
      // 'agent' silently lost admin. Both are real statements about the same
      // person: users.user_type is the seat they were created as, and each
      // user_role_assignments row is a business role ASSIGNED to them. The owner's
      // model is that one user wears several hats, so the answer is every hat.
      //
      // Deduped, and ORDER-STABLE by construction (user_type first, then grants
      // in the order returned) — but nothing downstream may depend on that order:
      // getNavigationForRole re-sorts into its own fixed precedence precisely
      // because the grant rows themselves come back unordered.
      const grantRoles = (rolesData ?? []).map((r: Record<string, unknown>) =>
        toCanonicalRoleOrDefault(r.role as string, 'agent'),
      )
      const resolvedRoles = Array.from(new Set([canonicalRole, ...grantRoles]))

      // Platform staff identity — ADDITIVE, beside roles, never inside them.
      // Same resolver as the server gates (lib/auth/platform-guard.ts →
      // resolvePlatformRoleIdentity), so client and server can never disagree
      // about who is staff. Deliberately NOT folded into resolvedRoles: role
      // resolution (and therefore sidebar/palette) is unchanged — the live
      // superadmin holds user_type='admin' and keeps the admin workspace.
      const platformRole = resolvePlatformRoleIdentity(
        (userData as { user_type?: string | null } | null)?.user_type ?? null,
        (userData as { platform_role?: string | null } | null)?.platform_role ?? null,
      )

      const ctx: UserContext = {
        id: authUser.id,
        email: authUser.email ?? '',
        firstName: userData?.first_name ?? (authUser.user_metadata?.first_name as string | undefined) ?? '',
        lastName: userData?.last_name ?? (authUser.user_metadata?.last_name as string | undefined) ?? '',
        roles: resolvedRoles,
        brokerageId: rolesData?.[0]?.brokerage_id ?? userData?.brokerage_id ?? agentFallback?.brokerage_id,
        teamId: rolesData?.[0]?.team_id ?? userData?.team_id,
        agentId: rolesData?.[0]?.agent_id ?? agentFallback?.id ?? undefined,
        vendorId: rolesData?.[0]?.vendor_id ?? undefined,
        platformRole,
      }

      const domainUser: User = {
        id: authUser.id,
        email: authUser.email,
        name: `${userData?.first_name ?? ''} ${userData?.last_name ?? ''}`.trim()
          || (authUser.user_metadata?.full_name as string | undefined)
          || (authUser.user_metadata?.name as string | undefined)
          || authUser.email?.split('@')[0]
          || 'User',
        role: canonicalRole,
      }

      setUser(domainUser)
      setRole(canonicalRole)
      setUserContext(ctx)
      setUserPersona(persona)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Auth error'))
      // Even on error, try to set a minimal context from the Supabase auth user
      // so the dashboard can redirect instead of spinning indefinitely.
      try {
        const client = supabase.current
        if (client) {
          const { data: { user: authUser } } = await client.auth.getUser()
          if (authUser) {
            const fallbackRole = toCanonicalRoleOrDefault(
              (authUser.user_metadata?.user_type as string | undefined) ?? 'agent',
              'agent'
            )
            const fallbackUser: User = {
              id: authUser.id,
              email: authUser.email,
              name: authUser.email?.split('@')[0] ?? 'User',
              role: fallbackRole,
            }
            setUser(fallbackUser)
            setRole(fallbackRole)
            setUserContext({
              id: authUser.id,
              email: authUser.email ?? '',
              firstName: '',
              lastName: '',
              roles: [fallbackRole],
            })
          }
        }
      } catch {
        // ignore secondary error — loading will still be cleared below
      }
    } finally {
      clearTimeout(timeoutId)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const client = supabase.current

    // One-time cleanup of the deprecated Zustand auth-storage persist key
    // (from stores/authStore.tsx which has been superseded by this hook).
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth-storage')
    }

    // If Supabase is not configured (dev/demo mode), just stop loading immediately.
    if (!client) {
      setLoading(false)
      return
    }

    let mounted = true

    resolveSession().then(() => {
      if (!mounted) return
    })

    const { data: { subscription } } = client.auth.onAuthStateChange((_event: unknown, session: unknown) => {
      if (!mounted) return
      if (!(session as any)?.user) {
        setUser(null)
        setUserContext(null)
        setUserPersona(null)
        setRole('agent')
        setLoading(false)
      } else {
        resolveSession()
      }
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [resolveSession])

  // ─── Demo sign-in (no Supabase session required) ─────────────────────────
  const signIn = useCallback(async (email: string, selectedRole: UserRole) => {
    const canonicalRole = toCanonicalRoleOrDefault(selectedRole, 'agent')
    const persona: string | null =
      canonicalRole === 'contact'
        ? email.includes('seller') ? 'seller'
          : email.includes('investor') ? 'investor'
          : 'buyer'
        : null

    const demoUser: User = {
      id: 'demo-user',
      email,
      name: email.split('@')[0],
      role: canonicalRole,
      ownsProperty: email.includes('investor') || email.includes('relo') || canonicalRole === 'contact',
    }

    setUser(demoUser)
    setRole(canonicalRole)
    setUserPersona(persona)
    setUserContext({
      id: 'demo-user',
      email,
      firstName: email.split('@')[0],
      lastName: '',
      roles: [canonicalRole],
    })
  }, [])

  // ─── Sign out ─────────────────────────────────────────────────────────────
  const signOut = useCallback(async () => {
    const client = supabase.current
    if (client) {
      try {
        await client.auth.signOut()
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          console.error('Sign out error:', err)
        }
      }
    }
    setUser(null)
    setRole('agent')
    setUserContext(null)
    setUserPersona(null)
  }, [])

  return {
    user,
    role,
    userContext,
    loading,
    isLoading: loading, // backward-compat alias
    error,
    userPersona,
    signIn,
    signOut,
  }
}
