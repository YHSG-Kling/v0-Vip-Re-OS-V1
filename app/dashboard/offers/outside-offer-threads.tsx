"use client"

// app/dashboard/offers/outside-offer-threads.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT'S OUTSIDE-OFFER INBOX (wave 143, lane 143A). One card per offer made
// on a listing that is NOT in this brokerage's system: send the packet to the
// verified outside listing agent, read what came back, and run the rounds.
//
// Everything here is a thin caller of app/actions/buyer-offer/outside-offer-loop.ts
// — tenancy, authority and every rule (recipient verified before anything leaves,
// only the COUNTER is sent on a counter-back, an acceptance needs a contract both
// parties signed, an unverified sender needs an explicit acknowledgement) live in
// those actions. This file decides nothing; it shows the platform's refusals
// in the agent's words and never presents the AI's reading as the record.
//
// The platform NEVER accepts, signs or creates a transaction from an email: the
// buttons below only ask the agent to CONFIRM what a reply means.

import { useState, useTransition } from "react"
import { cn } from "@/lib/utils"
import {
  listOutsideOffers,
  sendOutsideOffer,
  createOutsideCounterBack,
  confirmOutsideReply,
  respondToOutsideCounter,
  type OutsideOfferThread,
} from "@/app/actions/buyer-offer/outside-offer-loop"
import { recordContractAddendum } from "@/app/actions/buyer-offer/record-contract-addendum"
// WAVE 152 (lane 152F): the requested-signatures door for a PROPOSED addendum — every rule lives behind these actions.
import {
  proposeContractAddendum,
  listAddendumSignatures,
  reviewAddendumSignatureRequest,
  requestAddendumSignatures,
  startAddendumSignatureHandoff,
  approveAddendumForSignature,
  voidAddendumSignatureRequest,
  withdrawProposedAddendum,
  fileSignedAddendumCopy,
} from "@/app/actions/buyer-offer/request-addendum-signatures"
import { Loader2, Send, Upload, Check, X, AlertTriangle, MailQuestion, PenLine } from "lucide-react"

type Message = OutsideOfferThread["messages"][number]

const CLASS_LABEL: Record<string, string> = {
  acceptance: "Looks like an acceptance",
  counter: "Looks like a counter-offer",
  decline: "Looks like a decline",
  ambiguous: "Unclear — read it yourself",
  acknowledgement: "Acknowledgement only",
  other: "Other",
}

const ACTION_LABEL: Record<string, string> = {
  record_acceptance: "Review the signed contract and record the acceptance",
  record_counter: "Review the seller-signed counter and record it",
  record_decline: "Confirm the decline",
  request_signed_document: "Ask the listing agent for the signed document",
  request_clarification: "Ask the listing agent what they mean",
  review_manually: "Review manually",
  file_only: "Filed — nothing to do",
}

const STATUS_LABEL: Record<string, string> = {
  sent: "Sent",
  send_failed: "Send failed",
  awaiting_agent: "Needs you",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
  quarantined: "Quarantined (sender failed authentication)",
}

const VERIFIED_LABEL: Record<string, string> = {
  mls_published: "MLS-published listing agent",
  agent_confirmed: "Confirmed by you",
}

const btn = "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50 transition-colors inline-flex items-center gap-1"
const btnPrimary = "rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1"
const input = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"

function when(at: string | null): string {
  if (!at) return ""
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function OutsideOfferThreads({ initialThreads }: { initialThreads: OutsideOfferThread[] }) {
  const [threads, setThreads] = useState<OutsideOfferThread[]>(initialThreads)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function refresh() {
    const res = await listOutsideOffers()
    if (res.success) setThreads(res.threads)
    else setError(res.error ?? "Could not refresh your outside offers.")
  }

  if (threads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
        No offers on outside listings yet. An offer made on a property that is not listed with this brokerage appears here once it exists.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</div>}
      {threads.map((t) => (
        <ThreadCard key={t.offerId} thread={t} onChanged={refresh} onError={setError} onNotice={setNotice} />
      ))}
    </div>
  )
}

function ThreadCard({ thread, onChanged, onError, onNotice }: {
  thread: OutsideOfferThread
  onChanged: () => Promise<void>
  onError: (m: string | null) => void
  onNotice: (m: string | null) => void
}) {
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState<"send" | "counter" | null>(null)
  const [recipient, setRecipient] = useState(thread.recipientEmail ?? "")
  const [picked, setPicked] = useState<string[]>(thread.headDocuments.map((d) => d.id))
  const [confirmRecipient, setConfirmRecipient] = useState(false)
  const [needsConfirm, setNeedsConfirm] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [cPrice, setCPrice] = useState("")
  const [cClosing, setCClosing] = useState("")
  const [cEarnest, setCEarnest] = useState("")
  const [cNotes, setCNotes] = useState("")
  const [uploading, setUploading] = useState(false)

  const headSent = thread.messages.some((m) => m.direction === "outbound" && m.status === "sent" && m.headOfferId === thread.headOfferId)
  const sellerSideHead = thread.headIssuedBy === "seller_side"
  const awaiting = thread.messages.filter((m) => m.direction === "inbound" && m.status === "awaiting_agent")

  function run(fn: () => Promise<void>) {
    onError(null)
    onNotice(null)
    startTransition(async () => {
      try {
        await fn()
      } catch (err) {
        onError((err as Error)?.message ?? "That didn't go through — try again.")
      }
    })
  }

  function doSend() {
    run(async () => {
      const res = await sendOutsideOffer({ offerId: thread.headOfferId, documentIds: picked, recipientEmail: recipient.trim() || undefined, confirmRecipient: confirmRecipient || undefined, note: note.trim() || undefined })
      if (res.needsRecipientConfirmation) { setNeedsConfirm(res.error ?? "This address is not verified."); return }
      if (!res.success) { onError(res.error ?? "The email was not sent."); return }
      setNeedsConfirm(null); setConfirmRecipient(false); setOpen(null)
      onNotice(`Sent to ${res.deliveredTo}.${res.warnings?.length ? ` Note: ${res.warnings.join(" ")}` : ""}`)
      await onChanged()
    })
  }

  function doCounter() {
    const num = (s: string) => (s.trim() === "" ? undefined : Number(s.replace(/[$,]/g, "")))
    const price = num(cPrice), earnest = num(cEarnest)
    if ((price !== undefined && !Number.isFinite(price)) || (earnest !== undefined && !Number.isFinite(earnest))) { onError("Price and earnest money must be numbers."); return }
    run(async () => {
      const res = await createOutsideCounterBack({ parentOfferId: thread.headOfferId, counterPrice: price, closingDate: cClosing.trim() || undefined, earnestMoney: earnest, notes: cNotes.trim() || undefined })
      if (!res.success) { onError(res.error ?? "The counter could not be created."); return }
      setOpen(null)
      onNotice(`Counter (round ${res.round}) created. Attach the counter signed by your buyer, then send it — only the counter is sent.`)
      await onChanged()
    })
  }

  function doRespond(response: "accept" | "reject") {
    run(async () => {
      const res = await respondToOutsideCounter({ counterOfferId: thread.headOfferId, response })
      if (!res.success) { onError(res.error ?? "The response could not be recorded."); return }
      onNotice(response === "accept" ? "Counter accepted on your buyer's behalf — it still goes through compliance before any transaction exists." : "Counter declined.")
      await onChanged()
    })
  }

  async function doUpload(file: File) {
    onError(null); onNotice(null)
    setUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("docType", thread.headIssuedBy === "original" ? "offer_packet" : "counter_offer")
      const res = await fetch(`/api/offers/${thread.headOfferId}/upload-document`, { method: "POST", body })
      const json = (await res.json().catch(() => ({}))) as { document_id?: string; error?: string }
      if (!res.ok || !json.document_id) { onError(json.error ?? "The upload failed."); return }
      setPicked((p) => [...p, json.document_id!])
      onNotice("Uploaded. It is being read for signatures — a document that does not show your buyer's signature cannot be sent as a counter.")
      await onChanged()
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className={cn("rounded-lg border px-4 py-3 space-y-3", thread.needsAgent ? "border-amber-300 bg-amber-50/60" : "border-border bg-card")}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{thread.propertyAddress ?? "Outside listing"}</p>
          <p className="text-xs text-muted-foreground">
            Round {thread.headRound} · {thread.headIssuedBy === "buyer" ? "your counter" : thread.headIssuedBy === "seller_side" ? "seller's counter" : "original offer"}
            {thread.headStatus ? ` · ${thread.headStatus}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {thread.recipientEmail
              ? <>Listing agent: {thread.recipientEmail}{thread.verifiedBy ? ` (${VERIFIED_LABEL[thread.verifiedBy] ?? thread.verifiedBy})` : " (not yet verified)"}</>
              : "No listing agent email recorded yet."}
          </p>
        </div>
        {thread.needsAgent && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
            <MailQuestion className="h-3 w-3" /> Reply needs you
          </span>
        )}
      </div>

      {thread.governingError && (
        <p className="text-[11px] text-amber-900 flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> The contract terms could not be read: {thread.governingError}</p>
      )}
      {thread.governing && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs space-y-1">
          <p className="font-medium">
            Contract as it stands: version {thread.governing.versionNo} ({thread.governing.source})
            {thread.governing.supersededCount > 0 ? ` · ${thread.governing.supersededCount} earlier value${thread.governing.supersededCount === 1 ? "" : "s"} superseded` : ""}
            {thread.governing.pendingCount > 0 ? ` · ${thread.governing.pendingCount} proposed, not yet executed` : ""}
          </p>
          <p className="text-muted-foreground break-words">
            {Object.entries(thread.governing.values).map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v === null ? "none" : String(v)}`).join(" · ") || "No term is named yet."}
          </p>
        </div>
      )}

      {awaiting.map((m) => (
        <ReplyCard key={m.id} message={m} onChanged={onChanged} onError={onError} onNotice={onNotice} />
      ))}

      <div className="flex items-center gap-1.5 flex-wrap">
        {!sellerSideHead && !headSent && (
          <button className={btnPrimary} onClick={() => setOpen(open === "send" ? null : "send")} disabled={isPending}>
            <Send className="h-3 w-3" /> {thread.headIssuedBy === "buyer" ? "Send counter to listing agent" : "Send offer to listing agent"}
          </button>
        )}
        {sellerSideHead && (
          <>
            <button className={btn} onClick={() => doRespond("accept")} disabled={isPending}>
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Buyer accepts
            </button>
            <button className={btn} onClick={() => setOpen(open === "counter" ? null : "counter")} disabled={isPending}>Buyer counters</button>
            <button className={btn} onClick={() => doRespond("reject")} disabled={isPending}>
              <X className="h-3 w-3" /> Buyer declines
            </button>
          </>
        )}
        {(thread.headIssuedBy === "buyer" || thread.headIssuedBy === "original") && !headSent && (
          <label className={cn(btn, "cursor-pointer", uploading && "opacity-50")}>
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Attach a document
            <input type="file" accept="application/pdf,image/*" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doUpload(f) }} />
          </label>
        )}
        {headSent && <span className="text-[11px] text-muted-foreground">This round has been sent — waiting for the listing agent's reply.</span>}
      </div>

      {open === "send" && (
        <div className="rounded-md border border-border bg-background p-3 space-y-2">
          <label className="block text-[11px] font-medium">Listing agent's email
            <input className={cn(input, "mt-1")} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="agent@brokerage.com" />
          </label>
          <fieldset className="space-y-1">
            <legend className="text-[11px] font-medium">Documents to share (sent as secure links that expire in 7 days)</legend>
            {thread.headDocuments.length === 0 && <p className="text-[11px] text-muted-foreground">No documents are filed to this round yet — attach one.</p>}
            {thread.headDocuments.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked((p) => e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id))} />
                <span className="truncate">{d.name}</span>
                {d.classification && <span className="text-[10px] text-muted-foreground">{d.classification}</span>}
              </label>
            ))}
          </fieldset>
          <label className="block text-[11px] font-medium">Note to the listing agent (optional)
            <textarea className={cn(input, "mt-1")} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {needsConfirm && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-2 text-xs text-amber-900 space-y-1">
              <p className="flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {needsConfirm}</p>
              <label className="flex items-center gap-2"><input type="checkbox" checked={confirmRecipient} onChange={(e) => setConfirmRecipient(e.target.checked)} /> I know this is the listing agent's address.</label>
            </div>
          )}
          <button className={btnPrimary} onClick={doSend} disabled={isPending || picked.length === 0 || !recipient.trim() || (needsConfirm !== null && !confirmRecipient)}>
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Send
          </button>
        </div>
      )}

      {open === "counter" && (
        <div className="rounded-md border border-border bg-background p-3 space-y-2">
          <p className="text-[11px] text-muted-foreground">Change only what your buyer is countering. This creates a new round; the earlier rounds stay on file.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="block text-[11px] font-medium">Price<input className={cn(input, "mt-1")} value={cPrice} onChange={(e) => setCPrice(e.target.value)} inputMode="decimal" /></label>
            <label className="block text-[11px] font-medium">Closing date<input className={cn(input, "mt-1")} type="date" value={cClosing} onChange={(e) => setCClosing(e.target.value)} /></label>
            <label className="block text-[11px] font-medium">Earnest money<input className={cn(input, "mt-1")} value={cEarnest} onChange={(e) => setCEarnest(e.target.value)} inputMode="decimal" /></label>
          </div>
          <label className="block text-[11px] font-medium">Notes<textarea className={cn(input, "mt-1")} rows={2} value={cNotes} onChange={(e) => setCNotes(e.target.value)} /></label>
          <button className={btnPrimary} onClick={doCounter} disabled={isPending}>
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Create counter
          </button>
        </div>
      )}

      {thread.governing && (
        <AddendumForm thread={thread} onChanged={onChanged} onError={onError} onNotice={onNotice} />
      )}
      {thread.governing && (
        <AddendumSignaturePanel thread={thread} onChanged={onChanged} onError={onError} onNotice={onNotice} />
      )}

      {thread.messages.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">History ({thread.messages.length})</summary>
          <ul className="mt-2 space-y-1">
            {thread.messages.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground">{when(m.at)}</span>
                <span className="font-medium">{m.direction === "outbound" ? (m.kind === "counter_back" ? "You sent a counter" : "You sent the offer") : "Reply received"}</span>
                <span className="text-muted-foreground">{STATUS_LABEL[m.status] ?? m.status}{m.classification ? ` · ${CLASS_LABEL[m.classification] ?? m.classification}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/**
 * An addendum / amendment signed AFTER the contract (a repair credit, a closing-date extension). Upload the signed document, say
 * what day it was signed and which terms it changes — the platform records it only if the document shows BOTH parties' signatures,
 * and it then supersedes the earlier value of exactly those terms (the originals stay on file).
 */
function AddendumForm({ thread, onChanged, onError, onNotice }: {
  thread: OutsideOfferThread
  onChanged: () => Promise<void>
  onError: (m: string | null) => void
  onNotice: (m: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [kind, setKind] = useState<"addendum" | "amendment">("addendum")
  const [documentId, setDocumentId] = useState("")
  const [fileName, setFileName] = useState("")
  const [executedOn, setExecutedOn] = useState("")
  const [effectiveOn, setEffectiveOn] = useState("")
  const [termsText, setTermsText] = useState('{\n  "closing_date": "2026-12-20"\n}')
  // Wave 151 (151K): where each changed term is READ in the signed document — page / field / quoted words, keyed by term.
  const [evidenceText, setEvidenceText] = useState('{\n  "closing_date": { "page": 1, "field": "Closing Date", "quote": "" }\n}')
  const [uploading, setUploading] = useState(false)

  async function upload(file: File) {
    onError(null)
    setUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("docType", kind)
      const res = await fetch(`/api/offers/${thread.offerId}/upload-document`, { method: "POST", body })
      const json = (await res.json().catch(() => ({}))) as { document_id?: string; error?: string }
      if (!res.ok || !json.document_id) { onError(json.error ?? "The upload failed."); return }
      setDocumentId(json.document_id)
      setFileName(file.name)
    } finally {
      setUploading(false)
    }
  }

  function submit() {
    onError(null); onNotice(null)
    let terms: Record<string, unknown>
    try {
      const parsed = JSON.parse(termsText || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
      terms = parsed as Record<string, unknown>
    } catch {
      onError("The terms must be valid JSON — only the terms the addendum changes.")
      return
    }
    let termEvidence: Record<string, { page?: number | null; field?: string | null; quote?: string | null }> | null = null
    if (evidenceText.trim()) {
      try {
        const parsed = JSON.parse(evidenceText)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
        termEvidence = parsed as typeof termEvidence
      } catch {
        onError("The evidence must be valid JSON — each changed term with its page / field / quote (or clear the box).")
        return
      }
    }
    startTransition(async () => {
      const res = await recordContractAddendum({ offerId: thread.offerId, kind, documentId, terms, executedOn, effectiveOn: effectiveOn || null, termEvidence })
      if (!res.success) { onError(res.error ?? "The addendum could not be recorded."); return }
      setOpen(false); setDocumentId(""); setFileName(""); setEffectiveOn("")
      onNotice(`Recorded as ${kind} ${res.versionNo}. It now governs the terms it changes; the earlier values stay on file.`)
      await onChanged()
    })
  }

  return (
    <div className="space-y-2">
      <button className={btn} onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : "Record a signed addendum"}</button>
      {open && (
        <div className="rounded-md border border-border bg-background p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block text-[11px] font-medium">Kind
              <select className={cn(input, "mt-1")} value={kind} onChange={(e) => setKind(e.target.value as "addendum" | "amendment")}>
                <option value="addendum">Addendum</option>
                <option value="amendment">Amendment</option>
              </select>
            </label>
            <label className="block text-[11px] font-medium">Date fully signed
              <input className={cn(input, "mt-1")} type="date" value={executedOn} onChange={(e) => setExecutedOn(e.target.value)} />
            </label>
            <label className="block text-[11px] font-medium">Takes effect on (only if the addendum states a date)
              <input className={cn(input, "mt-1")} type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />
            </label>
          </div>
          <label className={cn(btn, "cursor-pointer", uploading && "opacity-50")}>
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} {fileName ? `Signed document: ${fileName}` : "Upload the signed document"}
            <input type="file" accept="application/pdf,image/*" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f) }} />
          </label>
          <label className="block text-[11px] font-medium">Terms it changes (JSON; null strikes a term)
            <textarea className={cn(input, "mt-1 font-mono")} rows={4} value={termsText} onChange={(e) => setTermsText(e.target.value)} />
          </label>
          <label className="block text-[11px] font-medium">Where each term is read in the signed document (JSON: page, field, quote — a term with none is recorded and flagged for review)
            <textarea className={cn(input, "mt-1 font-mono")} rows={3} value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} />
          </label>
          <p className="text-[10px] text-muted-foreground">Recorded only if the uploaded document has been read and shows both the buyer's and the seller's signatures. Nothing is signed or accepted for anyone.</p>
          <button className={btnPrimary} onClick={submit} disabled={isPending || !documentId || !executedOn}>
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Record
          </button>
        </div>
      )}
    </div>
  )
}

type ProposalView = Awaited<ReturnType<typeof listAddendumSignatures>>["proposals"][number]
type ReviewView = NonNullable<Awaited<ReturnType<typeof reviewAddendumSignatureRequest>>["review"]>

const TONE: Record<string, string> = {
  neutral: "text-muted-foreground",
  progress: "text-sky-800",
  done: "text-emerald-800",
  attention: "text-amber-900",
}
const LIVE = new Set(["pending", "sent", "partially_signed"])

/**
 * WAVE 152 (lane 152F) — REQUEST SIGNATURES ON A PROPOSED ADDENDUM. Propose the change (the unsigned document + only the terms it
 * changes), review who signs and through what route, send it through your e-sign connection, watch its status, void or resend it,
 * or — with no e-sign connection — download it and file the signed copy. The contract changes only when every required party has
 * signed and the record's checks pass; nothing here signs for anyone.
 */
function AddendumSignaturePanel({ thread, onChanged, onError, onNotice }: {
  thread: OutsideOfferThread
  onChanged: () => Promise<void>
  onError: (m: string | null) => void
  onNotice: (m: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [proposals, setProposals] = useState<ProposalView[] | null>(null)
  const [isPending, startTransition] = useTransition()
  const [kind, setKind] = useState<"addendum" | "amendment">("addendum")
  const [documentId, setDocumentId] = useState("")
  const [fileName, setFileName] = useState("")
  const [effectiveOn, setEffectiveOn] = useState("")
  const [termsText, setTermsText] = useState('{\n  "closing_date": "2026-12-20"\n}')
  // Where each changed term is READ on the addendum (page / field / quote). The same pages go out for signature, so this becomes the
  // executed version's located evidence (evidence.term_evidence_stated) — without it every changed term is held for review.
  const [evidenceText, setEvidenceText] = useState('{\n  "closing_date": { "page": 1, "field": "Closing Date", "quote": "" }\n}')
  const [uploading, setUploading] = useState(false)

  async function load() {
    const r = await listAddendumSignatures({ offerId: thread.offerId })
    if (r.success) setProposals(r.proposals)
    else onError(r.error ?? "The proposed addenda could not be loaded.")
  }

  async function upload(file: File) {
    onError(null)
    setUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("docType", kind)
      const res = await fetch(`/api/offers/${thread.offerId}/upload-document`, { method: "POST", body })
      const json = (await res.json().catch(() => ({}))) as { document_id?: string; error?: string }
      if (!res.ok || !json.document_id) { onError(json.error ?? "The upload failed."); return }
      setDocumentId(json.document_id)
      setFileName(file.name)
    } finally {
      setUploading(false)
    }
  }

  function propose() {
    onError(null); onNotice(null)
    let terms: Record<string, unknown>
    try {
      const parsed = JSON.parse(termsText || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
      terms = parsed as Record<string, unknown>
    } catch {
      onError("The terms must be valid JSON — only the terms the addendum would change.")
      return
    }
    let termEvidence: Record<string, { page?: number | null; field?: string | null; quote?: string | null }> | null = null
    if (evidenceText.trim()) {
      try {
        const parsed = JSON.parse(evidenceText)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
        termEvidence = parsed as typeof termEvidence
      } catch {
        onError("The evidence must be valid JSON — each changed term with its page / field / quote (or clear the box).")
        return
      }
    }
    startTransition(async () => {
      const r = await proposeContractAddendum({ offerId: thread.offerId, kind, documentId, terms, effectiveOn: effectiveOn || null, termEvidence })
      if (!r.success) { onError(r.error ?? "The addendum could not be proposed."); return }
      setDocumentId(""); setFileName(""); setEffectiveOn("")
      onNotice("Proposed. It does not change the contract until every required party signs it — review the signers below to send it.")
      await load()
      await onChanged()
    })
  }

  return (
    <div className="space-y-2">
      <button className={btn} onClick={() => { const next = !open; setOpen(next); if (next) startTransition(load) }}>
        <PenLine className="h-3 w-3" /> {open ? "Hide addenda for signature" : "Propose an addendum for signatures"}
      </button>
      {open && (
        <div className="rounded-md border border-border bg-background p-3 space-y-3">
          <div className="space-y-2">
            <p className="text-[11px] font-medium">New proposal</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block text-[11px] font-medium">Kind
                <select className={cn(input, "mt-1")} value={kind} onChange={(e) => setKind(e.target.value as "addendum" | "amendment")}>
                  <option value="addendum">Addendum</option>
                  <option value="amendment">Amendment</option>
                </select>
              </label>
              <label className="block text-[11px] font-medium">Takes effect on (only if the addendum states a date)
                <input className={cn(input, "mt-1")} type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />
              </label>
            </div>
            <label className={cn(btn, "cursor-pointer", uploading && "opacity-50")}>
              {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} {fileName ? `Unsigned addendum: ${fileName}` : "Upload the unsigned addendum (PDF)"}
              <input type="file" accept="application/pdf" className="hidden" disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f) }} />
            </label>
            <label className="block text-[11px] font-medium">Terms it would change (JSON; null strikes a term)
              <textarea className={cn(input, "mt-1 font-mono")} rows={3} value={termsText} onChange={(e) => setTermsText(e.target.value)} />
            </label>
            <label className="block text-[11px] font-medium">Where each term is read on the addendum (JSON: page, field, quote — a term with none is held for review once signed)
              <textarea className={cn(input, "mt-1 font-mono")} rows={3} value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} />
            </label>
            <button className={btnPrimary} onClick={propose} disabled={isPending || !documentId}>
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Propose
            </button>
          </div>
          {proposals === null && <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>}
          {proposals?.length === 0 && <p className="text-[11px] text-muted-foreground">No addendum has been proposed on this contract yet.</p>}
          {proposals?.map((p) => (
            <ProposalCard key={p.id} offerId={thread.offerId} proposal={p} onChanged={async () => { await load(); await onChanged() }} onError={onError} onNotice={onNotice} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProposalCard({ offerId, proposal: p, onChanged, onError, onNotice }: {
  /** The offer the signed copy is filed against (the same upload door as every other document on this card). */
  offerId: string
  proposal: ProposalView
  onChanged: () => Promise<void>
  onError: (m: string | null) => void
  onNotice: (m: string | null) => void
}) {
  const [isPending, startTransition] = useTransition()
  const [review, setReview] = useState<ReviewView | null>(null)
  const [agentEmail, setAgentEmail] = useState("")
  const [confirmAgent, setConfirmAgent] = useState(false)
  const [includeAttorneys, setIncludeAttorneys] = useState(true)
  const [reminders, setReminders] = useState(true)
  const [handoff, setHandoff] = useState<{ urls: Array<{ label: string; url: string }>; instructions: string } | null>(null)
  const [voidReason, setVoidReason] = useState("")
  const [signedDocId, setSignedDocId] = useState("")
  const [signedName, setSignedName] = useState("")
  const [signedOn, setSignedOn] = useState("")
  const [uploading, setUploading] = useState(false)

  const latest = p.requests[0] ?? null
  const live = latest && LIVE.has(latest.status) ? latest : null
  const choices = { counterpartyAgentEmail: agentEmail.trim() || null, confirmCounterpartyAgent: confirmAgent || undefined, includeAttorneys, reminders }
  const canFile = !!latest?.fileable
  const held = !!latest?.held

  function act(fn: () => Promise<void>) {
    onError(null); onNotice(null)
    startTransition(async () => { try { await fn() } catch (err) { onError((err as Error)?.message ?? "That didn't go through — try again.") } })
  }

  const doReview = () => act(async () => {
    const r = await reviewAddendumSignatureRequest({ versionId: p.id, choices })
    if (!r.success || !r.review) { onError(r.error ?? "The signers could not be reviewed."); return }
    setReview(r.review)
  })
  const doSend = () => act(async () => {
    const r = await requestAddendumSignatures({ versionId: p.id, choices })
    if (!r.success) { onError(r.error ?? "The addendum was not sent."); await onChanged(); return }
    if (r.handoff) setHandoff({ urls: r.handoff.urls, instructions: r.handoff.instructions })
    onNotice(r.replayed ? `Already out for signature — ${r.label?.toLowerCase()}. Nothing was sent twice.` : `${r.label}. ${r.detail ?? ""}`)
    setReview(null)
    await onChanged()
  })
  const doHandoff = () => act(async () => {
    const r = await startAddendumSignatureHandoff({ versionId: p.id })
    if (!r.success) { onError(r.error ?? "The hand-off could not be started."); return }
    onNotice(`${r.label}. ${r.detail ?? ""}`)
    await onChanged()
  })
  const doApprove = () => act(async () => {
    const r = await approveAddendumForSignature({ versionId: p.id })
    if (!r.success) { onError(r.error ?? "The approval was not saved."); return }
    onNotice("Approved for signature. The agent can now send it.")
    await onChanged()
  })
  const doVoid = () => act(async () => {
    if (!live) return
    const r = await voidAddendumSignatureRequest({ requestId: live.id, reason: voidReason })
    if (!r.success) { onError(r.error ?? "The request was not voided."); return }
    setVoidReason("")
    onNotice(r.providerVoided ? "Voided at the e-sign provider. Nothing it carried can be signed any more." : "Withdrawn here. If you already sent it from your own e-sign window, cancel it there too.")
    await onChanged()
  })
  const doWithdraw = () => act(async () => {
    const r = await withdrawProposedAddendum({ versionId: p.id, reason: voidReason || "withdrawn by the agent" })
    if (!r.success) { onError(r.error ?? "The proposal was not withdrawn."); return }
    onNotice("Proposal withdrawn. It stays in the contract history; propose a revised addendum if the terms are still changing.")
    await onChanged()
  })
  const doFile = () => act(async () => {
    if (!latest) return
    const r = await fileSignedAddendumCopy({ requestId: latest.id, documentId: signedDocId || null, executedOn: signedOn })
    if (!r.success) { onError(r.error ?? "The signed copy was not recorded."); return }
    setSignedDocId(""); setSignedName(""); setSignedOn("")
    onNotice(`Recorded as executed version ${r.versionNo}. Compliance re-checked the terms it changes; the earlier values stay on file.`)
    await onChanged()
  })

  async function uploadSigned(file: File) {
    onError(null)
    setUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("docType", p.source)
      const res = await fetch(`/api/offers/${offerId}/upload-document`, { method: "POST", body })
      const json = (await res.json().catch(() => ({}))) as { document_id?: string; error?: string }
      if (!res.ok || !json.document_id) { onError(json.error ?? "The upload failed."); return }
      setSignedDocId(json.document_id)
      setSignedName(file.name)
    } finally {
      setUploading(false)
    }
  }

  const approvalBlocked = review?.plan.blockers.some((b) => b.code === "broker_approval_required") ?? false
  const sendable = !!review && review.plan.ready && review.provider.state !== "connection_required" && !live

  return (
    <div className="rounded-md border border-border px-3 py-2 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-medium">
            Proposed {p.source} {p.createdAt ? `· ${when(p.createdAt)}` : ""}
            {p.status === "void" ? (p.closedAs === "executed" ? " · executed" : " · withdrawn") : ""}
          </p>
          <p className="text-[11px] text-muted-foreground break-words">
            {Object.entries(p.terms).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v === null ? "struck" : String(v)}`).join(" · ")}
          </p>
        </div>
      </div>

      {latest && (
        <div className={cn("text-[11px] space-y-0.5", TONE[latest.display.tone] ?? "")}>
          <p className="font-medium">{latest.display.label}</p>
          <p>{latest.display.detail}</p>
          {latest.display.action && <p>Next: {latest.display.action}.</p>}
        </div>
      )}

      {p.status === "proposed" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button className={btn} onClick={doReview} disabled={isPending}>{isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Review signers</button>
            {sendable && (
              <button className={btnPrimary} onClick={doSend} disabled={isPending}>
                <Send className="h-3 w-3" /> {latest && !live ? "Send a new request" : "Send for signatures"}
              </button>
            )}
            {approvalBlocked && <button className={btn} onClick={doApprove} disabled={isPending}>Approve for signature (broker)</button>}
            {review?.provider.state === "connection_required" && !live && (
              <button className={btn} onClick={doHandoff} disabled={isPending}>Collect signatures outside the platform</button>
            )}
          </div>

          {review && (
            <div className="rounded-md border border-border bg-muted/20 p-2 space-y-1.5 text-[11px]">
              <p className={review.provider.state === "connection_required" ? "text-amber-900" : "text-muted-foreground"}>{review.provider.message}</p>
              {review.provider.state === "connection_required" && review.documentUrl && (
                <a className="underline" href={review.documentUrl} target="_blank" rel="noopener noreferrer">Download the addendum</a>
              )}
              {review.plan.recipients.length > 0 && (
                <ol className="list-decimal pl-4 space-y-0.5">
                  {review.plan.recipients.map((r, i) => (
                    <li key={i}>{r.name} — {r.role.replace(/_/g, " ")}{r.kind === "attorney_review" ? " (reviews; does not sign for a party)" : ""} · {r.email}</li>
                  ))}
                </ol>
              )}
              {review.plan.routed.map((r) => (
                <p key={r.side}>The {r.side} is represented by another brokerage — their signature is requested through their agent ({r.agentEmail}{r.verified ? "" : ", confirmed by you"}) after your client signs.</p>
              ))}
              {review.plan.approvals.map((a, i) => (
                <p key={i}>{a.satisfied ? "Broker approval: in place" : "Needs your broker's approval"} — {a.reason}.</p>
              ))}
              {review.plan.blockers.map((b, i) => (
                <p key={i} className="text-amber-900 flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {b.message}</p>
              ))}
              {review.plan.blockers.some((b) => b.code === "no_counterparty_route" || b.code === "counterparty_unverified") && (
                <div className="space-y-1">
                  <label className="block font-medium">Their agent's email
                    <input className={cn(input, "mt-1")} value={agentEmail} onChange={(e) => setAgentEmail(e.target.value)} placeholder="agent@otherbrokerage.com" />
                  </label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={confirmAgent} onChange={(e) => setConfirmAgent(e.target.checked)} /> I know this is their agent's address.</label>
                </div>
              )}
              <label className="flex items-center gap-2"><input type="checkbox" checked={includeAttorneys} onChange={(e) => setIncludeAttorneys(e.target.checked)} /> Copy attorneys on the deal for review</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={reminders} onChange={(e) => setReminders(e.target.checked)} /> Remind me if it stalls</label>
              <button className={btn} onClick={doReview} disabled={isPending}>Check again</button>
            </div>
          )}

          {handoff && (
            <div className="rounded-md border border-sky-300 bg-sky-50 px-2 py-2 text-[11px] text-sky-900 space-y-1">
              <p>{handoff.instructions}</p>
              {handoff.urls.map((u) => <a key={u.url} className="block underline" href={u.url} target="_blank" rel="noopener noreferrer">{u.label}</a>)}
            </div>
          )}

          {live && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <input className={cn(input, "max-w-xs")} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Why it is being voided (the signers see this)" />
              <button className={btn} onClick={doVoid} disabled={isPending || !voidReason.trim()}><X className="h-3 w-3" /> Void request</button>
            </div>
          )}

          {canFile && (
            <div className="rounded-md border border-border p-2 space-y-1.5 text-[11px]">
              <p className="font-medium">File the fully signed copy</p>
              {held && <p className="text-muted-foreground">Retries the record on the copy the e-sign provider returned — no new file is needed.</p>}
              {!held && (
                <label className={cn(btn, "cursor-pointer", uploading && "opacity-50")}>
                  {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} {signedName ? `Signed copy: ${signedName}` : "Upload the signed copy"}
                  <input type="file" accept="application/pdf,image/*" className="hidden" disabled={uploading}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadSigned(f) }} />
                </label>
              )}
              <label className="block font-medium">Date the last party signed
                <input className={cn(input, "mt-1 max-w-[12rem]")} type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} />
              </label>
              <p className="text-muted-foreground">Recorded only if the copy shows every required party's signature. Nothing is signed for anyone.</p>
              <button className={btnPrimary} onClick={doFile} disabled={isPending || !signedOn || (!signedDocId && !held)}>
                <Check className="h-3 w-3" /> Record the signed copy
              </button>
            </div>
          )}

          <button className={cn(btn, "text-muted-foreground")} onClick={doWithdraw} disabled={isPending}>Withdraw this proposal</button>
        </div>
      )}
    </div>
  )
}

function ReplyCard({ message: m, onChanged, onError, onNotice }: {
  message: Message
  onChanged: () => Promise<void>
  onError: (m: string | null) => void
  onNotice: (m: string | null) => void
}) {
  const [isPending, startTransition] = useTransition()
  const [documentId, setDocumentId] = useState<string>(m.documentIds[0] ?? "")
  const [termsText, setTermsText] = useState(JSON.stringify(m.draftTerms ?? {}, null, 2))
  const [ackSender, setAckSender] = useState(false)
  const [needsAck, setNeedsAck] = useState(false)
  const untrusted = m.senderTrusted !== true

  function decide(decision: "accepted" | "countered" | "rejected" | "dismissed") {
    onError(null); onNotice(null)
    let terms: Record<string, unknown> | undefined
    if (decision === "countered") {
      try {
        const parsed = JSON.parse(termsText || "{}")
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
        terms = parsed as Record<string, unknown>
      } catch {
        onError("The counter's terms must be valid JSON — confirm exactly what the listing agent proposed.")
        return
      }
    }
    startTransition(async () => {
      const res = await confirmOutsideReply({ messageId: m.id, decision, documentId: documentId || undefined, terms, acknowledgeSender: ackSender || undefined })
      if (res.needsSenderAcknowledgement) { setNeedsAck(true); onError(res.error ?? "The sender could not be verified."); return }
      if (!res.success) { onError(res.error ?? "That could not be recorded."); return }
      onNotice(decision === "dismissed" ? "Reply dismissed." : "Recorded. Nothing becomes a transaction until the contract is fully executed and has passed compliance.")
      await onChanged()
    })
  }

  return (
    <div className="rounded-md border border-amber-300 bg-background px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium">{m.classification ? CLASS_LABEL[m.classification] ?? m.classification : "Reply received"}</span>
        <span className="text-[10px] text-muted-foreground">{when(m.at)}</span>
        {m.recommendedAction && <span className="text-[11px] text-muted-foreground">Suggested: {ACTION_LABEL[m.recommendedAction] ?? m.recommendedAction}</span>}
      </div>
      {m.subject && <p className="text-[11px] text-muted-foreground truncate">{m.subject}</p>}
      {m.summary && <p className="text-xs">AI reading (a draft, not the record): {m.summary}</p>}
      {m.downgrades.length > 0 && (
        <ul className="text-[11px] text-amber-900 list-disc pl-4">{m.downgrades.map((d, i) => <li key={i}>{d}</li>)}</ul>
      )}
      {m.questions.length > 0 && (
        <ul className="text-[11px] text-muted-foreground list-disc pl-4">{m.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      )}
      {untrusted && (
        <p className="flex items-start gap-1 text-[11px] text-amber-900"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> Sender not verified{m.senderReason ? `: ${m.senderReason}` : "."}</p>
      )}

      {m.documentIds.length > 0 && (
        <label className="block text-[11px] font-medium">Document that came with the reply
          <select className={cn(input, "mt-1")} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
            <option value="">None selected</option>
            {m.documentIds.map((id, i) => <option key={id} value={id}>Attachment {i + 1} ({id.slice(0, 8)})</option>)}
          </select>
        </label>
      )}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted-foreground">Terms to record if this is a counter (edit to match the signed counter)</summary>
        <textarea className={cn(input, "mt-1 font-mono")} rows={5} value={termsText} onChange={(e) => setTermsText(e.target.value)} />
      </details>

      {(untrusted || needsAck) && (
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={ackSender} onChange={(e) => setAckSender(e.target.checked)} /> I know this message is from the listing agent.</label>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <button className={btnPrimary} disabled={isPending} onClick={() => decide("accepted")}>
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Record acceptance
        </button>
        <button className={btn} disabled={isPending} onClick={() => decide("countered")}>Record seller counter</button>
        <button className={btn} disabled={isPending} onClick={() => decide("rejected")}>Record decline</button>
        <button className={btn} disabled={isPending} onClick={() => decide("dismissed")}>Dismiss</button>
      </div>
      <p className="text-[10px] text-muted-foreground">An acceptance is recorded only on a contract both parties signed — the email alone is never an acceptance.</p>
    </div>
  )
}
