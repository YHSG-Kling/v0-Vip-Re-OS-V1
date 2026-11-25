"use client"

/**
 * THE EXECUTED-PACKET REVIEW, ON SCREEN (wave 156, lane 156B round 2).
 *
 * One packet — a listing agreement or an executed offer — as lib/kernel/compliance/representation-gate.ts decided it:
 *   · the compared terms SIDE BY SIDE (the document says / the record says / where the document value came from);
 *   · every reason with its form, field and the repair that ends it — a hold is never "AI failure";
 *   · the link to the REAL executed document (the one open door, /api/documents/open);
 *   · for a reviewer: Approve / Hold (bound to the evidence hash on screen) and, where the scan could not read a document, the
 *     field-by-field attestation of what the reviewer read on the executed paper.
 * The agent and the coordinator see the same status and reasons and NO decision controls — the server refuses them anyway
 * (app/actions/compliance/representation-review.ts); the button being hidden is never the authorization.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getRepresentationReviewAction, recordRepresentationReview, attestRepresentationTerms } from "@/app/actions/compliance/representation-review"

type RecordKind = "listing_agreement" | "purchase_offer"
type Loaded = Extract<Awaited<ReturnType<typeof getRepresentationReviewAction>>, { success: true }>

const VERDICT_STYLE: Record<string, string> = {
  allow: "bg-emerald-100 text-emerald-900",
  needs_review: "bg-blue-100 text-blue-900",
  hold: "bg-orange-100 text-orange-900",
  refuse: "bg-red-600 text-white",
}
const VERDICT_LABEL: Record<string, string> = { allow: "Accepted", needs_review: "Waiting for a reviewer", hold: "On hold — repair needed", refuse: "Refused" }
const READ_FAILURES = new Set(["extraction_failed", "extraction_empty", "extraction_low_confidence", "ambiguous_signature"])
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.join(", ") : String(v))

export function RepresentationReviewPanel({ record, subjectId }: { record: RecordKind; subjectId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [attestFor, setAttestFor] = useState<string | null>(null)
  const [terms, setTerms] = useState<Record<string, string>>({})
  const [signersConfirmed, setSignersConfirmed] = useState(false)
  const [pending, start] = useTransition()

  const load = useCallback(() => {
    start(async () => {
      const r = await getRepresentationReviewAction({ record, subjectId })
      if (!r.success) { setError(r.error); setData(null); return }
      setError(null); setData(r)
    })
  }, [record, subjectId])
  useEffect(() => { load() }, [load])

  if (error) return <p className="text-sm text-red-700">{error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">{pending ? "Loading the review…" : ""}</p>
  const d = data.decision
  const docs = d.evidence.documents ?? []
  const docLabel = (id: string | null) => { const doc = docs.find((x) => x.id === id); return doc ? (doc.classification ?? "document").replace(/_/g, " ") : null }

  const decide = (decision: "approve" | "hold") => start(async () => {
    setNotice(null)
    const r = await recordRepresentationReview({ record, subjectId, decision, evidenceHash: d.evidenceHash, note: decision === "hold" ? note : undefined })
    if (!r.success) { setNotice(r.error ?? "The decision was not recorded."); return }
    setNotice(decision === "approve" ? "Approved. The next step has been continued." : "Held. The agent and coordinator have the reason.")
    load()
  })
  const attest = () => start(async () => {
    if (!attestFor) return
    setNotice(null)
    const r = await attestRepresentationTerms({ record, subjectId, documentId: attestFor, terms, signersConfirmed })
    if (!r.success) { setNotice(r.error ?? "The attestation was not recorded."); return }
    setNotice("Your reading was recorded. The terms below are now compared against it."); setAttestFor(null); setTerms({}); load()
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={VERDICT_STYLE[d.verdict] ?? ""}>{VERDICT_LABEL[d.verdict] ?? d.verdict}</Badge>
        <span className="text-xs text-muted-foreground">Checked {new Date(d.checkedAt).toLocaleString()} · evidence {d.evidenceHash.slice(0, 12)}…</span>
        {d.approval && <span className="text-xs text-emerald-800">Approved {new Date(d.approval.at).toLocaleString()}</span>}
      </div>

      <div>
        <h3 className="text-sm font-medium mb-1">What the executed document says, beside the record</h3>
        {d.evidence.compared.length === 0 ? (
          <p className="text-sm text-muted-foreground">No term could be compared yet — see the reasons below.</p>
        ) : (
          <>
          {/* phone: one card per term */}
          <ul className="md:hidden space-y-2">
            {d.evidence.compared.map((c, i) => (
              <li key={i} className={`border rounded p-2 text-sm ${c.agrees === false ? "bg-orange-50" : ""}`}>
                <p className="font-medium">{c.field.replace(/_/g, " ")} — {c.agrees === null ? "not stated" : c.agrees ? "agrees" : "DOES NOT AGREE"}</p>
                <p>Document says: {show(c.documentSays)}</p>
                <p>Record says: {show(c.recordSays)}</p>
                <p className="text-xs text-muted-foreground">Read by {c.source === "attested" ? "reviewer attestation" : "document scan"}</p>
              </li>
            ))}
          </ul>
          <div className="hidden md:block overflow-x-auto"><table className="w-full text-sm border">
            <thead><tr className="bg-muted text-left"><th className="p-2">Term</th><th className="p-2">Document says</th><th className="p-2">Record says</th><th className="p-2">Read by</th><th className="p-2">Agrees</th></tr></thead>
            <tbody>
              {d.evidence.compared.map((c, i) => (
                <tr key={i} className={c.agrees === false ? "bg-orange-50" : ""}>
                  <td className="p-2">{c.field.replace(/_/g, " ")}</td>
                  <td className="p-2">{show(c.documentSays)}</td>
                  <td className="p-2">{show(c.recordSays)}</td>
                  <td className="p-2 text-xs">{c.source === "attested" ? "reviewer attestation" : "document scan"}</td>
                  <td className="p-2">{c.agrees === null ? "not stated" : c.agrees ? "yes" : "NO"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          </>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium mb-1">Reasons</h3>
        <ul className="space-y-2">
          {d.blockingReasons.map((r, i) => (
            <li key={i} className="text-sm border rounded p-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline">{r.severity === "review" ? "for the reviewer" : r.severity}</Badge>
                {r.documentId && <span className="text-xs">Form: {docLabel(r.documentId) ?? "document"}</span>}
                {r.field && <span className="text-xs">Field: {r.field.replace(/_/g, " ")}</span>}
              </div>
              <p className="mt-1">{r.message}</p>
              {r.repair && <p className="text-xs text-muted-foreground mt-1">How this ends: {r.repair}</p>}
              {data.mayDecide && r.documentId && READ_FAILURES.has(r.code) && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => { setAttestFor(r.documentId); setSignersConfirmed(r.code === "ambiguous_signature") }}>
                  Record what I read on this document
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-1">Executed documents</h3>
        <ul className="text-sm space-y-1">
          {docs.map((doc) => (
            <li key={doc.id}>
              {doc.openHref ? <a className="text-blue-600 hover:underline" href={doc.openHref} target="_blank" rel="noreferrer">Open {(doc.classification ?? "document").replace(/_/g, " ")}</a> : <span>{(doc.classification ?? "document").replace(/_/g, " ")} (no stored file)</span>}
              {doc.stateFormId ? <span className="text-xs text-muted-foreground"> · form {doc.stateFormId}</span> : null}
              {doc.attestedBy ? <span className="text-xs text-muted-foreground"> · terms attested by a reviewer</span> : null}
            </li>
          ))}
        </ul>
      </div>

      {data.mayDecide && attestFor && (
        <div className="border rounded p-3 space-y-2">
          <p className="text-sm font-medium">Record the terms you read on the executed {docLabel(attestFor) ?? "document"}</p>
          <p className="text-xs text-muted-foreground">Recorded under your name. The comparison then uses your reading — a term that disagrees with the record still holds.</p>
          {data.attestableTerms.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <span className="w-48">{k.replace(/_/g, " ")}</span>
              <Input value={terms[k] ?? ""} onChange={(e) => setTerms({ ...terms, [k]: e.target.value })} />
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={signersConfirmed} onChange={(e) => setSignersConfirmed(e.target.checked)} /> I confirmed every signer on the executed document</label>
          <div className="flex gap-2"><Button size="sm" disabled={pending} onClick={attest}>Record my reading</Button><Button size="sm" variant="ghost" onClick={() => setAttestFor(null)}>Cancel</Button></div>
        </div>
      )}

      {data.mayDecide ? (
        <div className="space-y-2">
          <Textarea placeholder="For a hold: which form or term is wrong, and what fixes it" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button disabled={pending || d.verdict === "hold" || d.verdict === "refuse" || d.verdict === "allow"} onClick={() => decide("approve")}>Approve this packet</Button>
            <Button variant="outline" disabled={pending || !note.trim()} onClick={() => decide("hold")}>Hold with this reason</Button>
          </div>
          {(d.verdict === "hold" || d.verdict === "refuse") && <p className="text-xs text-muted-foreground">A hold is repaired, not approved: fix the items above (or record what you read), and the review runs again.</p>}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Compliance decides this packet. You will be told when it is accepted or what to fix.</p>
      )}
      {notice && <p className="text-sm">{notice}</p>}
    </div>
  )
}
