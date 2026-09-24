"use client"

// Phone test — gated on business registration (wave 81D). Shows, per lane the
// tenant's numbers need (10DLC for local, toll-free verification for 8xx), the
// carrier's own status, and lets a broker ring their own phone only once every
// lane is registered. A refusal names the reason; nothing is faked.

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PhoneCall } from "lucide-react"
import { getPhoneTestReadinessAction, placePhoneTestCallAction } from "@/app/actions/phone-test-call"

type Readiness = { ready: boolean; lanes: Array<{ lane: string; registered: boolean; statusLine: string }>; reason: string | null; numbers: string[] }

export function PhoneTestCard() {
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [toNumber, setToNumber] = useState("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = () => {
    getPhoneTestReadinessAction().then((r) => {
      if (r.ok) { setReadiness(r.readiness); setLoadError(null) } else setLoadError(r.error)
    }).catch((e) => setLoadError(e instanceof Error ? e.message : "Could not read registration status"))
  }
  useEffect(() => { load() }, [])

  const test = async () => {
    setBusy(true); setNote(null)
    const r = await placePhoneTestCallAction({ toNumber })
    if (r.ok) setNote(`Ringing ${toNumber} from ${r.fromNumber} (call ${r.callSid}).`)
    else { setNote(r.error); if (r.readiness) setReadiness((prev) => prev ? { ...prev, ...r.readiness! } : prev) }
    setBusy(false)
    load()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <PhoneCall className="h-4 w-4" /> Phone test — after business registration
        </CardTitle>
        <CardDescription className="text-xs">
          Registration starts automatically when a number is purchased or ported in. The test call is available once every lane your numbers need is carrier-registered; until then this card says exactly what is outstanding.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loadError && <div className="text-xs text-red-600">{loadError}</div>}
        {readiness && (
          <div className="space-y-1">
            {readiness.lanes.length === 0 && <div className="text-xs text-amber-700">{readiness.reason}</div>}
            {readiness.lanes.map((l) => (
              <div key={l.lane} className="flex items-start gap-2 text-xs">
                <span className={`rounded px-2 py-0.5 ${l.registered ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{l.lane === "10dlc" ? "10DLC" : "Toll-free"}</span>
                <span className="text-muted-foreground">{l.statusLine}</span>
              </div>
            ))}
            {readiness.numbers.length > 0 && <div className="text-[11px] text-muted-foreground">Active numbers: {readiness.numbers.join(", ")}</div>}
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <Input className="max-w-[16rem]" placeholder="Your mobile, e.g. +1 512 555 0100" value={toNumber} onChange={(e) => setToNumber(e.target.value)} disabled={busy} />
          <Button size="sm" onClick={test} disabled={busy || !readiness?.ready || toNumber.replace(/\D/g, "").length < 10}>
            {busy ? "Dialing…" : "Ring my phone"}
          </Button>
          {readiness && !readiness.ready && <span className="text-xs text-amber-700">{readiness.reason}</span>}
        </div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  )
}
