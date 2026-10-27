"use client"

// THE FINAL-VERSION RECORD (wave 145, lane 145Z — owner ruling 20). Every AI piece's final version: the text that was staged
// (or the approver's own edit), the brand line and logo it carried, who was told it was ready, who approved it, what they
// accepted, and what actually went out (where, when, the provider's reference). Reads app/actions/content-final-versions.ts.
import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2 } from "lucide-react"
import { getDistributionFinalsAction } from "@/app/actions/content-final-versions"

type FinalRecord = Extract<Awaited<ReturnType<typeof getDistributionFinalsAction>>, { ok: true }>["finals"][number]

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : null)

export function FinalVersionsPanel() {
  const [finals, setFinals] = useState<FinalRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getDistributionFinalsAction({ limit: 50 }).then((r) => {
      if (!live) return
      if (r.ok) setFinals(r.finals)
      else setError(r.error)
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [])

  if (error) return <Card><CardContent className="py-4 text-xs text-destructive">The final-version record could not be read: {error}</CardContent></Card>
  if (!finals) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  if (finals.length === 0) return <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No AI piece has reached its final version yet.</CardContent></Card>

  return (
    <Card>
      <div className="divide-y">
        {finals.map((f) => (
          <div key={f.id} className="p-4 space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">{f.assetKind.replace(/_/g, " ")} · version {f.version}</p>
              <Badge variant={f.status === "published" ? "default" : "secondary"} className="text-[10px]">{f.status.replace(/_/g, " ")}</Badge>
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5">
              {f.notifiedAt ? <p>Ready-for-approval notice sent {when(f.notifiedAt)}</p> : f.status === "awaiting_approval" ? <p>No one has been told it is ready yet.</p> : null}
              {f.approvedAt ? <p>Approved {when(f.approvedAt)}{f.approvalBasis ? ` (${f.approvalBasis.replace(/_/g, " ")})` : ""}{f.approvedBy ? "" : " — approver not recorded"}</p> : null}
              {f.publishedAt ? <p>Went out {when(f.publishedAt)} via {f.publishedVia}{f.publishedRef ? ` · ref ${f.publishedRef}` : ""}</p> : null}
              {f.tagline ? <p>Brand line: “{f.tagline}”</p> : null}
              {f.logoUrl ? <p>Logo placed from the brand on file</p> : null}
              {f.blockers.length > 0 ? <p className="text-amber-700">Open at staging: {f.blockers.join("; ")}</p> : null}
              {f.acknowledged.length > 0 ? <p>Accepted by the approver: {f.acknowledged.join("; ")}</p> : null}
            </div>
            <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setOpen(open === f.id ? null : f.id)}>
              {open === f.id ? "Hide the text" : "Show the exact text"}
            </button>
            {open === f.id ? <pre className="whitespace-pre-wrap text-xs bg-muted/40 rounded p-2 max-h-64 overflow-auto">{f.finalText}</pre> : null}
          </div>
        ))}
      </div>
    </Card>
  )
}
