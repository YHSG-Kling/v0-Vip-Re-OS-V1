"use client"

// Carrier registration (A2P 10DLC) — the platform files brand + campaign with
// the carrier registry from the brokerage's Business registration BRANDING
// SETTING and resumes automatically through the async reviews. Unregistered
// business texting gets filtered by US carriers — this card is why tenant
// texts land.
//
// TOMBSTONE (wave 84D): the typed business-profile form that lived here (EIN,
// privacy / terms URLs and a retyped legal name / address / contact, saved by
// saveA2pBusinessProfileAction) is merged onto its survivor,
// app/components/settings/BusinessRegistrationCard.tsx on /settings/branding
// (owner: "add the registration info needed for registration in as a branding
// setting so that info is pulled for registration."). This card now READS what
// is missing from the same derivation the filing uses and links there.

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ShieldCheck } from "lucide-react"
import { getA2pStatusAction, runA2pRegistrationAction } from "@/app/actions/a2p-registration"

// Wave 140G: the tenant's ONE texting state (AVAILABLE / PENDING REGISTRATION /
// ACTION REQUIRED / RESTRICTED) is derived server-side from the stored carrier
// phase (lib/voice/carrier-registration-loop.ts) — this card only renders it.
type UiState = "AVAILABLE" | "PENDING_REGISTRATION" | "ACTION_REQUIRED" | "RESTRICTED"
const UI_STATE_CLASS: Record<UiState, string> = {
  AVAILABLE: "bg-emerald-100 text-emerald-800",
  PENDING_REGISTRATION: "bg-sky-100 text-sky-800",
  ACTION_REQUIRED: "bg-amber-100 text-amber-900",
  RESTRICTED: "bg-slate-200 text-slate-800",
}

export function A2pRegistrationCard() {
  const [statusLine, setStatusLine] = useState<string>("Loading…")
  const [profileSaved, setProfileSaved] = useState(false)
  const [missing, setMissing] = useState<string[]>([])
  const [settingsPath, setSettingsPath] = useState("/settings/branding#business-registration")
  const [ein, setEin] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [uiState, setUiState] = useState<UiState | null>(null)
  const [uiLabel, setUiLabel] = useState<string>("")
  const [reason, setReason] = useState<string>("")
  const [halted, setHalted] = useState(false)

  useEffect(() => {
    getA2pStatusAction().then((r) => {
      if (r.ok) {
        setStatusLine(r.status.statusLine)
        setProfileSaved(r.status.profileSaved)
        setMissing(r.status.profileMissing)
        setSettingsPath(r.status.settingsPath)
        // Masked server-side (redactDraftForClient) — never the full EIN.
        setEin(r.status.prefill.ein ?? "")
        setUiState(r.status.uiState)
        setUiLabel(r.status.uiLabel)
        setReason(r.status.reason)
        setHalted(r.status.halted)
      } else setStatusLine(r.error)
    })
  }, [])

  const run = async () => {
    setBusy(true); setNote(null)
    const r = await runA2pRegistrationAction()
    setStatusLine(r.statusLine || r.error || "")
    if (r.uiState) { setUiState(r.uiState); setUiLabel(r.uiLabel ?? r.uiState) }
    if (r.error) { setNote(r.error); setReason(r.error) } else { setHalted(false) }
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Carrier registration (A2P 10DLC)
        </CardTitle>
        <CardDescription className="text-xs">
          US carriers require business texting to be registered — unregistered messages get filtered.
          We file the brand and campaign from your Business registration settings the moment you pick
          or port a number; an hourly check walks it through the carrier reviews and unlocks the phone
          test on approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {uiState && (
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${UI_STATE_CLASS[uiState]}`}>{uiLabel || uiState}</span>
            {uiState === "ACTION_REQUIRED" && reason && <span className="text-xs text-amber-700">{reason}</span>}
            {uiState === "RESTRICTED" && <span className="text-xs text-muted-foreground">Texting is restricted until a number is registered.</span>}
          </div>
        )}
        <div className="text-sm">{statusLine}</div>
        {halted && (
          <div className="text-xs text-amber-700">Automatic filing is paused until this is corrected — it is not retried on its own. Run / resume retries once after the fix.</div>
        )}
        {!profileSaved && missing.length > 0 && (
          <div className="text-xs text-amber-700">Business registration still needs: {missing.join(", ")}</div>
        )}
        {profileSaved && ein && <div className="text-xs text-muted-foreground">Filing as EIN {ein}</div>}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href={settingsPath}>{profileSaved ? "Review business registration" : "Complete business registration"}</Link>
          </Button>
          <Button size="sm" onClick={run} disabled={busy || !profileSaved}>Run / resume registration</Button>
        </div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  )
}
