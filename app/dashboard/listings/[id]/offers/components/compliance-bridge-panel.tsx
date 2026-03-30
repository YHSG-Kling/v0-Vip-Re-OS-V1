"use client"

/**
 * ComplianceBridgePanel
 *
 * Shows the Offer-to-Transaction Compliance Bridge status per offer.
 *
 * Visible states:
 *   1. pending      — offer not yet accepted, compliance not yet evaluated
 *   2. hold         — accepted attempt blocked by compliance gate
 *   3. accepted     — offer accepted, compliance passed, awaiting transaction
 *   4. transaction  — transaction shell created, shows link to transaction
 *
 * UI behavior:
 *   - "Submit for Compliance Review" triggers emitCompliancePassed (dev/manual path)
 *   - "Accept Offer" button calls acceptOfferConditionally via server action
 *   - If blocked, shows clear hold state with reason — no silent failures
 *   - Once transaction exists, shows "View Transaction" link
 *
 * Business rule: acceptOfferConditionally() is the ONLY path that creates a transaction.
 */

import { useState, useTransition } from "react"
import Link                        from "next/link"
import { Badge }                   from "@/components/ui/badge"
import { Button }                  from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  FileText,
  Loader2,
  ArrowRight,
  XCircle,
  Clock,
} from "lucide-react"
import { toast } from "@/hooks/use-toast"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ComplianceBridgeState {
  offerStatus:      string | null
  compliancePassed: boolean
  complianceTimestamp?: string | null
  holdReason?:      string | null
  transactionId?:   string | null
  transactionStatus?: string | null
  blockerEntries?:  Array<{ id: string; failure_reason: string | null; checked_at: string | null }>
}

interface ComplianceBridgePanelProps {
  offerId:        string
  listingId:      string
  brokerageId:    string
  agentUserId:    string
  initialState:   ComplianceBridgeState
  onAccepted?:    (transactionId: string) => void
}

// ─── Server action wrappers (imported dynamically to stay client-safe) ─────────

async function runAcceptOfferConditionally(params: {
  offerId: string; listingId: string; brokerageId: string; agentUserId: string
}) {
  const { acceptOfferConditionally } = await import("@/lib/kernel/transactions")
  return acceptOfferConditionally({
    offerId:     params.offerId,
    agentId:     params.agentUserId,
    brokerageId: params.brokerageId,
    listingId:   params.listingId,
  })
}

async function runEmitCompliancePassed(params: {
  offerId: string; userId: string
}) {
  const { emitCompliancePassed } = await import("@/lib/buyer-offer/compliance-gate")
  return emitCompliancePassed({ offerId: params.offerId, userId: params.userId })
}

async function reloadBridgeStatus(offerId: string) {
  const { loadComplianceBridgeStatus } = await import("@/lib/kernel/transactions")
  return loadComplianceBridgeStatus(offerId)
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ComplianceBridgePanel({
  offerId,
  listingId,
  brokerageId,
  agentUserId,
  initialState,
  onAccepted,
}: ComplianceBridgePanelProps) {
  const [state, setState]       = useState<ComplianceBridgeState>(initialState)
  const [isPending, startTransition] = useTransition()

  const isAccepted    = state.offerStatus === "accepted"
  const isRejected    = ["rejected", "withdrawn"].includes(state.offerStatus ?? "")
  const hasTransaction = !!state.transactionId
  const isHeld        = !state.compliancePassed && isAccepted

  // ── Mark compliance passed (manual/dev path, or triggered by compliance scan) ──
  function handleMarkCompliance() {
    startTransition(async () => {
      const result = await runEmitCompliancePassed({ offerId, userId: agentUserId })
      if (!result.success) {
        toast({ title: "Compliance marking failed", description: result.error, variant: "destructive" })
        return
      }
      const reload = await reloadBridgeStatus(offerId)
      if (reload.success && reload.data) {
        setState(prev => ({
          ...prev,
          compliancePassed:     reload.data!.complianceState.passed,
          complianceTimestamp:  reload.data!.complianceState.complianceTimestamp,
          holdReason:           reload.data!.complianceState.holdReason,
        }))
      }
      toast({ title: "Compliance marked as passed" })
    })
  }

  // ── Accept offer conditionally ────────────────────────────────────────────────
  function handleAccept() {
    startTransition(async () => {
      const result = await runAcceptOfferConditionally({ offerId, listingId, brokerageId, agentUserId })

      if (!result.success) {
        toast({ title: "Acceptance failed", description: result.error, variant: "destructive" })
        return
      }

      const bridgeData = result.data
      if (!bridgeData?.accepted) {
        // Compliance hold — update state to show blocked reason
        setState(prev => ({
          ...prev,
          offerStatus:      "compliance_hold",
          compliancePassed: false,
          holdReason:       bridgeData?.holdReason ?? "Compliance gate blocked acceptance",
        }))
        toast({
          title:       "Offer held — compliance required",
          description: bridgeData?.holdReason ?? "Compliance review must pass before acceptance.",
          variant:     "destructive",
        })
        return
      }

      // Accepted + transaction created
      const txId = bridgeData.transactionId ?? null
      setState(prev => ({
        ...prev,
        offerStatus:       "accepted",
        compliancePassed:  true,
        transactionId:     txId,
        transactionStatus: "under_contract",
      }))
      toast({ title: "Offer accepted", description: txId ? "Transaction created." : "Offer accepted." })
      if (txId) onAccepted?.(txId)
    })
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <Card className="border-border bg-background">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-foreground">
            Compliance Bridge
          </CardTitle>
          <BridgeStatusBadge
            offerStatus={state.offerStatus}
            compliancePassed={state.compliancePassed}
            hasTransaction={hasTransaction}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Compliance state row */}
        <div className="flex items-center gap-2 text-sm">
          {state.compliancePassed ? (
            <ShieldCheck className="h-4 w-4 text-green-600 flex-shrink-0" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-500 flex-shrink-0" />
          )}
          <span className={state.compliancePassed ? "text-green-700" : "text-amber-700"}>
            {state.compliancePassed
              ? `Compliance passed${state.complianceTimestamp ? ` — ${new Date(state.complianceTimestamp).toLocaleDateString()}` : ""}`
              : "Compliance review pending"}
          </span>
        </div>

        {/* Hold reason — shown when blocked */}
        {isHeld && state.holdReason && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-amber-800">Acceptance on hold</p>
              <p className="text-amber-700 mt-0.5">{state.holdReason}</p>
            </div>
          </div>
        )}

        {/* Compliance hold from conditional accept */}
        {state.offerStatus === "compliance_hold" && state.holdReason && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm">
            <XCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-red-800">Blocked — compliance hold</p>
              <p className="text-red-700 mt-0.5">{state.holdReason}</p>
            </div>
          </div>
        )}

        {/* Blocker log entries */}
        {(state.blockerEntries?.length ?? 0) > 0 && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-medium">Previous block events:</p>
            {state.blockerEntries!.map(b => (
              <p key={b.id} className="truncate">
                {b.checked_at ? new Date(b.checked_at).toLocaleString() : "—"}: {b.failure_reason}
              </p>
            ))}
          </div>
        )}

        {/* Transaction link — shown once transaction is created */}
        {hasTransaction && state.transactionId && (
          <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-green-800">Transaction created</p>
              {state.transactionStatus && (
                <p className="text-green-700 text-xs mt-0.5 capitalize">
                  {state.transactionStatus.replace(/_/g, " ")}
                </p>
              )}
            </div>
            <Link
              href={`/dashboard/transactions/${state.transactionId}`}
              className="inline-flex items-center gap-1 text-green-700 hover:text-green-900 font-medium text-xs flex-shrink-0"
            >
              View
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        )}

        {/* Downstream actions */}
        {!isRejected && !hasTransaction && (
          <div className="flex flex-col gap-2 pt-1">
            {/* Step 1: Mark compliance — only shown when not yet passed */}
            {!state.compliancePassed && (
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs"
                disabled={isPending}
                onClick={handleMarkCompliance}
              >
                {isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                ) : (
                  <FileText className="h-3 w-3 mr-1.5" />
                )}
                Submit for Compliance Review
              </Button>
            )}

            {/* Step 2: Accept — shown when compliance passed and offer not yet accepted */}
            {state.compliancePassed && !isAccepted && (
              <Button
                size="sm"
                className="w-full text-xs bg-foreground text-background hover:bg-foreground/90"
                disabled={isPending}
                onClick={handleAccept}
              >
                {isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                ) : (
                  <CheckCircle2 className="h-3 w-3 mr-1.5" />
                )}
                Accept Offer
              </Button>
            )}

            {/* Accepted but no transaction yet — retry */}
            {isAccepted && !hasTransaction && (
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs"
                disabled={isPending}
                onClick={handleAccept}
              >
                {isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                ) : (
                  <Clock className="h-3 w-3 mr-1.5" />
                )}
                Create Transaction
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Badge sub-component ──────────────────────────────────────────────────────

function BridgeStatusBadge({
  offerStatus,
  compliancePassed,
  hasTransaction,
}: {
  offerStatus:      string | null
  compliancePassed: boolean
  hasTransaction:   boolean
}) {
  if (hasTransaction) {
    return <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Transaction Created</Badge>
  }
  if (offerStatus === "accepted" && compliancePassed) {
    return <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-xs">Accepted</Badge>
  }
  if (offerStatus === "compliance_hold" || (offerStatus === "accepted" && !compliancePassed)) {
    return <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Compliance Hold</Badge>
  }
  if (offerStatus === "rejected") {
    return <Badge className="bg-red-100 text-red-800 border-red-200 text-xs">Rejected</Badge>
  }
  if (compliancePassed) {
    return <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Compliance Passed</Badge>
  }
  return <Badge variant="outline" className="text-xs">Pending Review</Badge>
}
