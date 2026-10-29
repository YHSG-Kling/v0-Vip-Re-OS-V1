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
import { useAuth } from "@/lib/auth/client"
import type { ApproverRole } from "@/lib/approval-workflow/approval-engine"
import { ApprovalToolsPanel } from "./approval-tools-panel"
import { FinalVersionsPanel } from "./final-versions-panel"

interface ApprovalStats {
  total_decisions: number
  approved_count: number
  pending_count: number
  rejected_count: number
  auto_approved_count: number
  common_blocking_reasons: Array<{ reason: string; count: number }>
}

/**
 * WHICH APPROVAL QUEUES THE SIGNED-IN PERSON STANDS IN (wave 146, lane 146H — owner ruling 9: "the tenants
 * approve their own ads/posts … assets"; brokerage approval only where policy or law imposes it).
 *
 * This page asked `getMyPendingApprovals({ approver_role: "broker" })` for EVERY viewer: a team lead or a
 * compliance officer opening Content Approvals saw the items that need the BROKER and never the items that
 * name THEM, and an agent approving their own content saw the broker's queue. The queue now follows the
 * roles the person HOLDS (the session's canonical roles, lib/security/types.ts — broker_owner / broker_admin
 * already canonicalise to `broker`), mapped onto the approval engine's own four approver roles
 * (lib/approval-workflow/approval-engine.ts ApproverRole). A role with no approver standing (isa, tc,
 * vendor …) stands in no queue. The authority to DECIDE is still the server's; deriving the queue from the
 * session inside the action (and from contract C5 `approverFor`) is routed as Outside-lane in lane 146H's notes.
 */
function approverRolesFor(roles: readonly string[]): ApproverRole[] {
  const out = new Set<ApproverRole>()
  for (const r of roles) {
    if (r === "broker" || r === "admin") out.add("broker")
    else if (r === "team_lead") out.add("team_lead")
    else if (r === "compliance_officer") out.add("compliance_officer")
    else if (r === "agent") out.add("agent")
  }
  return [...out]
}

export default function ContentApprovalsPage() {
  const { userContext, isLoading: authLoading } = useAuth()
  const heldRoles = (userContext?.roles ?? []) as string[]
  const rolesKey = heldRoles.slice().sort().join(",")
  const [queues, setQueues] = useState<ApproverRole[]>([])
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [pending, setPending] = useState<any[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [stats, setStats] = useState<ApprovalStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (authLoading) return
    const load = async () => {
      const myQueues = approverRolesFor(rolesKey ? rolesKey.split(",") : [])
      setQueues(myQueues)
      const [pendingRes, histRes, statsRes] = await Promise.allSettled([
        Promise.all(myQueues.map((role) => getMyPendingApprovals({ approver_role: role, limit: 50 }))),
        getApprovalHistory({ limit: 20 }),
        getApprovalStatistics({}),
      ])
      // One item can name several approver roles; show it once. A refused read SAYS so — "All caught
      // up" is reserved for a queue that was actually read and came back empty (CLAUDE.md §4).
      if (pendingRes.status === "fulfilled") {
        const refused = pendingRes.value.filter((r) => !r.success)
        const seen = new Set<string>()
        const merged: any[] = []
        for (const r of pendingRes.value) for (const item of r.pending ?? []) if (!seen.has(item.id)) { seen.add(item.id); merged.push(item) }
        setPending(merged)
        setPendingError(refused.length ? (refused[0].error ?? "Pending approvals could not be read") : null)
      } else {
        setPendingError("Pending approvals could not be read")
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
  }, [authLoading, rolesKey])

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
      // An UPDATE that matches nothing RESOLVES with no error (CLAUDE.md §3) — RLS refusing this seat, or an item
      // another approver already decided, read as success and the item vanished from the queue undecided.
      // Count what came back; zero rows is "not saved", said so (wave 146, lane 146H — no misleading statuses).
      const { data: decided, error } = await supabase
        .from("activities")
        .update({
          status: decision === "approved" ? "completed" : "rejected",
          completed_at: new Date().toISOString(),
          notes: { ...existingNotes, approval_status: decision },
        })
        .eq("id", itemId)
        .select("id")
      if (!error && (decided?.length ?? 0) > 0) {
        setPending(prev => prev.filter(p => p.id !== itemId))
        toast.success(decision === "approved" ? "Content approved" : "Revisions requested")
      } else {
        toast.error(error ? `Not saved — ${error.message}` : "Not saved — this item could not be updated from your seat (already decided, or not yours to decide)")
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
          <TabsTrigger value="finals">
            <FileText className="h-4 w-4 mr-1.5" />
            Final versions
          </TabsTrigger>
          <TabsTrigger value="tools">
            <FileText className="h-4 w-4 mr-1.5" />
            Routing tools
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4">
          {!loading && queues.length > 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              Showing the items that name you as an approver: {queues.map((q) => q.replace(/_/g, " ")).join(", ")}.
            </p>
          )}
          {pendingError ? (
            <Card>
              <CardContent className="py-6 text-center text-sm text-destructive" role="alert">
                {pendingError} — this is not an empty queue; refresh to try again.
              </CardContent>
            </Card>
          ) : !loading && queues.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                Your role does not approve content here. Use Routing tools to see who approves an item.
              </CardContent>
            </Card>
          ) : pending.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-600" />
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

        {/* WAVE 145 (lane 145Z — owner ruling 20): the final version of every AI piece, and what actually went out. */}
        <TabsContent value="finals" className="mt-4">
          <FinalVersionsPanel />
        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          <ApprovalToolsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
