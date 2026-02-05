'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { UserContext, UserType } from '@/app/types/roles'

interface UseAuthReturn {
  user: any | null
  userContext: UserContext | null
  loading: boolean
  error: Error | null
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<any | null>(null)
  const [userContext, setUserContext] = useState<UserContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    async function getUser() {
      try {
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
        
        if (authError || !authUser) {
          console.log('[v0] No authenticated user')
          setLoading(false)
          return
        }

        // Fetch user data from public.users table
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('*, brokerages(id, name), teams(id, name)')
          .eq('id', authUser.id)
          .single()

        if (userError) {
          console.error('[v0] Error fetching user data:', userError)
          setError(new Error('Failed to fetch user data'))
          setLoading(false)
          return
        }

        if (!userData) {
          console.log('[v0] User data not found in database')
          setLoading(false)
          return
        }

        const context: UserContext = {
          id: authUser.id,
          email: authUser.email || userData.email || '',
          first_name: userData.first_name || '',
          last_name: userData.last_name || '',
          user_type: userData.user_type as UserType || 'contact',
          brokerage_id: userData.brokerage_id,
          team_id: userData.team_id,
          brokerages: userData.brokerages,
          teams: userData.teams,
        }

        console.log('[v0] User context loaded:', context)
        setUser(authUser)
        setUserContext(context)
      } catch (err) {
        console.error('[v0] Auth error:', err)
        setError(err instanceof Error ? err : new Error('Auth error'))
      } finally {
        setLoading(false)
      }
    }

    getUser()

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) {
        console.log('[v0] Auth session ended')
        setUser(null)
        setUserContext(null)
      } else {
        console.log('[v0] Auth state changed, reloading user')
        getUser()
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [supabase, router])

  return { user, userContext, loading, error }
}
