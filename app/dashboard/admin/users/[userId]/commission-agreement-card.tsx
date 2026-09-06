"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { FileSignature, CheckCircle2, AlertCircle, Loader2, ExternalLink } from "lucide-react"
import {
  listCommissionAgreementFormsAction,
  getCommissionAgreementStatusAction,
  sendCommissionAgreementAction,
  uploadCommissionAgreementFormAction,
  type CommissionForm,
  type CommissionAgreementStatus,
} from "@/app/actions/admin/commission-agreement"

const STATUS_LABEL: Record<string, string> = {
  pending: "Ready — connect an e-sign provider to send",
  sent: "Sent for signature",
  viewed: "Viewed",
  agent_signed: "Signed by agent",
  fully_signed: "Fully signed",
  voided: "Voided",
  declined: "Declined",
}

export function CommissionAgreementCard({ targetUserId }: { targetUserId: string }) {
  const [forms, setForms] = useState<CommissionForm[]>([])
  const [status, setStatus] = useState<CommissionAgreementStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [formId, setFormId] = useState<string>("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okNote, setOkNote] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function refresh() {
    const [formsRes, statusRes] = await Promise.all([
      listCommissionAgreementFormsAction(),
      getCommissionAgreementStatusAction(targetUserId),
    ])
    // Surface a load failure honestly — never present { ok:false } as an empty
    // "no forms" state (that hides an auth/DB error behind a legitimate-looking UI).
    const failure = !formsRes.ok ? formsRes.error : !statusRes.ok ? statusRes.error : null
    setLoadError(failure)
    if (formsRes.ok) setForms(formsRes.forms)
    if (statusRes.ok) setStatus(statusRes.status)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId])

  const selectedForm = forms.find((f) => f.id === formId) ?? null

  // ── UPLOAD THE BROKERAGE'S OWN TEMPLATE (wave 26) ─────────────────────────
  // uploadCommissionAgreementFormAction has existed and been gated
  // (requireAdmin, path scoped to the caller's own brokerageId) since the rail
  // landed, with no caller. Meanwhile this card's empty state told admins to
  // "Upload your brokerage's form under Admin → Forms" — a surface that does not
  // exist anywhere in app/**. The instruction pointed at nothing, so a brokerage
  // with no template on file had no way to get one. This is the missing half.
  async function handleUpload(file: File) {
    setUploading(true); setError(null); setOkNote(null)
    try {
      // The action takes base64 with no data: prefix.
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ""
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const base64 = btoa(binary)

      const res = await uploadCommissionAgreementFormAction({
        fileName: file.name,
        base64,
        // Named from the file so the picker below has something meaningful to
        // show; the admin renames it in Forms if they want something else.
        formName: file.name.replace(/\.[^.]+$/, "") || "Commission Agreement",
        contractType: "commission_agreement",
      })
      if (!res.ok) { setError(res.error); return }
      setOkNote("Template uploaded. Choose it below to fill and send.")
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.")
    } finally {
      setUploading(false)
    }
  }

  async function handleSend() {
    if (!formId) { setError("Choose a commission agreement form first."); return }
    setSending(true); setError(null); setOkNote(null)
    try {
      const res = await sendCommissionAgreementAction({ targetUserId, formId, fieldValues: values })
      if (!res.ok) { setError(res.error); return }
      // A send can succeed and still need a human (envelope id unsaved, provider
      // unreachable) — show that instead of a flat "Sent".
      if (res.warning) { setError(res.warning) }
      setOkNote(
        res.dispatched
          ? `Sent for signature via ${res.provider}.`
          : "Saved to the agent's profile. Connect an e-sign provider (Settings → Integrations) to send it for signature.",
      )
      setValues({})
      setFormId("")
      await refresh()
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileSignature className="h-4 w-4 text-muted-foreground" />
          Commission Agreement
        </CardTitle>
        <CardDescription className="text-xs">
          Send this agent your brokerage commission agreement for e-signature. The signed copy
          is saved to their profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : loadError ? (
          <p className="text-sm text-red-600 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> Couldn’t load commission agreements: {loadError}
          </p>
        ) : (
          <>
            {/* Current status */}
            {status?.exists && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm">
                <Badge
                  variant="outline"
                  className={
                    status.esignStatus === "fully_signed"
                      ? "border-green-200 bg-green-50 text-green-700"
                      : status.esignStatus === "pending"
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : ""
                  }
                >
                  {STATUS_LABEL[status.esignStatus ?? ""] ?? status.esignStatus}
                </Badge>
                {status.provider && <span className="text-xs text-muted-foreground">via {status.provider}</span>}
                {status.documentUrl && (
                  <a
                    href={status.documentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 inline-flex items-center gap-1 hover:underline ml-auto"
                  >
                    View document <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}

            {/* Send a (new) agreement */}
            {forms.length === 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  No commission agreement forms uploaded yet. Upload your brokerage’s form (PDF)
                  to send it here.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="file"
                    accept="application/pdf"
                    disabled={uploading}
                    className="text-xs"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      // Reset the input so re-picking the same file fires onChange again.
                      e.target.value = ""
                      if (file) void handleUpload(file)
                    }}
                  />
                  {uploading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Form</Label>
                  <Select value={formId} onValueChange={(v) => { setFormId(v); setValues({}) }}>
                    <SelectTrigger><SelectValue placeholder="Choose a commission agreement…" /></SelectTrigger>
                    <SelectContent>
                      {forms.map((f) => (
                        <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedForm && selectedForm.fields.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {selectedForm.fields.map((field) => (
                      <div key={field.key} className="space-y-1.5">
                        <Label htmlFor={`cf-${field.key}`} className="text-xs">
                          {field.label}{field.required ? " *" : ""}
                        </Label>
                        <Input
                          id={`cf-${field.key}`}
                          type={field.type === "number" || field.type === "percent" ? "number" : field.type === "date" ? "date" : "text"}
                          value={values[field.key] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {selectedForm && (
                  <Button onClick={handleSend} disabled={sending} className="gap-1.5">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />}
                    Send for signature
                  </Button>
                )}
              </div>
            )}

            {okNote && (
              <p className="text-sm text-green-700 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" /> {okNote}
              </p>
            )}
            {error && (
              <p className="text-sm text-red-600 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
