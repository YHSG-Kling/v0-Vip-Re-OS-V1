"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, HelpCircle, ShieldCheck } from "lucide-react"
import { approveVendor, rejectVendor, requestVendorInfo, setVendorComplianceCredential, setVendorTierPricing } from "@/app/actions/vendor-verification"
import { readVendorInsurance, type InsurancePosture, type InsuranceRecord } from "@/lib/vendors/insurance-posture"

/** Same four-state vocabulary the vendor directory badges use. Grey means "we do
 *  not know", which is never rounded up to green or down to red. */
const INSURANCE_BADGE: Record<InsurancePosture, string> = {
  verified:  "bg-green-100 text-green-800 border-green-200",
  expiring:  "bg-amber-100 text-amber-900 border-amber-300",
  expired:   "bg-red-100 text-red-800 border-red-300",
  no_expiry: "bg-muted text-muted-foreground border-transparent",
  never:     "bg-muted text-muted-foreground border-transparent",
}

type TierPrice = { tier: "basic" | "standard" | "premium" | "preferred_network"; price: number }

export interface PendingVendor {
  id: string
  name: string | null
  category: string | null
  email: string | null
  phone: string | null
  website: string | null
  ai_verification_score: number | null
  verification_flags: string[] | null
  /** m376 credential bag — the certificate of insurance lives under `.insurance`. */
  compliance_credentials?: Record<string, InsuranceRecord | null | undefined> | null
}

/**
 * Super-admin / broker vendor approval queue. Nothing here auto-approves — a human clicks Approve
 * (→ active/surfaceable), Reject (→ inactive), or Request Info. Each button calls the admin-gated
 * server action; a vendor can never self-activate.
 */
export function VendorApprovalClient({ vendors, pricing }: { vendors: PendingVendor[]; pricing?: TierPrice[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // EVERY control here reads its outcome. These actions THROW on refusal (not an
  // admin, vendor outside your brokerage, an illegal status transition, an
  // expiry the m376 CHECK rejects) — and the previous version of this function
  // had no catch at all, so a refusal was indistinguishable from success: the
  // spinner stopped, the page refreshed, and nothing had happened.
  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    setErrors((prev) => ({ ...prev, [id]: "" }))
    try {
      await fn()
      router.refresh()
    } catch (e) {
      setErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : "The server refused that change." }))
    } finally {
      setBusy(null)
    }
  }

  const scoreColor = (s: number | null) =>
    s == null ? "bg-muted text-muted-foreground"
      : s >= 70 ? "bg-green-100 text-green-800 border-green-200"
      : s >= 40 ? "bg-amber-100 text-amber-800 border-amber-200"
      : "bg-red-100 text-red-800 border-red-200"

  const pricingEditor = pricing && pricing.length > 0 ? (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Vendor subscription pricing (your brokerage)</CardTitle></CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">Set custom monthly prices for vendor tiers. Blank/0 falls back to the platform default.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          {pricing.map((p) => (
            <div key={p.tier} className="space-y-1">
              <label className="text-xs font-medium capitalize">{p.tier.replace("_", " ")}</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">$</span>
                <input
                  type="number" min={0} defaultValue={p.price}
                  className="border rounded px-2 py-1 text-sm w-24"
                  disabled={busy === `price-${p.tier}`}
                  onBlur={(e) => { const val = Number(e.target.value); if (val !== p.price) run(`price-${p.tier}`, () => setVendorTierPricing(p.tier, val)) }}
                />
                <span className="text-xs text-muted-foreground">/mo</span>
              </div>
              {errors[`price-${p.tier}`] && (
                <p className="text-[11px] text-destructive">{errors[`price-${p.tier}`]}</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  ) : null

  if (vendors.length === 0) {
    return (
      <div className="space-y-4">
        {pricingEditor}
        <Card className="bg-green-50 border-green-200">
          <CardContent className="pt-6 flex items-center gap-2 text-green-900">
            <ShieldCheck className="h-5 w-5" /> No vendors awaiting approval — the bench is fully vetted.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
    {pricingEditor}
    <div className="grid gap-3 md:grid-cols-2">
      {vendors.map((v) => (
        <Card key={v.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="truncate">{v.name ?? "Unnamed vendor"}</span>
              <Badge className={`text-xs border ${scoreColor(v.ai_verification_score)}`}>
                {v.ai_verification_score == null ? "unscored" : `${v.ai_verification_score}/100`}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm text-muted-foreground space-y-0.5">
              {v.category && <div>{v.category}</div>}
              {v.email && <div className="truncate">{v.email}</div>}
              {v.phone && <div>{v.phone}</div>}
              {v.website && <div className="truncate">{v.website}</div>}
            </div>
            {v.verification_flags && v.verification_flags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {v.verification_flags.map((f) => (
                  <Badge key={f} variant="outline" className="text-[10px] text-amber-700 border-amber-200">{f.replace(/_/g, " ")}</Badge>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" disabled={busy === v.id} onClick={() => run(v.id, () => approveVendor(v.id))}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
              </Button>
              <Button size="sm" variant="outline" disabled={busy === v.id} onClick={() => run(v.id, () => rejectVendor(v.id, "not_approved"))}>
                <XCircle className="h-4 w-4 mr-1" /> Reject
              </Button>
              <Button size="sm" variant="ghost" disabled={busy === v.id} onClick={() => run(v.id, () => requestVendorInfo(v.id, ["license", "insurance"]))}>
                <HelpCircle className="h-4 w-4 mr-1" /> Request info
              </Button>
            </div>
            {/* INSURANCE POSTURE, computed from the stored expiry — so the
                approver sees whether coverage is live BEFORE they click Approve
                and put this vendor in front of a client. */}
            {(() => {
              const ins = readVendorInsurance(v.compliance_credentials, new Date())
              return (
                <div className="space-y-1">
                  <Badge className={`text-[11px] border ${INSURANCE_BADGE[ins.posture]}`} title={ins.detail}>
                    {ins.posture === "verified" ? <ShieldCheck className="h-3 w-3 mr-1" /> : null}
                    {ins.label}
                  </Badge>
                  <p className="text-[11px] text-muted-foreground leading-snug">{ins.detail}</p>
                </div>
              )
            })()}

            {/* Record insurance / license expiry — the document-expiry monitor acts on these dates.
                Pre-filled from what is on file, so the input shows the date it is about to replace. */}
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
              <span className="text-muted-foreground">Insurance expiry:</span>
              <input
                type="date"
                className="border rounded px-1.5 py-0.5 text-xs"
                defaultValue={readVendorInsurance(v.compliance_credentials, new Date()).expiry ?? ""}
                disabled={busy === v.id}
                onChange={(e) => e.target.value && run(v.id, () => setVendorComplianceCredential(v.id, "insurance", e.target.value))}
              />
              <span className="text-muted-foreground">License expiry:</span>
              <input
                type="date"
                className="border rounded px-1.5 py-0.5 text-xs"
                defaultValue={(v.compliance_credentials?.license?.expiry ?? "") as string}
                disabled={busy === v.id}
                onChange={(e) => e.target.value && run(v.id, () => setVendorComplianceCredential(v.id, "license", e.target.value))}
              />
            </div>

            {/* The refusal, in the server's own words. */}
            {errors[v.id] && <p className="text-xs text-destructive">{errors[v.id]}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
    </div>
  )
}
