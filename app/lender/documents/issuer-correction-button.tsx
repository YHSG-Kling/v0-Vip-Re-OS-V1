"use client"

// WAVE 153 (lane 153D; owner: "lender/title or any vendors can correct their own documents"). The lender / title company / vendor files
// a corrected version of ITS OWN document from its portal. The server decides whether the document is theirs (issuer, assignment,
// tenant), keeps the earlier version as history, re-runs the closing checks and tells the agent, TC and compliance — nothing is
// replaced silently. Used by app/lender/documents/page.tsx and app/title/documents/page.tsx. Door: app/actions/vendor-document-corrections.ts.

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { submitIssuerDocumentCorrectionAction } from "@/app/actions/vendor-document-corrections"

/** The file as a data: URL for a server-action upload. ONE copy for this lane's two forms (the closing card's off-platform form reads it). */
export const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result ?? ""))
  r.onerror = () => reject(new Error("The file could not be read on this device."))
  r.readAsDataURL(file)
})

export function IssuerCorrectionButton({ transactionId, documentId, as }: { transactionId: string; documentId: string; as?: "title" | "vendor" }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () => startTransition(async () => {
    if (!file) { setMessage("Choose the corrected document first."); return }
    let data = ""
    try { data = await readFileAsDataUrl(file) } catch (e) { setMessage(e instanceof Error ? e.message : "The file could not be read."); return }
    const r = await submitIssuerDocumentCorrectionAction({ transactionId, original: { rail: "transaction_documents", id: documentId }, fileName: file.name, contentType: file.type, fileData: data, note, as })
    setMessage(r.success ? r.message : r.error)
    if (r.success) { setFile(null); setNote(""); setOpen(false) }
  })

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Upload a corrected version</Button>
        {message ? <p className="max-w-xs text-right text-xs text-muted-foreground" role="status">{message}</p> : null}
      </div>
    )
  }
  return (
    <div className="w-full space-y-2 sm:w-80">
      <Input type="file" accept="application/pdf,image/png,image/jpeg,image/heic,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed (for example: corrected seller credit on page 2)" rows={2} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={submit} disabled={pending || !file}>File the corrected version</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
      </div>
      <p className="text-xs text-muted-foreground">Only your own documents can be corrected. The earlier version is kept, and the agent, TC and compliance are told.</p>
      {message ? <p className="text-xs" role="status">{message}</p> : null}
    </div>
  )
}
