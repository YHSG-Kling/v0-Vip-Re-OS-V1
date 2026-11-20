"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, ChevronRight } from "lucide-react"

/**
 * WHY the gate said what it said about ONE raw record.
 *
 * The bench row shows a raw record's dedupe_status as a single word
 * ("Duplicate") with no reason. The reasons were always recorded — every gate
 * stop writes a lead_deduplication_log row (stage, action, match score, the
 * matched fields, the record it collided with) — and GET
 * /api/leads/deduplication-log served them, filtered by `?raw_record_id=`, to
 * nothing: a complete, correctly-gated route with no reader in the tree. This
 * is the reader. The GATE STAYS ON THE ROUTE (requireAuth + resolveLeadVisibility,
 * scoped to the session's brokerage); this component only asks and renders.
 *
 * Response shape reused verbatim from the route: `{ data: rows, stats }`, where
 * `rows` are lead_deduplication_log columns (scripts/schema-snapshot.ts).
 */
interface DedupeLogRow {
  id: string
  stage: string | null
  action_taken: string | null
  match_score: number | null
  match_details: Record<string, unknown> | null
  skip_reason: string | null
  duplicate_of_lead_id: string | null
  duplicate_of_contact_id: string | null
  lead_id: string | null
  old_enrichment_confidence: number | null
  new_enrichment_confidence: number | null
  created_at: string
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; rows: DedupeLogRow[] }

const ACTION_TONE: Record<string, string> = {
  skipped: "bg-gray-100 text-gray-700 border-gray-200",
  merged: "bg-amber-100 text-amber-700 border-amber-200",
  promoted: "bg-emerald-100 text-emerald-700 border-emerald-200",
}

function fmtDetail(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

export function DedupeReasons({ rawRecordId }: { rawRecordId: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LoadState>({ kind: "idle" })

  async function load() {
    setState({ kind: "loading" })
    try {
      const res = await fetch(
        `/api/leads/deduplication-log?raw_record_id=${encodeURIComponent(rawRecordId)}&limit=50`,
        { cache: "no-store" },
      )
      const body = (await res.json().catch(() => null)) as { data?: DedupeLogRow[]; error?: string } | null
      if (!res.ok) {
        setState({ kind: "error", message: body?.error ?? `Request failed (${res.status})` })
        return
      }
      setState({ kind: "loaded", rows: body?.data ?? [] })
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Request failed" })
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && state.kind === "idle") void load()
  }

  return (
    <div className="mt-1">
      <Button size="sm" variant="ghost" className="h-6 px-1 text-xs" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
        Why
      </Button>
      {open && (
        <div className="mt-1 rounded border bg-muted/30 p-2 text-xs space-y-2">
          {state.kind === "loading" && <div className="text-muted-foreground">Loading gate log…</div>}
          {state.kind === "error" && <div className="text-red-700">Could not load the gate log: {state.message}</div>}
          {state.kind === "loaded" && state.rows.length === 0 && (
            <div className="text-muted-foreground">
              No gate decisions logged for this record yet — the log fills when the automatic pipeline runs its
              territory / identity / dedup gates on it.
            </div>
          )}
          {state.kind === "loaded" &&
            state.rows.map((r) => {
              const details = r.match_details ?? {}
              const detailEntries = Object.entries(details)
              return (
                <div key={r.id} className="space-y-1 border-b last:border-0 pb-2 last:pb-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-[11px]">{r.stage ?? "stage ?"}</Badge>
                    <Badge className={`text-[11px] ${ACTION_TONE[r.action_taken ?? ""] ?? ""}`} variant="outline">
                      {r.action_taken ?? "action ?"}
                    </Badge>
                    {typeof r.match_score === "number" && (
                      <span className="text-muted-foreground tabular-nums">match {Math.round(r.match_score)}</span>
                    )}
                    <span className="text-muted-foreground ml-auto tabular-nums">
                      {new Date(r.created_at).toLocaleString()}
                    </span>
                  </div>
                  {r.skip_reason && <div>{r.skip_reason}</div>}
                  {(r.duplicate_of_lead_id || r.duplicate_of_contact_id) && (
                    <div className="text-muted-foreground">
                      {r.duplicate_of_lead_id && <span>collided with lead {r.duplicate_of_lead_id}</span>}
                      {r.duplicate_of_contact_id && <span>collided with contact {r.duplicate_of_contact_id}</span>}
                    </div>
                  )}
                  {(r.old_enrichment_confidence !== null || r.new_enrichment_confidence !== null) && (
                    <div className="text-muted-foreground tabular-nums">
                      enrichment confidence {fmtDetail(r.old_enrichment_confidence)} → {fmtDetail(r.new_enrichment_confidence)}
                    </div>
                  )}
                  {detailEntries.length > 0 && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                      {detailEntries.map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-muted-foreground">{k}</dt>
                          <dd className="break-all">{fmtDetail(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
