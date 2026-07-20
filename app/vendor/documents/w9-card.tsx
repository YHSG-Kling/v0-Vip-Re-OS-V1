"use client"

/**
 * Vendor W-9 card (owner round 43) — the capture surface on the vendor
 * document center. Upload the signed W-9 PDF (existing client-documents
 * rail via uploadVendorW9Action) + the structured basics: legal name,
 * W-9 line-3 classification, TIN TYPE only (EIN vs SSN — the TIN itself is
 * never asked for or stored; it lives only inside the PDF), signature date.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { FileBadge, Loader2, ExternalLink, AlertTriangle } from "lucide-react"
import { uploadVendorW9Action } from "@/app/actions/vendor-w9"
// Client-safe pure vocab module — never the IO half (keeps the dispatch rail
// out of the client bundle).
import {
  W9_BUSINESS_TYPES,
  W9_BUSINESS_TYPE_LABELS,
  type VendorW9Read,
  type W9BusinessType,
  type W9TinType,
} from "@/lib/vendors/w9-vocab"

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  on_file: { label: "W-9 on file", cls: "bg-green-100 text-green-800" },
  missing: { label: "W-9 missing", cls: "bg-amber-100 text-amber-800" },
  expired: { label: "W-9 needs update", cls: "bg-red-100 text-red-800" },
}

export function VendorW9Card({ vendorId, w9 }: { vendorId: string; w9: VendorW9Read }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(w9.status !== "on_file")
  const [legalName, setLegalName] = useState(w9.record?.legalName ?? "")
  const [businessType, setBusinessType] = useState<W9BusinessType>(w9.record?.businessType ?? "individual_sole_proprietor")
  const [tinType, setTinType] = useState<W9TinType>(w9.record?.tinType ?? "ein")
  const [signatureDate, setSignatureDate] = useState(w9.record?.signatureDate ?? "")
  const [file, setFile] = useState<File | null>(null)

  const badge = STATUS_BADGE[w9.status] ?? STATUS_BADGE.missing

  function handleSubmit() {
    setError(null)
    if (!file) { setError("Attach your signed W-9 (PDF or scan)"); return }
    startTransition(async () => {
      const reader = new FileReader()
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "")
        reader.onerror = () => reject(new Error("Could not read the file"))
        reader.readAsDataURL(file)
      }).catch(() => null)
      if (!base64) { setError("Could not read the file"); return }
      const r = await uploadVendorW9Action({
        vendorId,
        file: { name: file.name, type: file.type, base64 },
        legalName,
        businessType,
        tinType,
        signatureDate,
      })
      if (!r.success) { setError(r.error ?? "Upload failed"); return }
      setShowForm(false)
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileBadge className="h-4 w-4" />
          Tax form W-9
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.cls}`}>{badge.label}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {w9.status !== "on_file" && (
          <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-amber-900 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              {w9.status === "expired"
                ? "Your legal name changed after your W-9 was filed — upload an updated, signed W-9 so 1099 reporting stays accurate."
                : "Your brokerage partner must report payments to the IRS (Form 1099), which requires your completed W-9. Payouts and invoicing are not blocked, but please put one on file."}
            </p>
          </div>
        )}

        {w9.record?.documentUrl && (
          <div className="flex items-center justify-between rounded border p-3">
            <div>
              <p className="font-medium">W-9 — {w9.record.legalName ?? "on file"}</p>
              <p className="text-xs text-muted-foreground">
                {w9.record.businessType ? W9_BUSINESS_TYPE_LABELS[w9.record.businessType] : ""}
                {w9.record.tinType ? ` · TIN type: ${w9.record.tinType.toUpperCase()}` : ""}
                {w9.record.signatureDate ? ` · signed ${w9.record.signatureDate}` : ""}
              </p>
            </div>
            <a href={w9.record.documentUrl} target="_blank" rel="noopener noreferrer"
               className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              <ExternalLink className="h-3 w-3" /> Open
            </a>
          </div>
        )}

        {!showForm ? (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            {w9.status === "on_file" ? "Replace W-9" : "Upload W-9"}
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium">Legal name (W-9 line 1)</span>
                <input className="w-full rounded border px-2 py-1.5 text-sm" value={legalName}
                       onChange={(e) => setLegalName(e.target.value)} placeholder="As shown on your tax return" />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">Federal tax classification (line 3)</span>
                <select className="w-full rounded border px-2 py-1.5 text-sm" value={businessType}
                        onChange={(e) => setBusinessType(e.target.value as W9BusinessType)}>
                  {W9_BUSINESS_TYPES.map((t) => (
                    <option key={t} value={t}>{W9_BUSINESS_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </label>
              <div className="space-y-1 text-xs">
                <span className="font-medium">TIN type certified (Part I)</span>
                <div className="flex gap-4 pt-1">
                  {(["ein", "ssn"] as const).map((t) => (
                    <label key={t} className="flex items-center gap-1.5">
                      <input type="radio" name="tinType" checked={tinType === t} onChange={() => setTinType(t)} />
                      <span>{t.toUpperCase()}</span>
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Only the type is recorded — your TIN stays on the signed form, never in our database.
                </p>
              </div>
              <label className="space-y-1 text-xs">
                <span className="font-medium">Signature date (Part II)</span>
                <input type="date" className="w-full rounded border px-2 py-1.5 text-sm" value={signatureDate}
                       onChange={(e) => setSignatureDate(e.target.value)} />
              </label>
            </div>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Signed W-9 (PDF or scan)</span>
              <input type="file" accept="application/pdf,image/png,image/jpeg"
                     onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
            </label>
            {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSubmit} disabled={isPending}>
                {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Uploading…</> : "Save W-9"}
              </Button>
              {w9.status === "on_file" && (
                <Button size="sm" variant="ghost" onClick={() => setShowForm(false)} disabled={isPending}>Cancel</Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
