"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { CheckCircle2, X, Loader2, Sparkles, Mail, FileText, Mic, Inbox } from "lucide-react"
import {
  approveMarketingAssetAction,
  rejectMarketingAssetAction,
  type PendingAssetRow,
  type AssetKind,
} from "@/app/actions/marketing-ai-approvals"

interface Props { initialRows: PendingAssetRow[] }

const KIND_META: Record<AssetKind, { label: string; icon: typeof Mail; tone: string }> = {
  newsletter:  { label: "Newsletter",   icon: Mail,    tone: "bg-blue-100 text-blue-800" },
  blog:        { label: "Blog post",    icon: FileText,tone: "bg-emerald-100 text-emerald-800" },
  podcast:     { label: "Podcast",      icon: Mic,     tone: "bg-purple-100 text-purple-800" },
  direct_mail: { label: "Direct mail",  icon: Inbox,   tone: "bg-amber-100 text-amber-800" },
}

export function MarketingApprovalsClient({ initialRows }: Props) {
  const [rows, setRows] = useState<PendingAssetRow[]>(initialRows)
  const [rejectingKey, setRejectingKey] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleApprove(kind: AssetKind, id: string) {
    startTransition(async () => {
      setFeedback(null)
      const r = await approveMarketingAssetAction(kind, id)
      if (!r.ok) { setFeedback(`Approve failed: ${r.error}`); return }
      setRows(prev => prev.filter(p => !(p.kind === kind && p.id === id)))
      setFeedback("Approved.")
    })
  }
  function handleReject(kind: AssetKind, id: string) {
    if (!reason || reason.trim().length < 5) {
      setFeedback("Rejection reason must be at least 5 characters."); return
    }
    startTransition(async () => {
      setFeedback(null)
      const r = await rejectMarketingAssetAction(kind, id, reason)
      if (!r.ok) { setFeedback(`Reject failed: ${r.error}`); return }
      setRows(prev => prev.filter(p => !(p.kind === kind && p.id === id)))
      setRejectingKey(null); setReason("")
      setFeedback("Rejected with reason recorded.")
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {rows.length} pending {rows.length === 1 ? "asset" : "assets"}
        </span>
        {feedback && (
          <div className="text-sm rounded-md border bg-muted/40 px-3 py-1.5 ml-auto">{feedback}</div>
        )}
      </div>

      {rows.length === 0 && (
        <div className="text-sm text-muted-foreground border rounded-md p-6 text-center">
          No marketing assets waiting for review.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {rows.map(r => {
          const meta = KIND_META[r.kind]
          const key  = `${r.kind}:${r.id}`
          const Icon = meta.icon
          return (
            <Card key={key}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <CardTitle className="text-base flex items-center gap-2">
                    {r.is_ai_generated && <Sparkles className="h-4 w-4 text-purple-500" />}
                    {r.title}
                  </CardTitle>
                  <Badge className={meta.tone}>
                    <Icon className="h-3 w-3 mr-1" />
                    {meta.label}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {r.summary && <p className="text-sm text-muted-foreground">{r.summary}</p>}
                {r.body_preview && (
                  <details className="rounded-md border bg-muted/30 p-2">
                    <summary className="cursor-pointer text-xs font-medium">View body preview</summary>
                    <pre className="text-xs whitespace-pre-wrap mt-2 max-h-64 overflow-y-auto">
                      {r.body_preview}{r.body_preview.length >= 600 ? "…" : ""}
                    </pre>
                  </details>
                )}

                {rejectingKey === key ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      rows={3}
                      value={reason}
                      onChange={(e: any) => setReason(e.target.value)}
                      placeholder="Why is this draft rejected? (e.g. tone is off, factual error)"
                      className="text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="destructive" onClick={() => handleReject(r.kind, r.id)} disabled={isPending}>
                        {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <X className="h-3 w-3 mr-1" />}
                        Confirm reject
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setRejectingKey(null); setReason("") }}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => handleApprove(r.kind, r.id)} disabled={isPending}>
                      {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRejectingKey(key)} disabled={isPending}>
                      <X className="h-3.5 w-3.5 mr-1" />
                      Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
