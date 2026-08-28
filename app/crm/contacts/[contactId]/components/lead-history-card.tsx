"use client"

/**
 * app/crm/contacts/[contactId]/components/lead-history-card.tsx
 *
 * The reader for GET /api/contacts/[contactId]/lead-history — the sole caller of
 * the `contact_lead_history` view (migration 039).
 *
 * WHY THIS IS NOT THE BRIEF'S PROVENANCE LINE, verified before building:
 * /api/contacts/[id]/brief returns ContactBrief, whose `provenanceLine` is ONE
 * composed sentence from lib/contacts/provenance-receipt.ts — the lifetime-value
 * receipt ("how the OS found them, every touch since, and the GCI it earned"),
 * assembled for the ten seconds before a call. This card renders the FUNNEL
 * LINEAGE instead: one ROW PER LEAD out of migration 039's view — source family
 * / channel / subtype, lead stage, lifecycle state, motivation and its
 * confidence, urgency, the qualification summary, the ISA handoff brief, and the
 * handed-to-agent / converted timestamps. Different question, different shape,
 * different table. Neither is derivable from the other, so this is a BUILD under
 * the orphan doctrine, not a duplicate.
 *
 * WHY AN AGENT MAY SEE IT AT ALL (§5 — leads belong to the brokerage, agents see
 * contacts): migration 039 is the sanctioned projection. It is SECURITY INVOKER
 * and exposes only non-sensitive lineage columns, so RLS on `contacts` decides
 * who sees which lineage; the `leads` table itself stays locked down by
 * migration 034. The route reads it on the COOKIE client, which is what makes
 * that gate real — this card adds no scope of its own and passes no tenant.
 *
 * THE LEFT JOIN IS WHY "EMPTY" NEEDS CARE: the view is
 * `contacts c LEFT JOIN leads l`, so a contact that never came through the lead
 * funnel still yields exactly one row — with `lead_id` NULL and every lead
 * column NULL. Rendering that as a lineage entry would invent a phantom lead, so
 * rows without a `lead_id` are dropped and reported as "no lead lineage", which
 * is a true answer and distinct from both "loading" and "could not read".
 */

import { useCallback, useEffect, useState } from "react"
import { GitBranch, Loader2, RefreshCw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface LeadHistoryRow {
  contact_id: string | null
  lead_id: string | null
  source: string | null
  source_family: string | null
  source_channel: string | null
  source_subtype: string | null
  lead_stage: string | null
  lead_score: number | null
  motivation_type: string | null
  motivation_confidence: number | null
  urgency_level: string | null
  qualification_summary: string | null
  isa_handoff_brief: string | null
  handed_to_agent_at: string | null
  converted_at: string | null
  last_contacted_at: string | null
  lifecycle_state: string | null
  lead_created_at: string | null
}

function when(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

export function LeadHistoryCard({ contactId }: { contactId: string }) {
  const [rows, setRows] = useState<LeadHistoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/lead-history`, { cache: "no-store" })
      const payload = await res.json().catch(() => null)
      // The response is READ, not assumed. A refused view read comes back
      // {success:false,error} with a 500; an auth refusal comes back from
      // requireAuth. Either way there is a reason and it is shown.
      if (!res.ok || !payload?.success || !Array.isArray(payload.history)) {
        setRows(null)
        setError(
          (payload && typeof payload.error === "string" && payload.error) ||
            `Lead lineage could not be read (HTTP ${res.status}).`,
        )
        return
      }
      // Drop the LEFT-JOIN placeholder row (see the header note).
      setRows((payload.history as LeadHistoryRow[]).filter((r) => r?.lead_id))
    } catch (err: unknown) {
      setRows(null)
      setError(err instanceof Error ? err.message : "Lead lineage could not be read.")
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              How this person reached you
            </CardTitle>
            <CardDescription className="text-xs">
              Lead lineage from the contact_lead_history view — the source, the qualification and
              the handoff behind every lead that resolved to this contact.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span className="sr-only">Refresh lead lineage</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Reading the lineage…</p>
        ) : error ? (
          <p className="text-sm text-destructive">
            Nothing below is a reading of this contact&apos;s lineage: {error}
          </p>
        ) : !rows ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No lead lineage on record — this contact was not created through the lead funnel.
          </p>
        ) : (
          <ol className="space-y-3">
            {rows.map((r) => {
              const sourceBits = [r.source_family, r.source_channel, r.source_subtype].filter(Boolean)
              return (
                <li key={r.lead_id!} className="rounded-lg border px-3 py-2 space-y-1.5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{r.source ?? "Source unrecorded"}</span>
                    {sourceBits.length > 0 && (
                      <span className="text-xs text-muted-foreground">{sourceBits.join(" · ")}</span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {when(r.lead_created_at) ?? "date unrecorded"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {r.lead_stage && (
                      <Badge variant="outline" className="text-[11px] capitalize">
                        stage: {r.lead_stage.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {r.lifecycle_state && (
                      <Badge variant="outline" className="text-[11px] capitalize">
                        {r.lifecycle_state.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {r.lead_score != null && (
                      <Badge variant="secondary" className="text-[11px]">score {r.lead_score}</Badge>
                    )}
                    {r.motivation_type && (
                      <Badge variant="secondary" className="text-[11px] capitalize">
                        {r.motivation_type.replace(/_/g, " ")}
                        {r.motivation_confidence != null ? ` (${r.motivation_confidence})` : ""}
                      </Badge>
                    )}
                    {r.urgency_level && (
                      <Badge variant="secondary" className="text-[11px] capitalize">
                        urgency {r.urgency_level.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>
                  {r.qualification_summary && (
                    <p className="text-sm text-muted-foreground">{r.qualification_summary}</p>
                  )}
                  {r.isa_handoff_brief && (
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">ISA handoff: </span>
                      {r.isa_handoff_brief}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {[
                      when(r.handed_to_agent_at) ? `handed to agent ${when(r.handed_to_agent_at)}` : null,
                      when(r.converted_at) ? `converted ${when(r.converted_at)}` : null,
                      when(r.last_contacted_at) ? `last contacted ${when(r.last_contacted_at)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No handoff or conversion timestamps recorded"}
                  </p>
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
