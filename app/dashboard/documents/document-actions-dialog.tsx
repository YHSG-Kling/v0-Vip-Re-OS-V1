"use client"

/**
 * PER-DOCUMENT ACTIONS — the surface for the remaining orphaned document
 * capabilities. None of these had a caller anywhere in the app:
 *
 *   aiClassifyDocument        (ai-document-intelligence)  -> client_documents.ai_metadata
 *   aiVerifySignatures        (ai-document-intelligence)  -> ai_metadata (+ SEEDS a null status only)
 *   getDocumentAccessLog      (dotloop-integration)       -> reads document_access_log
 *   sendForDotloopSignature   (dotloop-integration)       -> signature_requests + provider
 *   getDotloopSigningStatus   (dotloop-integration)       -> loop-wide signed/pending counts
 *   getDotloopDocumentStatus  (dotloop-integration)       -> provider activity for this document
 *
 * THE DOTLOOP CONTROLS REPORT THE PROVIDER'S REAL ANSWER. With no Dotloop
 * credentials configured the provider layer returns an explicit
 * "Dotloop credentials not configured" and that string is what the agent sees —
 * this dialog never converts a provider refusal into a green tick.
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Brain, Loader2, PenLine, ScrollText, Trash2, Plus } from "lucide-react"
import {
  getDocumentAccessLog,
  getDocumentSigningContext,
  getDotloopDocumentStatus,
  getDotloopSigningStatus,
  sendForDotloopSignature,
} from "@/app/actions/dotloop-integration"
import type {
  DocumentAccessLogEntry,
  DocumentSigningContext,
} from "@/app/actions/dotloop-integration"
import { aiClassifyDocument, aiVerifySignatures } from "@/app/actions/ai-document-intelligence"

interface Verdict {
  ok: boolean
  headline: string
  detail?: string
}

function VerdictNote({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null
  return (
    <Alert variant={verdict.ok ? "default" : "destructive"} className="mt-2">
      <AlertDescription className="text-xs">
        <span className="font-medium">{verdict.headline}</span>
        {verdict.detail ? <span className="block mt-0.5">{verdict.detail}</span> : null}
      </AlertDescription>
    </Alert>
  )
}

export function DocumentActionsDialog({
  documentId,
  documentName,
}: {
  documentId: string
  documentName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)

  const [context, setContext] = useState<DocumentSigningContext["document"] | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)

  const [classifyVerdict, setClassifyVerdict] = useState<Verdict | null>(null)
  const [classification, setClassification] = useState<any>(null)

  const [verifyVerdict, setVerifyVerdict] = useState<Verdict | null>(null)
  const [verification, setVerification] = useState<any>(null)

  const [log, setLog] = useState<DocumentAccessLogEntry[]>([])
  const [logVerdict, setLogVerdict] = useState<Verdict | null>(null)

  const [loopId, setLoopId] = useState("")
  const [signers, setSigners] = useState<Array<{ name: string; email: string; role: string }>>([])
  const [sendVerdict, setSendVerdict] = useState<Verdict | null>(null)
  const [loopStatus, setLoopStatus] = useState<{
    total: number
    signed: number
    pending: number
    percentComplete: number
  } | null>(null)
  const [activityVerdict, setActivityVerdict] = useState<Verdict | null>(null)
  const [activities, setActivities] = useState<any[]>([])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const res = await getDocumentSigningContext(documentId)
      if (!res.success) {
        setContextError(res.error ?? "Could not load this document.")
        setContext(null)
        return
      }
      setContextError(null)
      setContext(res.document ?? null)
      setLoopId(res.document?.dotloopLoopId ?? "")
      setSigners(res.suggestedSigners)
    })()
  }, [open, documentId])

  const runClassify = () => {
    setBusy("classify")
    setClassifyVerdict(null)
    startTransition(async () => {
      const res = await aiClassifyDocument({ documentId })
      setBusy(null)
      if (!res.success) {
        setClassifyVerdict({ ok: false, headline: res.error ?? "Classification failed." })
        return
      }
      setClassification(res.classification)
      setClassifyVerdict({
        ok: true,
        headline: `Classified as ${res.classification?.documentType} (${Math.round(
          (res.classification?.confidence ?? 0) * 100,
        )}% confidence) and saved to the document.`,
        detail:
          (res.classification?.complianceFlags?.length ?? 0) > 0
            ? `Compliance flags: ${res.classification!.complianceFlags.join("; ")}`
            : undefined,
      })
      router.refresh()
    })
  }

  const runVerify = () => {
    setBusy("verify")
    setVerifyVerdict(null)
    startTransition(async () => {
      const res = await aiVerifySignatures({ documentId })
      setBusy(null)
      if (!res.success) {
        setVerifyVerdict({ ok: false, headline: res.error ?? "Signature check failed." })
        return
      }
      setVerification(res.verification)
      setVerifyVerdict({
        ok: true,
        headline: res.verification?.allSignaturesPresent
          ? "The AI read finds every required signature present."
          : `Missing: ${res.verification?.missingSignatures?.join(", ") || "unspecified"}.`,
        // Says exactly what it did and did NOT do to the provider-owned column.
        detail: res.seededStatus
          ? "This document had no signature status yet, so it is now marked pending signature."
          : `Provider status left untouched (${res.providerStatus ?? "none on file"}). An AI reading never overwrites the provider's verdict.`,
      })
      router.refresh()
    })
  }

  const runLog = () => {
    setBusy("log")
    setLogVerdict(null)
    startTransition(async () => {
      const res = await getDocumentAccessLog(documentId)
      setBusy(null)
      if (!res.success) {
        setLog([])
        setLogVerdict({ ok: false, headline: res.error ?? "Could not read the access log." })
        return
      }
      setLog(res.entries)
      setLogVerdict({
        ok: true,
        headline:
          res.entries.length === 0
            ? "No recorded opens yet. Opens are recorded when the document is opened through the governed link."
            : `${res.entries.length} recorded access event(s).`,
      })
    })
  }

  const runSend = () => {
    setBusy("send")
    setSendVerdict(null)
    startTransition(async () => {
      const res: any = await sendForDotloopSignature({
        loopId,
        documentId,
        signers,
        contactId: context?.contactId ?? undefined,
      })
      setBusy(null)
      if (!res?.success) {
        // The provider's own words. A missing credential says so.
        setSendVerdict({ ok: false, headline: res?.error ?? "Send failed." })
        return
      }
      setSendVerdict({
        ok: true,
        headline: `Sent to ${signers.length} signer(s) on loop ${res.loopId}. A signature packet is now recorded, so the client's Sign button can appear.`,
      })
      router.refresh()
    })
  }

  const runLoopStatus = () => {
    setBusy("loop")
    setActivityVerdict(null)
    startTransition(async () => {
      const [statusRes, activityRes]: any[] = await Promise.all([
        getDotloopSigningStatus(loopId),
        getDotloopDocumentStatus(loopId, documentId),
      ])
      setBusy(null)
      if (statusRes?.success) {
        setLoopStatus({
          total: statusRes.total,
          signed: statusRes.signed,
          pending: statusRes.pending,
          percentComplete: statusRes.percentComplete,
        })
      } else {
        setLoopStatus(null)
      }
      if (activityRes?.success) {
        setActivities(activityRes.activities ?? [])
        setActivityVerdict({
          ok: true,
          headline: `${activityRes.activities?.length ?? 0} signature event(s) from the provider.`,
        })
      } else {
        setActivities([])
        setActivityVerdict({
          ok: false,
          headline: activityRes?.error ?? statusRes?.error ?? "Could not read the loop.",
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <Brain className="h-3 w-3 mr-1" />
          Actions
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{documentName}</DialogTitle>
          <DialogDescription className="text-xs">
            Classify, check signatures, review who opened it, and send it for e-signature.
          </DialogDescription>
        </DialogHeader>

        {contextError ? (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">{contextError}</AlertDescription>
          </Alert>
        ) : null}

        {context ? (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {context.documentType ? <Badge variant="outline">{context.documentType}</Badge> : null}
            {context.docCategory ? <Badge variant="outline">{context.docCategory}</Badge> : null}
            <Badge variant="outline">
              signature: {context.signatureStatus ?? "none"}
              {context.signatureProvider ? ` · ${context.signatureProvider}` : ""}
            </Badge>
          </div>
        ) : null}

        {/* ── AI CLASSIFY ─────────────────────────────────────────────────── */}
        <section className="border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Classify &amp; extract</p>
            <Button size="sm" variant="outline" disabled={pending} onClick={runClassify}>
              {busy === "classify" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Run
            </Button>
          </div>
          <VerdictNote verdict={classifyVerdict} />
          {classification?.missingFields?.length ? (
            <p className="text-xs mt-1">
              Missing fields: {classification.missingFields.join(", ")}
            </p>
          ) : null}
        </section>

        {/* ── SIGNATURE VERIFICATION ──────────────────────────────────────── */}
        <section className="border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <PenLine className="h-3.5 w-3.5" />
              Signature check
            </p>
            <Button size="sm" variant="outline" disabled={pending} onClick={runVerify}>
              {busy === "verify" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Run
            </Button>
          </div>
          <VerdictNote verdict={verifyVerdict} />
          {verification?.requiredSignatures?.length ? (
            <ul className="mt-1 text-xs space-y-0.5">
              {verification.requiredSignatures.map((s: any, i: number) => (
                <li key={i}>
                  {s.signed ? "✓" : "○"} {s.party}
                  {s.signedDate ? ` — ${s.signedDate}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ── ACCESS LOG ──────────────────────────────────────────────────── */}
        <section className="border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <ScrollText className="h-3.5 w-3.5" />
              Who opened this
            </p>
            <Button size="sm" variant="outline" disabled={pending} onClick={runLog}>
              {busy === "log" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Load log
            </Button>
          </div>
          <VerdictNote verdict={logVerdict} />
          {log.length > 0 ? (
            <ul className="mt-1 divide-y border rounded text-xs">
              {log.map((e) => (
                <li key={e.id} className="px-2 py-1 flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px]">
                    {e.accessType ?? "view"}
                  </Badge>
                  <span>{e.accessedByName ?? e.accessedByEmail ?? e.accessedByType ?? "unknown"}</span>
                  <span className="text-muted-foreground">
                    {e.accessedAt ? new Date(e.accessedAt).toLocaleString() : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ── E-SIGNATURE ─────────────────────────────────────────────────── */}
        <section className="border-t pt-3">
          <p className="text-sm font-medium">Send for e-signature (Dotloop)</p>
          <p className="text-xs text-muted-foreground">
            Requires the Dotloop loop this document belongs to. The loop id is pre-filled when the
            document is already linked.
          </p>

          <div className="mt-2 space-y-2">
            <div>
              <Label className="text-xs">Loop ID</Label>
              <Input
                className="h-8 text-xs"
                value={loopId}
                onChange={(e) => setLoopId(e.target.value)}
                placeholder="Dotloop loop id"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Signers</Label>
              {signers.map((s, i) => (
                <div key={i} className="flex gap-1.5 items-center">
                  <Input
                    className="h-7 text-xs"
                    value={s.name}
                    placeholder="Name"
                    onChange={(e) =>
                      setSigners((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)),
                      )
                    }
                  />
                  <Input
                    className="h-7 text-xs"
                    value={s.email}
                    placeholder="Email"
                    onChange={(e) =>
                      setSigners((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, email: e.target.value } : p)),
                      )
                    }
                  />
                  <Input
                    className="h-7 text-xs w-24"
                    value={s.role}
                    placeholder="Role"
                    onChange={(e) =>
                      setSigners((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, role: e.target.value } : p)),
                      )
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setSigners((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setSigners((prev) => [...prev, { name: "", email: "", role: "client" }])}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add signer
              </Button>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending || !loopId.trim() || signers.length === 0}
                onClick={runSend}
              >
                {busy === "send" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                Send for signature
              </Button>
              <Button size="sm" variant="outline" disabled={pending || !loopId.trim()} onClick={runLoopStatus}>
                {busy === "loop" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                Check loop status
              </Button>
            </div>

            <VerdictNote verdict={sendVerdict} />

            {loopStatus ? (
              <p className="text-xs">
                Loop: <b>{loopStatus.signed}</b> of <b>{loopStatus.total}</b> documents signed (
                {loopStatus.percentComplete}%), {loopStatus.pending} pending.
              </p>
            ) : null}
            <VerdictNote verdict={activityVerdict} />
            {activities.length > 0 ? (
              <ul className="text-xs list-disc pl-4">
                {activities.slice(0, 8).map((a, i) => (
                  <li key={i}>
                    {a.activity_type} — {a.created_at ?? a.timestamp ?? ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
