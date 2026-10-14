"use client"

// Settings → General → "Brokerage affiliation" (wave 141A). Rendered only for a
// solo / team workspace (an org tier IS the brokerage). Two halves of the one
// identity rule (lib/kernel/brokerage-identity.ts):
//   · the affiliated brokerage the subscriber DECLARES — business context on
//     their own workspace, never a link to another tenant;
//   · adoption requests ADDRESSED TO THIS WORKSPACE by a brokerage on the
//     platform — the owner consents (their statement is recorded as evidence)
//     or declines. Consent runs the migration immediately; the result is shown.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Building2, Loader2 } from "lucide-react"
import { getBrokerageAffiliationPanelAction, declareBrokerageAffiliationAction, type AffiliationPanel } from "@/app/actions/settings/brokerage-affiliation"
import { listIncomingTransferRequestsAction, respondToBrokerageTransferAction, type TransferRequestView } from "@/app/actions/brokerage-transfer"

export function BrokerageAffiliationCard() {
  const [panel, setPanel] = useState<AffiliationPanel | null>(null)
  const [requests, setRequests] = useState<TransferRequestView[]>([])
  const [name, setName] = useState("")
  const [licenseNumber, setLicenseNumber] = useState("")
  const [licenseState, setLicenseState] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [statement, setStatement] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const reload = async () => {
    const [p, r] = await Promise.all([getBrokerageAffiliationPanelAction(), listIncomingTransferRequestsAction()])
    if (p.ok) {
      setPanel(p.panel)
      const a = p.panel.affiliation
      if (a) { setName(a.name); setLicenseNumber(a.license_number ?? ""); setLicenseState(a.license_state ?? ""); setCity(a.city ?? ""); setState(a.state ?? "") }
    }
    if (r.ok) setRequests(r.requests)
  }
  useEffect(() => { reload().catch(() => {}) }, [])

  if (!panel || !panel.applicable) return null

  const save = () => {
    setError(null); setNotice(null)
    startTransition(async () => {
      const r = await declareBrokerageAffiliationAction({ name, licenseNumber: licenseNumber || null, licenseState: licenseState || null, city: city || null, state: state || null })
      if (!r.ok) { setError(r.error); return }
      setNotice("Saved. This is context for your disclosures — your workspace stays your own.")
      await reload()
    })
  }
  const respond = (id: string, decision: "consent" | "decline") => {
    setError(null); setNotice(null)
    startTransition(async () => {
      const r = await respondToBrokerageTransferAction({ requestId: id, decision, statement })
      if (!r.ok) { setError(r.error ?? "Could not record your answer"); return }
      if (decision === "decline") setNotice("Declined. The brokerage has been told.")
      else if (r.completed) setNotice("Done — your workspace now belongs to the brokerage. Sign in again to see it.")
      else setNotice(`Consent recorded. The migration stalled at ${r.stalledAt?.replace(/_/g, " ") ?? "a step"}${r.migrationError ? `: ${r.migrationError}` : ""}. The brokerage has been notified and can retry.`)
      setStatement("")
      await reload()
    })
  }

  const open = requests.filter((r) => r.status === "requested")
  const history = requests.filter((r) => r.status !== "requested")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Building2 className="h-4 w-4" /> Brokerage affiliation</CardTitle>
        <CardDescription>
          The brokerage you hang your licence with. Shown on your disclosures and documents. Declaring a name never
          links your workspace to another account — a brokerage on the platform can adopt your workspace only with your
          explicit consent below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          {panel.columnMissing ? <p className="text-sm text-amber-700">Declared affiliations cannot be saved yet — this feature is finishing its rollout.</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="aff-name">Brokerage name</Label>
              <Input id="aff-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="Harbor Realty — Northside office" />
            </div>
            <div className="space-y-1"><Label htmlFor="aff-lic">Brokerage licence number</Label><Input id="aff-lic" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} maxLength={64} /></div>
            <div className="space-y-1"><Label htmlFor="aff-lic-state">Licence state</Label><Input id="aff-lic-state" value={licenseState} onChange={(e) => setLicenseState(e.target.value.toUpperCase())} maxLength={2} placeholder="FL" /></div>
            <div className="space-y-1"><Label htmlFor="aff-city">City</Label><Input id="aff-city" value={city} onChange={(e) => setCity(e.target.value)} maxLength={120} /></div>
            <div className="space-y-1"><Label htmlFor="aff-state">State</Label><Input id="aff-state" value={state} onChange={(e) => setState(e.target.value.toUpperCase())} maxLength={2} placeholder="FL" /></div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} disabled={pending || panel.columnMissing || name.trim().length < 2}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save affiliation</Button>
            {panel.affiliation ? <p className="text-xs text-muted-foreground">Declared {new Date(panel.affiliation.declared_at).toLocaleDateString()}</p> : null}
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">Adoption requests</p>
          {open.length === 0 ? <p className="text-sm text-muted-foreground">No brokerage has asked to adopt your workspace.</p> : null}
          {open.map((r) => (
            <div key={r.id} className="space-y-2 rounded-md border p-3">
              <p className="text-sm"><strong>{r.targetName ?? "A brokerage"}</strong> asks to adopt your workspace as its {r.targetRole.replace(/_/g, " ")}.{r.reason ? ` "${r.reason}"` : ""}</p>
              <p className="text-xs text-muted-foreground">
                If you consent: your contacts, deals, listings, campaigns and media move to the brokerage, your individual
                billing stops at the effective time (no double billing, nothing refunded or charged that you did not agree to),
                and this workspace is archived — never deleted.
              </p>
              <div className="space-y-1">
                <Label htmlFor={`consent-${r.id}`}>Your statement (recorded as evidence)</Label>
                <Input id={`consent-${r.id}`} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={`I, the owner of this workspace, consent to joining ${r.targetName ?? "this brokerage"}.`} maxLength={1000} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => respond(r.id, "consent")} disabled={pending || statement.trim().length < 8}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Consent and move my workspace</Button>
                <Button variant="outline" onClick={() => respond(r.id, "decline")} disabled={pending}>Decline</Button>
              </div>
            </div>
          ))}
          {history.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {history.map((r) => <li key={r.id}>{r.targetName ?? "A brokerage"} · {r.status}{r.completedAt ? ` · ${new Date(r.completedAt).toLocaleDateString()}` : ""}</li>)}
            </ul>
          ) : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}
