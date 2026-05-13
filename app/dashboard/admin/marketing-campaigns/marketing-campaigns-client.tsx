"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Rocket, AlertCircle, CheckCircle2, ShieldAlert, Loader2 } from "lucide-react"
import {
  launchMarketingCampaignAction,
  type MarketingCampaignRow,
} from "@/app/actions/marketing-campaigns-admin"

interface Props {
  initialRows: MarketingCampaignRow[]
}

const STATUS_TONE: Record<string, string> = {
  draft:          "bg-slate-100 text-slate-800",
  scheduled:      "bg-blue-100 text-blue-800",
  pending_review: "bg-amber-100 text-amber-800",
  approved:       "bg-emerald-100 text-emerald-800",
  live:           "bg-purple-100 text-purple-800",
  paused:         "bg-yellow-100 text-yellow-800",
  ended:          "bg-slate-200 text-slate-700",
  archived:       "bg-slate-200 text-slate-700",
  failed:         "bg-red-100 text-red-800",
}

const COMPLIANCE_TONE: Record<string, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  pending:       { label: "compliance pending",  cls: "bg-slate-100 text-slate-700", Icon: AlertCircle },
  passed:        { label: "compliance passed",   cls: "bg-emerald-100 text-emerald-800", Icon: CheckCircle2 },
  blocked:       { label: "compliance blocked",  cls: "bg-red-100 text-red-800", Icon: ShieldAlert },
  needs_review:  { label: "needs review",        cls: "bg-amber-100 text-amber-800", Icon: AlertCircle },
}

export function MarketingCampaignsClient({ initialRows }: Props) {
  const [rows, setRows] = useState<MarketingCampaignRow[]>(initialRows)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleLaunch(id: string): void {
    startTransition(async () => {
      setFeedback(null)
      const result = await launchMarketingCampaignAction(id)
      if (!result.ok) {
        setFeedback(`Launch failed: ${result.error}`)
        return
      }
      setRows(prev => prev.map(r =>
        r.id === id
          ? { ...r, status: "live", audience_size_resolved: result.audienceSize, compliance_status: result.complianceStatus, launched_at: new Date().toISOString() }
          : r,
      ))
      setFeedback(`Launched — ${result.audienceSize} contacts in audience, compliance ${result.complianceStatus}.`)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {rows.length} campaign{rows.length === 1 ? "" : "s"}
        </span>
        {feedback && (
          <div className="text-sm rounded-md border bg-muted/40 px-3 py-1.5 ml-auto">{feedback}</div>
        )}
      </div>

      {rows.length === 0 && (
        <div className="text-sm text-muted-foreground border rounded-md p-6 text-center">
          No campaigns yet. Author one via the marketing workspace, then they&apos;ll appear here for launch + measurement.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {rows.map(r => {
          const tone     = STATUS_TONE[r.status] ?? STATUS_TONE.draft
          const compMeta = COMPLIANCE_TONE[r.compliance_status] ?? COMPLIANCE_TONE.pending
          const canLaunch = ["draft", "scheduled", "pending_review", "approved"].includes(r.status)

          return (
            <Card key={r.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <CardTitle className="text-base">{r.campaign_name}</CardTitle>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={tone}>{r.status}</Badge>
                    <Badge variant="outline">{r.campaign_type}</Badge>
                    <Badge className={compMeta.cls}>
                      <compMeta.Icon className="h-3 w-3 mr-1" />
                      {compMeta.label}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {r.compliance_blocked_reason && (
                  <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
                    {r.compliance_blocked_reason}
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">Audience</div>
                    <div className="font-medium">{r.audience_size_resolved.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Impressions</div>
                    <div className="font-medium">{r.impressions.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Engagements</div>
                    <div className="font-medium">{r.engagements.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Conversions</div>
                    <div className="font-medium">{r.conversions.toLocaleString()}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                  {r.scheduled_start_at && (
                    <span>Scheduled: {new Date(r.scheduled_start_at).toLocaleString()}</span>
                  )}
                  {r.launched_at && (
                    <span>Launched: {new Date(r.launched_at).toLocaleString()}</span>
                  )}
                </div>

                {canLaunch && (
                  <Button
                    size="sm"
                    onClick={() => handleLaunch(r.id)}
                    disabled={isPending}
                    className="self-start"
                  >
                    {isPending
                      ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      : <Rocket className="h-3.5 w-3.5 mr-1" />}
                    Launch now
                  </Button>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
