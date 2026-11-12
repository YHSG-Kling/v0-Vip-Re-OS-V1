"use client"

import { useEffect, useState } from "react"
import { FileText } from "lucide-react"
import { listVendorPortfolioForStaff, type VendorPortfolioRead } from "@/app/actions/vendor-portfolio"

/**
 * WORK SAMPLES in the vendor directory (wave 147, lane 147H) — the staff-side READER of the m906 portfolio store, so
 * what a vendor uploads on /vendor/portfolio actually reaches the agents choosing a vendor (a writer with no reader
 * is half a capability). Tenant from the session inside the action; signed links expire in an hour.
 */
export function VendorPortfolioStrip({ vendorId }: { vendorId: string }) {
  const [res, setRes] = useState<VendorPortfolioRead | null>(null)
  useEffect(() => {
    let live = true
    setRes(null)
    listVendorPortfolioForStaff(vendorId).then((r) => { if (live) setRes(r) }).catch((e) => { if (live) setRes({ ok: false, error: e instanceof Error ? e.message : "Could not load work samples." }) })
    return () => { live = false }
  }, [vendorId])

  if (!res) return <p className="text-sm text-muted-foreground">Loading work samples…</p>
  if (!res.ok) return <p className="text-sm text-destructive">{res.error}</p>
  if (!res.available) return <p className="text-sm text-muted-foreground">{res.note}</p>
  if (res.items.length === 0) return <p className="text-sm text-muted-foreground">This vendor has not added work samples yet.</p>
  return (
    <ul className="grid grid-cols-3 gap-2" aria-label="Work samples">
      {res.items.map((it) => (
        <li key={it.id} className="space-y-1">
          {it.url && it.mediaKind === "image" ? (
            <a href={it.url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={it.url} alt={it.title} className="h-20 w-full rounded object-cover" />
            </a>
          ) : (
            <a href={it.url ?? undefined} target="_blank" rel="noreferrer" className="flex h-20 items-center justify-center rounded bg-muted text-foreground" aria-label={`Open ${it.title}`}>
              <FileText className="h-5 w-5" />
            </a>
          )}
          <p className="truncate text-xs text-foreground" title={it.title}>{it.title}</p>
        </li>
      ))}
    </ul>
  )
}
