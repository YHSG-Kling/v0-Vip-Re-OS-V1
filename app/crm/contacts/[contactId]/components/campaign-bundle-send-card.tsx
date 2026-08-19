"use client"

/**
 * app/crm/contacts/[contactId]/components/campaign-bundle-send-card.tsx
 *
 * Dispatch a saved campaign bundle to THIS contact.
 *
 * The bundle builder at /settings/campaign-bundles composes an ordered set of
 * (channel, preset) steps and tells the user in its own copy that "nothing
 * sends until you dispatch it" — and until now there was no dispatch anywhere
 * in the product. The multi-channel dispatcher
 * (lib/direct-mail/orchestrate-bundle-send.ts) had no caller, so
 * campaign_bundle_dispatches had no writer and the bundle-attribution rollup
 * cron had nothing to roll up.
 *
 * The contact record is where a bundle actually gets sent to someone, which is
 * why the send lives here and the composition lives in settings.
 *
 * Every gate stays where it was: the server action proves the contact is in the
 * caller's tenant, and each channel orchestrator still runs its own compliance
 * check per piece (consent, DNC, opt-out, quiet hours). A bundle is not a way
 * around any of that — which is why the per-channel outcomes are reported
 * individually below rather than collapsed into one "sent".
 */

import { useState, useTransition } from "react"
import { Send, Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { sendCampaignBundleToContactAction } from "@/app/actions/campaign-bundle-dispatch"

export interface BundleOption {
  id: string
  name: string
  description: string | null
  stepCount: number
}

export function CampaignBundleSendCard({
  contactId,
  bundles,
}: {
  contactId: string
  bundles: BundleOption[]
}) {
  const [bundleId, setBundleId] = useState<string>("")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Array<{ channel: string; success: boolean; error?: string }> | null>(null)
  const [sentBundleName, setSentBundleName] = useState<string | null>(null)

  function send() {
    if (!bundleId) {
      setError("Pick a bundle first.")
      return
    }
    startTransition(async () => {
      setError(null)
      setOutcomes(null)
      setSentBundleName(null)
      const result = await sendCampaignBundleToContactAction({ bundleId, contactId })
      // The dispatcher reports per-channel outcomes and an overall ok that is
      // "at least one channel succeeded". Both halves are shown: claiming a
      // send for a piece the compliance gate refused is exactly the failure
      // this card exists not to repeat.
      setOutcomes(result.channelOutcomes ?? null)
      if (!result.success) {
        setError(result.error ?? "The bundle did not send.")
        return
      }
      setSentBundleName(result.bundleName ?? null)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="h-4 w-4" />
          Send a campaign bundle
        </CardTitle>
        <CardDescription>
          Fires every step of a saved bundle at this contact. Each piece still passes its own
          compliance gate, so a bundle can partly deliver — the result below says which parts did.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {bundles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active bundles in your scope. Build one under Settings → Campaign bundles.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Select value={bundleId} onValueChange={setBundleId}>
                <SelectTrigger className="max-w-80">
                  <SelectValue placeholder="Choose a bundle" />
                </SelectTrigger>
                <SelectContent>
                  {bundles.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name} · {b.stepCount} step{b.stepCount === 1 ? "" : "s"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={send} disabled={isPending}>
                {isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
                Send bundle
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {sentBundleName && (
              <p className="text-sm text-muted-foreground">
                Dispatched <strong>{sentBundleName}</strong>.
              </p>
            )}

            {outcomes && outcomes.length > 0 && (
              <ul className="space-y-1.5">
                {outcomes.map((o, i) => (
                  <li key={`${o.channel}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline" className="text-[11px]">{o.channel}</Badge>
                    <span className={o.success ? "text-emerald-700" : "text-destructive"}>
                      {o.success ? "sent" : (o.error ?? "not sent")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
