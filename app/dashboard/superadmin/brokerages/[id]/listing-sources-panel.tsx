'use client'

// PLATFORM-STAFF-ONLY BatchData on-market opt-in (wave 69). OWNER RULING (verbatim,
// 2026-09-17): "rentcast is platform provided but idx is for tenant connected... the setting
// page should only allow them to setup their idx connection." IDX-vs-RentCast is DERIVED
// (lib/buyer-search/listing-source-order.ts) and never shown here as a choice; the ONE thing
// left as a stored setting is whether this brokerage is opted into the BILLED BatchData
// on-market pull, which is a platform cost decision — hence this lives on the superadmin tenant
// page, not the tenant's own settings.
import { useEffect, useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, Database } from 'lucide-react'
import {
  getBrokerageActiveListingSourcesAction,
  setBrokerageActiveListingSourcesAction,
} from '@/app/actions/superadmin/active-listing-sources'

export function ListingSourcesPanel({ brokerageId }: { brokerageId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function refresh() {
    getBrokerageActiveListingSourcesAction(brokerageId).then((r) => {
      if (r.ok) setEnabled(r.sources.includes('batchdata_on_market'))
      else setErr(r.error ?? 'Failed to load')
      setLoading(false)
    })
  }
  useEffect(refresh, [brokerageId])

  function toggle(next: boolean) {
    setErr(null)
    startTransition(async () => {
      const r = await setBrokerageActiveListingSourcesAction({
        brokerageId,
        sources: next ? ['batchdata_on_market'] : [],
      })
      if (!r.ok) setErr(r.error ?? 'Failed')
      refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          Active-listing sources
          {enabled != null && (
            <Badge className={enabled ? 'bg-amber-100 text-amber-800 text-[10px]' : 'bg-slate-100 text-slate-600 text-[10px]'}>
              BatchData on-market {enabled ? 'ON' : 'off'}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          For-sale listings for this brokerage&apos;s regular-buyer smart search: their own IDX
          feed when connected, otherwise the platform&apos;s RentCast feed — derived automatically,
          never a tenant setting. The BatchData on-market quicklist bills per property RECORD and
          must re-walk every active listing each cycle, so it is a platform cost decision, off by
          default, opt-in HERE only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : (
          <Button size="sm" variant={enabled ? 'outline' : 'default'} disabled={pending} onClick={() => toggle(!enabled)}>
            {enabled ? 'Disable BatchData on-market pull' : 'Enable BatchData on-market pull'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
