'use client'

// Overage terms — administrable beside the tier prices (m479 AI, m666 video;
// owner rulings: "pass in the cent per limit … the same as how we are handling
// the subscription tier amount" and, wave 87C, "make video overage rate and
// option that the platform could charge on stripe billing subscriptions").
// One row per (canonical tier, billed metric): included units
// (plan_limits.limit_value), the overage toggle, and the rate as integer CENTS
// per 1K units — the same integer-cents discipline the tier price uses; the
// per-unit hint is derived display only, never what is saved. Each row also
// shows whether the terms are PUBLISHED to Stripe Billing as a metered price
// (overage then bills as a metered line on the tenant's subscription) and
// offers the publish button; unpublished tiers bill by invoice item. Below the
// rows: the audited change log.

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, Save, UploadCloud } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import {
  upsertAIOverageTermsAction,
  listAIOverageTermsAction,
  publishOverageMeteredPriceAction,
  listOverageTermsChangeLogAction,
  type AIOverageTermsRow,
  type OverageTermsChangeRow,
} from '@/app/actions/superadmin/plan-catalog'
import { OVERAGE_METRIC_UNIT, OVERAGE_BILLED_METRICS } from '@/lib/billing/plan-catalog'

const units = (v: number, plural: string) => (v < 0 ? 'Unlimited' : `${v.toLocaleString('en-US')} ${plural}`)
/** Display-only hint: integer cents per 1K ⇒ dollars per 1M units. */
const perMillion = (centsPer1k: number) => ((centsPer1k * 1000) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })
/** Display-only hint: integer cents per 1K ⇒ dollars per ONE unit. */
const perUnit = (centsPer1k: number) => (centsPer1k / 1000 / 100).toLocaleString('en-US', { maximumFractionDigits: 6 })

function stripeState(row: AIOverageTermsRow): { label: string; tone: string } {
  if (!row.stripe_link_readable) return { label: 'Stripe link unreadable (m669 not applied)', tone: 'bg-amber-100 text-amber-800' }
  if (!row.stripe_metered_price_id) return { label: 'Bills by invoice item', tone: 'bg-slate-100 text-slate-700' }
  if (row.stripe_metered_rate_cents_per_1k !== row.overage_rate_cents_per_1k) return { label: 'Stripe price stale — republish', tone: 'bg-amber-100 text-amber-800' }
  return { label: 'Metered on Stripe subscriptions', tone: 'bg-emerald-100 text-emerald-800' }
}

export function AIOverageTermsCard({ initialTerms, initialLog = [] }: { initialTerms: AIOverageTermsRow[]; initialLog?: OverageTermsChangeRow[] }) {
  const [rows, setRows] = useState<AIOverageTermsRow[]>(initialTerms)
  const [log, setLog] = useState<OverageTermsChangeRow[]>(initialLog)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() {
    listAIOverageTermsAction().then((r) => { if (r.ok) setRows(r.terms) })
    listOverageTermsChangeLogAction().then((r) => { if (r.ok) setLog(r.rows) })
  }

  function patch(id: string, p: Partial<AIOverageTermsRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))
  }

  function save(row: AIOverageTermsRow) {
    startTransition(async () => {
      const r = await upsertAIOverageTermsAction({
        planTier: row.plan_tier,
        metric: row.metric,
        overageAllowed: row.overage_allowed,
        // The input already holds integer cents — passed through untouched;
        // the server validator refuses anything non-integer or negative.
        overageRateCentsPer1k: row.overage_rate_cents_per_1k,
      })
      if (r.ok) { toast({ title: `Saved overage terms — ${row.plan_tier} ${row.metric}` }); reload() }
      else toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  function publish(row: AIOverageTermsRow) {
    startTransition(async () => {
      const r = await publishOverageMeteredPriceAction({ planTier: row.plan_tier, metric: row.metric })
      if (r.ok) {
        toast({
          title: `Published to Stripe — ${row.plan_tier} ${row.metric}`,
          description: `Metered price ${r.priceId} linked on ${r.linked} subscription(s)${r.notLinked.length ? `; ${r.notLinked.length} stay on invoice items` : ''}.`,
        })
        reload()
      } else toast({ title: 'Not published', description: r.error, variant: 'destructive' })
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Overage terms (AI tokens + video minutes)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Per-tier billing terms for usage past the included allowance. Overage is served and billed at period close only
          when enabled; the rate is integer <span className="font-medium">cents per 1K units</span> (¢ per 1K tokens for AI,
          ¢ per 1K minutes for video) — configured here exactly like the tier price, never hardcoded. Publishing a tier to
          Stripe creates a metered price on a Billing Meter and attaches it to that tier&apos;s subscriptions, so the overage
          lands as a metered line on the subscription invoice; unpublished tiers bill the same amount as an invoice item.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {OVERAGE_BILLED_METRICS.map((metric) => {
          const unit = OVERAGE_METRIC_UNIT[metric]
          const group = rows.filter((r) => r.metric === metric)
          return (
            <div key={metric} className="space-y-2">
              <p className="text-sm font-semibold">{unit.label} — {metric}</p>
              {group.length === 0 && (
                <p className="text-sm text-muted-foreground">No {metric} plan limits found — seed the included allowance first.</p>
              )}
              {group.map((row) => {
                const s = stripeState(row)
                return (
                  <div key={row.id} className="flex flex-wrap items-end gap-3 rounded border p-3">
                    <div className="min-w-[150px]">
                      <p className="text-sm font-medium">{row.plan_tier}</p>
                      <p className="text-[11px] text-muted-foreground">Included: {units(row.limit_value, unit.plural)}/mo</p>
                    </div>
                    <label className="flex items-center gap-2 text-sm pb-1">
                      <input
                        type="checkbox"
                        checked={row.overage_allowed}
                        disabled={row.limit_value < 0}
                        onChange={(e) => patch(row.id, { overage_allowed: e.target.checked })}
                      />
                      Overage billed
                    </label>
                    <div className="w-44">
                      <p className="text-[11px] text-muted-foreground mb-1">Rate (¢ per 1K {unit.plural})</p>
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        value={row.overage_rate_cents_per_1k}
                        onChange={(e) => patch(row.id, { overage_rate_cents_per_1k: e.target.value === '' ? 0 : Number(e.target.value) })}
                      />
                    </div>
                    <Badge variant="outline" className="text-[10px] mb-2">
                      {metric === 'ai_tokens_monthly'
                        ? `= $${perMillion(row.overage_rate_cents_per_1k)} / 1M ${unit.plural}`
                        : `= $${perUnit(row.overage_rate_cents_per_1k)} / ${unit.singular}`}
                    </Badge>
                    <Badge className={`text-[10px] mb-2 ${s.tone}`}>{s.label}</Badge>
                    <Button size="sm" disabled={pending} onClick={() => save(row)}>
                      {pending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !row.overage_allowed || row.overage_rate_cents_per_1k <= 0 || !row.stripe_link_readable}
                      onClick={() => publish(row)}
                      title="Create/refresh the Stripe metered price at the SAVED rate and attach it to this tier's subscriptions"
                    >
                      <UploadCloud className="h-4 w-4 mr-1.5" />{row.stripe_metered_price_id ? 'Republish to Stripe' : 'Publish metered price'}
                    </Button>
                  </div>
                )
              })}
            </div>
          )
        })}

        <div className="space-y-1">
          <p className="text-sm font-semibold">Change log</p>
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground">No overage term changes recorded yet.</p>
          ) : (
            <ul className="text-xs space-y-1">
              {log.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-2">
                  <span className="text-muted-foreground">{e.createdAtIso.slice(0, 16).replace('T', ' ')}</span>
                  <span className="font-medium">{e.actorEmail ?? 'staff'}</span>
                  <span>{e.action === 'plan_limits.overage_metered_price_published' ? 'published to Stripe' : 'terms updated'}</span>
                  <span className="font-mono">
                    {String(e.details.planTier ?? '')} {String(e.details.metric ?? 'ai_tokens_monthly')}
                    {e.details.overageRateCentsPer1k != null ? ` · ${String(e.details.overageAllowed) === 'false' ? 'off' : 'on'} @ ${String(e.details.overageRateCentsPer1k)}¢/1K` : ''}
                    {e.details.priceId ? ` · ${String(e.details.priceId)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
