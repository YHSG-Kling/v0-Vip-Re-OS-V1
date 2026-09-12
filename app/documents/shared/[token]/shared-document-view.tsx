"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FileText, Lock, ExternalLink, ShieldCheck, Clock, AlertTriangle } from "lucide-react"
import { accessSharedDocument, type SharedDocumentResult } from "@/app/actions/dotloop-integration"
import { getGovernedDocumentUrl } from "@/app/actions/document-center"

/**
 * Viewer for a team-shared document.
 *
 * The document body is NEVER fetched here. The file lives in a PRIVATE bucket,
 * so opening it goes back through getGovernedDocumentUrl, which re-checks the
 * viewer's brokerage server-side and mints a short-lived signed URL. A client
 * that skipped this component entirely would still get nothing.
 */
export function SharedDocumentView({
  token,
  initial,
}: {
  token: string
  initial: SharedDocumentResult
}) {
  const [state, setState] = useState<SharedDocumentResult>(initial)
  const [password, setPassword] = useState("")
  const [pending, startTransition] = useTransition()
  const [openError, setOpenError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const next = await accessSharedDocument(token, password)
      setState(next)
      if (next.success) setPassword("")
    })
  }

  async function openDocument() {
    if (!state.document) return
    setOpening(true)
    setOpenError(null)
    const res = await getGovernedDocumentUrl(
      state.document.id,
      state.accessLevel === "download" ? "download" : "view",
    )
    setOpening(false)
    if (res.success && res.url) {
      window.open(res.url, "_blank", "noopener,noreferrer")
    } else {
      setOpenError(res.error ?? "Could not open this document.")
    }
  }

  // ── Refused after an interactive attempt (expired, cap reached, revoked) ──
  if (!state.success && !state.passwordRequired) {
    return (
      <div className="max-w-md mx-auto p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <h1 className="text-lg font-semibold text-red-900">Document unavailable</h1>
          <p className="mt-2 text-sm text-red-800">{state.error}</p>
          <Link
            href="/dashboard/documents"
            className="mt-4 inline-block text-sm text-red-900 underline"
          >
            Back to Document Center
          </Link>
        </div>
      </div>
    )
  }

  // ── Password gate ─────────────────────────────────────────────────────────
  if (!state.success) {
    return (
      <div className="max-w-md mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4" />
              Password required
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitPassword} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="share-password" className="text-xs">
                  Share password
                </Label>
                <Input
                  id="share-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter the password you were given"
                />
              </div>
              {state.error?.startsWith("Incorrect") && (
                <p className="text-xs text-red-600">{state.error}</p>
              )}
              <Button type="submit" size="sm" disabled={pending || password.length === 0}>
                {pending ? "Checking…" : "Open document"}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                A wrong password does not count against this link&apos;s open limit.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Granted ───────────────────────────────────────────────────────────────
  const doc = state.document!
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
        Shared with your brokerage
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-start gap-2">
            <FileText className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
            <span className="min-w-0 break-words">{doc.documentName}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">Type</dt>
              <dd className="font-medium capitalize">
                {doc.documentType?.replace(/_/g, " ") ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Access level</dt>
              <dd className="font-medium capitalize">{state.accessLevel}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Link expires</dt>
              <dd className="font-medium">
                {state.expiresAt ? new Date(state.expiresAt).toLocaleString() : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Opens remaining</dt>
              <dd className="font-medium">
                {state.accessesRemaining == null ? "Unlimited" : state.accessesRemaining}
              </dd>
            </div>
          </dl>

          {state.accessesRemaining === 0 && (
            <p className="text-xs text-amber-700 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
              This was the last permitted open — the link will refuse the next one.
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={openDocument} disabled={opening}>
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              {opening ? "Preparing…" : state.accessLevel === "download" ? "Download" : "Open document"}
            </Button>
            <Link href="/dashboard/documents" className="text-xs text-blue-600 hover:underline">
              Document Center
            </Link>
          </div>

          {openError && <p className="text-xs text-red-600">{openError}</p>}

          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <Clock className="h-3 w-3 mt-px shrink-0" />
            Opening mints a short-lived signed URL and records the access against your account.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
