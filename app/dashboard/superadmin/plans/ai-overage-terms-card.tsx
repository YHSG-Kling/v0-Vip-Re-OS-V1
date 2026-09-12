'use client'

// AI overage terms — administrable beside the tier prices (m479; owner ruling:
// "pass in the cent per limit … the same as how we are handling the
// subscription tier amount"). One row per canonical tier: included AI tokens
// (plan_limits.limit_value), the overage toggle, and the rate as integer
// CENTS per 1K tokens — the same integer-cents discipline the tier price uses;
// the dollars-per-1M hint is derived display only, never what is saved.

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, Save } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { upsertAIOverageTermsAction, listAIOverageTermsAction, type AIOverageTermsRow } from '@/app/actions/superadmin/plan-catalog'

const tokens = (v: number) => (v < 0 ? 'Unlimited' : v.toLocaleString('en-US'))
/** Display-only hint: integer cents per 1K ⇒ dollars per 1M tokens. */
const perMillion = (centsPer1k: number) => ((centsPer1k * 1000) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })

export function AIOverageTermsCard({ initialTerms }: { initialTerms: AIOverageTermsRow[] }) {
  const [rows, setRows] = useState<AIOverageTermsRow[]>(initialTerms)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() {
    listAIOverageTermsAction().then((r) => { if (r.ok) setRows(r.terms) })
  }

  function patch(id: string, p: Partial<AIOverageTermsRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))
  }

  function save(row: AIOverageTermsRow) {
    startTransition(async () => {
      const r = await upsertAIOverageTermsAction({
        planTier: row.plan_tier,
        overageAllowed: row.overage_allowed,
        // The input already holds integer cents — passed through untouched;
        // the server validator refuses anything non-integer or negative.
        overageRateCentsPer1k: row.overage_rate_cents_per_1k,
      })
      if (r.ok) { toast({ title: `Saved AI overage terms — ${row.plan_tier}` }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">AI overage terms</CardTitle>
        <p className="text-xs text-muted-foreground">
          Per-tier billing terms for AI usage past the included quota (ai_tokens_monthly). Overage is served and
          billed at period close only when enabled; the rate is integer <span className="font-medium">cents per 1K tokens</span> —
          configured here exactly like the tier price, never hardcoded.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No ai_tokens_monthly plan limits found — seed the included quotas first.</p>
        )}
        {rows.map((row) => (
          <div key={row.id} className="flex flex-wrap items-end gap-3 rounded border p-3">
            <div className="min-w-[130px]">
              <p className="text-sm font-medium">{row.plan_tier}</p>
              <p className="text-[11px] text-muted-foreground">Included: {tokens(row.limit_value)} tokens/mo</p>
            </div>
            <label className="flex items-center gap-2 text-sm pb-1">
              <input
                type="checkbox"
                checked={row.overage_allowed}
                onChange={(e) => patch(row.id, { overage_allowed: e.target.checked })}
              />
              Overage billed
            </label>
            <div className="w-40">
              <p className="text-[11px] text-muted-foreground mb-1">Rate (¢ per 1K tokens)</p>
              <Input
                type="number"
                min={0}
                step={1}
                value={row.overage_rate_cents_per_1k}
                onChange={(e) => patch(row.id, { overage_rate_cents_per_1k: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
            </div>
            <Badge variant="outline" className="text-[10px] mb-2">= ${perMillion(row.overage_rate_cents_per_1k)} / 1M tokens</Badge>
            <Button size="sm" disabled={pending} onClick={() => save(row)}>
              {pending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}Save
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
