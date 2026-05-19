"use client"

/**
 * SendBuyerIntakeButton — drop-in CRM contact action that creates a secure
 * intake token + opens a share sheet with the URL the buyer can use to
 * self-serve their legal name + DL upload + funds info.
 *
 * Calls POST /api/workflow/buyer-intake/create.
 *
 * PURELY ADDITIVE — designed to slot anywhere in the CRM contact view
 * without affecting other actions.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Loader2, ShieldCheck, Copy, Check, ExternalLink } from "lucide-react"

interface Props {
  contactId:    string
  contactName?: string | null
  contactEmail?: string | null
  /** Render style — 'button' (default) or 'icon' (compact, for crowded toolbars) */
  variant?: "button" | "icon"
}

export default function SendBuyerIntakeButton({ contactId, contactName, contactEmail, variant = "button" }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [intakeUrl, setIntakeUrl] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function createLink() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/workflow/buyer-intake/create", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contactId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? "Could not create intake link")
        return
      }
      const json = await res.json() as { intakeUrl: string; expiresAt: string }
      setIntakeUrl(json.intakeUrl)
      setExpiresAt(json.expiresAt)
    } finally {
      setBusy(false)
    }
  }

  function handleOpen() {
    setOpen(true)
    setIntakeUrl(null)
    setError(null)
    setCopied(false)
    void createLink()
  }

  async function handleCopy() {
    if (!intakeUrl) return
    try {
      await navigator.clipboard.writeText(intakeUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard may be denied */ }
  }

  function buildSmsUrl() {
    if (!intakeUrl) return "#"
    const text = `Hi ${contactName ?? ""}, please complete this quick intake form so I can draft offers on your behalf: ${intakeUrl}`
    return `sms:?&body=${encodeURIComponent(text)}`
  }

  function buildMailtoUrl() {
    if (!intakeUrl || !contactEmail) return "#"
    const subject = "Quick intake form from your agent"
    const body = `Hi ${contactName ?? "there"},\n\nBefore we draft any offers, I need to capture a few details. Please use this secure link (it takes about 2 minutes):\n\n${intakeUrl}\n\nThe link expires in 14 days.\n\nThanks!`
    return `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  return (
    <>
      {variant === "icon" ? (
        <Button size="icon" variant="ghost" title="Send buyer intake link" onClick={handleOpen}>
          <ShieldCheck className="h-4 w-4" />
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={handleOpen} className="gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          Send Intake Link
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Buyer Self-Serve Intake
            </DialogTitle>
            <DialogDescription>
              Send {contactName ?? "your buyer"} a secure link to confirm their legal name (with DL upload) and funds source.
              The link expires in 14 days. We'll auto-update their contact record once they submit.
            </DialogDescription>
          </DialogHeader>

          {busy && (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Creating secure link…
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {intakeUrl && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input value={intakeUrl} readOnly className="font-mono text-xs" />
                <Button onClick={handleCopy} size="sm" variant="outline" className="shrink-0">
                  {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button asChild variant="outline">
                  <a href={buildSmsUrl()}>SMS to buyer</a>
                </Button>
                <Button asChild variant="outline" disabled={!contactEmail}>
                  <a href={buildMailtoUrl()}>Email to buyer</a>
                </Button>
              </div>
              <Button asChild variant="ghost" size="sm" className="w-full gap-1">
                <a href={intakeUrl} target="_blank" rel="noopener noreferrer">
                  Preview the form <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
              {expiresAt && (
                <p className="text-xs text-muted-foreground text-center">
                  Expires {new Date(expiresAt).toLocaleDateString()}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
