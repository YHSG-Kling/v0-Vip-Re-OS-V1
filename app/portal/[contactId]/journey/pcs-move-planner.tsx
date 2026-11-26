"use client"

// app/portal/[contactId]/journey/pcs-move-planner.tsx
//
// THE PERSON'S OWN PCS MOVE PLAN (wave 153, lane 153K — convergence row 61). Rendered on the journey page for the military
// persona beside its "PCS Planning" stage. The person shares only what they choose (destination, report date, their own BAH,
// VA interest, their own home numbers) and agrees first; planMyPcsMove refuses anyone but the person and anything without that
// agreement. The plan cites official sources by name and link — the OS never fetches or infers orders or allowances.

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2 } from "lucide-react"
import { planMyPcsMove } from "@/app/actions/portal-pcs-plan"

type PlanResult = Awaited<ReturnType<typeof planMyPcsMove>>

const num = (s: string): number | null => {
  const t = s.replace(/[$,\s]/g, "")
  return t === "" ? null : Number(t)
}

export default function PcsMovePlanner({ contactId }: { contactId: string }) {
  const [destination, setDestination] = useState("")
  const [installation, setInstallation] = useState("")
  const [state, setState] = useState("")
  const [reportDate, setReportDate] = useState("")
  const [bah, setBah] = useState("")
  const [va, setVa] = useState(false)
  const [home, setHome] = useState({ value: "", balance: "", payment: "", rent: "" })
  const [consent, setConsent] = useState(false)
  const [result, setResult] = useState<PlanResult | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      const anyHome = Object.values(home).some((v) => v.trim() !== "")
      const r = await planMyPcsMove({
        contactId, consentGiven: consent, destinationLabel: destination, installationName: installation || null,
        destinationState: state || null, reportDate: reportDate || null, bahMonthly: num(bah), vaInterest: va,
        currentHome: anyHome ? { value: num(home.value), mortgageBalance: num(home.balance), monthlyPayment: num(home.payment), expectedRent: num(home.rent) } : null,
      })
      setResult(r)
    })
  }

  const plan = result && result.ok ? result.plan : null
  return (
    <div className="rounded-xl border p-4 space-y-4">
      <div>
        <h3 className="font-semibold">Plan my PCS move</h3>
        <p className="text-xs text-muted-foreground">
          Share only what you want to. We use it to plan your move with your agent; we never look up orders or service history.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm space-y-1">Where you are moving<Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="City or area" /></label>
        <label className="text-sm space-y-1">Installation (optional)<Input value={installation} onChange={(e) => setInstallation(e.target.value)} /></label>
        <label className="text-sm space-y-1">State (two letters)<Input value={state} maxLength={2} onChange={(e) => setState(e.target.value)} /></label>
        <label className="text-sm space-y-1">Report date (optional)<Input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} /></label>
        <label className="text-sm space-y-1">Monthly BAH from your LES (optional)<Input inputMode="decimal" value={bah} onChange={(e) => setBah(e.target.value)} /></label>
        <label className="text-sm flex items-center gap-2 pt-6"><input type="checkbox" checked={va} onChange={(e) => setVa(e.target.checked)} /> I am interested in a VA loan</label>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer">Compare selling with renting out my current home (optional)</summary>
        <div className="grid gap-3 sm:grid-cols-2 pt-2">
          <label className="space-y-1">Home value<Input inputMode="decimal" value={home.value} onChange={(e) => setHome({ ...home, value: e.target.value })} /></label>
          <label className="space-y-1">Loan balance<Input inputMode="decimal" value={home.balance} onChange={(e) => setHome({ ...home, balance: e.target.value })} /></label>
          <label className="space-y-1">Monthly payment (with taxes and insurance)<Input inputMode="decimal" value={home.payment} onChange={(e) => setHome({ ...home, payment: e.target.value })} /></label>
          <label className="space-y-1">Expected monthly rent<Input inputMode="decimal" value={home.rent} onChange={(e) => setHome({ ...home, rent: e.target.value })} /></label>
        </div>
      </details>
      <label className="text-sm flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        I agree that my agent's team may use the details I share here to plan my move. My report date is saved so their timing follows it; the dollar amounts are used for this plan only.
      </label>
      <Button onClick={submit} disabled={pending || !consent || destination.trim().length < 2}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Plan my move"}
      </Button>
      {result && !result.ok && <p className="text-sm text-destructive">{result.message}</p>}
      {plan && result && result.ok && (
        <div className="space-y-3 text-sm">
          {result.dateLine && <p>{result.dateLine}</p>}
          {result.notes.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
          <ol className="list-decimal pl-5 space-y-1">
            {plan.steps.map((s) => <li key={s.key}>{s.what}</li>)}
          </ol>
          {plan.sellVsRent && (
            <div className="rounded-md bg-muted p-3 space-y-1">
              <p>Selling: {plan.sellVsRent.sell.netProceeds != null ? `about $${plan.sellVsRent.sell.netProceeds.toLocaleString("en-US")} after costs and the loan` : plan.sellVsRent.sell.why}</p>
              <p>Renting out: {plan.sellVsRent.rentOut.monthlyNet != null ? `about $${plan.sellVsRent.rentOut.monthlyNet.toLocaleString("en-US")} a month after costs and the payment` : plan.sellVsRent.rentOut.why}</p>
              <p className="text-xs text-muted-foreground">{plan.sellVsRent.assumptions.join(" · ")}. {plan.sellVsRent.boundary}</p>
            </div>
          )}
          <ul className="space-y-1">
            {plan.sources.map((s) => <li key={s.key}><a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.name}</a></li>)}
          </ul>
          <p className="text-xs text-muted-foreground">{plan.boundary}</p>
        </div>
      )}
    </div>
  )
}
