"use client"

/**
 * app/crm/contacts/[contactId]/components/identity-evidence-card.tsx
 *
 * IDENTITY EVIDENCE (wave 102.1, lane 102E) — the first UI reader of ContactBrief.identityEvidence
 * (lib/contacts/contact-brief.ts, filled from lib/kernel/person-identity.ts summarizePersonEvidence
 * under m697). It reads the SAME endpoint the voice pre-call card already consumes
 * (GET /api/contacts/[contactId]/brief — auth-scoped to the caller's brokerage; this card passes no
 * tenant and adds no scope), so there is one brief and two readers, not a second brief.
 *
 * WHAT IT SHOWS, and what it never shows: confidence, which chokepoints judged the link, how many
 * records of each kind resolved to this person, and the human lines ("same name and email",
 * "promoted lead → contact", "dedup match at pre_enrichment (85%)"). NEVER a cost: the summary is
 * built without any cost key (CLAUDE.md §5 — agents see contacts only, never lead cost) and this
 * card renders only the fields the summary exposes. Raw ids are not rendered either.
 *
 * Sits next to the lead-history card (the funnel LINEAGE: one row per lead). Different question:
 * that card says where each lead came from; this one says why those records are ONE person.
 */

import { useCallback, useEffect, useState } from "react"
import { IdCard, Loader2, RefreshCw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface IdentityEvidence {
  personId: string
  confidence: number
  evidenceCount: number
  sources: string[]
  linked: Partial<Record<string, number>>
  how: string[]
  convertedAt: string | null
}

const SOURCE_LABEL: Record<string, string> = {
  pipeline_processor: "lead pipeline",
  history_carry: "lead → contact promotion",
  contact_merge: "staff merge",
  crm_manual_dedup: "CRM dedup",
  contact_capture: "public capture",
  form_submit: "web form",
  open_house_kiosk: "open-house kiosk",
  unknown_sender: "inbound email",
  visitor_identify: "website visitor",
  platform_distribution: "platform distribution",
}

function when(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

export function IdentityEvidenceCard({ contactId }: { contactId: string }) {
  const [evidence, setEvidence] = useState<IdentityEvidence | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/brief`, { cache: "no-store" })
      const payload = await res.json().catch(() => null)
      // The response is READ, not assumed: a refused brief is a reason on screen, never "no evidence".
      if (!res.ok || !payload || typeof payload !== "object") {
        setEvidence(null)
        setError((payload && typeof payload.error === "string" && payload.error) || `Identity evidence could not be read (HTTP ${res.status}).`)
        return
      }
      const ev = (payload as { identityEvidence?: IdentityEvidence | null }).identityEvidence
      setEvidence(ev && typeof ev === "object" && typeof ev.confidence === "number" ? ev : null)
    } catch (err: unknown) {
      setEvidence(null)
      setError(err instanceof Error ? err.message : "Identity evidence could not be read.")
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => {
    void load()
  }, [load])

  const linkedEntries = evidence ? Object.entries(evidence.linked).filter(([, n]) => typeof n === "number" && n > 0) : []

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <IdCard className="h-4 w-4" />
              Why these records are one person
            </CardTitle>
            <CardDescription className="text-xs">
              Identity evidence — which records resolved to this contact, how each link was judged, and
              how confident the OS is. Never a cost.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="sr-only">Refresh identity evidence</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Reading the evidence…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Nothing below is a reading of this contact&apos;s identity: {error}</p>
        ) : !evidence ? (
          <p className="text-sm text-muted-foreground">
            No identity evidence on record — no other record has been resolved to this contact yet.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-[11px]">
                {Math.round(evidence.confidence * 100)}% confidence
              </Badge>
              <Badge variant="outline" className="text-[11px]">
                {evidence.evidenceCount} piece{evidence.evidenceCount === 1 ? "" : "s"} of evidence
              </Badge>
              {linkedEntries.map(([kind, n]) => (
                <Badge key={kind} variant="outline" className="text-[11px]">
                  {n} {kind.replace(/_/g, " ")}{n === 1 ? "" : "s"}
                </Badge>
              ))}
              {when(evidence.convertedAt) && (
                <span className="ml-auto text-xs text-muted-foreground">converted {when(evidence.convertedAt)}</span>
              )}
            </div>
            {evidence.sources.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Judged by: </span>
                {evidence.sources.map((s) => SOURCE_LABEL[s] ?? s.replace(/_/g, " ")).join(" · ")}
              </p>
            )}
            {evidence.how.length > 0 && (
              <ul className="space-y-1">
                {evidence.how.map((line, i) => (
                  <li key={i} className="text-xs text-muted-foreground rounded border px-2 py-1.5">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
