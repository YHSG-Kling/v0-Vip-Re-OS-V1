"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Eye, Layers, GitBranch } from "lucide-react"
import { toast } from "sonner"
import {
  previewContentApproval,
  batchEvaluateContentApproval,
  evaluateContentWorkflow,
  formatApprovalDecisionForDisplay,
} from "@/app/actions/content-approval-workflow"

const CONTENT_TYPES = ["listing_description", "social_post", "email", "blog_post", "market_report"]
const CHANNELS = ["social", "email", "sms", "mls", "web", "print"]
const COMPLIANCE = ["pass", "fail", "review_required"] as const
const ROLES = ["agent", "team_lead", "broker", "compliance_officer", "admin"]

/** A minimal ApprovalContext the server-side engine accepts. */
function ctxFor(role: string) {
  return { requester_role: role, brokerage_id: undefined, is_licensed: true } as any
}

/** A minimal ContentGenerationOutput wrapper around raw text. */
function draftFor(text: string, contentType: string, channel: string) {
  return {
    raw_content: text,
    content_type: contentType,
    channel_intent: channel,
    metadata: {},
  } as any
}

function verdictFor(status: (typeof COMPLIANCE)[number]) {
  return {
    status,
    violations: [],
    warnings: [],
    requires_review: status !== "pass",
  } as any
}

export function ApprovalToolsPanel() {
  const [isPending, startTransition] = useTransition()

  // ── preview ──────────────────────────────────────────────────────────────
  const [pType, setPType] = useState(CONTENT_TYPES[0])
  const [pChannel, setPChannel] = useState(CHANNELS[0])
  const [pCompliance, setPCompliance] = useState<(typeof COMPLIANCE)[number]>("pass")
  const [pRole, setPRole] = useState(ROLES[0])
  const [preview, setPreview] = useState<any>(null)

  // ── single workflow ──────────────────────────────────────────────────────
  const [wText, setWText] = useState("")
  const [workflow, setWorkflow] = useState<any>(null)
  const [formatted, setFormatted] = useState<string | null>(null)

  // ── batch ────────────────────────────────────────────────────────────────
  const [batchText, setBatchText] = useState("")
  const [batch, setBatch] = useState<any[] | null>(null)

  const handlePreview = () => {
    startTransition(async () => {
      const res = await previewContentApproval({
        content_type: pType,
        channel_intent: pChannel,
        compliance_status: pCompliance,
        context: ctxFor(pRole),
      })
      if (!res.success || !res.preview) {
        setPreview(null)
        toast.error(res.error ?? "Preview unavailable")
        return
      }
      setPreview(res.preview)
    })
  }

  const handleWorkflow = () => {
    startTransition(async () => {
      const res = await evaluateContentWorkflow({
        draft: draftFor(wText, pType, pChannel),
        complianceVerdict: verdictFor(pCompliance),
        context: ctxFor(pRole),
        log_signals: true,
      })
      if (!res.success || !res.workflow_result) {
        setWorkflow(null)
        setFormatted(null)
        toast.error(res.error ?? "Workflow evaluation failed")
        return
      }
      setWorkflow(res.workflow_result)

      // Render the decision through the server's own formatter so the wording
      // an approver reads is the wording the engine produced.
      const fmt = await formatApprovalDecisionForDisplay(res.workflow_result.approval)
      setFormatted(fmt.success ? (fmt.formatted ?? null) : null)
      if (!fmt.success) toast.error(fmt.error ?? "Could not format the decision")
      else toast.success("Decision logged to the approval queue")
    })
  }

  const handleBatch = () => {
    startTransition(async () => {
      const pieces = batchText
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean)

      if (pieces.length === 0) { toast.error("Paste one or more drafts, separated by a blank line"); return }
      const res = await batchEvaluateContentApproval({
        inputs: pieces.map((p) => ({
          draft: draftFor(p, pType, pChannel),
          complianceVerdict: verdictFor(pCompliance),
          context: ctxFor(pRole),
        })),
        log_signals: true,
      })
      if (!res.success || !res.decisions) {
        setBatch(null)
        toast.error(res.error ?? "Batch evaluation failed")
        return
      }
      setBatch(res.decisions)
      toast.success(`${res.decisions.length} drafts evaluated`)
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Shared settings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Content type</Label>
            <Select value={pType} onValueChange={setPType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Channel</Label>
            <Select value={pChannel} onValueChange={setPChannel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Compliance</Label>
            <Select value={pCompliance} onValueChange={(v) => setPCompliance(v as typeof pCompliance)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPLIANCE.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Requester role</Label>
            <Select value={pRole} onValueChange={setPRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ── PREVIEW ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Eye className="h-4 w-4" /> Who would have to approve this?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Answers before anything is written or logged — no draft required.
          </p>
          <Button onClick={handlePreview} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Preview routing
          </Button>
          {preview && (
            <div className="rounded-md border p-3 space-y-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className="text-[10px]">{preview.likely_status}</Badge>
                {preview.likely_approvers.map((a: string) => (
                  <Badge key={a} variant="outline" className="text-[10px]">
                    {a.replace(/_/g, " ")}
                  </Badge>
                ))}
              </div>
              <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
                {preview.reasoning.map((r: string, i: number) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── SINGLE WORKFLOW ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <GitBranch className="h-4 w-4" /> Run one draft through the workflow
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea rows={5} value={wText} onChange={(e) => setWText(e.target.value)} placeholder="Paste the draft…" />
          <Button onClick={handleWorkflow} disabled={isPending || !wText.trim()}>
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Evaluate &amp; log
          </Button>
          {workflow && (
            <div className="rounded-md border p-3 space-y-2 text-xs">
              <Badge className="text-[10px]">{workflow.approval.status}</Badge>
              {formatted && <pre className="whitespace-pre-wrap font-sans">{formatted}</pre>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── BATCH ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="h-4 w-4" /> Evaluate a batch
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">One draft per block, separated by a blank line.</p>
          <Textarea rows={8} value={batchText} onChange={(e) => setBatchText(e.target.value)} />
          <Button onClick={handleBatch} disabled={isPending || !batchText.trim()}>
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Evaluate all
          </Button>
          {batch && (
            <div className="divide-y">
              {batch.map((d: any, i: number) => (
                <div key={i} className="py-2 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Draft {i + 1}</span>
                  <div className="flex items-center gap-1.5">
                    {(d.required_approvers ?? []).map((a: string) => (
                      <Badge key={a} variant="outline" className="text-[10px]">
                        {a.replace(/_/g, " ")}
                      </Badge>
                    ))}
                    <Badge className="text-[10px]">{d.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
