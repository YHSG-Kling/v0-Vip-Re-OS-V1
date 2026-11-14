"use client"

/**
 * THE CLOSING DISCLOSURE RECEIPT PANEL (wave 153, lane 153C; directive §153C C2) — agent, TC and compliance view.
 *
 * Shows when the buyer RECEIVED the Closing Disclosure (lender-confirmed, deemed by the mailbox rule, or only reported), the
 * earliest permitted closing day on the precise business-day calendar, and — when the lender is not on the platform — the coaching
 * step: ask the lender, then record what the lender said. A reported entry is labeled as waiting for the lender and never reads as
 * ready. Compliance / an admin verifies a reported entry with the lender's written confirmation filed on the deal.
 * Every control reports the server's verdict (no optimistic success).
 */

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CalendarClock, ShieldAlert, ShieldCheck, MessageSquareWarning } from "lucide-react"
import {
  reportClosingDisclosureReceiptAction,
  verifyReportedClosingDisclosureReceiptAction,
  type getTridDisclosureStatusAction,
} from "@/app/actions/trid-disclosure-receipt"
import { zonedWallTimeToInstant } from "@/lib/compliance/trid-disclosure-clock"

type Status = Awaited<ReturnType<typeof getTridDisclosureStatusAction>>

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  ready: { label: "Ready", className: "bg-emerald-100 text-emerald-800" },
  not_applicable: { label: "Not a TRID closing", className: "bg-slate-100 text-slate-700" },
  waiting: { label: "Waiting period running", className: "bg-blue-100 text-blue-800" },
  blocked: { label: "Holding the closing", className: "bg-amber-100 text-amber-800" },
  unavailable: { label: "Could not check", className: "bg-red-100 text-red-800" },
}
const METHODS: Array<[string, string]> = [["email", "Email"], ["electronic_portal", "Lender's online portal"], ["mail", "Mail"], ["courier", "Courier"], ["in_person", "In person"], ["fax", "Fax"], ["other", "Other"]]
const EVIDENCE: Array<[string, string]> = [["lender_statement", "The lender stated the receipt date"], ["consumer_acknowledged_receipt", "The buyer acknowledged receipt"], ["lender_esign_receipt", "The lender's e-delivery shows receipt"], ["mailbox_rule", "Only the delivery date is known"], ["in_person_delivery", "Handed to the buyer in person"]]
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"]
const CHANGES: Array<[string, string]> = [["apr_changed", "APR changed"], ["loan_product_changed", "Loan product changed"], ["prepayment_penalty_added", "Prepayment penalty added"], ["other_terms", "Other terms only"]]
const SOURCE_WORDS: Record<string, string> = { lender_portal: "Lender", agent_reported: "Agent (reported)", tc_reported: "Coordinator (reported)", compliance_verified: "Compliance (verified)" }

const zonedToIso = zonedWallTimeToInstant

export function TridReceiptSection({ transactionId, initial }: { transactionId: string; initial: Status }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const browserZone = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return "America/New_York" } }, [])
  const [f, setF] = useState({ version: "1", issuer: "", senderRole: "creditor", method: "email", deliveredAt: "", receivedAt: "", zone: ZONES.includes(browserZone) ? browserZone : "America/New_York", evidence: "lender_statement", contactName: "", contactMethod: "", changes: [] as string[], aprPrev: "", aprCur: "", notes: "" })
  const [v, setV] = useState({ documentId: "", regularity: "", determination: "", notes: "" })

  if (!initial.success) {
    return (
      <Card className="mt-6"><CardHeader><CardTitle className="text-base">Closing Disclosure receipt (TRID)</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">{initial.error}</p></CardContent></Card>
    )
  }
  const s = initial
  const badge = STATUS_BADGE[s.item.status] ?? STATUS_BADGE.blocked

  const submitReport = () => start(async () => {
    setMessage(null)
    const r = await reportClosingDisclosureReceiptAction({
      transactionId, version: Number(f.version), issuerName: f.issuer, senderRole: f.senderRole, deliveryMethod: f.method,
      deliveredAt: f.deliveredAt ? zonedToIso(f.deliveredAt, f.zone) : null, receivedAt: f.receivedAt ? zonedToIso(f.receivedAt, f.zone) : null,
      receiptTimezone: f.zone, receiptEvidence: f.evidence, lenderContactName: f.contactName, lenderContactMethod: f.contactMethod || null,
      revisionChanges: Number(f.version) > 1 ? f.changes : [], aprPrevious: f.aprPrev ? Number(f.aprPrev) : null, aprCurrent: f.aprCur ? Number(f.aprCur) : null, notes: f.notes || null,
    })
    setMessage(r.success ? { ok: true, text: "Recorded as reported — it waits for the lender's confirmation before the waiting period starts." } : { ok: false, text: r.error })
    if (r.success) router.refresh()
  })
  const submitVerify = () => start(async () => {
    if (!s.readiness.reportedPendingId) return
    setMessage(null)
    const r = await verifyReportedClosingDisclosureReceiptAction({
      transactionId, reportedReceiptId: s.readiness.reportedPendingId, documentId: v.documentId,
      regularity: v.regularity || null, newWaitDetermination: v.determination || null, notes: v.notes || null,
    })
    setMessage(r.success ? { ok: true, text: r.earliestConsummationDate ? `Verified. The earliest closing day is ${r.earliestConsummationDate}.` : "Verified." } : { ok: false, text: r.error })
    if (r.success) router.refresh()
  })

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2"><CalendarClock className="h-4 w-4" />Closing Disclosure receipt (TRID)</CardTitle>
          <Badge variant="secondary" className={badge.className}>{badge.label}</Badge>
        </div>
        <CardDescription>
          {s.lender.onPlatform ? `${s.lender.name ?? "The lender"} records the delivery and the buyer's receipt on its loan file.` : "The lender is not on the platform — confirm the receipt with the lender and record what it says."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-2 sm:grid-cols-2">
          <div><span className="text-muted-foreground">Buyer's receipt:</span> {s.readiness.effectiveReceiptDate ?? "Not confirmed"}</div>
          <div><span className="text-muted-foreground">Earliest closing day:</span> {s.readiness.earliestConsummationDate ?? "—"}</div>
        </div>
        <p>{s.item.detail}</p>
        <p className="font-medium">Next step: {s.item.nextAction}</p>

        {s.readiness.coaching && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 flex gap-2">
            <MessageSquareWarning className="h-4 w-4 mt-0.5 text-amber-700 shrink-0" />
            <p className="text-amber-900">{s.readiness.coaching}</p>
          </div>
        )}

        {s.receipts.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">Record</p>
            <ul className="space-y-1">
              {s.receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded border p-2">
                  {r.verification === "lender_confirmed" ? <ShieldCheck className="h-4 w-4 text-emerald-700" /> : <ShieldAlert className="h-4 w-4 text-amber-700" />}
                  <span>Version {r.version}</span>
                  <span className="text-muted-foreground">{SOURCE_WORDS[r.source] ?? r.source}</span>
                  <span>{r.verification === "lender_confirmed" ? "Lender-confirmed" : r.verification === "pending_lender_confirmation" ? "Waiting for the lender's confirmation" : "Rejected"}</span>
                  <span className="text-muted-foreground">{r.receivedAt ? `received ${new Date(r.receivedAt).toLocaleString("en-US", { timeZone: r.timezone })} (${r.timezone})` : r.deliveredAt ? `delivered ${new Date(r.deliveredAt).toLocaleString("en-US", { timeZone: r.timezone })} (${r.timezone})` : ""}</span>
                  {r.lenderContactName && <span className="text-muted-foreground">per {r.lenderContactName}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {s.can.report && !s.lender.onPlatform && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="font-medium">Record what the lender told you</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>Which Closing Disclosure</Label><Input type="number" min={1} max={50} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /><p className="text-xs text-muted-foreground mt-1">1 = the initial one; 2 or more = a revised one.</p></div>
              <div><Label>Lender that issued it</Label><Input value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} /></div>
              <div><Label>Sent by</Label><select className="w-full rounded-md border px-2 py-2" value={f.senderRole} onChange={(e) => setF({ ...f, senderRole: e.target.value })}><option value="creditor">The lender</option><option value="settlement_agent">The lender's settlement agent</option></select></div>
              <div><Label>How it reached the buyer</Label><select className="w-full rounded-md border px-2 py-2" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div><Label>Delivered or mailed (buyer's local time)</Label><Input type="datetime-local" value={f.deliveredAt} onChange={(e) => setF({ ...f, deliveredAt: e.target.value })} /></div>
              <div><Label>Received by the buyer (buyer's local time)</Label><Input type="datetime-local" value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} /></div>
              <div><Label>Buyer's time zone</Label><select className="w-full rounded-md border px-2 py-2" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</select></div>
              <div><Label>What shows the buyer received it</Label><select className="w-full rounded-md border px-2 py-2" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })}>{EVIDENCE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div><Label>Who at the lender said this</Label><Input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></div>
              <div><Label>How you heard (phone, email…)</Label><Input value={f.contactMethod} onChange={(e) => setF({ ...f, contactMethod: e.target.value })} /></div>
            </div>
            {Number(f.version) > 1 && (
              <div className="space-y-2">
                <Label>What the revised Closing Disclosure changed</Label>
                <div className="flex flex-wrap gap-3">{CHANGES.map(([k, l]) => (
                  <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.changes.includes(k)} onChange={(e) => setF({ ...f, changes: e.target.checked ? [...f.changes, k] : f.changes.filter((c) => c !== k) })} />{l}</label>
                ))}</div>
                {f.changes.includes("apr_changed") && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><Label>APR on the earlier one (%)</Label><Input inputMode="decimal" value={f.aprPrev} onChange={(e) => setF({ ...f, aprPrev: e.target.value })} /></div>
                    <div><Label>APR on the revised one (%)</Label><Input inputMode="decimal" value={f.aprCur} onChange={(e) => setF({ ...f, aprCur: e.target.value })} /></div>
                  </div>
                )}
              </div>
            )}
            <div><Label>Notes</Label><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
            <Button disabled={pending} onClick={submitReport}>{pending ? "Saving…" : "Record what the lender said"}</Button>
            <p className="text-xs text-muted-foreground">Your entry is saved as reported and does not start the three-business-day waiting period until the lender confirms it in writing.</p>
          </div>
        )}

        {s.can.verify && s.readiness.reportedPendingId && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="font-medium">Verify the reported receipt with the lender's written confirmation</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>The lender's written confirmation (on this deal)</Label><select className="w-full rounded-md border px-2 py-2" value={v.documentId} onChange={(e) => setV({ ...v, documentId: e.target.value })}><option value="">Choose a document</option>{s.documents.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></div>
              <div><Label>Loan classification, as the lender states it</Label><select className="w-full rounded-md border px-2 py-2" value={v.regularity} onChange={(e) => setV({ ...v, regularity: e.target.value })}><option value="">Not stated</option><option value="regular">Regular transaction</option><option value="irregular">Irregular transaction</option></select></div>
              <div><Label>New waiting period, as the lender states it</Label><select className="w-full rounded-md border px-2 py-2" value={v.determination} onChange={(e) => setV({ ...v, determination: e.target.value })}><option value="">Not stated</option><option value="new_wait_required">A new waiting period applies</option><option value="no_new_wait">No new waiting period</option></select></div>
            </div>
            <div><Label>Notes</Label><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></div>
            <Button disabled={pending || !v.documentId} onClick={submitVerify}>{pending ? "Verifying…" : "Verify the receipt"}</Button>
          </div>
        )}

        {message && <p className={message.ok ? "text-emerald-700" : "text-red-700"}>{message.text}</p>}
        <p className="text-xs text-muted-foreground">Timing follows 12 CFR 1026.19(f): the buyer must receive the Closing Disclosure at least three business days before closing (Saturdays count; Sundays and federal holidays do not). The lender remains responsible for its disclosure.</p>
      </CardContent>
    </Card>
  )
}
