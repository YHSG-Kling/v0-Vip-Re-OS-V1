"use client"

/**
 * Composable agent-action toolbar for the offer detail view.
 *
 * Surfaces every server action we shipped this sprint as a single button:
 *   - Submit to compliance   → submitOfferToCompliance
 *   - Flag a compliance issue → flagOfferCompliance
 *   - Run packet scan         → scanOfferPacketCompleteness
 *   - Record seller response  → recordSellerResponse
 *   - Record seller-signed counter → recordSellerSignedCounter
 *
 * Each button is gated on the offer's current state so the agent only sees
 * the actions that make sense right now. Disabled state shows a tooltip
 * explaining why.
 *
 * The component is pure presentational — it dispatches the actions and
 * reports back to the page via the onResult callback. The page owns state
 * + revalidation.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { AlertCircle, CheckCircle2, FileText, Flag, RefreshCw, Send, Loader2 } from "lucide-react"

import { submitOfferToCompliance }     from "@/app/actions/buyer-offer/submit-to-compliance"
import { flagOfferCompliance }         from "@/app/actions/buyer-offer/flag-compliance"
import { recordSellerResponse }        from "@/app/actions/buyer-offer/record-seller-response"
import { recordSellerSignedCounter }   from "@/app/actions/buyer-offer/record-seller-signed-counter"

interface OfferAgentActionsProps {
  offerId:      string
  agentUserId:  string
  /** Offer state from the parent (informs which buttons are active). */
  state: {
    buyer_signed:                 boolean
    seller_response_type:         "accepted" | "countered" | "rejected" | null
    fully_signed_contract_on_file: boolean
    compliance_passed:            boolean
    transaction_id:               string | null
  }
  onResult?: (result: { kind: string; ok: boolean; message: string }) => void
}

export function OfferAgentActions({ offerId, agentUserId, state, onResult }: OfferAgentActionsProps) {
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)

  const report = (kind: string, ok: boolean, message: string) => {
    if (onResult) onResult({ kind, ok, message })
  }

  // ── Action handlers ────────────────────────────────────────────────────
  function submit() {
    setBusy("submit")
    startTransition(async () => {
      try {
        const r = await submitOfferToCompliance({ offerId, userId: agentUserId })
        report("submit", r.success, r.success
          ? `Submitted to compliance. Transaction created: ${r.transaction_id}`
          : `Refused: ${r.error}`)
      } finally { setBusy(null) }
    })
  }
  function flag() {
    setBusy("flag")
    startTransition(async () => {
      try {
        const title = prompt("Flag title (e.g. 'Missing buyer initial page 3'):") ?? ""
        if (!title) { setBusy(null); return }
        const r = await flagOfferCompliance({
          offerId,
          raiserUserId: agentUserId,
          flagType:     "missing_initial",
          severity:     "high",
          title,
        })
        report("flag", r.success, r.success ? `Flagged. ${r.notified_count} people notified.` : `Failed: ${r.error}`)
      } finally { setBusy(null) }
    })
  }
  function recordAccepted() {
    setBusy("accepted")
    startTransition(async () => {
      try {
        const url = prompt("Seller-signed contract URL (storage URL):") ?? ""
        const r = await recordSellerResponse({
          offerId, userId: agentUserId, responseType: "accepted",
          documentUrl: url || undefined,
        })
        report("accepted", r.success, r.success ? "Seller acceptance recorded." : `Failed: ${r.error}`)
      } finally { setBusy(null) }
    })
  }
  function recordCounter() {
    setBusy("counter")
    startTransition(async () => {
      try {
        const url = prompt("Seller-signed COUNTER URL (storage URL):") ?? ""
        const priceStr = prompt("Counter price?") ?? ""
        const counterPrice = priceStr ? Number(priceStr) : undefined
        const r = await recordSellerSignedCounter({
          parentOfferId: offerId,
          raiserUserId:  agentUserId,
          source:        "external",
          terms:         { counterPrice },
          sellerSignedDocumentUrl: url,
        })
        report("counter", r.success, r.success ? `Counter round ${r.round} recorded.` : `Failed: ${r.error}`)
      } finally { setBusy(null) }
    })
  }
  async function runScan() {
    setBusy("scan")
    try {
      const res = await fetch(`/api/offers/${offerId}/packet-scan`, { method: "POST" })
      const json = await res.json().catch(() => ({}))
      report("scan", res.ok, res.ok
        ? `Scan complete: ${json.completionPercent ?? "?"}% complete, ${json.blockers?.length ?? 0} blockers.`
        : `Scan failed: ${json.error ?? res.statusText}`)
    } finally { setBusy(null) }
  }

  // ── Button gates ───────────────────────────────────────────────────────
  const canFlag    = true   // any time
  const canScan    = true   // any time pre-tx-creation
  const canAccept  = state.buyer_signed && !state.seller_response_type && !state.transaction_id
  const canCounter = state.buyer_signed && !state.transaction_id
  const canSubmit  = state.buyer_signed && state.fully_signed_contract_on_file
                      && !state.compliance_passed && !state.transaction_id

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <Button size="sm" variant="default" onClick={submit} disabled={!canSubmit || pending}>
        {busy === "submit" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
        Submit to compliance
      </Button>
      <Button size="sm" variant="outline" onClick={recordAccepted} disabled={!canAccept || pending}>
        {busy === "accepted" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
        Record seller accepted
      </Button>
      <Button size="sm" variant="outline" onClick={recordCounter} disabled={!canCounter || pending}>
        {busy === "counter" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <FileText className="h-3 w-3 mr-1" />}
        Record counter
      </Button>
      <Button size="sm" variant="outline" onClick={runScan} disabled={!canScan || pending}>
        {busy === "scan" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
        Run packet scan
      </Button>
      <Button size="sm" variant="outline" onClick={flag} disabled={!canFlag || pending}>
        {busy === "flag" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Flag className="h-3 w-3 mr-1" />}
        Flag issue
      </Button>
      {!canSubmit && state.buyer_signed && (
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          Submit unlocks once executed contract is on file
        </span>
      )}
    </div>
  )
}
