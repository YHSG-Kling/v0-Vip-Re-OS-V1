'use client'

import React, { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MagicLinkState } from '@/app/types/auth'
import { AUTH_MESSAGES, DEMO_CONFIG, DEMO_USERS } from '@/app/constants/auth'
import { signInWithMagicLink } from '@/app/actions/auth'
import { demoLogin } from '@/app/actions/demo-login'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  
  const [state, setState] = useState<MagicLinkState>({
    email: '',
    message: null,
    isLoading: false,
  })

  const [demoMode, setDemoMode] = useState(false)
  const [demoUsers, setDemoUsers] = useState<any[]>([])

  // Load demo users on mount
  useEffect(() => {
    console.log('[v0] Demo Config - ENABLED:', DEMO_CONFIG.ENABLED)
    console.log('[v0] Demo Users Count:', DEMO_USERS.length)
    console.log('[v0] Environment Variable:', process.env.NEXT_PUBLIC_DEMO_MODE)
    
    if (DEMO_CONFIG.ENABLED) {
      setDemoMode(true)
      setDemoUsers(DEMO_USERS)
      console.log('[v0] ✅ Demo mode activated successfully with', DEMO_USERS.length, 'users')
    } else {
      console.log('[v0] ❌ Demo mode is DISABLED - check NEXT_PUBLIC_DEMO_MODE env var')
    }
  }, [])

  // Handle messages from URL
  useEffect(() => {
    const message = searchParams.get('message') as any
    if (message && AUTH_MESSAGES[message as keyof typeof AUTH_MESSAGES]) {
      setState((prev) => ({
        ...prev,
        message,
        error: AUTH_MESSAGES[message as keyof typeof AUTH_MESSAGES],
      }))
    }
  }, [searchParams])

  const handleMagicLinkSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    if (!state.email) {
      setState((prev) => ({
        ...prev,
        error: 'Please enter your email',
      }))
      return
    }

    setState((prev) => ({ ...prev, isLoading: true }))

    const result = await signInWithMagicLink({ email: state.email })

    if (result.success) {
      setState((prev) => ({
        ...prev,
        message: 'check-email',
        isLoading: false,
      }))
    } else {
      setState((prev) => ({
        ...prev,
        error: result.error?.message,
        isLoading: false,
      }))
    }
  }

  const handleDemoLogin = async (email: string) => {
    setState((prev) => ({ ...prev, isLoading: true }))
    console.log('[v0] Initiating demo login for:', email)
    
    // demoLogin now handles redirect internally
    await demoLogin(email)
  }

  const getMessageColor = () => {
    if (state.error) return 'text-red-600 bg-red-50'
    if (state.message === 'check-email') return 'text-green-600 bg-green-50'
    return 'text-blue-600 bg-blue-50'
  }

  // Group demo users by role for better UI
  const groupedUsers = demoUsers.reduce((acc, user) => {
    if (!acc[user.role]) {
      acc[user.role] = []
    }
    acc[user.role].push(user)
    return acc
  }, {} as Record<string, any[]>)

  const roleOrder = ['agent', 'broker', 'admin', 'transaction_coordinator', 'compliance_manager', 'lender', 'title_agent', 'contact', 'vendor']

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">VIP Agents</h1>
          <p className="text-gray-600 mt-2">Real Estate Operating System</p>
        </div>

        {/* Message */}
        {(state.error || state.message) && (
          <div className={`p-3 rounded-md mb-6 text-sm font-medium ${getMessageColor()}`}>
            {state.error || AUTH_MESSAGES[state.message!]}
          </div>
        )}

        {/* Tabs for Demo vs Magic Link */}
        {demoMode ? (
          <Tabs defaultValue="demo" className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-gray-100">
              <TabsTrigger value="demo" className="text-sm">
                🚀 Quick Demo Login
              </TabsTrigger>
              <TabsTrigger value="magic-link" className="text-sm">
                Magic Link
              </TabsTrigger>
            </TabsList>

            {/* DEMO MODE TAB */}
            <TabsContent value="demo" className="space-y-4 mt-4">
              <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-4">
                <p className="text-sm text-blue-900">
                  ✨ <strong>Demo Mode:</strong> Click any user below to instantly log in and test all features
                </p>
              </div>

              {/* Group users by role */}
              {roleOrder.map((role) => {
                if (!groupedUsers[role]) return null
                
                return (
                  <div key={role}>
                    <h3 className="text-sm font-semibold text-gray-900 mb-2 capitalize">
                      {role.replace(/_/g, ' ')}
                    </h3>
                    <div className="space-y-2 mb-4">
                      {groupedUsers[role].map((user) => (
                        <button
                          key={user.email}
                          onClick={() => handleDemoLogin(user.email)}
                          disabled={state.isLoading}
                          className="w-full p-3 rounded-md border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <div className="font-medium text-gray-900">{user.name}</div>
                          <div className="text-xs text-gray-600">{user.description}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </TabsContent>

            {/* MAGIC LINK TAB */}
            <TabsContent value="magic-link" className="space-y-4 mt-4">
              {state.message !== 'check-email' ? (
                <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-2">
                      Email Address
                    </label>
                    <Input
                      type="email"
                      placeholder="you@example.com"
                      value={state.email}
                      onChange={(e) =>
                        setState((prev) => ({
                          ...prev,
                          email: e.target.value,
                          error: undefined,
                        }))
                      }
                      disabled={state.isLoading}
                      className="border-gray-200 bg-gray-50"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={state.isLoading}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    {state.isLoading ? 'Sending link...' : 'Send Magic Link'}
                  </Button>
                </form>
              ) : (
                <div className="text-center">
                  <p className="text-gray-600 mb-4">
                    We've sent a sign-in link to <strong>{state.email}</strong>
                  </p>
                  <p className="text-sm text-gray-500 mb-6">
                    The link expires in 24 hours.
                  </p>
                  <Button
                    onClick={() => setState((prev) => ({ ...prev, message: null, email: '' }))}
                    variant="outline"
                    className="w-full border-gray-200"
                  >
                    Try Another Email
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        ) : (
          /* Original magic link form (if demo mode disabled) */
          <>
            {state.message !== 'check-email' ? (
              <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900 mb-2">
                    Email Address
                  </label>
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    value={state.email}
                    onChange={(e) =>
                      setState((prev) => ({
                        ...prev,
                        email: e.target.value,
                        error: undefined,
                      }))
                    }
                    disabled={state.isLoading}
                    className="border-gray-200 bg-gray-50"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={state.isLoading}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {state.isLoading ? 'Sending link...' : 'Send Magic Link'}
                </Button>
              </form>
            ) : (
              <div className="text-center">
                <p className="text-gray-600 mb-4">
                  We've sent a sign-in link to <strong>{state.email}</strong>
                </p>
                <p className="text-sm text-gray-500 mb-6">
                  The link expires in 24 hours.
                </p>
                <Button
                  onClick={() => setState((prev) => ({ ...prev, message: null, email: '' }))}
                  variant="outline"
                  className="w-full border-gray-200"
                >
                  Try Another Email
                </Button>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <p className="text-center text-sm text-gray-500 mt-6">
          By signing in, you agree to our{' '}
          <a href="#" className="text-blue-600 hover:underline">
            Terms of Service
          </a>
        </p>
      </div>
    </div>
  )
}
