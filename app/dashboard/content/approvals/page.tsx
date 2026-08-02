"use client"

import { useState, useEffect, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, CheckCircle2, Clock, AlertTriangle, FileText } from "lucide-react"
import { toast } from "sonner"
import {
  getMyPendingApprovals,
  getApprovalHistory,
  getApprovalStatistics,
} from "@/app/actions/content-approval-workflow"
import { createClient } from "@/lib/supabase/client"

interface ApprovalStats {
  total_decisions: number
  approved_count: number
  pending_count: number
  rejected_count: number
  auto_approved_count: number
  common_blocking_reasons: Array<{ reason: string; count: number }>
}

export default function ContentApprovalsPage() {
  const [pending, setPending] = useState<any[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [stats, setStats] = useState<ApprovalStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const load = async () => {
      const [pendingRes, histRes, statsRes] = await Promise.allSettled([
        getMyPendingApprovals({ approver_role: "broker", limit: 50 }),
        getApprovalHistory({ limit: 20 }),
        getApprovalStatistics({}),
      ])
      if (pendingRes.status === "fulfilled" && pendingRes.value.success) {
        setPending(pendingRes.value.pending ?? [])
      }
      if (histRes.status === "fulfilled" && (histRes.value as any).success) {
        setHistory((histRes.value as any).history ?? [])
      }
      // Read the outcome — a refused stats call must say so, not render zeroes.
      if (statsRes.status === "fulfilled") {
        if (statsRes.value.success && statsRes.value.stats) {
          setStats(statsRes.value.stats as ApprovalStats)
        } else {
          setStatsError(statsRes.value.error ?? "Approval statistics unavailable")
        }
      } else {
        setStatsError("Approval statistics unavailable")
      }
      setLoading(false)
    }
    load()
  }, [])

  const handleDecision = (itemId: string, decision: "approved" | "rejected") => {
    startTransition(async () => {
      const supabase = createClient()
      const item = pending.find(p => p.id === itemId)
      let existingNotes = item?.notes ?? {}
      if (typeof item?.notes === "string") {
        try {
          existingNotes = JSON.parse(item.notes)
        } catch {
          existingNotes = {}
        }
      }
      const { error } = await supabase
        .from("activities")
        .update({
          status: decision === "approved" ? "completed" : "rejected",
          completed_at: new Date().toISOString(),
          notes: { ...existingNotes, approval_status: decision },
        })
        .eq("id", itemId)
      if (!error) {
        setPending(prev => prev.filter(p => p.id !== itemId))
        toast.success(decision === "approved" ? "Content approved" : "Revisions requested")
      } else {
        toast.error("Action failed")
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Content Approvals</h1>
          <p className="text-muted-foreground text-sm mt-1">Review and approve agent-generated content</p>
        </div>
        <Badge variant="secondary">{pending.length} pending</Badge>
      </div>

      {/* Decision statistics — the real approval-signal ledger, not a count of
          what happens to be on this screen. */}
      {statsError ? (
        <Card>
          <CardContent className="py-3 text-xs text-destructive">{statsError}</CardContent>
        </Card>
      ) : stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Total decisions", value: stats.total_decisions },
            { label: "Approved", value: stats.approved_count },
            { label: "Pending", value: stats.pending_count },
            { label: "Rejected", value: stats.rejected_count },
            { label: "Auto-approved", value: stats.auto_approved_count },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-xl font-semibold">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {stats && stats.common_blocking_reasons.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Most common blocking reasons</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {stats.common_blocking_reasons.slice(0, 5).map((r) => (
              <div key={r.reason} className="flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">{r.reason}</p>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {r.count}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">
            <Clock className="h-4 w-4 mr-1.5" />
            Pending ({pending.length})
          </TabsTrigger>
          <TabsTrigger value="history">
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4">
          {pending.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
                All caught up — no pending approvals
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {pending.map(item => (
                <Card key={item.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <p className="font-medium text-sm">{item.title}</p>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Submitted {new Date(item.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => handleDecision(item.id, "rejected")}
                          disabled={isPending}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                          Request Revisions
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleDecision(item.id, "approved")}
                          disabled={isPending}
                        >
                          {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                          Approve
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {history.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">No history yet</CardContent>
            </Card>
          ) : (
            <Card>
              <div className="divide-y">
                {history.map((item: any) => (
                  <div key={item.id} className="p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{item.title ?? item.content_id}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(item.created_at ?? item.evaluated_at).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge className={
                      item.decision === "approved" ? "bg-green-100 text-green-700" :
                      "bg-red-100 text-red-700"
                    }>
                      {item.decision ?? "reviewed"}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
