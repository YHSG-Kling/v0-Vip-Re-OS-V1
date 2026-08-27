'use client'

/**
 * The landing page for the link in a Supabase password-reset email.
 *
 * /api/auth/reset-password has always sent that email with
 * `redirectTo: <APP_URL>/auth/reset-password-confirm`, but this page did not
 * exist — every reset link in the product landed on a 404, so nobody could
 * finish a reset. This is the other half.
 *
 * Supabase turns the `type=recovery` link into a real (short-lived) session
 * before the user gets here, so the check that matters is "is there a session";
 * with one, `updateUser({ password })` is the supported way to set the new one.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
// The ONE password-length rule (§6) — this page used to restate `8` in four
// places; a policy change now lands everywhere this page enforces or describes it.
import { PASSWORD_REQUIREMENTS } from '@/app/constants/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Lock, CheckCircle2 } from 'lucide-react'

type SessionState = 'checking' | 'ready' | 'no-session'

export default function ResetPasswordConfirmPage() {
  const router = useRouter()
  const [sessionState, setSessionState] = useState<SessionState>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // The recovery session is established asynchronously from the URL fragment,
    // so read it once and then keep listening: a bare getSession() on first
    // paint can legitimately come back empty a moment before the link is
    // exchanged, and reporting "expired link" there would be a lie.
    void (async () => {
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (cancelled) return
      if (sessionError) {
        setError(sessionError.message)
        setSessionState('no-session')
        return
      }
      if (data.session) setSessionState('ready')
    })()

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        if (cancelled) return
        if (session) setSessionState('ready')
      },
    )

    const settle = setTimeout(() => {
      if (!cancelled) setSessionState((s) => (s === 'checking' ? 'no-session' : s))
    }, 3000)

    return () => {
      cancelled = true
      clearTimeout(settle)
      sub.subscription.unsubscribe()
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < PASSWORD_REQUIREMENTS.MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_REQUIREMENTS.MIN_LENGTH} characters`)
      return
    }
    // The complexity flags were declared and enforced NOWHERE (adjudicated
    // 2026-08-27, lane CB): a form that reads only MIN_LENGTH accepts "aaaaaaaa"
    // while the constants promise four character classes. Each flag gates its own
    // check so turning one off in app/constants/auth.ts turns the check off with
    // it — one vocabulary, one enforcement (§6).
    if (PASSWORD_REQUIREMENTS.REQUIRE_UPPERCASE && !/[A-Z]/.test(password)) {
      setError('Password must include at least one uppercase letter')
      return
    }
    if (PASSWORD_REQUIREMENTS.REQUIRE_LOWERCASE && !/[a-z]/.test(password)) {
      setError('Password must include at least one lowercase letter')
      return
    }
    if (PASSWORD_REQUIREMENTS.REQUIRE_NUMBERS && !/[0-9]/.test(password)) {
      setError('Password must include at least one number')
      return
    }
    if (PASSWORD_REQUIREMENTS.REQUIRE_SPECIAL && !/[^A-Za-z0-9]/.test(password)) {
      setError('Password must include at least one special character')
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match')
      return
    }

    setIsSaving(true)
    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setIsSaving(false)
      return
    }
    setDone(true)
    setIsSaving(false)
    // The recovery session is a live session; sign out so the new password is
    // actually exercised on the next sign-in rather than silently skipped.
    await supabase.auth.signOut()
    setTimeout(() => router.push('/login'), 1500)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-gray-900">Set a new password</CardTitle>
          <CardDescription className="text-gray-600">
            Choose a password for your VIP Agents AI account
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessionState === 'checking' && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
            </div>
          )}

          {sessionState === 'no-session' && (
            <div className="space-y-4">
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm text-amber-800">
                  This page did not receive a valid password-reset session
                  {error ? `: ${error}` : ''}. Reset links can only be used once
                  and expire, so request a new one.
                </p>
              </div>
              <Button className="w-full" onClick={() => router.push('/login')}>
                Back to sign in
              </Button>
            </div>
          )}

          {sessionState === 'ready' && !done && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <Input
                    id="new-password"
                    type="password"
                    required
                    minLength={PASSWORD_REQUIREMENTS.MIN_LENGTH}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10"
                    placeholder={`At least ${PASSWORD_REQUIREMENTS.MIN_LENGTH} characters`}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <Input
                    id="confirm-password"
                    type="password"
                    required
                    minLength={PASSWORD_REQUIREMENTS.MIN_LENGTH}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="pl-10"
                    placeholder="Re-enter the password"
                  />
                </div>
              </div>
              {error && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3">
                  <p className="text-sm text-red-600">{error}</p>
                </div>
              )}
              <Button type="submit" className="w-full bg-blue-600 hover:bg-blue-700" disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save new password'
                )}
              </Button>
            </form>
          )}

          {done && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
              <p className="text-sm text-gray-700">
                Password updated. Taking you to sign in...
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
