'use client'

// Company channels — connect the PLATFORM'S OWN social accounts (the ones the
// product social calendar posts to). Per channel: honest status, Connect via the
// real OAuth flow when the provider's env creds exist, otherwise the exact env
// vars to set. Verify pings the provider for real; nothing pretends.
import { useEffect, useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, Share2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import {
  listPlatformSocialAccountsAction,
  startPlatformSocialConnectAction,
  disconnectPlatformSocialAction,
  verifyPlatformSocialAction,
} from '@/app/actions/superadmin/platform-social'

export interface ChannelAccount {
  platform: string
  label: string
  status: 'pending' | 'connected' | 'error' | 'disconnected'
  accountName: string | null
  connectedAt: string | null
  lastVerifiedAt: string | null
  envReady: boolean
  missingEnv: string[]
  dispatch: { supported: boolean; reason?: string }
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-700',
  connected: 'bg-emerald-100 text-emerald-800',
  error: 'bg-red-100 text-red-700',
  disconnected: 'bg-amber-100 text-amber-800',
}

export function CompanyChannelsCard({ initialAccounts }: { initialAccounts: ChannelAccount[] }) {
  const [accounts, setAccounts] = useState<ChannelAccount[]>(initialAccounts)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  // Surface the OAuth callback result (the route redirects back here with query params).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('channel_connected')
    const failed = params.get('channel_error')
    if (connected) toast({ title: `${connected} connected` })
    if (failed) toast({ title: 'Connection failed', description: failed, variant: 'destructive' })
    if (connected || failed) {
      params.delete('channel_connected'); params.delete('channel_error'); params.delete('channel')
      const qs = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
      reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function reload() {
    listPlatformSocialAccountsAction().then((r) => { if (r.ok) setAccounts(r.accounts as ChannelAccount[]) })
  }

  function connect(platform: string) {
    setBusy(platform)
    startTransition(async () => {
      const r = await startPlatformSocialConnectAction(platform)
      setBusy(null)
      if (!r.ok) { toast({ title: 'Error', description: r.error, variant: 'destructive' }); return }
      if ('needsCreds' in r) {
        toast({ title: 'OAuth app not configured', description: `Set ${r.missingEnv.join(' and ')} in the environment, then retry.`, variant: 'destructive' })
        return
      }
      window.location.href = r.url // real provider authorize flow
    })
  }

  function verify(platform: string) {
    setBusy(platform)
    startTransition(async () => {
      const r = await verifyPlatformSocialAction(platform)
      setBusy(null)
      if (r.ok) toast({ title: `Verified${r.accountName ? ` — ${r.accountName}` : ''}` })
      else toast({ title: 'Verification failed', description: r.error, variant: 'destructive' })
      reload()
    })
  }

  function disconnect(platform: string) {
    setBusy(platform)
    startTransition(async () => {
      const r = await disconnectPlatformSocialAction(platform)
      setBusy(null)
      if (r.ok) toast({ title: `${platform} disconnected` })
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
      reload()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Share2 className="h-4 w-4 text-primary" />Company channels
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The platform&apos;s own social accounts — the calendar below posts to these. Connecting uses each
          provider&apos;s real OAuth app; a provider without credentials says exactly which env vars are missing.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {accounts.map((a) => (
          <div key={a.platform} className="rounded-lg border p-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium w-24">{a.label}</span>
            <Badge className={'text-[10px] ' + (STATUS_BADGE[a.status] ?? '')}>{a.status}</Badge>
            {a.status === 'connected' && a.accountName && (
              <span className="text-xs text-muted-foreground">{a.accountName}</span>
            )}
            {a.status === 'connected' && a.lastVerifiedAt && (
              <span className="text-[11px] text-muted-foreground">verified {new Date(a.lastVerifiedAt).toLocaleDateString()}</span>
            )}
            <span className="flex-1" />
            {!a.envReady ? (
              <span className="text-[11px] text-amber-700">
                OAuth app not configured — set <code className="font-mono">{a.missingEnv.join(', ')}</code>
              </span>
            ) : a.status === 'connected' ? (
              <>
                <Button size="sm" variant="outline" disabled={pending && busy === a.platform} onClick={() => verify(a.platform)}>
                  {pending && busy === a.platform ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Verify'}
                </Button>
                <Button size="sm" variant="ghost" className="text-red-600" disabled={pending && busy === a.platform} onClick={() => disconnect(a.platform)}>
                  Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={pending && busy === a.platform} onClick={() => connect(a.platform)}>
                {pending && busy === a.platform ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (a.status === 'error' || a.status === 'disconnected' ? 'Reconnect' : 'Connect')}
              </Button>
            )}
            {a.status === 'connected' && !a.dispatch.supported && a.dispatch.reason && (
              <p className="w-full text-[11px] text-muted-foreground">{a.dispatch.reason}</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
