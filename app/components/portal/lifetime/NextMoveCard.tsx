"use client"

// NextMoveCard — "Your Next Move" radar. The lifetime customer's portal is not a
// dead end: their built equity quietly opens real options (move up, right-size,
// invest, refinance, improve). This card surfaces those as SELF-DIRECTED taps —
// the homeowner chooses to start a conversation; nothing is targeted at them.
// A tap records a client-INITIATED re-transaction intent (submitNextMoveIntent),
// which notifies their agent AND rides the manager bus (AI ISA -> Sphere Manager
// -> the right next step). Equity/tenure framing only — no protected-class signal.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Compass, Loader2, CheckCircle2, ArrowRight } from "lucide-react"
import { submitNextMoveIntent } from "@/app/actions/portal-lifetime"
import { nextMoveDeck, type NextMoveIntent } from "@/lib/portal/next-move"

export function NextMoveCard({
  contactId,
  estimatedEquity,
  yearsHeld,
}: {
  contactId: string
  estimatedEquity?: number | null
  yearsHeld?: number | null
}) {
  const deck = nextMoveDeck({ estimatedEquity, yearsHeld })
  const [busy, setBusy] = useState<NextMoveIntent | null>(null)
  const [done, setDone] = useState<NextMoveIntent | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function tap(intent: NextMoveIntent) {
    setErr(null)
    setBusy(intent)
    const res = await submitNextMoveIntent({ contactId, intent })
    setBusy(null)
    if (res.ok) setDone(intent)
    else setErr(res.error ?? "Something went wrong — please try again.")
  }

  if (done) {
    const picked = deck.options.find((o) => o.intent === done)
    return (
      <Card className="shadow-lg border-0">
        <CardContent className="p-6 text-center space-y-2">
          <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto" />
          <p className="font-semibold text-foreground">Your agent is on it</p>
          <p className="text-sm text-muted-foreground">
            {picked
              ? `We've let your agent know you're interested in "${picked.title.toLowerCase()}." They'll reach out — no pressure, no obligation.`
              : "We've let your agent know. They'll reach out soon."}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="shadow-lg border-0 md:col-span-2 lg:col-span-3">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Compass className="h-4 w-4 text-violet-600" />
          Your Next Move
        </CardTitle>
        <p className="text-xs text-muted-foreground">{deck.headline}</p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {deck.options.map((o) => (
            <button
              key={o.intent}
              onClick={() => void tap(o.intent)}
              disabled={busy !== null}
              className="group text-left rounded-lg border border-border p-3 transition-colors hover:border-violet-400 hover:bg-violet-50/50 disabled:opacity-60"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-sm text-foreground">{o.title}</p>
                {busy === o.intent ? (
                  <Loader2 className="h-4 w-4 animate-spin text-violet-600 shrink-0" />
                ) : (
                  <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-violet-600 shrink-0" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{o.blurb}</p>
              <p className="text-xs font-medium text-violet-700 mt-2">{o.cta}</p>
            </button>
          ))}
        </div>
        {err && <p className="text-xs text-destructive mt-2">{err}</p>}
        <p className="text-[11px] text-muted-foreground mt-3">
          These are options, not advice — tapping just starts a conversation with your agent.
        </p>
      </CardContent>
    </Card>
  )
}
