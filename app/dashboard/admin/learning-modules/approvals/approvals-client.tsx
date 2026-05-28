"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { CheckCircle2, X, Loader2, Sparkles } from "lucide-react"
import {
  approveLearningModuleAction,
  rejectLearningModuleAction,
  type PendingModuleRow,
} from "@/app/actions/learning-modules-approvals"

interface Props {
  initialRows: PendingModuleRow[]
}

export function ApprovalsClient({ initialRows }: Props) {
  const [rows, setRows] = useState<PendingModuleRow[]>(initialRows)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleApprove(id: string): void {
    startTransition(async () => {
      setFeedback(null)
      const result = await approveLearningModuleAction(id)
      if (!result.ok) {
        setFeedback(`Approve failed: ${result.error}`)
        return
      }
      setRows(r => r.filter(x => x.id !== id))
      setFeedback("Approved + published.")
    })
  }

  function handleReject(id: string): void {
    if (!reason || reason.trim().length < 5) {
      setFeedback("Rejection reason must be at least 5 characters.")
      return
    }
    startTransition(async () => {
      setFeedback(null)
      const result = await rejectLearningModuleAction(id, reason)
      if (!result.ok) {
        setFeedback(`Reject failed: ${result.error}`)
        return
      }
      setRows(r => r.filter(x => x.id !== id))
      setRejectingId(null)
      setReason("")
      setFeedback("Rejected with reason recorded.")
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {rows.length} pending review{rows.length === 1 ? "" : "s"}
        </span>
        {feedback && (
          <div className="text-sm rounded-md border bg-muted/40 px-3 py-1.5 ml-auto">{feedback}</div>
        )}
      </div>

      {rows.length === 0 && (
        <div className="text-sm text-muted-foreground border rounded-md p-6 text-center">
          No AI modules waiting for review.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {rows.map(r => (
          <Card key={r.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <CardTitle className="text-base flex items-center gap-2">
                  {r.is_ai_generated && <Sparkles className="h-4 w-4 text-purple-500" />}
                  {r.title}
                </CardTitle>
                <div className="flex flex-wrap gap-1.5">
                  {r.channels.map(c => <Badge key={c} variant="outline" className="text-xs">{c}</Badge>)}
                  {r.milestone_key && <Badge variant="secondary" className="text-xs">{r.milestone_key}</Badge>}
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {r.summary && <p className="text-sm text-muted-foreground">{r.summary}</p>}

              <div className="flex flex-wrap gap-1">
                {r.audience_roles.map(a => <Badge key={a} variant="outline" className="text-xs">role: {a}</Badge>)}
                {r.audience_personas.map(p => <Badge key={p} variant="outline" className="text-xs">persona: {p}</Badge>)}
                {r.stage_tags.map(s => <Badge key={s} variant="outline" className="text-xs">stage: {s}</Badge>)}
              </div>

              <details className="rounded-md border bg-muted/30 p-2">
                <summary className="cursor-pointer text-xs font-medium">View body draft</summary>
                <pre className="text-xs whitespace-pre-wrap mt-2 max-h-64 overflow-y-auto">
                  {r.body ?? "(empty body)"}
                </pre>
              </details>

              {rejectingId === r.id ? (
                <div className="flex flex-col gap-2">
                  <Textarea
                    rows={3}
                    value={reason}
                    onChange={(e: any) => setReason(e.target.value)}
                    placeholder="Why is this draft rejected? (e.g. tone is off, factual error, conflicts with brand voice)"
                    className="text-sm"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="destructive" onClick={() => handleReject(r.id)} disabled={isPending}>
                      {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <X className="h-3 w-3 mr-1" />}
                      Confirm reject
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setRejectingId(null); setReason("") }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => handleApprove(r.id)} disabled={isPending}>
                    {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                    Approve & publish
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRejectingId(r.id)} disabled={isPending}>
                    <X className="h-3.5 w-3.5 mr-1" />
                    Reject
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
