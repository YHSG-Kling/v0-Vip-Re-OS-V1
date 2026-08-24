"use client"

// app/portal/vendor/vendor-coverage-panel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THIS COMPANY WORKS — the vendor's own declaration, and the only writer
// for `vendor_service_areas` (m551).
//
// WHY IT IS ON THE VENDOR PORTAL AND NOT ON A BROKERAGE DASHBOARD. Coverage is a
// fact about the COMPANY, so it hangs off the global identity
// (vendor_marketplace_profiles), and a brokerage asserting that a title company
// is licensed in Nevada would be a brokerage asserting somebody else's
// licensure. The server gate admits exactly two writers — the vendor themselves
// or platform staff — and this panel is the vendor's half of that.
//
// A TABLE WITH NO REACHABLE WRITER RETURNS A PERMANENT ZERO THAT READS LIKE
// POLICY. That is the trap vendor-access-panel.tsx records paying for on
// vendor_contact_assignments, and it applies with more force here: with no
// coverage declared, m551's booking gate refuses EVERY booking with
// `vendor_coverage_unknown` — correctly, and forever, until this panel exists.
//
// STATE-LICENSED TRADES. For title, lender, refinance_lender, attorney and
// insurance the server REFUSES a declaration with no licence number, because a
// coverage row without one would look declared and never be bookable. The form
// says so before the round trip rather than after it.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { MapPin, Loader2, ShieldCheck, Ban } from "lucide-react"
import {
  declareVendorServiceAreaAction,
  withdrawVendorServiceAreaAction,
} from "@/app/actions/vendor-service-areas"
import { isStateLicensedTrade } from "@/lib/vendors/vendor-service-area"

export interface VendorCoverageRowView {
  id: string
  state: string
  zip_code: string | null
  trade_category: string
  status: string
  license: { policy_number?: string; expiry?: string } | null
}

export function VendorCoveragePanel({
  platformVendorId,
  tradeCategory,
  rows,
}: {
  /** NULL when this bench row has no platform identity — see the note below. */
  platformVendorId: string | null
  tradeCategory: string | null
  rows: VendorCoverageRowView[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState("")
  const [zip, setZip] = useState("")
  const [licenceNo, setLicenceNo] = useState("")
  const [licenceExpiry, setLicenceExpiry] = useState("")

  const licensed = isStateLicensedTrade(tradeCategory)

  // A bench row with no platform identity is a company a brokerage added by
  // hand; it has no global profile to hang coverage on. Saying that plainly
  // beats a form that cannot save.
  if (!platformVendorId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="h-4 w-4" /> Service areas
          </CardTitle>
          <CardDescription>
            Service areas belong to your company&apos;s platform profile. This listing was added
            directly by a brokerage and has no platform profile yet, so there is nowhere to record
            coverage. Ask the brokerage to send you a platform invitation.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  async function declare() {
    if (!tradeCategory) {
      toast.error("This listing has no trade set, so coverage cannot be recorded against one.")
      return
    }
    setBusy(true)
    const r = await declareVendorServiceAreaAction({
      platformVendorId: platformVendorId!,
      state,
      zipCode: zip.trim() === "" ? null : zip,
      tradeCategory,
      license: licenced(),
    })
    setBusy(false)
    if (!r.ok) { toast.error(r.error ?? "Could not save that service area"); return }
    toast.success(zip.trim() === "" ? `Statewide coverage saved for ${state.toUpperCase()}` : `Coverage saved for ${zip}`)
    setState(""); setZip(""); setLicenceNo(""); setLicenceExpiry("")
    router.refresh()
  }

  function licenced() {
    if (!licenceNo.trim()) return null
    return {
      policy_number: licenceNo.trim(),
      ...(licenceExpiry ? { expiry: licenceExpiry } : {}),
    }
  }

  async function withdraw(id: string) {
    setBusy(true)
    const r = await withdrawVendorServiceAreaAction({ platformVendorId: platformVendorId!, serviceAreaId: id })
    setBusy(false)
    if (!r.ok) { toast.error(r.error ?? "Could not withdraw"); return }
    toast.success("Coverage withdrawn")
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="h-4 w-4" /> Service areas
        </CardTitle>
        <CardDescription>
          Where your company works. Leave the ZIP blank for statewide coverage.
          {licensed && (
            <>
              {" "}
              <strong>This is a state-licensed trade</strong> — a licence number is required per
              state, and you cannot be booked in a state you have not declared and licensed.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="vsa-state">State</Label>
            <Input id="vsa-state" value={state} onChange={(e) => setState(e.target.value)}
              placeholder="AZ" maxLength={2} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vsa-zip">ZIP (blank = statewide)</Label>
            <Input id="vsa-zip" value={zip} onChange={(e) => setZip(e.target.value)} placeholder="85001" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vsa-lic">Licence number{licensed ? "" : " (optional)"}</Label>
            <Input id="vsa-lic" value={licenceNo} onChange={(e) => setLicenceNo(e.target.value)}
              placeholder={licensed ? "Required for this trade" : "—"} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vsa-exp">Licence expiry</Label>
            <Input id="vsa-exp" type="date" value={licenceExpiry}
              onChange={(e) => setLicenceExpiry(e.target.value)} />
          </div>
        </div>
        <Button onClick={declare} disabled={busy || !state.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
          Save service area
        </Button>

        <div className="space-y-2 pt-2">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No service areas declared yet — until one is, you cannot be booked anywhere.
            </p>
          ) : rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between rounded-md border p-2">
              <div className="flex items-center gap-2 text-sm">
                <Badge variant={r.status === "active" ? "default" : "secondary"}>{r.status}</Badge>
                <span className="font-medium">{r.state}{r.zip_code ? ` · ${r.zip_code}` : " · statewide"}</span>
                <span className="text-muted-foreground">{r.trade_category}</span>
                {r.license?.policy_number && (
                  <span className="text-xs text-muted-foreground">licence {r.license.policy_number}
                    {r.license.expiry ? ` · exp ${r.license.expiry}` : ""}</span>
                )}
              </div>
              {r.status === "active" && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => withdraw(r.id)}>
                  <Ban className="h-3.5 w-3.5 mr-1" /> Withdraw
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
