"use client"

// RelocatedClientCard — the nurture lane for a past client who LEFT our market
// (moved away, downsized out of area, entered senior living, etc.). We don't push
// equity / maintenance / "your next move" they can't use. Instead: stay in touch,
// be a referral SOURCE for people still here, and — if they're still moving — get
// them a great agent in their NEW area (a referral-OUT: goodwill + a referral fee).
//
// Fair housing: we never ask or store WHY they relocated. Just "where are you
// headed?" so we can connect them with the right local expert there.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Heart, Loader2, CheckCircle2, MapPin } from "lucide-react"
import { requestRelocationReferral } from "@/app/actions/portal-lifetime"

export function RelocatedClientCard({
  contactId,
  agentFirstName,
}: {
  contactId: string
  agentFirstName?: string | null
}) {
  const [area, setArea] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function request() {
    setErr(null)
    setBusy(true)
    const res = await requestRelocationReferral({ contactId, newArea: area || null })
    setBusy(false)
    if (res.ok) setDone(true)
    else setErr(res.error ?? "Something went wrong — please try again.")
  }

  return (
    <Card className="shadow-lg border-0 md:col-span-2 lg:col-span-3">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Heart className="h-4 w-4 text-rose-600" />
          Wherever you are, you're still family
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {agentFirstName ? `${agentFirstName} is` : "Your agent is"} still here for you — even from a distance. Two ways we can keep helping:
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Referral-out: an agent in their new area */}
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-2 mb-1">
            <MapPin className="h-4 w-4 text-rose-600" />
            <p className="font-medium text-sm">Moving somewhere new?</p>
          </div>
          {done ? (
            <p className="text-sm text-emerald-600 flex items-center gap-1.5 mt-2">
              <CheckCircle2 className="h-4 w-4" />
              {agentFirstName ? `${agentFirstName} will` : "Your agent will"} personally connect you with a trusted agent there.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-2">
                We'll connect you with a top agent in your new area — hand-picked, no cold searching. Tell us where you're headed.
              </p>
              <div className="flex gap-2">
                <Input
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  placeholder="City or area you're moving to (optional)"
                  maxLength={120}
                  disabled={busy}
                />
                <Button onClick={() => void request()} disabled={busy} className="shrink-0">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect me"}
                </Button>
              </div>
              {err && <p className="text-xs text-destructive mt-2">{err}</p>}
            </>
          )}
        </div>

        {/* Referral-in: still a source for people here */}
        <div className="rounded-lg border border-border p-3">
          <p className="font-medium text-sm">Know someone buying or selling here?</p>
          <p className="text-xs text-muted-foreground mt-1">
            Even after a move, the best compliment is sending a friend or family member our way. Use the referral card below — we'll take great care of them.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
