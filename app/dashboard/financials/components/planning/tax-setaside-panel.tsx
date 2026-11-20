"use client"

// ESTIMATED QUARTERLY TAXES — the person's planner (wave 153, lane 153A). Owner: "make sure estimate quarterly taxes work
// (if we cant determine their tax percentages, then the user can enter that in)". Everything shown comes from THE ONE
// estimator (lib/finance/tax-planning.ts via getTaxPlanAction). No rate is ever pre-filled: until the person (or their
// accountant) enters one, the planner asks for it and shows no reserve. Recording a payment APPENDS; nothing is paid here.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PiggyBank, Info, CalendarClock, Loader2, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { getTaxPlanAction, saveTaxAssumptionsAction, recordQuarterlyPaymentAction, saveTaxProfileAction } from "@/app/actions/tax-planning"
import { EXPENSE_CATEGORIES } from "@/lib/documents/receipt-rules"

interface TaxSetasidePanelProps {
  ytdGCI: number
  /** Legacy prop from the parent page; the planner no longer uses a set-aside percentage of its own. */
  setAsidePercent: number
  /** Told the combined rate the person ENTERED (federal + state, in percent), or 0 when none is entered. */
  onUpdatePercent: (pct: number) => void
}

type Plan = Extract<Awaited<ReturnType<typeof getTaxPlanAction>>, { success: true }>["plan"]
type Source = "self_entered" | "accountant_supplied"

const fmt = (val: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val)
const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
const pct = (v: number | undefined | null) => (v == null ? "" : String(Math.round(v * 10000) / 100))
const sourceLabel = (s: string | undefined) => (s === "accountant_supplied" ? "from your accountant" : "entered by you")

export function TaxSetasidePanel({ onUpdatePercent }: TaxSetasidePanelProps) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // TENANT OPTION (m574): tax assistance is opt-in per brokerage. When the action refuses with the
  // disabled sentinel, the panel explains quietly instead of rendering tools every save would refuse.
  const [disabledByBrokerage, setDisabledByBrokerage] = useState(false)
  const [pending, startTransition] = useTransition()
  const [federal, setFederal] = useState("")
  const [state, setState] = useState("")
  const [source, setSource] = useState<Source>("self_entered")
  const [payQuarter, setPayQuarter] = useState<1 | 2 | 3 | 4>(1)
  const [payAmount, setPayAmount] = useState("")
  const [payKind, setPayKind] = useState<"payment" | "set_aside">("payment")
  const [targets, setTargets] = useState<Record<number, string>>({})
  // Profile facts shown beside the plan (never used to derive a rate).
  const [filing, setFiling] = useState<string>("")
  const [homeState, setHomeState] = useState<string>("")

  const loadPlan = () => {
    getTaxPlanAction().then((res) => {
      if (res.success) {
        setPlan(res.plan)
        const a = res.plan.inputs.assumptions
        setFederal(pct(a.federalRate?.value)); setState(pct(a.stateRate?.value))
        setFiling(res.profile.filingStatus ?? ""); setHomeState(res.profile.homeState ?? "")
        onUpdatePercent(a.federalRate && a.stateRate ? Math.round((a.federalRate.value + a.stateRate.value) * 10000) / 100 : 0)
        const open = res.plan.quarterly.find((q) => q.status !== "recorded" && q.status !== "past_due_nothing_recorded")
        if (open) setPayQuarter(open.quarter)
        setLoadError(null)
      } else if ((res.error ?? "").startsWith("tax_assistance_disabled")) {
        setDisabledByBrokerage(true)
      } else {
        setLoadError(res.error)
      }
      setLoading(false)
    })
  }
  useEffect(loadPlan, []) // eslint-disable-line react-hooks/exhaustive-deps

  const save = (fn: () => ReturnType<typeof saveTaxAssumptionsAction>, ok: string) => {
    startTransition(async () => {
      const res = await fn()
      if (res.success) { toast.success(ok); loadPlan() }
      else toast.error("That change was not saved", { description: res.error })
    })
  }
  const saveRates = () => {
    const f = federal.trim() === "" ? null : Number(federal) / 100
    const s = state.trim() === "" ? null : Number(state) / 100
    if ((f != null && !Number.isFinite(f)) || (s != null && !Number.isFinite(s))) { toast.error("Enter each rate as a percentage, like 22 or 4.5"); return }
    startTransition(async () => {
      const a = await saveTaxAssumptionsAction({ change: { key: "federalRate", value: f }, source })
      const b = a.success ? await saveTaxAssumptionsAction({ change: { key: "stateRate", value: s }, source }) : a
      if (a.success && b.success) { toast.success("Your rates are saved — the plan below uses them"); loadPlan() }
      else toast.error("Your rates were not saved", { description: (!a.success ? a.error : !b.success ? b.error : undefined) })
    })
  }
  const recordPayment = () => {
    const amount = Number(payAmount)
    startTransition(async () => {
      const res = await recordQuarterlyPaymentAction({ quarter: payQuarter, amount, kind: payKind })
      if (res.success) { toast.success(`Q${payQuarter} ${payKind === "set_aside" ? "set-aside" : "payment"} recorded`); setPayAmount(""); loadPlan() }
      else toast.error("That was not recorded", { description: res.error })
    })
  }

  if (disabledByBrokerage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><PiggyBank className="h-5 w-5 text-muted-foreground" />Estimated Quarterly Taxes</CardTitle>
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

  const a = plan?.inputs.assumptions
  const confirmed = new Set(a?.deductibleCategories?.value ?? [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PiggyBank className="h-5 w-5 text-green-600" />Estimated Quarterly Taxes</CardTitle>
        <CardDescription>A planning reserve from your recorded income and the rates you enter — not the amount legally due.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building your tax plan…</div>
        ) : loadError || !plan ? (
          <p className="text-sm text-muted-foreground">{loadError ?? "Your tax planner could not be loaded right now."}</p>
        ) : (
          <>
            {/* ── Your rates (never pre-filled) ── */}
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">Your estimated tax rates</p>
              <p className="text-xs text-muted-foreground">
                We can&apos;t know your personal rates (filing status, other income, deductions and your state all change them), so enter
                what you or your accountant use. Self-employment tax is calculated for you from the IRS formula.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="tax-federal" className="text-xs">Federal %</Label>
                  <Input id="tax-federal" inputMode="decimal" placeholder="e.g. 22" value={federal} onChange={(e) => setFederal(e.target.value)} />
                  {a?.federalRate && <p className="text-[11px] text-muted-foreground">{sourceLabel(a.federalRate.source)} · {a.federalRate.period} · updated {dateLabel(a.federalRate.updatedAt.slice(0, 10))} · v{a.federalRate.version}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tax-state" className="text-xs">State % (0 if your state has no income tax)</Label>
                  <Input id="tax-state" inputMode="decimal" placeholder="e.g. 5" value={state} onChange={(e) => setState(e.target.value)} />
                  {a?.stateRate && <p className="text-[11px] text-muted-foreground">{sourceLabel(a.stateRate.source)} · {a.stateRate.period} · updated {dateLabel(a.stateRate.updatedAt.slice(0, 10))} · v{a.stateRate.version}</p>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-1"><input type="radio" name="tax-source" checked={source === "self_entered"} onChange={() => setSource("self_entered")} /> I chose these</label>
                <label className="flex items-center gap-1"><input type="radio" name="tax-source" checked={source === "accountant_supplied"} onChange={() => setSource("accountant_supplied")} /> My accountant gave these</label>
                <Button size="sm" onClick={saveRates} disabled={pending}>{pending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save rates</Button>
              </div>
            </div>

            {plan.flags.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                {plan.flags.map((f) => <li key={f} className="flex gap-1.5"><AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />{f}</li>)}
              </ul>
            )}

            {/* ── The four quantities, kept separate ── */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Net so far ({plan.basis.value === "accrual" ? "earned" : "received"})</p>
                <p className="font-semibold">{fmt(plan.periodToDate.net)}</p>
                <p className="text-[11px] text-muted-foreground">{fmt(plan.periodToDate.income)} income − {fmt(plan.periodToDate.confirmedDeductible)} confirmed deductible</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Projected {plan.taxYear} reserve</p>
                <p className="font-semibold">{plan.reserve ? fmt(plan.reserve.projectedAnnualReserve) : "Needs your rates"}</p>
                {plan.reserve && <p className="text-[11px] text-muted-foreground">incl. {fmt(plan.reserve.selfEmploymentTax.total)} self-employment ({plan.reserve.selfEmploymentSource === "statutory" ? "IRS formula" : "your rate"})</p>}
              </div>
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Already set aside / paid</p>
                <p className="font-semibold">{fmt(plan.alreadySetAsideOrPaid)}</p>
              </div>
              <div className="rounded-lg bg-green-50 border border-green-200 p-3">
                <p className="text-xs text-green-700">Still suggested to set aside</p>
                <p className="font-semibold text-green-800">{plan.remainingSuggestedReserve == null ? "Needs your rates" : fmt(plan.remainingSuggestedReserve)}</p>
              </div>
            </div>

            {/* ── Quarters: real due dates, suggestions only for quarters ahead ── */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium"><CalendarClock className="h-4 w-4 text-indigo-600" /> Quarterly dates</div>
              {plan.quarterly.map((q) => (
                <div key={q.quarter} className="flex items-center justify-between text-sm rounded-md border px-3 py-2 gap-2">
                  <span className="text-muted-foreground">Q{q.quarter} · due {dateLabel(q.dueDate)}{q.dueDateSource === "your_schedule" ? " (your date)" : ""}</span>
                  <span className="text-right">
                    {q.suggested != null && <span className="font-medium">{fmt(q.suggested)}{q.suggestedSource === "accountant" ? " (accountant)" : ""}</span>}
                    {q.status === "needs_input" && <span className="text-xs text-muted-foreground">rates needed</span>}
                    {q.recorded > 0 && <span className="ml-2 text-[11px] text-emerald-700">{fmt(q.recorded)} recorded</span>}
                    {q.status === "past_due_nothing_recorded" && <span className="ml-2 text-[11px] text-amber-700">nothing recorded</span>}
                  </span>
                </div>
              ))}
            </div>

            {/* ── Record what you paid or set aside (appends; nothing is paid here) ── */}
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">Record a payment or set-aside</p>
              <div className="flex flex-wrap items-end gap-2">
                <select aria-label="Quarter" className="h-9 rounded border bg-background px-2 text-sm" value={payQuarter} onChange={(e) => setPayQuarter(Number(e.target.value) as 1 | 2 | 3 | 4)}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>Q{n}</option>)}
                </select>
                <select aria-label="Kind" className="h-9 rounded border bg-background px-2 text-sm" value={payKind} onChange={(e) => setPayKind(e.target.value as "payment" | "set_aside")}>
                  <option value="payment">Paid</option>
                  <option value="set_aside">Set aside</option>
                </select>
                <Input aria-label="Amount" inputMode="decimal" className="w-32" placeholder="Amount" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                <Button size="sm" variant="outline" onClick={recordPayment} disabled={pending || !(Number(payAmount) > 0)}>Record</Button>
              </div>
              <p className="text-[11px] text-muted-foreground">Pay through IRS Direct Pay or your usual method; this only records it. Earlier entries are kept.</p>
            </div>

            {/* ── Advanced: basis, deductible categories, accountant amounts, your schedule ── */}
            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">More settings — income basis, deductible categories, accountant amounts, due dates</summary>
              <div className="mt-3 space-y-3">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Count income when it is</p>
                  <div className="flex gap-2">
                    {(["cash", "accrual"] as const).map((b) => (
                      <Button key={b} size="sm" variant={plan.basis.chosen && plan.basis.value === b ? "default" : "outline"} disabled={pending}
                        onClick={() => save(() => saveTaxAssumptionsAction({ change: { key: "incomeBasis", value: b }, source }), "Income basis saved")}>
                        {b === "cash" ? "Received (cash)" : "Earned at closing (accrual)"}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Expense categories you (or your accountant) confirm are deductible — only these reduce the estimate</p>
                  <div className="flex flex-wrap gap-2">
                    {EXPENSE_CATEGORIES.map((c) => (
                      <label key={c} className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={confirmed.has(c)} disabled={pending}
                          onChange={(e) => {
                            const next = new Set(confirmed); if (e.target.checked) next.add(c); else next.delete(c)
                            save(() => saveTaxAssumptionsAction({ change: { key: "deductibleCategories", value: next.size ? [...next] : null }, source }), "Deductible categories saved")
                          }} />
                        {c}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Quarterly amounts your accountant gave you (used instead of the calculation for that quarter)</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([1, 2, 3, 4] as const).map((n) => (
                      <div key={n} className="flex items-center gap-1">
                        <span className="text-xs w-6">Q{n}</span>
                        <Input inputMode="decimal" className="h-8" placeholder={a?.accountantTargets[n] ? String(a.accountantTargets[n]!.value) : "—"} value={targets[n] ?? ""} onChange={(e) => setTargets((t) => ({ ...t, [n]: e.target.value }))} />
                        <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" disabled={pending}
                          onClick={() => save(() => saveTaxAssumptionsAction({ change: { key: "accountantTarget", quarter: n, value: (targets[n] ?? "").trim() === "" ? null : Number(targets[n]) }, source: "accountant_supplied" }), `Q${n} accountant amount saved`)}>
                          Save
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Filing status and home state (for your records and your accountant — they never set a rate)</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="Filing status" className="h-8 rounded border bg-background px-2 text-xs" value={filing} onChange={(e) => setFiling(e.target.value)}>
                      <option value="">Filing status…</option>
                      <option value="single">Single</option>
                      <option value="married_joint">Married filing jointly</option>
                      <option value="married_separate">Married filing separately</option>
                      <option value="head_of_household">Head of household</option>
                    </select>
                    <Input aria-label="Home state" className="h-8 w-20" maxLength={2} placeholder="ST" value={homeState} onChange={(e) => setHomeState(e.target.value.toUpperCase())} />
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" disabled={pending}
                      onClick={() => startTransition(async () => {
                        const res = await saveTaxProfileAction({ ...(filing ? { filingStatus: filing as "single" | "married_joint" | "married_separate" | "head_of_household" } : {}), homeState: homeState.trim() || null })
                        if (res.success) { toast.success("Saved"); loadPlan() } else toast.error("Not saved", { description: res.error })
                      })}>
                      Save
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Your own due dates (leave empty to use the IRS schedule)</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([1, 2, 3, 4] as const).map((n) => (
                      <div key={n} className="flex items-center gap-1">
                        <span className="text-xs w-6">Q{n}</span>
                        <Input type="date" className="h-8" defaultValue={a?.dueDateOverrides[n]?.value ?? ""} disabled={pending}
                          onBlur={(e) => {
                            const v = e.target.value || null
                            if (v === (a?.dueDateOverrides[n]?.value ?? null)) return
                            save(() => saveTaxAssumptionsAction({ change: { key: "dueDateOverride", quarter: n, value: v }, source }), v ? `Q${n} due date saved` : `Q${n} back on the IRS schedule`)
                          }} />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>IRS dates move to the next business day for weekends and holidays. Enter your own only when your accountant gives you different ones (a fiscal year, a state&apos;s schedule, a disaster postponement). Reminders follow whichever date applies.</span>
                </div>
              </div>
            </details>

            <p className="text-[11px] text-muted-foreground">{plan.disclaimer}</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
