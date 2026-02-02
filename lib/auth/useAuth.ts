'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { UserContext, UserRole } from '@/app/types/roles'

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
        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) {
          setLoading(false)
          return
        }

        const { data: userData } = await supabase.from('users').select('*').eq('id', authUser.id).single()
        const { data: rolesData } = await supabase.from('user_roles').select('role, brokerage_id, team_id, agent_id, vendor_id').eq('user_id', authUser.id)

        const context: UserContext = {
          id: authUser.id,
          email: authUser.email || '',
          firstName: userData?.first_name || '',
          lastName: userData?.last_name || '',
          roles: rolesData?.map((r: any) => r.role as UserRole) || [],
          brokerageId: rolesData?.[0]?.brokerage_id,
          teamId: rolesData?.[0]?.team_id,
          agentId: rolesData?.[0]?.agent_id,
          vendorId: rolesData?.[0]?.vendor_id,
        }

        setUser(authUser)
        setUserContext(context)
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Auth error'))
      } finally {
        setLoading(false)
      }
    }

    getUser()

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) {
        setUser(null)
        setUserContext(null)
      } else {
        getUser()
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [supabase, router])

  return { user, userContext, loading, error }
}
