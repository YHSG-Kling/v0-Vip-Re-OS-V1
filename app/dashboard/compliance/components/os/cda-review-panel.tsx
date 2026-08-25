"use client"

/**
 * CdaReviewPanel — compliance dashboard surface for the CDA approval queue.
 *
 *   • Lists CDAs the brokerage currently needs to review (submitted +
 *     recently-changes-requested), ordered by submission time
 *   • Shows the signature pre-scan result + missing docs callouts so
 *     compliance can see the gate status at a glance
 *   • Three actions per CDA: Approve · Request Changes · Manual Override
 *     (override requires a typed reason ≥10 chars per the action contract)
 *
 * Wraps the EXISTING server actions in app/actions/cda-portal.ts:
 *     approveCdaAction, requestCdaChangesAction, manualOverrideCdaAction
 *   plus the read action listCdasForComplianceReviewAction.
 *
 * Slot into app/dashboard/compliance/page.tsx alongside
 * <ExceptionReviewPanelWrapper />.
 */

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ShieldCheck, AlertTriangle, CheckCircle, Loader2, FileWarning, Send } from "lucide-react"
import {
  approveCdaAction,
  brokerSignCdaAction,
  sendCdaToTitleAction,
  requestCdaChangesAction,
  manualOverrideCdaAction,
} from "@/app/actions/cda-portal"
import { listCdasForComplianceReviewAction, type CdaReviewItem } from "@/app/actions/cda-portal-list"
import { toast } from "sonner"

type Mode = "request_changes" | "manual_override" | "send_to_title" | null

export function CdaReviewPanel() {
  const [items, setItems] = useState<CdaReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()

  const [activeId, setActiveId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [reason, setReason] = useState("")
  // Send-to-title recipient. The closing agent is a person at a title company /
  // escrow / closing attorney, not a stored platform user, so it is captured here.
  const [titleEmail, setTitleEmail] = useState("")
  const [titleName, setTitleName] = useState("")

  useEffect(() => { void reload() }, [])

  async function reload() {
    setLoading(true)
    const res = await listCdasForComplianceReviewAction()
    if (res.success) setItems(res.items)
    setLoading(false)
  }

  function openDialog(cdaId: string, m: Exclude<Mode, null>) {
    setActiveId(cdaId)
    setMode(m)
    setReason("")
  }

  function closeDialog() {
    setActiveId(null); setMode(null); setReason("")
    setTitleEmail(""); setTitleName("")
  }

  function handleApprove(cdaId: string) {
    startTransition(async () => {
      const res = await approveCdaAction({ cdaId })
      if (res.success) {
        toast.success("CDA approved")
        void reload()
      } else {
        if ("error" in res && res.error === "signature_check_failed_use_manual_override") {
          toast.error("Required signatures missing — use Manual Override with a reason if you still need to approve")
        } else if ("error" in res && res.error === "contract_check_failed_use_manual_override") {
          toast.error("CDA split doesn't match the agent's brokerage contract — use Manual Override with a reason if it's intentional")
        } else {
          toast.error("error" in res ? res.error : "Approval failed")
        }
      }
    })
  }

  function handleBrokerSign(cdaId: string) {
    startTransition(async () => {
      const res = await brokerSignCdaAction({ cdaId })
      if (res.success) {
        const mode = "signMode" in res ? res.signMode : "in_app"
        const provider = "provider" in res ? res.provider : null
        toast.success(
          mode === "esign" && provider
            ? `CDA sent to ${provider} for your signature — ready to send to the closing agent`
            : "CDA signed — ready to send to the closing agent",
        )
        void reload()
      } else {
        toast.error("error" in res && res.error === "forbidden_broker_only"
          ? "Only the broker (or a broker/admin) can sign the CDA"
          : ("error" in res ? res.error : "Signing failed"))
      }
    })
  }

  function handleSubmitDialog() {
    if (!activeId) return
    if (mode === "send_to_title") {
      const email = titleEmail.trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast.error("Enter a valid closing-agent email"); return }
      startTransition(async () => {
        const res = await sendCdaToTitleAction({
          cdaId: activeId,
          recipientEmail: email,
          recipientName: titleName.trim() || undefined,
          method: "email",
        })
        if (res.success) { toast.success(`CDA delivered to ${email}`); closeDialog(); void reload() }
        else toast.error("error" in res ? res.error : "Send failed")
      })
      return
    }
    if (mode === "request_changes") {
      if (!reason.trim()) { toast.error("Reason is required"); return }
      startTransition(async () => {
        const res = await requestCdaChangesAction({ cdaId: activeId, reason: reason.trim() })
        if (res.success) { toast.success("Sent back to agent"); closeDialog(); void reload() }
        else toast.error("error" in res ? res.error : "Action failed")
      })
    } else if (mode === "manual_override") {
      if (reason.trim().length < 10) { toast.error("Manual override reason must be ≥ 10 characters"); return }
      startTransition(async () => {
        const res = await manualOverrideCdaAction({ cdaId: activeId, reason: reason.trim() })
        if (res.success) {
          // After override is recorded, run approval — gate is now satisfied
          const ok = await approveCdaAction({ cdaId: activeId })
          if (ok.success) toast.success("Manual override + approval complete")
          else toast.error("Override recorded; approval still failed")
          closeDialog()
          void reload()
        } else toast.error("error" in res ? res.error : "Override failed")
      })
    }
  }

  const submitted = items.filter(i => i.status === "submitted")
  const changesRequested = items.filter(i => i.status === "changes_requested")
  // Compliance-approved CDAs awaiting the BROKER's signature (the 2nd signature
  // before the CDA can go to title).
  const awaitingBrokerSignature = items.filter(i => i.status === "approved" && !i.brokerApprovedAt)
  // Signed by the broker and NOT yet delivered. This bucket did not exist, and
  // neither did the list query behind it — a signed CDA simply left the queue
  // with its disbursement instruction sitting on the platform.
  const awaitingSendToTitle = items.filter(
    i => i.status === "approved" && !!i.brokerApprovedAt && !i.sentToTitleAt,
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            CDA Approval Queue
          </CardTitle>
          <div className="flex items-center gap-2">
            {submitted.length > 0 && <Badge className="bg-orange-500 text-white">{submitted.length} Pending</Badge>}
            {changesRequested.length > 0 && <Badge variant="outline">{changesRequested.length} Awaiting Agent</Badge>}
            {awaitingSendToTitle.length > 0 && (
              <Badge className="bg-blue-600 text-white">{awaitingSendToTitle.length} To Deliver</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="rounded-full bg-green-500/10 p-3 mb-3">
              <ShieldCheck className="h-6 w-6 text-green-600" />
            </div>
            <p className="text-sm text-muted-foreground">No CDAs awaiting review, signature or delivery</p>
          </div>
        ) : (
          <>
            {submitted.map(c => <CdaRow key={c.id} item={c} pending={pending} onApprove={handleApprove} onOpenDialog={openDialog} />)}
            {changesRequested.length > 0 && (
              <div className="pt-3 border-t">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Awaiting agent revision</p>
                {changesRequested.map(c => <CdaRow key={c.id} item={c} pending={pending} compact />)}
              </div>
            )}
            {awaitingBrokerSignature.length > 0 && (
              <div className="pt-3 border-t">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Approved — awaiting broker signature</p>
                {awaitingBrokerSignature.map(c => <CdaRow key={c.id} item={c} pending={pending} onBrokerSign={handleBrokerSign} compact />)}
              </div>
            )}
            {awaitingSendToTitle.length > 0 && (
              <div className="pt-3 border-t">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Signed — awaiting delivery to the closing agent
                </p>
                {awaitingSendToTitle.map(c => (
                  <CdaRow key={c.id} item={c} pending={pending} onOpenDialog={openDialog} sendToTitle compact />
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={mode !== null} onOpenChange={v => { if (!v) closeDialog() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === "request_changes" ? "Request changes"
                : mode === "send_to_title" ? "Send the signed CDA to the closing agent"
                : "Manual override approval"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {mode === "manual_override" && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
                <div className="flex gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-900">A compliance gate failed</p>
                    <p className="text-amber-800 text-xs mt-1">
                      Required signatures are missing or the CDA split doesn't match the agent's
                      brokerage contract. Manual override is logged with your name + reason — use only
                      when you've verified out-of-band that the disbursement is correct.
                    </p>
                  </div>
                </div>
              </div>
            )}
            {mode === "send_to_title" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  This is the disbursement authorization. The closing agent uses it to split funds at
                  closing, so it has to reach them — approving and signing it is not delivery.
                </p>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold">Closing agent email *</Label>
                  <Input
                    type="email"
                    value={titleEmail}
                    onChange={e => setTitleEmail(e.target.value)}
                    placeholder="closer@titlecompany.com"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold">Name (optional)</Label>
                  <Input
                    value={titleName}
                    onChange={e => setTitleName(e.target.value)}
                    placeholder="Sarah Lee, First American Title"
                  />
                </div>
              </>
            ) : (
              <>
                <Label className="text-xs font-semibold">
                  {mode === "request_changes" ? "What does the agent need to fix?" : "Override reason (min 10 characters)"}
                </Label>
                <Textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={4}
                  placeholder={mode === "request_changes"
                    ? "e.g. Buyer-broker agreement signature is missing on page 3"
                    : "e.g. All signatures verified out-of-band by phone with title officer Sarah Lee"}
                />
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={pending}>Cancel</Button>
            <Button
              onClick={handleSubmitDialog}
              disabled={pending || (
                mode === "send_to_title" ? !titleEmail.trim()
                  : mode === "manual_override" ? reason.trim().length < 10
                  : !reason.trim()
              )}
            >
              {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {mode === "request_changes" ? "Send back"
                : mode === "send_to_title" ? "Send to closing agent"
                : "Override & Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

interface RowProps {
  item: CdaReviewItem
  pending: boolean
  compact?: boolean
  onApprove?: (id: string) => void
  onOpenDialog?: (id: string, mode: Exclude<Mode, null>) => void
  onBrokerSign?: (id: string) => void
  /** Renders the delivery action instead of the review actions. */
  sendToTitle?: boolean
}

function CdaRow({ item, pending, compact, onApprove, onOpenDialog, onBrokerSign, sendToTitle }: RowProps) {
  const sigPassed = item.signatureCheckPassed === true
  const sigFailed = item.signatureCheckPassed === false
  const contractPassed = item.contractCheckPassed === true
  const contractFailed = item.contractCheckPassed === false
  const contractBlocker = (item.contractDiscrepancies ?? []).some(d => d.severity === "blocker")
  const overridden = !!item.manualOverrideBy

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/dashboard/transactions/${item.transactionId}`}
            className="font-medium text-sm hover:underline truncate"
          >
            {item.propertyAddress ?? "Transaction"}
          </Link>
          {item.revisionNumber > 1 && (
            <Badge variant="outline" className="text-[10px]">rev {item.revisionNumber}</Badge>
          )}
          {sigPassed && <Badge className="bg-green-100 text-green-800 text-[10px]"><CheckCircle className="h-3 w-3 mr-1" /> Sigs OK</Badge>}
          {sigFailed && !overridden && <Badge variant="destructive" className="text-[10px]"><FileWarning className="h-3 w-3 mr-1" /> Missing sigs</Badge>}
          {contractPassed && <Badge className="bg-green-100 text-green-800 text-[10px]"><CheckCircle className="h-3 w-3 mr-1" /> Split OK</Badge>}
          {contractFailed && contractBlocker && !overridden && <Badge variant="destructive" className="text-[10px]"><AlertTriangle className="h-3 w-3 mr-1" /> Split ≠ contract</Badge>}
          {item.outstandingFees > 0 && <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-700">Owes ${item.outstandingFees.toLocaleString()} fees</Badge>}
          {overridden && <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-700">Override on file</Badge>}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {item.agentName ? `${item.agentName} · ` : ""}
          {item.grossCommission != null && <>Gross ${item.grossCommission.toLocaleString()}</>}
          {item.agentNet != null && <> · Agent ${item.agentNet.toLocaleString()}</>}
          {item.outstandingFees > 0 && <> · must deduct ${item.outstandingFees.toLocaleString()} in fees</>}
        </p>
        {sigFailed && item.missingDocs && item.missingDocs.length > 0 && !compact && (
          <div className="mt-2 text-xs text-amber-700 space-y-0.5">
            {item.missingDocs.slice(0, 3).map((d, i) => (
              <div key={i}>• {d.document_type}: {d.reason}</div>
            ))}
            {item.missingDocs.length > 3 && (
              <div className="text-muted-foreground">+{item.missingDocs.length - 3} more</div>
            )}
          </div>
        )}
        {contractFailed && item.contractDiscrepancies && item.contractDiscrepancies.length > 0 && !compact && (
          <div className="mt-2 text-xs text-red-700 space-y-0.5">
            {item.contractDiscrepancies.slice(0, 3).map((d, i) => {
              const pct = d.field === "agent_split"
              const label = d.field === "agent_split" ? "Agent split" : "Gross commission"
              const fmt = (n: number) => pct ? `${n}%` : `$${n.toLocaleString()}`
              return (
                <div key={i}>
                  • {label}: CDA shows {fmt(d.actual)} vs expected {fmt(d.expected)} ({d.severity})
                </div>
              )
            })}
          </div>
        )}
        {item.status === "changes_requested" && item.changesRequestedNotes && (
          <p className="text-xs text-muted-foreground italic mt-1">"{item.changesRequestedNotes}"</p>
        )}
      </div>

      {!compact && onApprove && onOpenDialog && (
        <div className="flex flex-col gap-1.5">
          <Button size="sm" disabled={pending} onClick={() => onApprove(item.id)} className="gap-1">
            <CheckCircle className="h-3 w-3" /> Approve
          </Button>
          <Button size="sm" variant="outline" disabled={pending}
            onClick={() => onOpenDialog(item.id, "request_changes")}>
            Request changes
          </Button>
          {(sigFailed || (contractFailed && contractBlocker)) && !overridden && (
            <Button size="sm" variant="outline" disabled={pending}
              onClick={() => onOpenDialog(item.id, "manual_override")}
              className="gap-1 border-amber-500 text-amber-700 hover:bg-amber-50">
              <AlertTriangle className="h-3 w-3" /> Override
            </Button>
          )}
        </div>
      )}
      {onBrokerSign && (
        <div className="shrink-0">
          <Button size="sm" disabled={pending} onClick={() => onBrokerSign(item.id)} className="gap-1">
            ✍️ Sign as Broker
          </Button>
        </div>
      )}
      {sendToTitle && onOpenDialog && (
        <div className="shrink-0">
          <Button size="sm" disabled={pending} className="gap-1"
            onClick={() => onOpenDialog(item.id, "send_to_title")}>
            <Send className="h-3 w-3" /> Send to Title
          </Button>
        </div>
      )}
    </div>
  )
}
