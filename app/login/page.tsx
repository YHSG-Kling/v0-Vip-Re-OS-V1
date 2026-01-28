'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/authStore'
import { UserRole } from '@/types'

interface DemoUser {
  email: string
  name: string
  first_name: string
  last_name: string
  user_type: string
  role: UserRole
  brokerage: string | null
}

interface GroupedUsers {
  'Agents & Brokers': DemoUser[]
  'Internal Staff': DemoUser[]
  'Buyers & Sellers': DemoUser[]
  'Service Providers': DemoUser[]
}

export default function LoginPage() {
  const router = useRouter()
  const { isAuthenticated } = useAuthStore()
  const [demoUsers, setDemoUsers] = useState<DemoUser[]>([])
  const [groupedUsers, setGroupedUsers] = useState<GroupedUsers>({
    'Agents & Brokers': [],
    'Internal Staff': [],
    'Buyers & Sellers': [],
    'Service Providers': [],
  })
  const [isLoading, setIsLoading] = useState(false)
  const [isFetchingUsers, setIsFetchingUsers] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null)

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      router.push('/dashboard')
    }
  }, [isAuthenticated, router])

  // Fetch demo users on mount
  useEffect(() => {
    async function fetchDemoUsers() {
      try {
        const response = await fetch('/api/auth/demo-users')
        const data = await response.json()

        if (data.success) {
          setDemoUsers(data.users)
          
          // Group users by category
          const grouped: GroupedUsers = {
            'Agents & Brokers': [],
            'Internal Staff': [],
            'Buyers & Sellers': [],
            'Service Providers': [],
          }

          data.users.forEach((user: DemoUser) => {
            if (user.role === UserRole.AGENT || user.role === UserRole.BROKER || user.role === UserRole.TEAM_LEADER) {
              grouped['Agents & Brokers'].push(user)
            } else if (user.role === UserRole.ADMIN || user.role === UserRole.TC || user.role === UserRole.COMPLIANCE_OFFICER) {
              grouped['Internal Staff'].push(user)
            } else if (user.role === UserRole.CONTACT) {
              grouped['Buyers & Sellers'].push(user)
            } else if (user.role === UserRole.LENDER || user.role === UserRole.VENDOR) {
              grouped['Service Providers'].push(user)
            }
          })

          setGroupedUsers(grouped)
        }
      } catch (err) {
        console.error('Failed to fetch demo users:', err)
      } finally {
        setIsFetchingUsers(false)
      }
    }

    fetchDemoUsers()
  }, [])

  const handleLogin = async (email: string) => {
    setIsLoading(true)
    setError(null)
    setSelectedEmail(email)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (data.success && data.user) {
        // Update Zustand store
        const { login } = useAuthStore.getState()
        await login(email, '') // Password not used for demo login
        
        // Redirect to dashboard
        router.push('/dashboard')
      } else {
        setError(data.error || 'Login failed')
      }
    } catch (err) {
      console.error('Login error:', err)
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setIsLoading(false)
      setSelectedEmail(null)
    }
  }

  const getRoleBadgeColor = (role: UserRole) => {
    switch (role) {
      case UserRole.AGENT:
      case UserRole.BROKER:
      case UserRole.TEAM_LEADER:
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20'
      case UserRole.ADMIN:
        return 'bg-purple-500/10 text-purple-400 border-purple-500/20'
      case UserRole.TC:
      case UserRole.COMPLIANCE_OFFICER:
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      case UserRole.CONTACT:
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20'
      case UserRole.LENDER:
      case UserRole.VENDOR:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
    }
  }

  const getRoleLabel = (role: UserRole) => {
    const roleMap: Record<string, string> = {
      [UserRole.AGENT]: 'Agent',
      [UserRole.BROKER]: 'Broker',
      [UserRole.TEAM_LEADER]: 'Team Leader',
      [UserRole.ADMIN]: 'Admin',
      [UserRole.TC]: 'Transaction Coordinator',
      [UserRole.COMPLIANCE_OFFICER]: 'Compliance',
      [UserRole.CONTACT]: 'Contact',
      [UserRole.LENDER]: 'Lender',
      [UserRole.VENDOR]: 'Vendor',
    }
    return roleMap[role] || role
  }

  if (isFetchingUsers) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          <p className="text-sm text-slate-400">Loading demo users...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-12 text-center">
          <div className="mb-4 inline-flex items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-blue-700 p-3 shadow-lg shadow-blue-600/20">
            <svg
              className="h-8 w-8 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
              />
            </svg>
          </div>
          <h1 className="mb-3 bg-gradient-to-r from-white to-slate-300 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
            Smart Engine VIP Agents
          </h1>
          <p className="text-lg text-slate-400">
            Select a demo user to sign in
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-8 rounded-lg border border-red-500/20 bg-red-500/10 p-4">
            <div className="flex items-start gap-3">
              <svg
                className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div>
                <h3 className="font-semibold text-red-400">Login Failed</h3>
                <p className="mt-1 text-sm text-red-300">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* User Groups */}
        <div className="space-y-8">
          {Object.entries(groupedUsers).map(([groupName, users]) => {
            if (users.length === 0) return null

            return (
              <div key={groupName} className="space-y-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                  {groupName}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
                  {users.map((user) => {
                    const isCurrentlyLoading = isLoading && selectedEmail === user.email

                    return (
                      <button
                        key={user.email}
                        onClick={() => handleLogin(user.email)}
                        disabled={isLoading}
                        className="group relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-left transition-all hover:border-blue-600/50 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {/* Loading overlay */}
                        {isCurrentlyLoading && (
                          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
                            <div className="flex items-center gap-2">
                              <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                              <span className="text-sm font-medium text-blue-400">
                                Signing in...
                              </span>
                            </div>
                          </div>
                        )}

                        {/* User info */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="mb-2 flex items-center gap-2">
                              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-blue-700 text-sm font-semibold text-white shadow-lg shadow-blue-600/20">
                                {user.first_name[0]}
                                {user.last_name[0]}
                              </div>
                              <div className="min-w-0 flex-1">
                                <h3 className="truncate text-base font-semibold text-white">
                                  {user.name}
                                </h3>
                              </div>
                            </div>
                            <div className="space-y-1.5">
                              <p className="truncate text-sm text-slate-400">
                                {user.email}
                              </p>
                              {user.brokerage && (
                                <p className="truncate text-xs text-slate-500">
                                  {user.brokerage}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex-shrink-0">
                            <span
                              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${getRoleBadgeColor(
                                user.role
                              )}`}
                            >
                              {getRoleLabel(user.role)}
                            </span>
                          </div>
                        </div>

                        {/* Hover effect */}
                        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-blue-600/0 via-blue-600/5 to-blue-600/0 opacity-0 transition-opacity group-hover:opacity-100" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="mt-12 text-center">
          <p className="text-sm text-slate-500">
            Demo environment • All users have full access
          </p>
        </div>
      </div>
    </div>
  )
}
