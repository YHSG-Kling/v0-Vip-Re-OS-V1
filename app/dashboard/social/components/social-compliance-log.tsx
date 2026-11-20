"use client"

// app/dashboard/social/components/social-compliance-log.tsx
//
// MERGED FROM the legacy Social Planner body (lane 85E, CLAUDE.md §1.1). The
// orphan app/social-planner/social-planner-content.tsx — imported by nothing,
// behind a redirect page — carried the ONE capability the survivor
// (app/dashboard/social/social-dashboard-client.tsx) lacked: the compliance
// log of content the Fair Housing / brand gate BLOCKED (System 4.2's
// evaluation history, the same table the rules engine writes). It is mounted
// here as the survivor's "Compliance" tab; the rest of the legacy body (queue,
// calendar, analytics) already lived on the survivor.
//
// Honest by construction: a refused history read says so — it never renders
// as "All Posts Compliant" (the legacy tab did exactly that before its setter
// was wired, and would again on a refusal).

import { useEffect, useState } from "react"
import { ShieldCheck, AlertCircle, RefreshCw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getEvaluationHistory } from "@/app/actions/content-compliance"

interface BlockedEvaluation {
  id: string
  reason: string
  timestamp: string
}

export function SocialComplianceLog() {
  const [rows, setRows] = useState<BlockedEvaluation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getEvaluationHistory({ status_filter: "fail" })
      if (!result.success) {
        setError(result.error ?? "The compliance history could not be read.")
        setRows([])
        return
      }
      // compliance_events (lib/compliance-rules/compliance-logger.ts): id,
      // blocked_reason, violations, created_at — the same row shape the legacy
      // tab mapped.
      setRows((result.history ?? []).map((h: { id: string; blocked_reason?: string | null; violations?: string[] | null; created_at?: string | null }) => ({
        id: h.id,
        reason: h.blocked_reason ?? h.violations?.join("; ") ?? "Compliance gate blocked this content",
        timestamp: h.created_at ?? "",
      })))
    } catch (e) {
      setError(e instanceof Error ? e.message : "The compliance history could not be read.")
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  return (
    <Card className="border-2">
      <CardHeader className="bg-muted/30">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Compliance Log
            </CardTitle>
            <CardDescription>Content the Fair Housing and brand gate blocked — review and revise before publishing</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading the compliance history…</p>
        ) : error ? (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Compliance history unavailable: {error}. Nothing here means "unchecked", not "compliant".</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 border-2 border-dashed rounded-xl">
            <ShieldCheck className="h-10 w-10 text-green-600 mx-auto mb-3" />
            <p className="font-semibold">No blocked content on record</p>
            <p className="text-sm text-muted-foreground">The compliance gate has not blocked any of your content.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="flex items-start gap-3 rounded border p-3">
                <Badge variant="destructive" className="shrink-0">BLOCKED</Badge>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium">{r.reason}</p>
                  <p className="text-xs text-muted-foreground">Review and revise before publishing.</p>
                  {r.timestamp && <p className="text-xs text-muted-foreground">{new Date(r.timestamp).toLocaleString()}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
