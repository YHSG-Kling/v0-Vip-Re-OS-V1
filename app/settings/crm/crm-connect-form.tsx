"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  connectCrmAction,
  disconnectCrmAction,
  syncContactNowAction,
  type CrmProvider,
} from "@/app/actions/crm-connect"

const PROVIDERS: Array<{ key: CrmProvider; label: string; needsUrl?: boolean; hint: string }> = [
  { key: "followupboss", label: "Follow Up Boss", hint: "API key from FUB → Admin → API" },
  { key: "lofty", label: "Lofty", needsUrl: true, hint: "API token from Lofty; API host optional" },
  { key: "gohighlevel", label: "GoHighLevel", hint: "Location API key" },
]

export function CrmConnectForm({
  active,
  connected,
}: {
  active: string | null
  connected: CrmProvider[]
}) {
  const [keys, setKeys] = useState<Record<string, string>>({})
  // The SECOND HALF of a key+secret pair. Optional, and separate from `keys`
  // because a blank one must arrive as absent rather than as "" — the server
  // treats "" as no secret for exactly that reason (crm-connect.ts).
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const [syncId, setSyncId] = useState("")
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  function connect(p: CrmProvider) {
    setMsg(null)
    start(async () => {
      const res = await connectCrmAction({
        provider: p,
        apiKey: keys[p] ?? "",
        apiSecret: secrets[p] ?? undefined,
        apiUrl: urls[p],
      })
      setMsg(res.ok ? `Connected ${p} ✓` : `Error: ${res.error}`)
    })
  }
  function disconnect(p: CrmProvider) {
    start(async () => {
      const res = await disconnectCrmAction(p)
      setMsg(res.ok ? `Disconnected ${p}` : `Error: ${res.error}`)
    })
  }
  function syncNow() {
    setSyncMsg(null)
    start(async () => {
      const res = await syncContactNowAction(syncId.trim())
      setSyncMsg(res.ok ? `Synced to ${res.providerKey} (${res.action ?? "ok"})` : `Error: ${res.error}`)
    })
  }

  return (
    <div className="space-y-4">
      {msg && <div className="text-sm text-muted-foreground">{msg}</div>}
      {PROVIDERS.map((p) => {
        const isConnected = connected.includes(p.key)
        return (
          <Card key={p.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                {p.label}
                {isConnected && <Badge variant="default">connected</Badge>}
                {active === p.key && <Badge variant="outline">active</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">{p.hint}. Sync-out only — pushes contact updates.</p>
              <Input
                type="password"
                placeholder="API key"
                value={keys[p.key] ?? ""}
                onChange={(e) => setKeys((s) => ({ ...s, [p.key]: e.target.value }))}
              />
              {/* The pair's SECOND half. Optional — most CRMs issue a single key, and
                  the column it fills (agent_api_credentials.api_secret /
                  integration_credentials.api_secret) had no writer at all until this
                  box existed, so any provider that DOES issue a secret resolved as
                  key-only and could not authenticate. Stored encrypted; never echoed
                  back into this form. */}
              <Input
                type="password"
                placeholder="API secret (only if your provider issues one)"
                value={secrets[p.key] ?? ""}
                onChange={(e) => setSecrets((s) => ({ ...s, [p.key]: e.target.value }))}
              />
              {p.needsUrl && (
                <Input
                  placeholder="API host (optional, e.g. https://api.lofty.com/v1)"
                  value={urls[p.key] ?? ""}
                  onChange={(e) => setUrls((s) => ({ ...s, [p.key]: e.target.value }))}
                />
              )}
              <div className="flex gap-2">
                <Button size="sm" disabled={pending} onClick={() => connect(p.key)}>
                  {isConnected ? "Update + set active" : "Connect"}
                </Button>
                {isConnected && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => disconnect(p.key)}>
                    Disconnect
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Sync a contact now</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">Pushes one contact OUT to the active CRM via the sync layer.</p>
          <div className="flex gap-2">
            <Input placeholder="Contact ID" value={syncId} onChange={(e) => setSyncId(e.target.value)} />
            <Button size="sm" disabled={pending || !syncId.trim()} onClick={syncNow}>Sync now</Button>
          </div>
          {syncMsg && <div className="text-sm text-muted-foreground">{syncMsg}</div>}
        </CardContent>
      </Card>
    </div>
  )
}
