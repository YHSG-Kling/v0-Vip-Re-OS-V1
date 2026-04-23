"use client"

import { useState, useEffect, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, CheckCircle2, Clock, AlertTriangle, FileText } from "lucide-react"
import { toast } from "sonner"
import { getMyPendingApprovals, getApprovalHistory } from "@/app/actions/content-approval-workflow"
import { createClient } from "@/lib/supabase/client"

export default function ContentApprovalsPage() {
  const [pending, setPending] = useState<any[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const load = async () => {
      const [pendingRes, histRes] = await Promise.allSettled([
        getMyPendingApprovals({ approver_role: "broker", limit: 50 }),
        getApprovalHistory({ limit: 20 }),
      ])
      if (pendingRes.status === "fulfilled" && pendingRes.value.success) {
        setPending(pendingRes.value.pending ?? [])
      }
      if (histRes.status === "fulfilled" && (histRes.value as any).success) {
        setHistory((histRes.value as any).history ?? [])
      }
      setLoading(false)
    }
    load()
  }, [])

  const handleDecision = (itemId: string, decision: "approved" | "rejected") => {
    startTransition(async () => {
      const supabase = createClient()
      const { error } = await supabase
        .from("content_approvals")
        .update({ status: decision, reviewed_at: new Date().toISOString() })
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
