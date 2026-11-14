"use client"

// FINAL CLOSING COMPLIANCE (wave 153, lane 153D; owner: "when the transaction is closing and goes through a compliance review, they take
// charge of approving and making sure all docs are accurate and submitted (settlement statement and cda-if required are part of the
// check)"). ONE readiness list for the closing — the brokerage's required documents at this deal's checklist version and their
// signatures, contract terms and commission, the settlement statement / Closing Disclosure, TRID, insurance, the CDA if this deal uses
// one (or the closing question if not) — and the reviewer's approve / hold / reject with notes. The decision is stored and it holds
// the close: a change after an approval reopens it. Shown in both CDA modes. Rules: lib/transactions/closing-compliance-core.ts (pure) + closing-compliance.ts (reads, decision, gate).

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { getClosingReadinessAction, recordClosingReviewDecisionAction, amendDealChecklistAction } from "@/app/actions/compliance/closing-review"
import { recordOffPlatformIssuerDocumentAction } from "@/app/actions/vendor-document-corrections"
import { readFileAsDataUrl } from "@/app/lender/documents/issuer-correction-button"

type Loaded = Extract<Awaited<ReturnType<typeof getClosingReadinessAction>>, { success: true }>

const STANDING_WORDS: Record<string, { text: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  approved: { text: "Approved by compliance", variant: "default" },
  reopened: { text: "Reopened — the file changed after approval", variant: "destructive" },
  on_hold: { text: "On hold", variant: "secondary" },
  rejected: { text: "Rejected", variant: "destructive" },
  awaiting_review: { text: "Waiting for compliance", variant: "outline" },
  not_required: { text: "Closes on the closing question", variant: "outline" },
}
const STATE_WORDS: Record<string, { text: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  ready: { text: "Ready", variant: "default" },
  blocked: { text: "Holds closing", variant: "destructive" },
  open: { text: "Review", variant: "secondary" },
  not_applicable: { text: "Not needed", variant: "outline" },
}

export function ClosingReadinessCard({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [notes, setNotes] = useState("")
  const [pending, startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await getClosingReadinessAction({ transactionId })
      if (!r.success) { setError(r.error); return }
      setError(null)
      setData(r)
    })
  }, [transactionId])
  useEffect(() => { load() }, [load])

  const decide = (decision: "approve" | "hold" | "reject") => startTransition(async () => {
    const r = await recordClosingReviewDecisionAction({ transactionId, decision, notes })
    if (!r.success) { setNotice(r.error); return }
    setNotice(decision === "approve" ? "Approved. The closing can proceed while nothing changes; any change reopens this review." : "Recorded. The agent and TC were told what to fix, and the closing waits.")
    setNotes("")
    load()
  })
  const amend = () => startTransition(async () => {
    const r = await amendDealChecklistAction({ transactionId, reason: notes })
    if (!r.success) { setNotice(r.error); return }
    setNotice(`This deal now uses the current checklist (${r.rules} rule${r.rules === 1 ? "" : "s"}). ${r.rechecked ? `${r.openBlocking} item${r.openBlocking === 1 ? "" : "s"} still hold the closing.` : "It is applied at the deal's next closing check."}`)
    setNotes("")
    load()
  })

  if (error) {
    return (
      <Card><CardHeader><CardTitle className="text-base">Final closing compliance</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{error} <Button variant="link" className="h-auto p-0" onClick={load} disabled={pending}>Try again</Button></CardContent>
      </Card>
    )
  }
  if (!data) return <Card><CardHeader><CardTitle className="text-base">Final closing compliance</CardTitle><CardDescription>Loading the closing file…</CardDescription></CardHeader></Card>

  const standing = STANDING_WORDS[data.standing.state] ?? STANDING_WORDS.awaiting_review
  const groups = new Map<string, Loaded["readiness"]["items"]>()
  for (const item of data.readiness.items) groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  const checklistChanged = data.readiness.items.some((i) => i.key === "closing_docs.checklist_version" && i.state !== "ready")

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Final closing compliance</CardTitle>
          <Badge variant={standing.variant}>{standing.text}</Badge>
        </div>
        <CardDescription>
          {data.readiness.blocking === 0 ? "Everything on the closing list is satisfied." : `${data.readiness.blocking} item${data.readiness.blocking === 1 ? " holds" : "s hold"} the closing.`}
          {data.checklistVersionAt ? ` Checked against the brokerage checklist in force on ${data.checklistVersionAt.slice(0, 10)}.` : ""}
          {data.required ? " Compliance approves this closing before it can close." : " This account closes on the closing question; a review can still be recorded."}
        </CardDescription>
        {data.standing.blocker ? <p className="text-sm text-destructive">{data.standing.blocker}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {[...groups.entries()].map(([group, items]) => (
          <div key={group} className="space-y-2">
            <p className="text-sm font-medium">{data.groupLabels[group as keyof typeof data.groupLabels] ?? group}</p>
            <ul className="space-y-2">
              {items.map((item) => {
                const s = STATE_WORDS[item.state] ?? STATE_WORDS.open
                return (
                  <li key={item.key} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="text-sm">{item.label}</span>
                      <Badge variant={s.variant}>{s.text}</Badge>
                    </div>
                    {item.detail ? <p className="mt-1 text-xs text-muted-foreground break-words">{item.detail}</p> : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
        {data.latest?.notes ? <p className="text-xs text-muted-foreground">Last review note{data.latest.decidedAt ? ` (${data.latest.decidedAt.slice(0, 10)})` : ""}: {data.latest.notes}</p> : null}
        {data.canDecide ? (
          <div className="space-y-2 border-t pt-3">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for the agent and TC (required to hold or reject, and to apply the current checklist)" rows={3} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => decide("approve")} disabled={pending || data.readiness.blocking > 0}>Approve closing</Button>
              <Button size="sm" variant="secondary" onClick={() => decide("hold")} disabled={pending}>Hold</Button>
              <Button size="sm" variant="destructive" onClick={() => decide("reject")} disabled={pending}>Reject</Button>
              {checklistChanged ? <Button size="sm" variant="outline" onClick={amend} disabled={pending}>Apply the current checklist to this deal</Button> : null}
            </div>
          </div>
        ) : null}
        {notice ? <p className="text-sm" role="status">{notice}</p> : null}
        <OffPlatformIssuerDocument transactionId={transactionId} offPlatform={data.offPlatform} onFiled={load} />
      </CardContent>
    </Card>
  )
}

/** A lender / title company / vendor emailed a corrected file: the deal team files it FOR the issuer, with how it arrived. */
function OffPlatformIssuerDocument({ transactionId, offPlatform, onFiled }: { transactionId: string; offPlatform: Loaded["offPlatform"]; onFiled: () => void }) {
  const [open, setOpen] = useState(false)
  const [docId, setDocId] = useState("")
  const [issuer, setIssuer] = useState("")
  const [sender, setSender] = useState("")
  const [receivedAt, setReceivedAt] = useState("")
  const [channel, setChannel] = useState("email")
  const [file, setFile] = useState<File | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  if (offPlatform.documents.length === 0 || offPlatform.issuers.length === 0) {
    return offPlatform.unreadable ? <p className="text-xs text-muted-foreground">The deal's vendor documents couldn't be read just now, so a vendor's emailed correction can't be filed here yet.</p> : null
  }
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>File a corrected document a vendor sent outside the platform</Button>
  const submit = () => startTransition(async () => {
    const chosen = offPlatform.issuers.find((i) => (i.kind === "title" ? "title" : i.vendorId) === issuer)
    if (!docId || !chosen || !file) { setMessage("Choose the document, who sent the correction and the corrected file."); return }
    let data = ""
    try { data = await readFileAsDataUrl(file) } catch (e) { setMessage(e instanceof Error ? e.message : "The file could not be read."); return }
    const r = await recordOffPlatformIssuerDocumentAction({
      transactionId, original: { rail: "transaction_documents", id: docId },
      onBehalfOf: chosen.kind === "title" ? { kind: "title" } : { kind: chosen.kind, vendorId: chosen.vendorId },
      proof: { channel, sender, receivedAt }, fileName: file.name, contentType: file.type, fileData: data,
    })
    setMessage(r.success ? r.message : r.error)
    if (r.success) { setOpen(false); setFile(null); onFiled() }
  })
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-medium">File a vendor's corrected document</p>
      <select className="w-full rounded-md border p-2 text-sm" value={docId} onChange={(e) => setDocId(e.target.value)} aria-label="Document being corrected">
        <option value="">Which document is being corrected?</option>
        {offPlatform.documents.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <select className="w-full rounded-md border p-2 text-sm" value={issuer} onChange={(e) => setIssuer(e.target.value)} aria-label="Who sent the correction">
        <option value="">Who sent the correction?</option>
        {offPlatform.issuers.map((i) => <option key={i.kind === "title" ? "title" : i.vendorId} value={i.kind === "title" ? "title" : i.vendorId}>{i.name}</option>)}
      </select>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select className="rounded-md border p-2 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="How it arrived">
          <option value="email">Email</option><option value="courier">Courier</option><option value="fax">Fax</option><option value="in_person">In person</option>
        </select>
        <Input value={sender} onChange={(e) => setSender(e.target.value)} placeholder="Sent by (name or email)" />
        <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} aria-label="Received on" />
      </div>
      <Input type="file" accept="application/pdf,image/png,image/jpeg,image/heic,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>File it for the vendor</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
      </div>
      <p className="text-xs text-muted-foreground">The vendor's earlier version is kept, the closing checks re-run, and the agent gets a task to confirm the file with the vendor.</p>
      {message ? <p className="text-xs" role="status">{message}</p> : null}
    </div>
  )
}
