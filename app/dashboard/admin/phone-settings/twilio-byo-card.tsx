"use client"

/**
 * BYO Twilio card — the Multi-Location escape hatch for tenants that already
 * hold their own carrier contract.
 *
 * Wave 4 slice 2: `app/actions/voice-tenancy.ts:setTwilioByoCredsAction` was a
 * finished, tier-gated, validated credential writer with **no UI anywhere** —
 * the one commercially-promised way off platform-managed telephony could not be
 * reached by the customer it was written for.
 *
 * Two things this card is careful about:
 *  1. The auth token is WRITE-ONLY. `getTwilioByoStatusAction` returns the
 *     Account SID (a public identifier) and a boolean; the token is never sent
 *     back to the browser, so "connected" is shown without echoing a secret.
 *  2. The tier rule is ENFORCED IN THE ACTION, not here. This card only decides
 *     whether to render, and it renders the action's own refusal text verbatim
 *     if the two ever disagree.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PhoneCall, Loader2, CheckCircle2, AlertTriangle } from "lucide-react"
import { setTwilioByoCredsAction } from "@/app/actions/voice-tenancy"

export function TwilioByoCard({
  initialConfigured,
  initialAccountSid,
}: {
  initialConfigured: boolean
  initialAccountSid: string | null
}) {
  const [configured, setConfigured] = useState(initialConfigured)
  const [savedSid, setSavedSid] = useState(initialAccountSid)
  const [showForm, setShowForm] = useState(!initialConfigured)
  const [accountSid, setAccountSid] = useState("")
  const [authToken, setAuthToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleSave() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const r = await setTwilioByoCredsAction({ accountSid, authToken }).catch(() => ({
        ok: false,
        error: "Could not reach the server",
      }))
      if (!r.ok) {
        // Includes the tier refusal ("Multi-Location tier feature…") and both
        // format validations. Shown as written — never softened into a generic
        // "failed", and never reported as success.
        setError(r.error ?? "Could not save those credentials")
        return
      }
      setConfigured(true)
      setSavedSid(accountSid.trim())
      setAuthToken("")
      setAccountSid("")
      setShowForm(false)
      setSaved(true)
    })
  }

  return (
    <Card className="mx-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <PhoneCall className="h-4 w-4" />
          Bring your own Twilio
          {configured && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-800">
              Connected
            </span>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          Your Multi-Location plan can run the phone system on your own Twilio account
          instead of platform-managed numbers. Calls are then billed by Twilio directly to
          you. Leave this empty and everything keeps running on your dedicated
          platform-managed subaccount — nothing to set up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {configured && savedSid && (
          <div className="rounded border p-3 flex items-center justify-between">
            <div>
              <p className="font-medium">Account SID</p>
              <p className="text-xs text-muted-foreground font-mono">{savedSid}</p>
            </div>
            {!showForm && (
              <Button variant="outline" size="sm" onClick={() => { setShowForm(true); setSaved(false) }}>
                Replace credentials
              </Button>
            )}
          </div>
        )}

        {saved && (
          <p className="flex items-center gap-2 text-xs text-green-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved. New numbers and calls will resolve through your Twilio account.
          </p>
        )}

        {showForm && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="byo-sid" className="text-xs">Twilio Account SID</Label>
                <Input
                  id="byo-sid"
                  value={accountSid}
                  onChange={(e) => setAccountSid(e.target.value)}
                  placeholder="AC…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="byo-token" className="text-xs">Twilio Auth Token</Label>
                <Input
                  id="byo-token"
                  type="password"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder="Never shown again once saved"
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </div>
            </div>

            {error && (
              <p className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </p>
            )}

            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={isPending || !accountSid || !authToken}>
                {isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
                ) : (
                  "Save Twilio credentials"
                )}
              </Button>
              {configured && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setShowForm(false); setError(null); setAccountSid(""); setAuthToken("") }}
                  disabled={isPending}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
