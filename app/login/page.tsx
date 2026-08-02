'use client'

import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useEffect, Suspense, useId } from 'react'
import { Mail, Lock, Loader2, KeyRound } from 'lucide-react'
import { checkSsoDomainAction } from '@/app/actions/tenant-sso'

function LoginContent() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [mounted, setMounted] = useState(false)
  // SSO (SAML): when the typed email's domain has an ACTIVE brokerage SSO
  // connection, an additive "Sign in with SSO" button appears. Password and
  // magic-link stay the default — nothing is taken away.
  const [ssoAvailable, setSsoAvailable] = useState(false)
  const [ssoCheckedDomain, setSsoCheckedDomain] = useState<string | null>(null)
  const [ssoLoading, setSsoLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()

  // Prevent hydration mismatch by only rendering tabs after mount
  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const errorParam = searchParams.get('error')
    if (errorParam) {
      setError(decodeURIComponent(errorParam))
    }
  }, [searchParams])

  // Cheap availability probe on email blur — the server action returns ONLY
  // { ssoAvailable } for an active connection; it never enumerates domains.
  const checkSsoAvailability = async () => {
    const domain = email.trim().toLowerCase().split('@')[1] ?? ''
    if (!domain || !domain.includes('.')) {
      setSsoAvailable(false)
      setSsoCheckedDomain(null)
      return
    }
    if (domain === ssoCheckedDomain) return
    setSsoCheckedDomain(domain)
    try {
      const { ssoAvailable: available } = await checkSsoDomainAction(email)
      setSsoAvailable(available)
    } catch {
      setSsoAvailable(false)
    }
  }

  const handleSsoLogin = async () => {
    const domain = email.trim().toLowerCase().split('@')[1]
    if (!domain) return
    setSsoLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.auth.signInWithSSO({
        domain,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      })
      if (error) {
        setError(error.message)
        setSsoLoading(false)
        return
      }
      if (data?.url) {
        window.location.href = data.url // hand off to the identity provider
        return
      }
      setError('SSO sign-in could not start — try password sign-in instead')
      setSsoLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
      setSsoLoading(false)
    }
  }

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      const supabase = createClient()
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (error) {
        setError(error.message)
        setIsLoading(false)
        return
      }

      router.push('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
      setIsLoading(false)
    }
  }

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setMessage(null)

    try {
      const supabase = createClient()
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })

      if (error) {
        setError(error.message)
        setIsLoading(false)
        return
      }

      setMessage('Check your email for the magic link!')
      setIsLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
      setIsLoading(false)
    }
  }

  // Password reset had a working endpoint (/api/auth/reset-password) and no way
  // to reach it — no control on any login page, and the confirm page its email
  // linked to did not exist. Both halves are wired now.
  //
  // The response is deliberately the same whether or not the address is
  // registered: telling an anonymous caller "no account with that email" turns
  // this form into an account-enumeration oracle.
  const handleForgotPassword = async () => {
    const address = email.trim()
    if (!address) {
      setError('Enter your email address first, then choose Forgot password')
      return
    }
    setIsLoading(true)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        setError(body?.error || `Could not send the reset email (HTTP ${res.status})`)
        setIsLoading(false)
        return
      }
      setMessage(`If an account exists for ${address}, a password reset link is on its way.`)
      setIsLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
      setIsLoading(false)
    }
  }

  // Show loading placeholder until client-side mounted to prevent hydration mismatch
  if (!mounted) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-gray-900">VIP Agents AI</CardTitle>
          <CardDescription className="text-gray-600">
            Real Estate Operating System
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold text-gray-900">VIP Agents AI</CardTitle>
        <CardDescription className="text-gray-600">
          Real Estate Operating System
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="password" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="password">Email &amp; Password</TabsTrigger>
            <TabsTrigger value="magic">Magic Link</TabsTrigger>
          </TabsList>

          <TabsContent value="password">
            <form onSubmit={handlePasswordLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email-password">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    id="email-password"
                    type="email"
                    placeholder="you@example.com"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={checkSsoAvailability}
                    className="pl-10"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    id="password"
                    type="password"
                    placeholder="Enter your password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                  <p className="text-sm text-red-600">{error}</p>
                </div>
              )}
              {message && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                  <p className="text-sm text-blue-700">{message}</p>
                </div>
              )}
              <Button type="submit" className="w-full bg-blue-600 hover:bg-blue-700" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  'Sign In'
                )}
              </Button>

              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={isLoading}
                className="w-full text-sm text-blue-600 hover:underline disabled:opacity-50"
              >
                Forgot password?
              </button>

              {/* Additive SSO path — appears only when the typed email's
                  domain has an active brokerage SSO connection. */}
              {ssoAvailable && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handleSsoLogin}
                  disabled={isLoading || ssoLoading}
                >
                  {ssoLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Redirecting to your identity provider...
                    </>
                  ) : (
                    <>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Sign in with SSO
                    </>
                  )}
                </Button>
              )}
            </form>
          </TabsContent>

          <TabsContent value="magic">
            <form onSubmit={handleMagicLink} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email-magic">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    id="email-magic"
                    type="email"
                    placeholder="you@example.com"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                  <p className="text-sm text-red-600">{error}</p>
                </div>
              )}
              {message && (
                <div className="p-3 bg-green-50 border border-green-200 rounded-md">
                  <p className="text-sm text-green-600">{message}</p>
                </div>
              )}
              <Button type="submit" className="w-full bg-blue-600 hover:bg-blue-700" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending link...
                  </>
                ) : (
                  'Send Magic Link'
                )}
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <Suspense fallback={
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold text-gray-900">VIP Agents AI</CardTitle>
            <CardDescription className="text-gray-600">Loading...</CardDescription>
          </CardHeader>
        </Card>
      }>
        <LoginContent />
      </Suspense>
    </div>
  )
}
