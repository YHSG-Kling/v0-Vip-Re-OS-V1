"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, HelpCircle, ShieldCheck } from "lucide-react"
import { approveVendor, rejectVendor, requestVendorInfo, setVendorComplianceCredential } from "@/app/actions/vendor-verification"

export interface PendingVendor {
  id: string
  name: string | null
  category: string | null
  email: string | null
  phone: string | null
  website: string | null
  ai_verification_score: number | null
  verification_flags: string[] | null
}

/**
 * Super-admin / broker vendor approval queue. Nothing here auto-approves — a human clicks Approve
 * (→ active/surfaceable), Reject (→ inactive), or Request Info. Each button calls the admin-gated
 * server action; a vendor can never self-activate.
 */
export function VendorApprovalClient({ vendors }: { vendors: PendingVendor[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    try { await fn() ; router.refresh() } finally { setBusy(null) }
  }

  const scoreColor = (s: number | null) =>
    s == null ? "bg-muted text-muted-foreground"
      : s >= 70 ? "bg-green-100 text-green-800 border-green-200"
      : s >= 40 ? "bg-amber-100 text-amber-800 border-amber-200"
      : "bg-red-100 text-red-800 border-red-200"

  if (vendors.length === 0) {
    return (
      <Card className="bg-green-50 border-green-200">
        <CardContent className="pt-6 flex items-center gap-2 text-green-900">
          <ShieldCheck className="h-5 w-5" /> No vendors awaiting approval — the bench is fully vetted.
        </CardContent>
      </Card>
    )
  }

  return (
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
            {/* Record insurance / license expiry — the document-expiry monitor acts on these dates. */}
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
              <span className="text-muted-foreground">Insurance expiry:</span>
              <input
                type="date"
                className="border rounded px-1.5 py-0.5 text-xs"
                disabled={busy === v.id}
                onChange={(e) => e.target.value && run(v.id, () => setVendorComplianceCredential(v.id, "insurance", e.target.value))}
              />
              <span className="text-muted-foreground">License expiry:</span>
              <input
                type="date"
                className="border rounded px-1.5 py-0.5 text-xs"
                disabled={busy === v.id}
                onChange={(e) => e.target.value && run(v.id, () => setVendorComplianceCredential(v.id, "license", e.target.value))}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
