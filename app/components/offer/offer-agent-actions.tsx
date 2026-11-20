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
 *   - Upload document         → /api/offers/[offerId]/upload-document
 *
 * Each button is gated on the offer's current state so the agent only sees
 * the actions that make sense right now. Disabled state shows a tooltip
 * explaining why.
 *
 * The component is pure presentational — it dispatches the actions and
 * reports back to the page via the onResult callback. The page owns state
 * + revalidation.
 */

import { useRef, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertCircle, CheckCircle2, FileText, Flag, RefreshCw, Send, Loader2, Upload,
} from "lucide-react"

import { submitOfferToCompliance }     from "@/app/actions/buyer-offer/submit-to-compliance"
import { flagOfferCompliance }         from "@/app/actions/buyer-offer/flag-compliance"
import { recordSellerResponse }        from "@/app/actions/buyer-offer/record-seller-response"
import { recordSellerSignedCounter }   from "@/app/actions/buyer-offer/record-seller-signed-counter"
import { CommissionDisclosureDialog }  from "@/app/components/offer/commission-disclosure-dialog"

export interface OfferAgentActionsState {
  buyer_signed:                  boolean
  seller_response_type:          "accepted" | "countered" | "rejected" | null
  fully_signed_contract_on_file: boolean
  compliance_passed:             boolean
  transaction_id:                string | null
  /** NAR-2024 buyer commission disclosure recorded? submit-for-signature blocks until true. */
  commission_acknowledged:       boolean
}

export interface OfferAgentActionsProps {
  offerId:     string
  agentUserId: string
  state:       OfferAgentActionsState
  onResult?:   (result: { kind: string; ok: boolean; message: string }) => void
}

export function OfferAgentActions({ offerId, agentUserId, state, onResult }: OfferAgentActionsProps) {
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const report = (kind: string, ok: boolean, message: string) => {
    if (onResult) onResult({ kind, ok, message })
  }

  function submit() {
    setBusy("submit")
    startTransition(async () => {
      try {
        const r = await submitOfferToCompliance({ offerId, userId: agentUserId })
        report("submit", r.success, r.success
          ? `Submitted to compliance. Transaction created: ${r.transaction_id}`
          : `Refused: ${r.error}${
              r.missing_required?.length ? ` (missing: ${r.missing_required.join(", ")})` : ""
            }${
              r.packet_blockers?.length ? ` (packet: ${r.packet_blockers.map(b => b.title).join("; ")})` : ""
            }`)
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
        report("flag", r.success, r.success
          ? `Flagged. ${r.notified_count ?? 0} people notified.`
          : `Failed: ${r.error}`)
      } finally { setBusy(null) }
    })
  }
  function recordAccepted() {
    setBusy("accepted")
    startTransition(async () => {
      try {
        const url = prompt("Seller-signed contract URL (storage URL or leave blank to upload separately):") ?? ""
        let r = await recordSellerResponse({
          offerId, userId: agentUserId, responseType: "accepted",
          documentUrl: url || undefined,
        })

        // THE ATTESTATION THE REFUSAL ASKS FOR — answerable from here.
        //
        // An offer from an outside buyer's agent was signed on THEIR paperwork,
        // so our e-sign webhook never fires and `offers.buyer_signed_at` stays
        // null. The action now names the evidence that CAN establish it and
        // flags `needs_buyer_signature_attestation`. Without this branch the
        // agent is told exactly what is required and given no control to supply
        // it — a refusal nobody can answer is the same dead end, one step later.
        //
        // Retried ONLY on that explicit flag, never on a generic failure, and
        // the attestation is TYPED by a person: it is a statement they are
        // accountable for, which is why the action rejects a click or a stray
        // character. Cancelling leaves the original refusal on screen.
        if (!r.success && r.needs_buyer_signature_attestation) {
          const signedAt = prompt(
            "The buyer signed on the outside agent's paperwork, so we never saw the signature land.\n\n" +
            "What DATE does the buyer's signature on the executed contract bear? (YYYY-MM-DD)"
          ) ?? ""
          if (signedAt.trim()) {
            const attestation = prompt(
              "In your own words: who holds the executed contract, and confirm it carries the buyer's signature.\n\n" +
              "This is recorded against your name as the attestor."
            ) ?? ""
            if (attestation.trim()) {
              r = await recordSellerResponse({
                offerId, userId: agentUserId, responseType: "accepted",
                documentUrl: url || undefined,
                buyerSignature: { signedAt: signedAt.trim(), attestation: attestation.trim() },
              })
            }
          }
        }

        report("accepted", r.success, r.success
          ? "Seller acceptance recorded. Submit to compliance next."
          : `Failed: ${r.error}`)
      } finally { setBusy(null) }
    })
  }
  function recordCounter() {
    setBusy("counter")
    startTransition(async () => {
      try {
        const url = prompt("Seller-signed COUNTER URL (storage URL or upload separately):") ?? ""
        const priceStr = prompt("Counter price?") ?? ""
        const counterPrice = priceStr ? Number(priceStr) : undefined
        const r = await recordSellerSignedCounter({
          parentOfferId: offerId,
          raiserUserId:  agentUserId,
          source:        "external",
          terms:         { counterPrice },
          sellerSignedDocumentUrl: url || undefined,
        })
        report("counter", r.success, r.success
          ? `Counter round ${r.round} recorded. Dispatch to buyer for signature when ready.`
          : `Failed: ${r.error}`)
      } finally { setBusy(null) }
    })
  }
  async function runScan() {
    setBusy("scan")
    try {
      const res = await fetch(`/api/offers/${offerId}/packet-scan`, { method: "POST" })
      const json = await res.json().catch(() => ({}))

      // THE REMEDY IS THE POINT OF THE REFUSAL.
      //
      // This read only `json.error`, so the agent was told "No staged document
      // found for this offer" and nothing else — a refusal that names the fault
      // and withholds the fix is the dead end this whole sequence removes. Since
      // wave 9 every unrunnable exit carries a critical blocker whose `title`
      // says what happened and whose `body` says what to DO ("…stage the
      // completed forms in the Form Wizard, then resubmit"), and the API route
      // returns the whole summary on the 400 as well as on the 200. Both are
      // surfaced, on both paths — a scan that RAN and found blockers is just as
      // useless without the instruction.
      const blockers: Array<{ title?: string; body?: string }> = Array.isArray(json.blockers) ? json.blockers : []
      const first = blockers[0]
      const remedy = [first?.title, first?.body].filter(Boolean).join(" — ")
      const more = blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ""

      if (!res.ok) {
        // `no_packet_staged` is not a system fault and must not read like one:
        // the offer wizard stages no packet at all, and those offers pass the
        // gate on their executed-contract columns.
        const headline = json.scanOutcome === "no_packet_staged"
          ? "Nothing to scan"
          : "Scan could not run"
        report("scan", false, remedy
          ? `${headline}: ${remedy}${more}`
          : `${headline}: ${json.error ?? res.statusText}`)
        return
      }

      report("scan", true, blockers.length === 0
        ? `Scan complete: ${json.completionPercent ?? "?"}% complete, nothing outstanding.`
        : `Scan complete: ${json.completionPercent ?? "?"}% complete, ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}. ${remedy}${more}`)
    } finally { setBusy(null) }
  }
  function pickFile() {
    fileInputRef.current?.click()
  }
  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setBusy("upload")
    try {
      const fd = new FormData()
      fd.append("file", file)
      // Hint the classifier from filename — scanner refines further from content
      const lower = file.name.toLowerCase()
      let hint = "uploaded_document"
      if (lower.includes("pal") || lower.includes("pre-approval") || lower.includes("preapproval")) hint = "pre_approval_letter"
      else if (lower.includes("counter")) hint = "counter_offer"
      else if (lower.includes("contract")) hint = "signed_contract"
      else if (lower.includes("disclosure")) hint = "disclosure"
      else if (lower.includes("inspection")) hint = "inspection_report"
      else if (lower.includes("appraisal")) hint = "appraisal_report"
      else if (lower.includes("earnest") || lower.includes("emd")) hint = "earnest_money_receipt"
      fd.append("docType", hint)
      const res = await fetch(`/api/offers/${offerId}/upload-document`, { method: "POST", body: fd })
      const json = await res.json().catch(() => ({}))
      report("upload", res.ok, res.ok
        ? `Uploaded ${file.name}. Scanner is classifying it.`
        : `Upload failed: ${json.error ?? res.statusText}`)
    } finally { setBusy(null) }
  }

  const canFlag    = true
  const canScan    = !state.transaction_id
  const canUpload  = true
  const canAccept  = state.buyer_signed && !state.seller_response_type && !state.transaction_id
  const canCounter = state.buyer_signed && !state.transaction_id
  const canSubmit  = state.buyer_signed && state.fully_signed_contract_on_file
                      && !state.compliance_passed && !state.transaction_id

  const needsCommissionDisclosure = !state.commission_acknowledged && !state.transaction_id

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {needsCommissionDisclosure && (
        <CommissionDisclosureDialog
          offerId={offerId}
          onDone={(r) => report("commission", r.ok, r.message)}
        />
      )}
      {state.commission_acknowledged && !state.transaction_id && (
        <span className="text-xs text-emerald-700 inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Commission disclosed
        </span>
      )}
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
      <Button size="sm" variant="outline" onClick={pickFile} disabled={!canUpload || pending}>
        {busy === "upload" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Upload className="h-3 w-3 mr-1" />}
        Upload document
      </Button>
      <Button size="sm" variant="outline" onClick={runScan} disabled={!canScan || pending}>
        {busy === "scan" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
        Run packet scan
      </Button>
      <Button size="sm" variant="outline" onClick={flag} disabled={!canFlag || pending}>
        {busy === "flag" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Flag className="h-3 w-3 mr-1" />}
        Flag issue
      </Button>
      {state.transaction_id && (
        <span className="text-xs text-emerald-700 inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Under contract — tx {state.transaction_id.slice(0, 8)}
        </span>
      )}
      {!canSubmit && !state.transaction_id && state.buyer_signed && (
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          Submit unlocks once seller acceptance is recorded
        </span>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/*,.doc,.docx"
        className="hidden"
        onChange={onFileChosen}
      />
    </div>
  )
}

// ── Helper: map an `offers` row → OfferAgentActionsState ──────────────────
export function offerRowToActionsState(o: {
  buyer_signed_at?: string | null
  seller_response_type?: "accepted" | "countered" | "rejected" | null
  fully_signed_contract_received_at?: string | null
  compliance_passed_at?: string | null
  transaction_id?: string | null
  buyer_commission_acknowledged_at?: string | null
}): OfferAgentActionsState {
  return {
    buyer_signed:                  !!o.buyer_signed_at,
    seller_response_type:          (o.seller_response_type as any) ?? null,
    fully_signed_contract_on_file: !!o.fully_signed_contract_received_at,
    compliance_passed:             !!o.compliance_passed_at,
    transaction_id:                (o.transaction_id as string | null) ?? null,
    commission_acknowledged:       !!o.buyer_commission_acknowledged_at,
  }
}
