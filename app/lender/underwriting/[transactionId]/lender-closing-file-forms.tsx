"use client"

/**
 * The lender's Closing Disclosure + insurance forms (wave 153, lane 153C). Every control reports the server's verdict.
 * A receipt the lender records here is lender-confirmed and starts the three-business-day waiting period on the precise calendar;
 * confirming an agent's reported entry supersedes it. A signature is not entered as receipt — say what shows the buyer received it.
 */

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { recordLenderClosingDisclosureReceiptAction, type getLenderTridStatusAction } from "@/app/actions/trid-disclosure-receipt"
import { recordLenderInsuranceRequirementAction, lenderAcceptInsuranceEvidenceAction, type getLenderInsuranceCheckpointAction } from "@/app/actions/transaction-hazard-insurance"
import { zonedWallTimeToInstant } from "@/lib/compliance/trid-disclosure-clock"

type Trid = Extract<Awaited<ReturnType<typeof getLenderTridStatusAction>>, { success: true }>
type Insurance = Awaited<ReturnType<typeof getLenderInsuranceCheckpointAction>>

const METHODS: Array<[string, string]> = [["email", "Email"], ["electronic_portal", "Online portal"], ["mail", "Mail"], ["courier", "Courier"], ["in_person", "In person"], ["fax", "Fax"], ["other", "Other"]]
const EVIDENCE: Array<[string, string]> = [["lender_esign_receipt", "Our e-delivery system shows the buyer received it"], ["consumer_acknowledged_receipt", "The buyer acknowledged receipt"], ["in_person_delivery", "Handed to the buyer in person"], ["mailbox_rule", "Delivery date only (received three business days later)"], ["lender_statement", "Our records state the receipt date"]]
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"]
const CHANGES: Array<[string, string]> = [["apr_changed", "APR changed"], ["loan_product_changed", "Loan product changed"], ["prepayment_penalty_added", "Prepayment penalty added"], ["other_terms", "Other terms only"]]
const COVERAGES: Array<[string, string]> = [["hazard", "Homeowner's / hazard"], ["flood", "Flood"], ["wind", "Wind"], ["earthquake", "Earthquake"], ["other", "Other"]]

const zonedToIso = zonedWallTimeToInstant

export function LenderClosingFileForms({ transactionId, trid, insurance }: { transactionId: string; trid: Trid; insurance: Insurance }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const browserZone = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return "America/New_York" } }, [])
  const nextVersion = String(Math.max(1, ...trid.receipts.map((r) => r.version + (r.verification === "lender_confirmed" ? 1 : 0))))
  const [f, setF] = useState({ version: nextVersion, issuer: "", senderRole: "creditor", senderName: "", method: "electronic_portal", deliveredAt: "", receivedAt: "", zone: ZONES.includes(browserZone) ? browserZone : "America/New_York", evidence: "lender_esign_receipt", ackAt: "", changes: [] as string[], aprPrev: "", aprCur: "", regularity: "", determination: "", confirmReported: !!trid.readiness.reportedPendingId })
  const [ins, setIns] = useState({ required: "yes", coverages: ["hazard"] as string[], other: "", mortgagee: "", escrow: "unknown", recipient: "", due: "" })

  const saveReceipt = () => start(async () => {
    setMessage(null)
    const r = await recordLenderClosingDisclosureReceiptAction({
      transactionId, version: Number(f.version), supersedesId: f.confirmReported ? trid.readiness.reportedPendingId : null, issuerName: f.issuer,
      senderRole: f.senderRole, senderName: f.senderName || null, deliveryMethod: f.method,
      deliveredAt: f.deliveredAt ? zonedToIso(f.deliveredAt, f.zone) : null, receivedAt: f.receivedAt ? zonedToIso(f.receivedAt, f.zone) : null,
      receiptTimezone: f.zone, receiptEvidence: f.evidence, acknowledgmentSignedAt: f.ackAt ? zonedToIso(f.ackAt, f.zone) : null,
      revisionChanges: Number(f.version) > 1 ? f.changes : [], aprPrevious: f.aprPrev ? Number(f.aprPrev) : null, aprCurrent: f.aprCur ? Number(f.aprCur) : null,
      regularity: f.regularity || null, newWaitDetermination: f.determination || null,
    })
    setMessage(r.success ? { ok: true, text: r.earliestConsummationDate ? `Recorded. The earliest closing day is ${r.earliestConsummationDate}.` : "Recorded." } : { ok: false, text: r.error })
    if (r.success) router.refresh()
  })
  const saveRequirement = () => start(async () => {
    setMessage(null)
    const r = await recordLenderInsuranceRequirementAction({ transactionId, required: ins.required === "yes", coverages: ins.required === "yes" ? ins.coverages : [], otherCoverage: ins.other || null, mortgageeClause: ins.mortgagee || null, escrowTreatment: ins.escrow, evidenceRecipient: ins.recipient || null, dueDate: ins.due || null })
    setMessage(r.success ? { ok: true, text: "Your insurance requirement was recorded." } : { ok: false, text: r.error ?? "Not saved." })
    if (r.success) router.refresh()
  })
  const acceptEvidence = () => start(async () => {
    setMessage(null)
    const r = await lenderAcceptInsuranceEvidenceAction({ transactionId })
    setMessage(r.success ? { ok: true, text: "You accepted the insurance evidence." } : { ok: false, text: r.error ?? "Not saved." })
    if (r.success) router.refresh()
  })

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Closing Disclosure</CardTitle>
          <CardDescription>{trid.readiness.reasons.join(" ") || "No receipt recorded yet."} {trid.readiness.nextAction}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {trid.receipts.length > 0 && (
            <ul className="space-y-1">{trid.receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-2 rounded border p-2">
                <span>Version {r.version}</span><Badge variant="secondary">{r.verification === "lender_confirmed" ? "Confirmed" : r.verification === "pending_lender_confirmation" ? "Reported by the agent — needs your confirmation" : "Rejected"}</Badge>
                <span className="text-gray-500">{r.receivedAt ? `received ${new Date(r.receivedAt).toLocaleString("en-US", { timeZone: r.timezone })}` : r.deliveredAt ? `delivered ${new Date(r.deliveredAt).toLocaleString("en-US", { timeZone: r.timezone })}` : ""} ({r.timezone})</span>
              </li>
            ))}</ul>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Which Closing Disclosure</Label><Input type="number" min={1} max={50} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></div>
            <div><Label>Issuing lender (creditor)</Label><Input value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} /></div>
            <div><Label>Sent by</Label><select className="w-full rounded-md border px-2 py-2" value={f.senderRole} onChange={(e) => setF({ ...f, senderRole: e.target.value })}><option value="creditor">Us (the lender)</option><option value="settlement_agent">Our settlement agent</option></select></div>
            <div><Label>Sender name</Label><Input value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} /></div>
            <div><Label>Delivery method</Label><select className="w-full rounded-md border px-2 py-2" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><Label>Buyer's time zone</Label><select className="w-full rounded-md border px-2 py-2" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</select></div>
            <div><Label>Delivered or mailed</Label><Input type="datetime-local" value={f.deliveredAt} onChange={(e) => setF({ ...f, deliveredAt: e.target.value })} /></div>
            <div><Label>Received by the buyer</Label><Input type="datetime-local" value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} /></div>
            <div className="sm:col-span-2"><Label>What shows the buyer received it</Label><select className="w-full rounded-md border px-2 py-2" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })}>{EVIDENCE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><Label>Acknowledgment signed (optional — not receipt by itself)</Label><Input type="datetime-local" value={f.ackAt} onChange={(e) => setF({ ...f, ackAt: e.target.value })} /></div>
          </div>
          {Number(f.version) > 1 && (
            <div className="space-y-2">
              <Label>What the revision changed</Label>
              <div className="flex flex-wrap gap-3">{CHANGES.map(([k, l]) => (
                <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.changes.includes(k)} onChange={(e) => setF({ ...f, changes: e.target.checked ? [...f.changes, k] : f.changes.filter((c) => c !== k) })} />{l}</label>
              ))}</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {f.changes.includes("apr_changed") && <><div><Label>Previous APR (%)</Label><Input inputMode="decimal" value={f.aprPrev} onChange={(e) => setF({ ...f, aprPrev: e.target.value })} /></div><div><Label>Revised APR (%)</Label><Input inputMode="decimal" value={f.aprCur} onChange={(e) => setF({ ...f, aprCur: e.target.value })} /></div></>}
                <div><Label>Loan classification</Label><select className="w-full rounded-md border px-2 py-2" value={f.regularity} onChange={(e) => setF({ ...f, regularity: e.target.value })}><option value="">Not stated</option><option value="regular">Regular transaction</option><option value="irregular">Irregular transaction</option></select></div>
                <div><Label>New three-business-day waiting period</Label><select className="w-full rounded-md border px-2 py-2" value={f.determination} onChange={(e) => setF({ ...f, determination: e.target.value })}><option value="">Not stated</option><option value="new_wait_required">Required</option><option value="no_new_wait">Not required</option></select></div>
              </div>
            </div>
          )}
          {trid.readiness.reportedPendingId && (
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.confirmReported} onChange={(e) => setF({ ...f, confirmReported: e.target.checked })} />This confirms (or corrects) the receipt the agent reported</label>
          )}
          <Button disabled={pending} onClick={saveReceipt}>{pending ? "Saving…" : "Record the delivery and receipt"}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Insurance evidence</CardTitle>
          <CardDescription>{insurance.success && insurance.checkpoint ? `${insurance.checkpoint.label}: ${insurance.checkpoint.detail}` : insurance.error ?? "Not available."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Insurance evidence required</Label><select className="w-full rounded-md border px-2 py-2" value={ins.required} onChange={(e) => setIns({ ...ins, required: e.target.value })}><option value="yes">Yes</option><option value="no">No</option></select></div>
            <div><Label>Due date</Label><Input type="date" value={ins.due} onChange={(e) => setIns({ ...ins, due: e.target.value })} /></div>
          </div>
          {ins.required === "yes" && (
            <>
              <div className="flex flex-wrap gap-3">{COVERAGES.map(([k, l]) => (
                <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={ins.coverages.includes(k)} onChange={(e) => setIns({ ...ins, coverages: e.target.checked ? [...ins.coverages, k] : ins.coverages.filter((x) => x !== k) })} />{l}</label>
              ))}</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {ins.coverages.includes("other") && <div><Label>Other coverage</Label><Input value={ins.other} onChange={(e) => setIns({ ...ins, other: e.target.value })} /></div>}
                <div><Label>Send evidence to</Label><Input value={ins.recipient} onChange={(e) => setIns({ ...ins, recipient: e.target.value })} /></div>
                <div><Label>Premium handled</Label><select className="w-full rounded-md border px-2 py-2" value={ins.escrow} onChange={(e) => setIns({ ...ins, escrow: e.target.value })}><option value="unknown">Not stated</option><option value="escrowed">Escrowed</option><option value="paid_at_closing">Paid at closing</option><option value="paid_outside_closing">Paid outside closing</option></select></div>
                <div className="sm:col-span-2"><Label>Mortgagee clause</Label><Input value={ins.mortgagee} onChange={(e) => setIns({ ...ins, mortgagee: e.target.value })} /></div>
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending} onClick={saveRequirement}>{pending ? "Saving…" : "Record the requirement"}</Button>
            {insurance.success && insurance.binderOnFile && insurance.checkpoint?.state === "evidence_pending_verification" && <Button variant="outline" disabled={pending} onClick={acceptEvidence}>Accept the filed evidence</Button>}
          </div>
        </CardContent>
      </Card>
      {message && <p className={message.ok ? "text-emerald-700 text-sm" : "text-red-700 text-sm"}>{message.text}</p>}
    </div>
  )
}
