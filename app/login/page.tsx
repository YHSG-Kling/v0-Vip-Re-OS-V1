'use client'

import React, { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { signInWithMagicLink } from '@/app/actions/auth'
import { MagicLinkState } from '@/app/types/auth'
import { AUTH_MESSAGES } from '@/app/constants/auth'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  
  const [state, setState] = useState<MagicLinkState>({
    email: '',
    message: null,
    isLoading: false,
  })

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
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

  const getMessageColor = () => {
    if (state.error) return 'text-red-600 bg-red-50 border-red-200'
    if (state.message === 'check-email') return 'text-green-600 bg-green-50 border-green-200'
    return 'text-blue-600 bg-blue-50 border-blue-200'
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">VIP Agents AI</h1>
          <p className="text-gray-600 mt-2">Real Estate Operating System</p>
        </div>

        {/* Message */}
        {(state.error || state.message) && (
          <div className={`p-4 rounded-lg border mb-6 text-sm font-medium ${getMessageColor()}`}>
            {state.error || (state.message ? AUTH_MESSAGES[state.message as keyof typeof AUTH_MESSAGES] || '' : '')}
          </div>
        )}

        {/* Form */}
        {state.message !== 'check-email' ? (
          <form onSubmit={handleSubmit} className="space-y-4">
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
                className="border-gray-300 bg-white focus:border-blue-600 focus:ring-blue-600"
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
          <div className="text-center space-y-4">
            <div className="p-6 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-gray-900 font-medium mb-2">
                Check your email
              </p>
              <p className="text-gray-600 text-sm">
                {'We\'ve sent a sign-in link to '}
                <strong className="text-gray-900">{state.email}</strong>
              </p>
              <p className="text-xs text-gray-500 mt-3">
                The link expires in 24 hours.
              </p>
            </div>
            <Button
              onClick={() => setState({ email: '', message: null, isLoading: false })}
              variant="outline"
              className="w-full border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Try Another Email
            </Button>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-sm text-gray-500 mt-8">
          {'By signing in, you agree to our '}
          <a href="#" className="text-blue-600 hover:underline">
            Terms of Service
          </a>
        </p>
      </div>
    </div>
  )
}
