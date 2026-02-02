'use client'

import React, { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { signInWithMagicLink } from '@/app/actions/auth'
import { demoLogin } from '@/app/actions/demo-login'
import { MagicLinkState } from '@/app/types/auth'
import { AUTH_MESSAGES, DEMO_CONFIG, DEMO_USERS } from '@/app/constants/auth'

export function LoginForm() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<MagicLinkState>({
    state: 'idle',
    isLoading: false,
  })
  const [demoMode, setDemoMode] = useState(false)
  const [demoUsers, setDemoUsers] = useState<typeof DEMO_USERS>([])
  const router = useRouter()
  const searchParams = useSearchParams()

  // Load demo users on mount
  useEffect(() => {
    if (DEMO_CONFIG.ENABLED) {
      setDemoMode(true)
      setDemoUsers(DEMO_USERS)
    }
  }, [])

  // Handle URL error params
  useEffect(() => {
    const error = searchParams.get('error')
    if (error) {
      setState((prev) => ({ ...prev, error: decodeURIComponent(error) }))
    }
  }, [searchParams])

  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setState({ state: 'sending', isLoading: true })

    const result = await signInWithMagicLink(email)

    if (result.success) {
      setState({ state: 'sent', isLoading: false })
    } else {
      setState({
        state: 'error',
        isLoading: false,
        error: result.error?.message,
      })
    }
  }

  const handleDemoLogin = async (email: string) => {
    setState((prev) => ({ ...prev, isLoading: true }))
    await demoLogin(email)
  }

  const groupedDemoUsers = () => {
    return {
      'Real Estate Team': demoUsers.filter((u) => ['agent', 'broker', 'admin', 'transaction_coordinator', 'compliance_manager'].includes(u.role)),
      'Contacts': demoUsers.filter((u) => u.role === 'contact'),
      'Vendors': demoUsers.filter((u) => u.role === 'vendor'),
    }
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-bold text-gray-900 mb-2 text-center">VIP Agents AI</h1>
        <p className="text-gray-600 mb-8 text-center">Real Estate Operating System</p>

        {demoMode ? (
          <Tabs defaultValue="demo" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="demo">Quick Demo Login</TabsTrigger>
              <TabsTrigger value="magic">Magic Link</TabsTrigger>
            </TabsList>

            <TabsContent value="demo" className="space-y-4">
              <div className="space-y-4">
                <p className="text-sm text-gray-600">Click any user to instantly log in:</p>

                {Object.entries(groupedDemoUsers()).map(([category, users]) => (
                  <div key={category}>
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">{category}</h3>
                    <div className="grid gap-2">
                      {users.map((user) => (
                        <Button
                          key={user.email}
                          variant="outline"
                          className="justify-start text-left h-auto py-3"
                          onClick={() => handleDemoLogin(user.email)}
                          disabled={state.isLoading}
                        >
                          <div className="flex flex-col">
                            <span className="font-medium">{user.name}</span>
                            <span className="text-xs text-gray-500">{user.email}</span>
                            <span className="text-xs text-gray-400">{user.description}</span>
                          </div>
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="magic">
              <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
                <div>
                  <Input
                    type="email"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={state.isLoading || state.state === 'sent'}
                    className="w-full"
                    required
                  />
                </div>

                <Button type="submit" disabled={state.isLoading || state.state === 'sent'} className="w-full bg-blue-600 hover:bg-blue-700 text-white">
                  {state.state === 'sending' ? 'Sending...' : state.state === 'sent' ? 'Check your email' : 'Send magic link'}
                </Button>

                {state.state === 'sent' && <p className="text-sm text-green-600">{AUTH_MESSAGES.MAGIC_LINK_SENT}</p>}
                {state.state === 'error' && <p className="text-sm text-red-600">{state.error || AUTH_MESSAGES.GENERIC_ERROR}</p>}
              </form>
            </TabsContent>
          </Tabs>
        ) : (
          <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
            <div>
              <Input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state.isLoading || state.state === 'sent'}
                className="w-full"
                required
              />
            </div>

            <Button type="submit" disabled={state.isLoading || state.state === 'sent'} className="w-full bg-blue-600 hover:bg-blue-700 text-white">
              {state.state === 'sending' ? 'Sending...' : state.state === 'sent' ? 'Check your email' : 'Send magic link'}
            </Button>

            {state.state === 'sent' && <p className="text-sm text-green-600">{AUTH_MESSAGES.MAGIC_LINK_SENT}</p>}
            {state.state === 'error' && <p className="text-sm text-red-600">{state.error || AUTH_MESSAGES.GENERIC_ERROR}</p>}
          </form>
        )}
      </div>
    </div>
  )
}
