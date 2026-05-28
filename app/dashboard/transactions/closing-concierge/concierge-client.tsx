"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import {
  AlertTriangle, AlertCircle, Clock, CheckCircle2, ArrowRight, Sparkles, Mail, Send,
  X, Loader2, Building2, FileText, Calendar, ShieldCheck, ChevronRight, Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  resolveConciergeAction, dismissConciergeAction, draftConciergeActionEmail,
  dispatchConciergeActionEmail, type ConciergeBoard, type ConciergeAction, type Severity,
} from "./actions"

interface Props { board: ConciergeBoard }

const SEV_META: Record<Severity, { label: string; tone: string; Icon: typeof AlertTriangle }> = {
  urgent: { label: "Urgent", tone: "bg-red-50 text-red-900 border-red-200",       Icon: AlertTriangle },
  high:   { label: "High",   tone: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertCircle },
  medium: { label: "Medium", tone: "bg-blue-50 text-blue-900 border-blue-200",    Icon: Clock },
  low:    { label: "Low",    tone: "bg-slate-50 text-slate-700 border-slate-200", Icon: CheckCircle2 },
}

const ACTION_TYPE_LABELS: Record<string, string> = {
  appraisal_not_ordered:     "Appraisal not ordered",
  inspection_window_closing: "Inspection window closing",
  inspection_overdue:        "Inspection overdue",
  em_not_received:           "Earnest money not received",
  lender_condition_stale:    "Lender condition stale",
  clear_to_close_late:       "Clear-to-close late",
  walkthrough_unscheduled:   "Walkthrough not scheduled",
  wire_instructions_missing: "Wire instructions missing",
  cda_missing:               "CDA not delivered",
  title_commitment_late:     "Title commitment late",
  financing_deadline_close:  "Financing deadline near",
  contract_followup_check:   "Contract follow-up",
}

const RECIPIENT_LABELS: Record<string, string> = {
  buyer: "buyer", seller: "seller", lender: "loan officer", inspector: "inspector",
  title: "title officer", escrow: "escrow officer", co_agent: "co-agent", agent: "you",
}

const daysTo = (iso: string | null) => {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
}

export function ClosingConciergeClient({ board }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  const [draftOpen, setDraftOpen] = useState(false)
  const [draftLoading, setDraftLoading] = useState(false)
  const [draftAction, setDraftAction] = useState<ConciergeAction | null>(null)
  const [draftSubject, setDraftSubject] = useState("")
  const [draftBody, setDraftBody] = useState("")
  const [recipientEmail, setRecipientEmail] = useState("")
  const [dispatching, setDispatching] = useState(false)

  async function openDraft(action: ConciergeAction) {
    setDraftAction(action)
    setDraftOpen(true)
    setDraftLoading(true)
    setDraftSubject("")
    setDraftBody("")
    setRecipientEmail("")
    try {
      const r = await draftConciergeActionEmail(action.id)
      if (r.success) {
        setDraftSubject(r.subject ?? "")
        setDraftBody(r.body ?? "")
        setRecipientEmail(r.suggestedRecipientEmail ?? "")
      } else {
        toast.error(r.error ?? "Draft failed")
        setDraftOpen(false)
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Draft failed")
      setDraftOpen(false)
    } finally {
      setDraftLoading(false)
    }
  }

  async function handleDispatch() {
    if (!draftAction) return
    if (!recipientEmail.trim()) { toast.error("Add a recipient email"); return }
    setDispatching(true)
    try {
      const r = await dispatchConciergeActionEmail({
        actionId:       draftAction.id,
        recipientEmail,
        subject:        draftSubject,
        body:           draftBody,
      })
      if (r.success) {
        toast.success(`Sent via ${r.providerKey ?? "your email provider"}.`)
        setDraftOpen(false)
        router.refresh()
      } else {
        toast.error(r.error ?? "Send failed")
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Send failed")
    } finally {
      setDispatching(false)
    }
  }

  function handleResolve(actionId: string) {
    setBusyId(actionId)
    startTransition(async () => {
      const r = await resolveConciergeAction(actionId, null)
      if (r.success) { toast.success("Resolved"); router.refresh() }
      else toast.error(r.error ?? "Failed")
      setBusyId(null)
    })
  }

  function handleDismiss(actionId: string) {
    if (!confirm("Dismiss this action without acting on it?")) return
    setBusyId(actionId)
    startTransition(async () => {
      const r = await dismissConciergeAction(actionId, "Dismissed by agent")
      if (r.success) { toast.success("Dismissed"); router.refresh() }
      else toast.error(r.error ?? "Failed")
      setBusyId(null)
    })
  }

  // Group actions by transaction for readability
  const byTransaction = board.actions.reduce<Map<string, ConciergeAction[]>>((acc, a) => {
    const list = acc.get(a.transactionId) ?? []
    list.push(a)
    acc.set(a.transactionId, list)
    return acc
  }, new Map())

  return (
    <div className="container max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-semibold tracking-tight">Closing Concierge</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every open transaction has things that need to happen between offer accepted and closing. AI watches
          every 6 hours — appraisals, inspections, lender conditions, walkthroughs, CDAs, wire instructions —
          and tells you exactly who to email and what to ask. Click "Draft email," review, send. The deal
          stays on the rails.
        </p>
      </div>

      {/* ── Severity summary ────────────────────────────────────────────── */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 mb-6">
        {(["urgent", "high", "medium", "low"] as Severity[]).map(level => {
          const meta = SEV_META[level]
          const Icon = meta.Icon
          return (
            <Card key={level} className={cn("border", meta.tone)}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-4 w-4" />
                  <span className="text-xs uppercase tracking-wide font-medium">{meta.label}</span>
                </div>
                <p className="text-2xl font-bold">{board.summary[level]}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {board.actions.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground space-y-2">
            <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
            <p className="font-medium text-foreground">Nothing pending across your active transactions.</p>
            <p className="text-xs">When the next inspection deadline, appraisal trigger, or wire-instructions gap shows up, it'll appear here with a one-click email draft.</p>
            <Button asChild size="sm" variant="outline" className="mt-2">
              <Link href="/dashboard/transactions">Open Transactions <ArrowRight className="h-3 w-3 ml-1" /></Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Per-transaction grouped actions ─────────────────────────────── */}
      <div className="space-y-6">
        {Array.from(byTransaction.entries()).map(([txnId, actions]) => {
          const first = actions[0]
          const ctd = daysTo(first.closeDate)
          return (
            <div key={txnId}>
              <div className="flex items-center justify-between mb-2 px-1">
                <Link href={`/dashboard/transactions/${txnId}`} className="flex items-center gap-2 group min-w-0">
                  <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <h2 className="text-sm font-semibold truncate group-hover:underline">{first.transactionLabel}</h2>
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                </Link>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {first.closeDate && (
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {ctd != null && ctd >= 0 ? `${ctd} day${ctd === 1 ? "" : "s"} to close` : `Close was ${first.closeDate}`}
                    </span>
                  )}
                  <Badge variant="outline" className="text-[10px]">{actions.length} action{actions.length === 1 ? "" : "s"}</Badge>
                </div>
              </div>

              <div className="space-y-2">
                {actions.map(action => {
                  const meta = SEV_META[action.severity]
                  const Icon = meta.Icon
                  const dtd = daysTo(action.dueDate)
                  return (
                    <Card key={action.id} className={cn(action.severity === "urgent" ? "border-red-300" : action.severity === "high" ? "border-amber-300" : undefined)}>
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <CardTitle className="text-sm font-medium flex items-center gap-2 flex-wrap">
                              <Icon className="h-4 w-4 shrink-0" style={{ color: action.severity === "urgent" ? "#dc2626" : action.severity === "high" ? "#d97706" : "#2563eb" }} />
                              <span>{action.headline}</span>
                              <Badge className={cn(meta.tone, "text-[10px]")}>{meta.label}</Badge>
                              <Badge variant="outline" className="text-[10px]">{ACTION_TYPE_LABELS[action.actionType] ?? action.actionType}</Badge>
                            </CardTitle>
                            {action.detail && <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{action.detail}</p>}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          {action.suggestedRecipient && (
                            <span className="inline-flex items-center gap-1">
                              <Mail className="h-3 w-3" /> Send to {RECIPIENT_LABELS[action.suggestedRecipient]}
                            </span>
                          )}
                          {action.dueDate && (
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {dtd != null && dtd > 0 ? `${dtd} day${dtd === 1 ? "" : "s"} to deadline` : dtd === 0 ? "due today" : `${Math.abs(dtd ?? 0)} day${Math.abs(dtd ?? 0) === 1 ? "" : "s"} overdue`}
                            </span>
                          )}
                        </div>
                        <div className="flex gap-2 pt-1">
                          <Button size="sm" variant="default" onClick={() => openDraft(action)}>
                            <Sparkles className="h-3 w-3 mr-1" /> Draft email
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => handleResolve(action.id)} disabled={busyId === action.id || pending}>
                            <CheckCircle2 className="h-3 w-3 mr-1" /> Mark done
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDismiss(action.id)} disabled={busyId === action.id || pending}>
                            <Trash2 className="h-3 w-3 mr-1" /> Dismiss
                          </Button>
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/dashboard/transactions/${txnId}`}>
                              <FileText className="h-3 w-3 mr-1" /> Open transaction
                            </Link>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Draft + dispatch dialog ─────────────────────────────────────── */}
      <Dialog open={draftOpen} onOpenChange={(o) => { if (!o) setDraftOpen(false) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {draftAction ? draftAction.headline : "Draft email"}
            </DialogTitle>
            <DialogDescription>
              AI drafted this from your transaction's actual data. Review, edit, then send through your
              email provider — or copy and open in your own client.
            </DialogDescription>
          </DialogHeader>

          {draftLoading ? (
            <div className="py-12 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Drafting…
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="recipient">Recipient email</Label>
                <Input id="recipient" type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} placeholder="lender@example.com" />
                {!recipientEmail && draftAction?.suggestedRecipient && (
                  <p className="text-[10px] text-amber-700">
                    No {RECIPIENT_LABELS[draftAction.suggestedRecipient]} email on file for this transaction yet — add one to use one-click send.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="subject">Subject</Label>
                <Input id="subject" value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="body">Body</Label>
                <Textarea id="body" rows={10} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraftOpen(false)} disabled={draftLoading || dispatching}>
              <X className="h-3 w-3 mr-1" /> Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const params = new URLSearchParams({ subject: draftSubject, body: draftBody }).toString()
                window.location.href = `mailto:${encodeURIComponent(recipientEmail)}?${params}`
                toast.success("Opening your email client.")
              }}
              disabled={draftLoading || !draftBody.trim()}
            >
              <Mail className="h-3 w-3 mr-1" /> Open in client
            </Button>
            <Button onClick={handleDispatch} disabled={draftLoading || dispatching || !draftBody.trim() || !recipientEmail.trim()}>
              {dispatching ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
              Send via platform
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
