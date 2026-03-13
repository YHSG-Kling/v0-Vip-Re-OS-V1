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

    try {
      const { data: { user: authUser } } = await client.auth.getUser()

      if (!authUser) {
        setUser(null)
        setUserContext(null)
        setLoading(false)
        return
      }

      // Fetch extended profile + roles in parallel
      const [{ data: userData }, { data: rolesData }] = await Promise.all([
        client.from('users').select('*').eq('id', authUser.id).single(),
        client.from('user_role_assignments').select('role, brokerage_id, team_id, agent_id, vendor_id').eq('user_id', authUser.id),
      ])

      const rawRole: string = authUser.user_metadata?.user_type
        || rolesData?.[0]?.role
        || 'agent'

      const canonicalRole = toCanonicalRoleOrDefault(rawRole, 'agent')
      const persona: string | null = authUser.user_metadata?.contact_persona ?? null

      const ctx: UserContext = {
        id: authUser.id,
        email: authUser.email ?? '',
        firstName: userData?.first_name ?? '',
        lastName: userData?.last_name ?? '',
        roles: rolesData && rolesData.length > 0
          ? rolesData.map((r: Record<string, unknown>) =>
              toCanonicalRoleOrDefault(r.role as string, 'agent')
            )
          : [canonicalRole],
        brokerageId: rolesData?.[0]?.brokerage_id ?? userData?.brokerage_id,
        teamId: rolesData?.[0]?.team_id ?? userData?.team_id,
        agentId: rolesData?.[0]?.agent_id ?? undefined,
        vendorId: rolesData?.[0]?.vendor_id ?? undefined,
      }

      const domainUser: User = {
        id: authUser.id,
        email: authUser.email,
        name: userData?.full_name
          || `${userData?.first_name ?? ''} ${userData?.last_name ?? ''}`.trim()
          || authUser.user_metadata?.full_name
          || 'User',
        role: canonicalRole,
      }

      setUser(domainUser)
      setRole(canonicalRole)
      setUserContext(ctx)
      setUserPersona(persona)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Auth error'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const client = supabase.current

    // If Supabase is not configured (dev/demo mode), just stop loading immediately.
    if (!client) {
      setLoading(false)
      return
    }

    let mounted = true

    resolveSession().then(() => {
      if (!mounted) return
    })

    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return
      if (!session?.user) {
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
