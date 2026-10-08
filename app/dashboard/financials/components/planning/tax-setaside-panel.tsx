"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { PiggyBank, Check, Info, CalendarClock, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { getTaxPlanAction, saveTaxProfileAction, recordQuarterlyPaymentAction } from "@/app/actions/tax-planning"

interface TaxSetasidePanelProps {
  ytdGCI: number
  setAsidePercent: number
  onUpdatePercent: (pct: number) => void
}

type Plan = Extract<Awaited<ReturnType<typeof getTaxPlanAction>>, { success: true }>["plan"]

const fmt = (val: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val)

export function TaxSetasidePanel({ ytdGCI, setAsidePercent, onUpdatePercent }: TaxSetasidePanelProps) {
  const [localPercent, setLocalPercent] = useState(setAsidePercent)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  // TENANT OPTION (m574): tax assistance is opt-in per brokerage. When the action refuses with the
  // disabled sentinel, the panel explains quietly instead of rendering tools every save would refuse.
  const [disabledByBrokerage, setDisabledByBrokerage] = useState(false)
  const [pending, startTransition] = useTransition()

  const loadPlan = () => {
    getTaxPlanAction().then((res) => {
      if (res.success) {
        setPlan(res.plan)
        setLocalPercent(res.profile.setAsidePercent)
        onUpdatePercent(res.profile.setAsidePercent)
      } else if ((res.error ?? "").startsWith("tax_assistance_disabled")) {
        setDisabledByBrokerage(true)
      }
      setLoading(false)
    })
  }
  useEffect(loadPlan, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setAsideAmount = plan ? plan.setAsideAmount : (Math.max(0, ytdGCI) * localPercent) / 100

  const handleSliderChange = (value: number[]) => {
    setLocalPercent(value[0])
    onUpdatePercent(value[0])
  }

  const handleSave = () => {
    startTransition(async () => {
      const res = await saveTaxProfileAction({ setAsidePercent: localPercent })
      if (res.success) {
        setSaved(true)
        toast.success(`Set-aside of ${localPercent}% saved`, { description: `${fmt(setAsideAmount)} earmarked for taxes` })
        loadPlan()
        setTimeout(() => setSaved(false), 3000)
      } else {
        toast.error("Could not save your tax set-aside", { description: res.error })
      }
    })
  }

  const markQuarterPaid = (quarter: 1 | 2 | 3 | 4, amount: number) => {
    startTransition(async () => {
      const res = await recordQuarterlyPaymentAction({ quarter, amount })
      if (res.success) { toast.success(`Q${quarter} estimated payment recorded`); loadPlan() }
      else toast.error("Could not record the payment", { description: res.error })
    })
  }

  if (disabledByBrokerage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PiggyBank className="h-5 w-5 text-muted-foreground" />
            Tax Set-Aside & Quarterly Estimates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Tax assistance isn&apos;t enabled for your brokerage. A broker or admin can turn it on under
            Settings → Commission &amp; Offerings.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="h-5 w-5 text-green-600" />
          Tax Set-Aside & Quarterly Estimates
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Slider */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Set-aside percentage</span>
            <span className="text-lg font-semibold">{localPercent}%</span>
          </div>
          <Slider value={[localPercent]} onValueChange={handleSliderChange} min={0} max={35} step={1} className="w-full" />
          <div className="flex justify-between text-xs text-muted-foreground"><span>0%</span><span>35%</span></div>
        </div>

        {/* Amount display */}
        <div className="p-4 rounded-lg bg-green-50 border border-green-200 text-center">
          <p className="text-sm text-green-700">Set aside from your net income</p>
          <p className="text-3xl font-bold text-green-800">{fmt(setAsideAmount)}</p>
        </div>

        {/* Recommended range */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-medium">Recommended: 25-30%</p>
            <p className="text-muted-foreground">Most self-employed agents should set aside 25-30% of net income for federal + state + self-employment tax.</p>
          </div>
        </div>

        {/* Save button */}
        <Button onClick={handleSave} disabled={pending || saved} className="w-full" variant={saved ? "secondary" : "default"}>
          {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : saved ? <Check className="h-4 w-4 mr-2" /> : null}
          {saved ? "Saved" : "Save set-aside"}
        </Button>

        {/* Projected liability + SE-tax breakdown + quarterly schedule (the real planner) */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building your tax plan…</div>
        ) : plan ? (
          <div className="space-y-3 border-t pt-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Projected {plan.taxYear} tax</p>
                <p className="font-semibold">{fmt(plan.projectedAnnualTaxLiability)}</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">of which self-employment tax</p>
                <p className="font-semibold">{fmt(plan.selfEmploymentTax.total)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm font-medium"><CalendarClock className="h-4 w-4 text-indigo-600" /> Quarterly estimated payments</div>
            <div className="space-y-1.5">
              {plan.quarterly.map((q) => (
                <div key={q.quarter} className="flex items-center justify-between text-sm rounded-md border px-3 py-2">
                  <span className="text-muted-foreground">Q{q.quarter} · due {new Date(q.dueDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{fmt(q.amount)}</span>
                    {q.paid ? (
                      <span className="text-[11px] text-emerald-600 flex items-center gap-1"><Check className="h-3 w-3" /> paid</span>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => markQuarterPaid(q.quarter, q.amount)}>Mark paid</Button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">Estimates from your YTD commission income net of business expenses, annualized. Self-employment tax is exact (15.3%); the income-tax portion uses your blended effective rate — adjust with your CPA.</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
