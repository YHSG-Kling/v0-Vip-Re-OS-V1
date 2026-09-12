"use client"

/**
 * BuyerIntakeForm — client component for /buyer-intake/[token].
 *
 * Three states:
 *   - submitted/expired/cancelled  → status panel, no form
 *   - pending                       → 3-step form (legal name → DL upload → funds)
 *
 * Uploads go through /api/workflow/buyer-intake/upload (token-authed,
 * server-side Vercel Blob put). Final submit hits
 * /api/workflow/buyer-intake/submit which updates the contact record.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Check, AlertCircle, Upload, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type TokenStatus = "pending" | "submitted" | "expired" | "cancelled"

interface Props {
  token:            string
  status:           TokenStatus
  expiresAt:        string
  /** buyer_intake_tokens.submitted_at — WHEN this buyer's intake was received.
   *  Null on a token that has not been submitted, and null on rows written before
   *  the stamp existed; the panel then says "on file" with no date rather than
   *  inventing one. */
  submittedAt?:     string | null
  /** buyer_intake_tokens.submitted_data — the snapshot of what this buyer typed,
   *  shown back to them as a receipt. Null before submission and on rows written
   *  before the column was populated. */
  submittedData?:   Record<string, unknown> | null
  contactFirstName: string | null
  contactEmail:     string | null
}

interface UploadedDoc {
  url:  string
  kind: "dl" | "pre_approval" | "pof"
}

export default function BuyerIntakeForm({
  token, status, expiresAt, submittedAt = null, submittedData = null, contactFirstName, contactEmail,
}: Props) {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(status === "submitted")

  const [legalFirstName, setLegalFirstName] = useState("")
  const [legalMiddleName, setLegalMiddleName] = useState("")
  const [legalLastName, setLegalLastName] = useState("")
  const [dlImage, setDlImage] = useState<UploadedDoc | null>(null)
  const [fundsSourceType, setFundsSourceType] = useState<"pre_approval" | "pof" | "mixed" | "">("")
  const [fundsMaxPurchase, setFundsMaxPurchase] = useState<string>("")
  const [preApprovalDoc, setPreApprovalDoc] = useState<UploadedDoc | null>(null)
  const [pofDoc, setPofDoc] = useState<UploadedDoc | null>(null)

  // The received-on line, or null. An unparseable stamp yields null rather than
  // "Invalid Date" on a buyer-facing confirmation.
  const receivedDate = submittedAt ? new Date(submittedAt) : null
  const receivedLabel =
    receivedDate && !Number.isNaN(receivedDate.getTime())
      ? receivedDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : null

  // THE RECEIPT, read off submitted_data. Only the keys the submit route actually
  // writes are rendered, each with the label the form used — an unknown key is
  // ignored rather than dumped as raw JSON at a buyer.
  const receipt: Array<{ label: string; value: string }> = (() => {
    const d = submittedData
    if (!d) return []
    const out: Array<{ label: string; value: string }> = []
    const name = [d.legalFirstName, d.legalMiddleName, d.legalLastName]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(" ")
    if (name) out.push({ label: "Legal name", value: name })
    const FUNDS_LABEL: Record<string, string> = {
      pre_approval: "Financing (pre-approval)",
      pof: "Cash (proof of funds)",
      mixed: "Financing and cash",
    }
    if (typeof d.fundsSourceType === "string" && FUNDS_LABEL[d.fundsSourceType]) {
      out.push({ label: "Funds source", value: FUNDS_LABEL[d.fundsSourceType] })
    }
    if (typeof d.fundsMaxPurchase === "number" && Number.isFinite(d.fundsMaxPurchase)) {
      out.push({
        label: "Maximum purchase",
        value: `$${Math.round(d.fundsMaxPurchase).toLocaleString()}`,
      })
    }
    return out
  })()

  // ── Status panels ────────────────────────────────────────────────────────
  if (status === "expired" || new Date(expiresAt) < new Date()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-amber-600 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Link expired
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This intake link has expired. Please reach out to your agent to receive a fresh link.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (submitted || status === "submitted") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-emerald-600 flex items-center gap-2">
            <Check className="h-4 w-4" />
            All set
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            Thanks{contactFirstName ? `, ${contactFirstName}` : ""}. Your information is on file with your agent
            {receivedLabel ? `, received ${receivedLabel}` : ""}.
          </p>
          {receipt.length > 0 && (
            <dl className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              {receipt.map((r) => (
                <div key={r.label} className="flex justify-between gap-4 py-0.5">
                  <dt className="text-muted-foreground">{r.label}</dt>
                  <dd className="font-medium text-right">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="text-sm text-muted-foreground">
            You can close this page. Your agent will reach out with next steps.
            {receipt.length > 0 && " If anything above is wrong, reply to your agent and they'll correct it."}
          </p>
        </CardContent>
      </Card>
    )
  }

  if (status === "cancelled") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-slate-600">Link no longer active</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your agent cancelled this intake link. Please contact them directly if you need to provide info.
          </p>
        </CardContent>
      </Card>
    )
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  async function uploadFile(file: File, kind: "dl" | "pre_approval" | "pof"): Promise<UploadedDoc | null> {
    setError(null)
    const fd = new FormData()
    fd.append("token", token)
    fd.append("kind", kind)
    fd.append("file", file)
    const res = await fetch("/api/workflow/buyer-intake/upload", { method: "POST", body: fd })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? "Upload failed")
      return null
    }
    const json = await res.json() as { url: string; kind: typeof kind }
    return { url: json.url, kind }
  }

  async function handleFinalSubmit() {
    if (!dlImage) { setError("Driver's license photo required"); return }
    if (!legalFirstName.trim() || !legalLastName.trim()) {
      setError("Legal first + last name are required")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/workflow/buyer-intake/submit", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          legalFirstName,
          legalMiddleName: legalMiddleName.trim() || undefined,
          legalLastName,
          dlImageBlobUrl:    dlImage.url,
          fundsSourceType:   fundsSourceType || undefined,
          fundsMaxPurchase:  fundsMaxPurchase ? Number(fundsMaxPurchase) : undefined,
          preApprovalDocUrl: preApprovalDoc?.url,
          pofDocUrl:         pofDoc?.url,
          emailVerified:     contactEmail ?? undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? "Submit failed")
        return
      }
      setSubmitted(true)
    } finally {
      setBusy(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          Quick secure intake
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Step {step} of 3 — your data is encrypted and only visible to your agent.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* ── Step 1: legal name ──────────────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Your legal name (as it appears on your driver's license)</p>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label htmlFor="firstName">First *</Label>
                <Input id="firstName" value={legalFirstName} onChange={e => setLegalFirstName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="middleName">Middle</Label>
                <Input id="middleName" value={legalMiddleName} onChange={e => setLegalMiddleName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="lastName">Last *</Label>
                <Input id="lastName" value={legalLastName} onChange={e => setLegalLastName(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Real estate contracts use your exact legal name. Even if you go by a nickname, please use the
              name printed on your driver's license.
            </p>
          </div>
        )}

        {/* ── Step 2: DL upload ────────────────────────────────────────────── */}
        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Driver's license photo</p>
            <p className="text-xs text-muted-foreground">
              Upload a photo of the front of your driver's license. We'll use it to verify your legal name.
            </p>
            <FileDropzone
              accept="image/*"
              currentDoc={dlImage}
              onUpload={async file => {
                const result = await uploadFile(file, "dl")
                if (result) setDlImage(result)
              }}
              label="Tap to upload DL photo"
            />
          </div>
        )}

        {/* ── Step 3: funds + optional docs ───────────────────────────────── */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fundsSource">How are you funding the purchase?</Label>
              <Select value={fundsSourceType} onValueChange={v => setFundsSourceType(v as typeof fundsSourceType)}>
                <SelectTrigger id="fundsSource">
                  <SelectValue placeholder="Select funding source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pre_approval">Loan pre-approval</SelectItem>
                  <SelectItem value="pof">All cash (proof of funds)</SelectItem>
                  <SelectItem value="mixed">Mix of cash + financing</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxPurchase">Maximum purchase price you're approved for</Label>
              <Input
                id="maxPurchase"
                type="number"
                inputMode="decimal"
                placeholder="e.g. 750000"
                value={fundsMaxPurchase}
                onChange={e => setFundsMaxPurchase(e.target.value)}
              />
            </div>

            {(fundsSourceType === "pre_approval" || fundsSourceType === "mixed") && (
              <div className="space-y-2">
                <Label>Pre-approval letter (PDF)</Label>
                <FileDropzone
                  accept="application/pdf"
                  currentDoc={preApprovalDoc}
                  onUpload={async file => {
                    const result = await uploadFile(file, "pre_approval")
                    if (result) setPreApprovalDoc(result)
                  }}
                  label="Tap to upload pre-approval"
                />
              </div>
            )}

            {(fundsSourceType === "pof" || fundsSourceType === "mixed") && (
              <div className="space-y-2">
                <Label>Proof of funds (PDF)</Label>
                <FileDropzone
                  accept="application/pdf"
                  currentDoc={pofDoc}
                  onUpload={async file => {
                    const result = await uploadFile(file, "pof")
                    if (result) setPofDoc(result)
                  }}
                  label="Tap to upload POF"
                />
              </div>
            )}
          </div>
        )}

        {/* ── Footer buttons ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between pt-3">
          <Button
            variant="outline"
            onClick={() => setStep(s => Math.max(1, s - 1))}
            disabled={step === 1 || busy}
          >
            Back
          </Button>
          {step < 3 ? (
            <Button
              onClick={() => setStep(s => s + 1)}
              disabled={
                busy ||
                (step === 1 && (!legalFirstName.trim() || !legalLastName.trim())) ||
                (step === 2 && !dlImage)
              }
            >
              Continue
            </Button>
          ) : (
            <Button onClick={handleFinalSubmit} disabled={busy || !dlImage}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── File dropzone ──────────────────────────────────────────────────────────

function FileDropzone({
  accept, currentDoc, onUpload, label,
}: {
  accept:     string
  currentDoc: UploadedDoc | null
  onUpload:   (file: File) => Promise<void> | void
  label:      string
}) {
  const [uploading, setUploading] = useState(false)

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      await onUpload(file)
    } finally {
      setUploading(false)
    }
  }

  return (
    <label className={`
      flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer
      transition-colors hover:bg-muted/40
      ${currentDoc ? "border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-slate-300 dark:border-slate-700"}
    `}>
      <input type="file" accept={accept} className="sr-only" onChange={handleChange} />
      {uploading ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
          <span className="text-sm text-slate-500">Uploading…</span>
        </>
      ) : currentDoc ? (
        <>
          <Check className="h-5 w-5 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Uploaded — tap to replace</span>
        </>
      ) : (
        <>
          <Upload className="h-5 w-5 text-slate-500" />
          <span className="text-sm text-slate-700 dark:text-slate-300">{label}</span>
          <span className="text-xs text-muted-foreground">JPG, PNG, or PDF, up to 8 MB</span>
        </>
      )}
    </label>
  )
}
