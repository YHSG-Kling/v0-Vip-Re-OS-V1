'use client'

// Integration credentials that need rotation — expired / expiring-soon OAuth tokens across all
// tenants. The schema carried token_expires_at + refresh_token but nothing watched them; a silently
// expired Google/social/CRM token breaks the AI team's outbound. Staff-gated server-side.
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { KeyRound, Loader2 } from 'lucide-react'
import { getCredentialRotationAction } from '@/app/actions/superadmin/ai-ops'
import type { RotationRisk } from '@/lib/security/credential-rotation'

export function RotationRisksPanel() {
  const [risks, setRisks] = useState<RotationRisk[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getCredentialRotationAction().then((r) => { if (r.ok) setRisks(r.data); else setErr(r.error); setLoading(false) })
  }, [])

  const expired = risks.filter((r) => r.status === 'expired').length

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" />Credential rotation</CardTitle>
        {risks.length > 0 && (
          <span className="text-xs">
            {expired > 0 && <Badge className="text-[10px] bg-red-100 text-red-800">{expired} expired</Badge>}
            {risks.length - expired > 0 && <Badge className="ml-1 text-[10px] bg-amber-100 text-amber-800">{risks.length - expired} expiring</Badge>}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {err && <p className="p-4 text-xs text-red-600">{err}</p>}
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : risks.length === 0 ? (
          <p className="p-4 text-sm text-emerald-600">All integration credentials are current — nothing to rotate.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2">Provider</th><th className="px-4 py-2">Source</th><th className="px-4 py-2">Expires</th>
                <th className="px-4 py-2">Refreshable</th><th className="px-4 py-2 text-right">Status</th>
              </tr></thead>
              <tbody>
                {risks.map((r) => (
                  <tr key={`${r.table}:${r.id}`} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{r.provider ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{r.table}</td>
                    <td className="px-4 py-2 text-xs">{r.tokenExpiresAt ? new Date(r.tokenExpiresAt).toLocaleString() : '—'}</td>
                    <td className="px-4 py-2 text-xs">{r.hasRefreshToken ? 'yes' : 'no'}</td>
                    <td className="px-4 py-2 text-right">
                      <span className={'rounded px-1.5 py-0.5 text-[11px] font-medium ' + (r.status === 'expired' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800')}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
