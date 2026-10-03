'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { CheckCircle, AlertTriangle, Mail, MessageSquare } from 'lucide-react'

type Stage = 'confirm' | 'processing' | 'done' | 'error' | 'invalid'

export function UnsubscribeClient() {
  const params = useSearchParams()
  const contactId = params.get('contactId')
  const channel   = params.get('channel') as 'email' | 'sms' | 'mail' | null

  const [stage, setStage]   = useState<Stage>(() => {
    if (!contactId || !channel) return 'invalid'
    // 'mail' is admitted now that both suppression writers can express it and
    // dispatchDirectMail reads it back. The route's ALLOWED set is the authority;
    // this list must not be narrower or a valid link renders as "invalid link".
    if (channel !== 'email' && channel !== 'sms' && channel !== 'mail') return 'invalid'
    return 'confirm'
  })
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const channelLabel =
    channel === 'sms' ? 'text messages (SMS)' : channel === 'mail' ? 'physical mail' : 'marketing emails'
  const Icon = channel === 'sms' ? MessageSquare : Mail

  async function handleConfirm() {
    setStage('processing')
    try {
      const res = await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, channel }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Something went wrong. Please try again.')
        setStage('error')
      } else {
        setStage('done')
      }
    } catch {
      setErrorMsg('Network error. Please try again.')
      setStage('error')
    }
  }

  if (stage === 'invalid') {
    return (
      <PageShell>
        <AlertTriangle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-foreground mb-2">Invalid link</h1>
        <p className="text-muted-foreground text-sm">
          This unsubscribe link is invalid or has expired. Please use the link from your most recent email.
        </p>
      </PageShell>
    )
  }

  if (stage === 'done') {
    return (
      <PageShell>
        <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-foreground mb-2">You have been unsubscribed</h1>
        <p className="text-muted-foreground text-sm">
          You will no longer receive {channelLabel} from us. This may take up to 10 business days to take effect across all systems.
        </p>
        <p className="text-muted-foreground text-xs mt-4">
          You may still receive transactional messages required to complete an active transaction.
        </p>
      </PageShell>
    )
  }

  if (stage === 'error') {
    return (
      <PageShell>
        <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-foreground mb-2">Something went wrong</h1>
        <p className="text-muted-foreground text-sm mb-6">{errorMsg}</p>
        <Button variant="outline" onClick={() => setStage('confirm')}>Try again</Button>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <Icon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
      <h1 className="text-xl font-semibold text-foreground mb-2">
        Unsubscribe from {channelLabel}?
      </h1>
      <p className="text-muted-foreground text-sm mb-8 max-w-sm text-center leading-relaxed">
        Clicking confirm will stop all {channelLabel} immediately.
        You may still receive messages required to complete an active transaction.
      </p>
      <div className="flex gap-3">
        <Button
          variant="destructive"
          onClick={handleConfirm}
          disabled={stage === 'processing'}
        >
          {stage === 'processing' ? 'Processing...' : 'Confirm unsubscribe'}
        </Button>
      </div>
    </PageShell>
  )
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-background">
      <div className="w-full max-w-md flex flex-col items-center text-center gap-2">
        {children}
      </div>
      <p className="mt-12 text-xs text-muted-foreground">
        Equal Housing Opportunity &mdash; Powered by VIP Agents AI
      </p>
    </main>
  )
}
