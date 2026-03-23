'use client'

import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useSearchParams } from 'next/navigation'
import { useState, Suspense } from 'react'
import { Loader2, Mail, Shield } from 'lucide-react'

function PortalLoginContent() {
  const searchParams = useSearchParams()
  const contactId = searchParams.get('contactId') ?? ''
  const expired = searchParams.get('expired') === '1'

  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const redirectTo = contactId
      ? `${window.location.origin}/portal/${contactId}`
      : `${window.location.origin}/portal`

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    })

    setLoading(false)

    if (otpError) {
      setError(otpError.message)
      return
    }

    setSent(true)
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-foreground/5">
              <Mail className="h-6 w-6 text-foreground" />
            </div>
            <CardTitle>Check your email</CardTitle>
            <CardDescription>
              We sent a secure login link to <span className="font-medium text-foreground">{email}</span>.
              Click the link in the email to access your portal — no password needed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              The link expires in 60 minutes. If you did not receive it, check your spam folder or contact your agent for a new one.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-foreground/5">
            <Shield className="h-6 w-6 text-foreground" />
          </div>
          <CardTitle>Access Your Client Portal</CardTitle>
          <CardDescription>
            Enter the email address your agent has on file. We will send you a secure, one-click login link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {expired && (
            <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              This link has expired. Contact your agent for a new one.
            </div>
          )}

          <form onSubmit={handleSend} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={loading || !email}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending link...
                </>
              ) : (
                'Send Secure Link'
              )}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            Only the email your agent has on file will grant access.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

export default function PortalLoginPage() {
  return (
    <Suspense>
      <PortalLoginContent />
    </Suspense>
  )
}
