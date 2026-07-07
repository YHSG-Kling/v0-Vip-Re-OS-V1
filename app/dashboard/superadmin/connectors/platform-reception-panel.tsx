"use client"

// The PLATFORM's own AI reception line — bind the master-account number
// (TWILIO_PHONE_NUMBER) to the Twilio-native conversational lane and review
// what the line has been doing: calls answered, prospects captured, support
// transfers. The same engine that answers tenant lines, pointed at the app's
// own front door.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { PhoneCall } from "lucide-react"
import { bindPlatformReceptionAction, listPlatformReceptionCallsAction } from "@/app/actions/superadmin/platform-reception"

export function PlatformReceptionPanel() {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [calls, setCalls] = useState<any[] | null>(null)

  const bind = async () => {
    setBusy(true); setNote(null)
    const r = await bindPlatformReceptionAction()
    setNote(r.ok ? `AI reception is live on ${r.phoneNumber} — calls now route to the conversational lane.` : r.error)
    setBusy(false)
  }

  const load = async () => {
    setBusy(true); setNote(null)
    const r = await listPlatformReceptionCallsAction()
    if (r.ok) setCalls(r.calls)
    else setNote(r.error)
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PhoneCall className="h-4 w-4" /> Platform reception line
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          The platform's own number is answered by the AI receptionist: it pitches the product honestly
          (live plan pricing, never hardcoded), captures prospect hand-raises into the growth funnel, and
          routes existing-customer support. Bind after changing the number or app URL — it's idempotent.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={bind} disabled={busy}>Bind platform number</Button>
          <Button size="sm" variant="outline" onClick={load} disabled={busy}>Show recent calls</Button>
        </div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
        {calls && (
          calls.length === 0
            ? <div className="text-xs text-muted-foreground">No calls on the platform line yet.</div>
            : (
              <ul className="text-xs space-y-1">
                {calls.slice(0, 25).map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <Badge variant={c.outcome === "prospect_captured" ? "default" : "outline"}>
                      {c.outcome ?? c.status}
                    </Badge>
                    <span className="font-medium">{c.phone_from ?? "unknown caller"}</span>
                    <span className="text-muted-foreground">{c.started_at ? new Date(c.started_at).toLocaleString() : ""}</span>
                    {c.prospect_id && <span className="text-muted-foreground">→ prospect saved</span>}
                  </li>
                ))}
              </ul>
            )
        )}
      </CardContent>
    </Card>
  )
}
