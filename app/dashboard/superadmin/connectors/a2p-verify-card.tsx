"use client"

// One-click pre-production A2P verification: runs the whole ISV registration
// chain against the live Twilio account with a MOCK brand (no TCR filing, no
// fees). Pick a tenant that has a subaccount + saved business profile —
// honest errors name exactly what's missing at each step.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ShieldCheck } from "lucide-react"
import { verifyA2pPipelineMockAction } from "@/app/actions/superadmin/a2p-verify"

export function A2pVerifyCard() {
  const [brokerageId, setBrokerageId] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const run = async () => {
    setBusy(true); setResult(null)
    const r = await verifyA2pPipelineMockAction(brokerageId.trim())
    setResult(r.error ? `${r.statusLine ? `${r.statusLine} — ` : ""}${r.error}` : r.statusLine)
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Verify A2P pipeline (mock)
        </CardTitle>
        <CardDescription className="text-xs">
          Runs the entire carrier-registration chain (TrustHub profile → trust product → brand →
          messaging service → campaign) against the live Twilio account with a MOCK brand — Twilio's
          documented integration test, no real filing or fees. Run once per environment before go-live.
          The tenant needs a provisioned number and a saved business profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex gap-2">
          <Input placeholder="Brokerage id (uuid)" value={brokerageId} onChange={(e) => setBrokerageId(e.target.value)} className="max-w-xs" />
          <Button size="sm" onClick={run} disabled={busy || !brokerageId.trim()}>Run mock verification</Button>
        </div>
        {result && <div className="text-xs text-muted-foreground">{result}</div>}
      </CardContent>
    </Card>
  )
}
