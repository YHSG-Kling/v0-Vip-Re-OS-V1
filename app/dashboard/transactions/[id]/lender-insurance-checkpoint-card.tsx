"use client"

/**
 * THE LENDER-REQUIRED INSURANCE CHECKPOINT (wave 153, lane 153C; directive §153C C3) — agent, TC and compliance view.
 *
 * Positioned around the appraisal deadline by the account's setting (the lender's own date wins). Shows what the lender requires,
 * by when, and whether the evidence was accepted; when the lender is not on the platform, the coaching step tells the agent what to
 * ask and the form records what the lender said. Compliance / an admin accepts the filed binder against the requirement. A cash
 * purchase shows "not applicable" and is never held. Every control reports the server's verdict.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Umbrella } from "lucide-react"
import { acceptInsuranceEvidenceAction, recordInsuranceRequirementFromLenderAction } from "@/app/actions/transaction-hazard-insurance"
import type { HazardInsuranceView } from "@/lib/transactions/hazard-insurance"

const HOLD_BADGE: Record<string, { label: string; className: string }> = {
  blocking: { label: "Holding the closing", className: "bg-red-100 text-red-800" },
  warning: { label: "Needs attention", className: "bg-amber-100 text-amber-800" },
  none: { label: "On track", className: "bg-slate-100 text-slate-700" },
}
const COVERAGES: Array<[string, string]> = [["hazard", "Homeowner's / hazard"], ["flood", "Flood"], ["wind", "Wind"], ["earthquake", "Earthquake"], ["other", "Other"]]
const DUE_WORDS: Record<string, string> = { lender_date: "the lender's date", appraisal_deadline: "around the appraisal deadline", financing_deadline: "around the financing deadline", days_before_closing: "before closing", closing_lead_time: "the closing lead time" }

export function LenderInsuranceCheckpointCard({ transactionId, view }: { transactionId: string; view: HazardInsuranceView }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [f, setF] = useState({ coverages: ["hazard"] as string[], other: "", mortgagee: "", escrow: "unknown", recipient: "", due: "", lenderName: "" })
  const c = view.checkpoint
  if (!c) {
    return <Card className="mt-6"><CardHeader><CardTitle className="text-base">Lender-required insurance</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">The lender's insurance checkpoint could not be read right now.</p></CardContent></Card>
  }
  const badge = HOLD_BADGE[c.hold] ?? HOLD_BADGE.none
  const record = () => start(async () => {
    setMessage(null)
    const r = await recordInsuranceRequirementFromLenderAction({
      transactionId, required: true, coverages: f.coverages, otherCoverage: f.other || null, mortgageeClause: f.mortgagee || null,
      escrowTreatment: f.escrow, evidenceRecipient: f.recipient || null, dueDate: f.due || null, lenderName: f.lenderName || null,
    })
    setMessage(r.success ? { ok: true, text: "The lender's requirement was recorded." } : { ok: false, text: r.error ?? "Not saved." })
    if (r.success) router.refresh()
  })
  const accept = () => start(async () => {
    setMessage(null)
    const r = await acceptInsuranceEvidenceAction({ transactionId })
    setMessage(r.success ? { ok: true, text: "The insurance evidence was accepted against the lender's requirement." } : { ok: false, text: r.error ?? "Not saved." })
    if (r.success) router.refresh()
  })
  const showForm = !!view.can?.recordRequirement && (c.state === "requirement_unknown" || c.state === "required_missing")

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2"><Umbrella className="h-4 w-4" />Lender-required insurance</CardTitle>
          <Badge variant="secondary" className={badge.className}>{c.label} · {badge.label}</Badge>
        </div>
        <CardDescription>{c.dueDate ? `Due ${c.dueDate} (${DUE_WORDS[c.dueBasis ?? ""] ?? "scheduled"}).` : "No due date yet."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{c.detail}</p>
        {c.coaching && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">{c.coaching}</p>}
        {showForm && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="font-medium">Record what the lender requires</p>
            <div className="flex flex-wrap gap-3">{COVERAGES.map(([k, l]) => (
              <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.coverages.includes(k)} onChange={(e) => setF({ ...f, coverages: e.target.checked ? [...f.coverages, k] : f.coverages.filter((x) => x !== k) })} />{l}</label>
            ))}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {f.coverages.includes("other") && <div><Label>Other coverage</Label><Input value={f.other} onChange={(e) => setF({ ...f, other: e.target.value })} /></div>}
              <div><Label>Lender's due date</Label><Input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></div>
              <div><Label>Who receives the evidence</Label><Input value={f.recipient} onChange={(e) => setF({ ...f, recipient: e.target.value })} /></div>
              <div><Label>Premium handled</Label><select className="w-full rounded-md border px-2 py-2" value={f.escrow} onChange={(e) => setF({ ...f, escrow: e.target.value })}><option value="unknown">Not stated</option><option value="escrowed">Escrowed</option><option value="paid_at_closing">Paid at closing</option><option value="paid_outside_closing">Paid outside closing</option></select></div>
              <div className="sm:col-span-2"><Label>Mortgagee clause (as the lender wrote it)</Label><Input value={f.mortgagee} onChange={(e) => setF({ ...f, mortgagee: e.target.value })} /></div>
              <div><Label>Lender name</Label><Input value={f.lenderName} onChange={(e) => setF({ ...f, lenderName: e.target.value })} /></div>
            </div>
            <Button size="sm" disabled={pending || f.coverages.length === 0} onClick={record}>{pending ? "Saving…" : "Record the requirement"}</Button>
          </div>
        )}
        {view.can?.acceptEvidence && c.state === "evidence_pending_verification" && (
          <Button size="sm" disabled={pending} onClick={accept}>{pending ? "Saving…" : "Accept the filed evidence"}</Button>
        )}
        {message && <p className={message.ok ? "text-emerald-700" : "text-red-700"}>{message.text}</p>}
      </CardContent>
    </Card>
  )
}
