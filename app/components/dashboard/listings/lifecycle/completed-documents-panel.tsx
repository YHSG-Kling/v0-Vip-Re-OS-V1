"use client"

// ═══════════════════════════════════════════════════════════════════════════════
// CompletedDocumentsPanel
//
// THE INBOUND SIDE OF THE LISTING FILE.
//
// ListingFormsPanel sends paperwork OUT (prefill → draft → e-sign). Nothing
// brought completed paperwork back IN: the only uploader in the product was the
// client portal's, rendered for the seller and writing a different table than
// the compliance audit reads. So the agent who walks out of a listing
// appointment holding the signed agreement had nowhere to put it — and the
// draft listing it would have promoted just sat there.
//
// This panel uploads through the same universal path the offer file uses, shows
// what the scanner made of each document, and reports the SAME required-document
// verdict the listing gate will reach — so what the agent reads here is what the
// gate decides, not a second opinion.
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Upload, FileText, Loader2, CheckCircle2, AlertCircle, ExternalLink, RefreshCw,
} from "lucide-react"
import {
  getListingDocumentsAction,
  type ListingDocumentRow,
} from "@/app/actions/listing-documents"

interface CompletedDocumentsPanelProps {
  listingId: string
  /** Drives the explanatory line — a draft is waiting on this paperwork. */
  listingStatus?: string | null
}

export function CompletedDocumentsPanel({ listingId, listingStatus }: CompletedDocumentsPanelProps) {
  const [documents, setDocuments]   = useState<ListingDocumentRow[]>([])
  const [missing, setMissing]       = useState<string[]>([])
  const [warnings, setWarnings]     = useState<string[]>([])
  const [requiredTotal, setRequiredTotal] = useState(0)
  const [presentCount, setPresentCount]   = useState(0)
  const [loading, setLoading]       = useState(true)
  const [uploading, setUploading]   = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await getListingDocumentsAction(listingId)
    if (!res.success) {
      setError(res.error ?? "Could not load this listing's documents.")
    } else {
      setError(null)
      setDocuments(res.documents)
      setMissing(res.missingBlocking)
      setWarnings(res.missingWarning)
      setRequiredTotal(res.requiredTotal)
      setPresentCount(res.presentCount)
    }
    setLoading(false)
  }, [listingId])

  useEffect(() => { void load() }, [load])

  async function handleFile(file: File) {
    setError(null)
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) {
      setError("Upload a PDF or an image of the completed document.")
      return
    }
    setUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      const res = await fetch(`/api/listings/${listingId}/upload-document`, {
        method: "POST",
        body,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.success) {
        setError(json?.error ?? "The document was not uploaded.")
        return
      }
      // The scan runs in the background, so the classification lands a moment
      // after the row does. Reload now for the row, and once more shortly for
      // the verdict — rather than claiming a result we do not have yet.
      await load()
      setTimeout(() => { void load() }, 4000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed.")
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const isDraft = listingStatus === "draft"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Completed documents
        </CardTitle>
        <CardDescription>
          {isDraft
            ? "This listing is a draft. Upload the signed listing agreement and the required seller documents — when every signature, initial and required form is in, the listing is taken on automatically."
            : "Signed and completed paperwork on file for this listing."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploading} className="gap-2">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? "Uploading…" : "Upload completed document"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* The required-document verdict — the same one the gate reaches. */}
        {requiredTotal > 0 && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Required documents
              </p>
              <span className="text-xs text-muted-foreground">{presentCount} of {requiredTotal} on file</span>
            </div>
            {missing.length === 0 ? (
              <p className="text-sm text-emerald-600 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                Every required document is on file.
              </p>
            ) : (
              <div className="space-y-1">
                <p className="text-sm text-destructive">Still needed:</p>
                <div className="flex flex-wrap gap-1">
                  {missing.map((m) => (
                    <Badge key={m} variant="destructive" className="text-xs font-normal">{m}</Badge>
                  ))}
                </div>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                <span className="text-xs text-muted-foreground mr-1">Recommended:</span>
                {warnings.map((w) => (
                  <Badge key={w} variant="outline" className="text-xs font-normal">{w}</Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {loading && documents.length === 0 ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading documents…
          </p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No completed documents yet.
          </p>
        ) : (
          <div className="space-y-2">
            {documents.map((d) => (
              <div key={d.id} className="rounded-lg border p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{d.fileName}</p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {d.scannedAt ? (
                        <Badge variant="secondary" className="text-xs font-normal">{d.classificationLabel}</Badge>
                      ) : d.scanError ? (
                        <Badge variant="outline" className="text-xs font-normal">Could not classify — review manually</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs font-normal">Scanning…</Badge>
                      )}
                      {d.confidence && d.scannedAt && (
                        <span className="text-xs text-muted-foreground">{d.confidence} confidence</span>
                      )}
                    </div>
                  </div>
                  {d.storageUrl && (
                    <Button asChild variant="ghost" size="sm" className="shrink-0">
                      <a href={d.storageUrl} target="_blank" rel="noopener noreferrer">
                        Open <ExternalLink className="h-3.5 w-3.5 ml-1" />
                      </a>
                    </Button>
                  )}
                </div>

                {d.summary && <p className="text-xs text-muted-foreground">{d.summary}</p>}

                {/* Why this agreement has not taken the listing on yet. */}
                {d.gateBlockers.length > 0 && (
                  <div className="text-xs text-amber-700 dark:text-amber-500 space-y-0.5 pt-0.5">
                    {d.gateBlockers.map((b, i) => (
                      <p key={i} className="flex items-start gap-1">
                        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>{b}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
