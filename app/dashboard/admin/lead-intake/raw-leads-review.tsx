"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Inbox, Loader2, ArrowRight } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { promoteLead, type RawLeadReviewRow } from "@/app/actions/lead-promotion/promote-lead"
import { rawLeadReviewStatus, type RawLeadReviewTone } from "@/lib/lead-promotion/review-status"

const TONE: Record<RawLeadReviewTone, string> = {
  promoted: "bg-emerald-100 text-emerald-700 border-emerald-200",
  duplicate: "bg-gray-100 text-gray-600 border-gray-200",
  error: "bg-red-100 text-red-700 border-red-200",
  pending: "bg-blue-100 text-blue-700 border-blue-200",
  attempted: "bg-amber-100 text-amber-700 border-amber-200",
}

/**
 * Admin Raw Leads review — see scraped raw records and manually promote eligible ones
 * to leads (the gate: enrich + dedup + territory/identity guards run inside promoteLead).
 */
export function RawLeadsReviewPanel({ initialRows }: { initialRows: RawLeadReviewRow[] }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<RawLeadReviewRow[]>(initialRows)
  const [busy, setBusy] = useState<string | null>(null)

  async function promote(row: RawLeadReviewRow) {
    setBusy(row.id)
    try {
      const r = await promoteLead(row.id)
      if (r.success) {
        toast({ title: "Promoted to lead", description: r.message })
        setRows((cur) => cur.map((x) => (x.id === row.id ? { ...x, leadId: r.leadId ?? "promoted" } : x)))
      } else {
        toast({ title: `Not promoted (${r.stage})`, description: r.message, variant: "destructive" })
        // Reflect an attempt/eligibility outcome so the row's status updates.
        setRows((cur) => cur.map((x) => (x.id === row.id ? { ...x, promotionAttempts: (x.promotionAttempts ?? 0) + 1 } : x)))
      }
    } finally {
      setBusy(null)
    }
  }

  const name = (r: RawLeadReviewRow) => [r.firstName, r.lastName].filter(Boolean).join(" ") || "(no name)"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Inbox className="h-4 w-4" />Raw Leads — Review &amp; Promote</CardTitle>
        <CardDescription>
          Scraped raw records for your brokerage. Promote eligible ones to leads — enrichment, dedup, and
          territory/identity guards run automatically inside the promotion gate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No raw leads yet — this fills as the scraper bench lands records. They appear here for review before promotion.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Contact</th>
                  <th className="py-2 pr-4 font-medium">Location</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const review = rawLeadReviewStatus({
                    lead_id: r.leadId, processing_status: r.processingStatus,
                    dedupe_status: r.dedupeStatus, promotion_attempts: r.promotionAttempts, error_message: r.errorMessage,
                  })
                  return (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-4 font-medium">{name(r)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        <div>{r.email ?? "—"}</div>
                        <div>{r.phone ?? ""}</div>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{r.source ?? r.sourceFamily ?? "—"}</td>
                      <td className="py-2 pr-4"><Badge className={TONE[review.tone]}>{review.label}</Badge></td>
                      <td className="py-2 text-right">
                        {review.canPromote ? (
                          <Button size="sm" onClick={() => promote(r)} disabled={busy === r.id}>
                            {busy === r.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowRight className="h-3 w-3 mr-1" />}
                            Promote
                          </Button>
                        ) : r.leadId ? (
                          <Button size="sm" variant="ghost" asChild>
                            <Link href={`/leads/${r.leadId}`}>View lead</Link>
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
