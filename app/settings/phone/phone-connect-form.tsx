"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { connectPhoneAction, disconnectPhoneAction, type PhonePlatform } from "@/app/actions/phone-connect"

const PLATFORMS: Array<{ key: PhonePlatform; label: string; sidLabel: string }> = [
  { key: "twilio", label: "Twilio", sidLabel: "Account SID" },
  { key: "telnyx", label: "Telnyx", sidLabel: "API Key" },
  { key: "bandwidth", label: "Bandwidth", sidLabel: "Account ID" },
]

export function PhoneConnectForm({ connected }: { connected: Array<{ platform: string; fromNumber: string | null }> }) {
  const [platform, setPlatform] = useState<PhonePlatform>("twilio")
  const [sid, setSid] = useState("")
  const [token, setToken] = useState("")
  const [from, setFrom] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const current = PLATFORMS.find((p) => p.key === platform)!
  const connectedFor = connected.find((c) => c.platform === platform)

  function connect() {
    setMsg(null)
    start(async () => {
      const res = await connectPhoneAction({ platform, accountSid: sid, authToken: token, fromNumber: from })
      setMsg(res.ok ? `Connected ${platform} ✓ (${res.scope})` : `Error: ${res.error}`)
    })
  }
  function disconnect() {
    start(async () => {
      const res = await disconnectPhoneAction(platform)
      setMsg(res.ok ? `Disconnected ${platform}` : `Error: ${res.error}`)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          Phone / SMS
          {connectedFor && <Badge variant="default">connected · {connectedFor.fromNumber ?? platform}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">Used for AI ISA calls and SMS (TCPA-gated). Your own line takes precedence over the brokerage's.</p>
        <select
          className="w-full border rounded-md px-2 py-1.5 text-sm bg-background"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as PhonePlatform)}
        >
          {PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <Input placeholder={current.sidLabel} value={sid} onChange={(e) => setSid(e.target.value)} />
        <Input type="password" placeholder="Auth token" value={token} onChange={(e) => setToken(e.target.value)} />
        <Input placeholder="From number (+15551234567)" value={from} onChange={(e) => setFrom(e.target.value)} />
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={connect}>{connectedFor ? "Update" : "Connect"}</Button>
          {connectedFor && <Button size="sm" variant="outline" disabled={pending} onClick={disconnect}>Disconnect</Button>}
        </div>
        {msg && <div className="text-sm text-muted-foreground">{msg}</div>}
      </CardContent>
    </Card>
  )
}
