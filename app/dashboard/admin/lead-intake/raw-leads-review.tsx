"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Inbox, RotateCcw } from "lucide-react"
import type { RawLeadReviewRow } from "@/app/actions/lead-promotion/promote-lead"
import { rawLeadReviewStatus, type RawLeadReviewTone } from "@/lib/lead-promotion/review-status"
import { DedupeReasons } from "./dedupe-reasons"

const TONE: Record<RawLeadReviewTone, string> = {
  promoted: "bg-emerald-100 text-emerald-700 border-emerald-200",
  duplicate: "bg-gray-100 text-gray-600 border-gray-200",
  error: "bg-red-100 text-red-700 border-red-200",
  pending: "bg-blue-100 text-blue-700 border-blue-200",
  attempted: "bg-amber-100 text-amber-700 border-amber-200",
}

/**
 * Platform Raw Leads bench — INSPECTION ONLY (owner, round 37): raw leads are
 * platform-only and can't be manually moved to leads. Promotion is fully
 * automatic (the lead-scraping cron's processRawRecord pass: enrich + dedup +
 * territory/identity gates). This panel shows where each raw record stands in
 * that automatic pipeline; there is no manual promote action.
 *
 * "RESET FOR RETRY" — the missing IN-TREE caller for PATCH /api/leads/raw
 * (lane 64D, route-no-caller 6b → 0). That route's own header names itself
 * "the only state-repair verb on raw rows" and says the read-only survivor
 * here must NOT grow a write verb of its own — this button is that repair
 * verb's caller, not a second promotion door: it flips an `error` row back to
 * `pending` (clearing error_message) so the EXISTING automatic pipeline
 * (processRawRecord) picks it back up on its next pass. No lead is created
 * here, no processing_status other than "pending" is ever sent — that keeps
 * round-37's "no manual promote" intact while giving platform staff the one
 * thing the automatic pipeline cannot do for itself: un-stick a row stuck in
 * `error` from a transient upstream failure (skip-trace timeout, provider
 * 5xx). Platform-only, same as the panel's own render gate.
 */
function ResetToPendingButton({ id, onDone }: { id: string; onDone: (nextStatus: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleReset() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch("/api/leads/raw", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, processing_status: "pending", error_message: null }),
      })
      const body = await res.json() as { data?: { processing_status?: string }; error?: string }
      if (!res.ok) { setErr(body.error ?? `HTTP ${res.status}`); return }
      onDone(body.data?.processing_status ?? "pending")
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button size="sm" variant="outline" disabled={busy} onClick={handleReset} className="h-7 gap-1 text-xs">
        <RotateCcw className="h-3 w-3" />
        {busy ? "Resetting…" : "Reset for retry"}
      </Button>
      {err && <span className="text-[11px] text-red-600">{err}</span>}
    </div>
  )
}

export function RawLeadsReviewPanel({ initialRows }: { initialRows: RawLeadReviewRow[] }) {
  const [rows, setRows] = useState(initialRows)
  const name = (r: RawLeadReviewRow) => [r.firstName, r.lastName].filter(Boolean).join(" ") || "(no name)"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Inbox className="h-4 w-4" />Raw Leads — Pipeline Bench (read-only)</CardTitle>
        <CardDescription>
          Scraped raw records awaiting the automatic promotion pipeline. Promotion is automatic only — the
          scheduled gate (enrichment, dedup, territory/identity guards) moves eligible records to leads;
          stranded records are retried by the daily re-enrich sweep. Nothing here can be promoted by hand.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No raw leads yet — this fills as the scraper bench lands records. The automatic pipeline promotes eligible ones to leads.
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
                  <th className="py-2 pr-4 font-medium">Pipeline status</th>
                  <th className="py-2 pr-4 font-medium text-right">Lead</th>
                  <th className="py-2 font-medium text-right">Repair</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const review = rawLeadReviewStatus({
                    lead_id: r.leadId, processing_status: r.processingStatus,
                    promotion_attempts: r.promotionAttempts, error_message: r.errorMessage,
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
                      <td className="py-2 pr-4">
                        <Badge className={TONE[review.tone]}>{review.label}</Badge>
                        {/* The WHY behind the status: this record's gate log, fetched on demand
                            from the (session-gated) deduplication-log route. */}
                        <DedupeReasons rawRecordId={r.id} />
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {r.leadId ? (
                          <Button size="sm" variant="ghost" asChild>
                            <Link href={`/leads/${r.leadId}`}>View lead</Link>
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {r.processingStatus === "error" ? (
                          <ResetToPendingButton
                            id={r.id}
                            onDone={(nextStatus) =>
                              setRows((prev) =>
                                prev.map((row) =>
                                  row.id === r.id ? { ...row, processingStatus: nextStatus, errorMessage: null } : row,
                                ),
                              )
                            }
                          />
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
