"use client"

// Direct Mail — Analytics tab.
//
// WHY THIS EXISTS (w4s1): `getDirectMailAnalytics` and
// `aiAnalyzeCampaignPerformance` in app/actions/ai-direct-mail.ts both computed the
// spend / response / cost-per-response picture for the calling agent's paid mail and
// neither had a caller — the mail dashboard shipped Campaigns / Recipients /
// Tracking / Responses and no place that answered "did this mail make money?". Every
// other tab reports activity; this one reports outcome.
//
// Both actions derive the agent AND brokerage from the session (a caller-supplied
// agentId is ignored), so this surface passes no identity. The AI read is behind an
// explicit button, never on load: it bills a model call per invocation and that spend
// should follow an intent, not a tab change.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { BarChart3, Loader2, Sparkles, TrendingUp } from "lucide-react"
import {
  getDirectMailAnalytics,
  aiAnalyzeCampaignPerformance,
} from "@/app/actions/ai-direct-mail"

interface CampaignAnalytics {
  id: string
  name: string | null
  quantity: number | null
  responses: number
  responseRate: number
  cost: number
  costPerResponse: number
  status: string | null
  sentDate: string | null
}

function money(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0)
}

export function AnalyticsTab({ selectedCampaignId }: { selectedCampaignId: string | null }) {
  const [rows, setRows] = useState<CampaignAnalytics[] | null>(null)
  const [loading, setLoading] = useState(true)
  // `error` is surfaced, not swallowed: these actions report a refused read as a
  // failure, and rendering "$0 across 0 campaigns" over a denied query would be a
  // confident lie about someone's marketing spend.
  const [error, setError] = useState<string | null>(null)

  const [aiPending, startAi] = useTransition()
  const [aiResult, setAiResult] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getDirectMailAnalytics({})
      .then((res: any) => {
        if (cancelled) return
        if (!res?.success) {
          setError(res?.error ?? "Could not load campaign analytics")
          setRows(null)
          return
        }
        setRows((res.analytics ?? []) as CampaignAnalytics[])
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message ?? "Could not load campaign analytics")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  function runAiAnalysis() {
    setAiResult(null)
    setAiError(null)
    startAi(async () => {
      try {
        const res: any = await aiAnalyzeCampaignPerformance()
        if (!res?.success) {
          setAiError(res?.error ?? "The analysis could not be produced")
          return
        }
        // The action's payload shape varies with the model response; render whatever
        // text it produced rather than asserting a structure that may not be there.
        const text =
          typeof res.analysis === "string"
            ? res.analysis
            : typeof res.insights === "string"
              ? res.insights
              : JSON.stringify(res.analysis ?? res.insights ?? res, null, 2)
        setAiResult(text)
      } catch (e: any) {
        setAiError(e?.message ?? "The analysis could not be produced")
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading analytics…
      </div>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-red-600">{error}</p>
        </CardContent>
      </Card>
    )
  }

  const list = rows ?? []
  const totalSpend = list.reduce((s, r) => s + (r.cost || 0), 0)
  const totalPieces = list.reduce((s, r) => s + (r.quantity || 0), 0)
  const totalResponses = list.reduce((s, r) => s + (r.responses || 0), 0)
  const blendedRate = totalPieces > 0 ? (totalResponses / totalPieces) * 100 : 0
  const blendedCpr = totalResponses > 0 ? totalSpend / totalResponses : 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total spend</p>
            <p className="text-2xl font-semibold">{money(totalSpend)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Pieces mailed</p>
            <p className="text-2xl font-semibold">{totalPieces.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Responses</p>
            <p className="text-2xl font-semibold">{totalResponses.toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{blendedRate.toFixed(2)}% response rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Cost per response</p>
            <p className="text-2xl font-semibold">
              {totalResponses > 0 ? money(blendedCpr) : "—"}
            </p>
            {totalResponses === 0 && (
              <p className="text-[11px] text-muted-foreground mt-0.5">No responses recorded yet</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" />
            Campaign performance
          </CardTitle>
          <CardDescription>
            Spend, responses and cost per response for your direct mail campaigns.
            Responses are QR scans off the mailer plus anything logged against the
            piece&apos;s tracking code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No direct mail campaigns yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Pieces</TableHead>
                  <TableHead className="text-right">Responses</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Cost / response</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((r) => (
                  <TableRow
                    key={r.id}
                    className={r.id === selectedCampaignId ? "bg-muted/50" : undefined}
                  >
                    <TableCell className="font-medium">{r.name ?? r.id.slice(0, 8)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.status ?? "—"}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{(r.quantity ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right">{r.responses.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{r.responseRate.toFixed(2)}%</TableCell>
                    <TableCell className="text-right">{money(r.cost)}</TableCell>
                    <TableCell className="text-right">
                      {r.responses > 0 ? money(r.costPerResponse) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" />
            AI performance read
          </CardTitle>
          <CardDescription>
            Reads your mail history and says what is working and what to change. Runs
            only when you ask — each run bills a model call.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={runAiAnalysis} disabled={aiPending || list.length === 0}>
            {aiPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Analyzing…
              </>
            ) : (
              <>
                <TrendingUp className="h-4 w-4 mr-2" />
                Analyze my direct mail
              </>
            )}
          </Button>
          {list.length === 0 && (
            <p className="text-xs text-muted-foreground">
              There is nothing to analyze until a campaign has been mailed.
            </p>
          )}
          {aiError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {aiError}
            </p>
          )}
          {aiResult && (
            <pre className="text-sm whitespace-pre-wrap font-sans bg-muted/40 border rounded-lg p-3">
              {aiResult}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
