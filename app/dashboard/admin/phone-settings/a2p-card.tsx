"use client"

// Carrier registration (A2P 10DLC) — the tenant supplies their REAL business
// profile once; the platform files brand + campaign with the carrier registry
// and resumes automatically through the async reviews. Unregistered business
// texting gets filtered by US carriers — this card is why tenant texts land.

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ShieldCheck } from "lucide-react"
import { getA2pStatusAction, saveA2pBusinessProfileAction, runA2pRegistrationAction } from "@/app/actions/a2p-registration"

const FIELDS: Array<{ key: string; label: string; placeholder?: string }> = [
  { key: "legalName", label: "Legal business name" },
  { key: "ein", label: "EIN (9 digits)" },
  { key: "website", label: "Website", placeholder: "https://" },
  { key: "street", label: "Street address" },
  { key: "city", label: "City" },
  { key: "region", label: "State" },
  { key: "postalCode", label: "ZIP" },
  { key: "contactFirstName", label: "Contact first name" },
  { key: "contactLastName", label: "Contact last name" },
  { key: "contactEmail", label: "Contact email" },
  { key: "contactPhone", label: "Contact phone" },
]

export function A2pRegistrationCard() {
  const [statusLine, setStatusLine] = useState<string>("Loading…")
  const [profileSaved, setProfileSaved] = useState(false)
  const [missing, setMissing] = useState<string[]>([])
  const [form, setForm] = useState<Record<string, string>>({})
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    getA2pStatusAction().then((r) => {
      if (r.ok) {
        setStatusLine(r.status.statusLine)
        setProfileSaved(r.status.profileSaved)
        setMissing(r.status.profileMissing)
      } else setStatusLine(r.error)
    })
  }, [])

  const save = async () => {
    setBusy(true); setNote(null)
    const r = await saveA2pBusinessProfileAction(form)
    if (!r.ok) setNote(r.missing?.length ? `Still needed: ${r.missing.join(", ")}` : r.error ?? "Save failed")
    else { setProfileSaved(true); setMissing([]); setShowForm(false); setNote("Profile saved — run registration below.") }
    setBusy(false)
  }

  const run = async () => {
    setBusy(true); setNote(null)
    const r = await runA2pRegistrationAction()
    setStatusLine(r.statusLine || r.error || "")
    if (r.error) setNote(r.error)
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
          Enter your business profile once; we file the brand and campaign for you and resume through
          the carrier reviews automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="text-sm">{statusLine}</div>
        {!profileSaved && missing.length > 0 && (
          <div className="text-xs text-amber-600">Business profile needed: {missing.join(", ")}</div>
        )}
        {showForm && (
          <div className="grid grid-cols-2 gap-2">
            {FIELDS.map((f) => (
              <Input key={f.key} placeholder={f.placeholder ?? f.label} aria-label={f.label}
                value={form[f.key] ?? ""} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} />
            ))}
            <div className="col-span-2 flex gap-2">
              <Button size="sm" onClick={save} disabled={busy}>Save profile</Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)} disabled={busy}>Cancel</Button>
            </div>
          </div>
        )}
        {!showForm && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowForm(true)} disabled={busy}>
              {profileSaved ? "Edit business profile" : "Enter business profile"}
            </Button>
            <Button size="sm" onClick={run} disabled={busy || !profileSaved}>Run / resume registration</Button>
          </div>
        )}
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  )
}
