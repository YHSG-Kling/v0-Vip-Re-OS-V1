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
import { Loader2, Send, Upload, Check, X, AlertTriangle, MailQuestion } from "lucide-react"

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
  const [termsText, setTermsText] = useState('{\n  "closing_date": "2026-12-20"\n}')
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
    startTransition(async () => {
      const res = await recordContractAddendum({ offerId: thread.offerId, kind, documentId, terms, executedOn })
      if (!res.success) { onError(res.error ?? "The addendum could not be recorded."); return }
      setOpen(false); setDocumentId(""); setFileName("")
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
          </div>
          <label className={cn(btn, "cursor-pointer", uploading && "opacity-50")}>
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} {fileName ? `Signed document: ${fileName}` : "Upload the signed document"}
            <input type="file" accept="application/pdf,image/*" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f) }} />
          </label>
          <label className="block text-[11px] font-medium">Terms it changes (JSON; null strikes a term)
            <textarea className={cn(input, "mt-1 font-mono")} rows={4} value={termsText} onChange={(e) => setTermsText(e.target.value)} />
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
