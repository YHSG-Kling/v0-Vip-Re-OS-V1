"use client"

// app/dashboard/admin/privacy/requests/dsar-row-actions.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The DSAR queue was a READ-ONLY table: a brokerage could watch the 45-day CCPA
// clock run out but had no way to answer a request from the product. The three
// fulfillment capabilities existed as server actions with no caller. This is the
// surface for them.
//
// ORDER IS THE POINT. "Export" only appears once identity_verified is true —
// the server refuses an unverified export regardless, and this mirrors that
// refusal in the UI so the operator is never invited to try it. Every button
// reads the server's verdict before it claims anything; none of them close on
// an unread promise.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { BadgeCheck, Download, Ban, Eraser, Loader2 } from "lucide-react"
import {
  verifyDSARIdentityAction,
  fulfillExportRequestAction,
  fulfillDeleteRequestAction,
  denyDSARRequestAction,
  type DSARIdentityMethod,
} from "@/app/actions/privacy/data-subject-requests"

const IDENTITY_METHODS: Array<{ value: DSARIdentityMethod; label: string; hint: string }> = [
  { value: "matching_user",  label: "Matching account",     hint: "The email matches a signed-in account we control." },
  { value: "magic_link",     label: "Emailed magic link",   hint: "The subject proved control of the email address." },
  { value: "driver_license", label: "Government ID",        hint: "A photo ID was reviewed against the record." },
  { value: "manual_review",  label: "Manual review",        hint: "Verified by other means — describe in your records." },
]

// The request types fulfillExportRequestAction will answer. delete / opt_out_*
// route to their own fulfillment action, so the button is not offered for them.
const EXPORTABLE = new Set(["export", "access", "portability", "correction"])
// ERASURE — the fourth capability. The header above said "the three fulfillment
// capabilities existed as server actions with no caller"; there were FOUR, and
// fulfillDeleteRequestAction (data-subject-requests.ts:553) was the one still
// without a surface. A brokerage could watch the 45-day CCPA clock run out on a
// deletion request with no way to answer it from the product. 'delete' is the
// live request_type CHECK value (scripts/check-vocabularies.ts).
const ERASABLE = new Set(["delete"])
const OPEN_STATUSES = new Set(["received", "in_progress"])

export interface DSARRowActionsProps {
  requestId:         string
  subjectEmail:      string
  requestType:       string
  status:            string
  identityVerified:  boolean
}

export function DSARRowActions({
  requestId, subjectEmail, requestType, status, identityVerified,
}: DSARRowActionsProps) {
  const router = useRouter()

  const [verifyOpen, setVerifyOpen] = useState(false)
  const [method, setMethod] = useState<DSARIdentityMethod>("matching_user")
  const [verifying, setVerifying] = useState(false)

  const [denyOpen, setDenyOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [denying, setDenying] = useState(false)

  const [exporting, setExporting] = useState(false)

  const [eraseOpen, setEraseOpen] = useState(false)
  const [erasing, setErasing] = useState(false)

  const isOpen = OPEN_STATUSES.has(status)

  if (!isOpen) {
    return <span className="text-xs text-muted-foreground">Closed</span>
  }

  async function handleVerify() {
    setVerifying(true)
    try {
      const res = await verifyDSARIdentityAction({ requestId, method })
      // Read the verdict. A silent close here is how an unverified subject ends
      // up looking verified in the queue.
      if (!res.ok) {
        toast.error(res.error ?? "Could not verify identity")
        return
      }
      toast.success(`Identity verified for ${subjectEmail}`)
      setVerifyOpen(false)
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not verify identity")
    } finally {
      setVerifying(false)
    }
  }

  async function handleExport() {
    setExporting(true)
    try {
      const res = await fulfillExportRequestAction(requestId)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      // Hand the operator the artifact. The action returns the bundle inline;
      // this turns it into the file they attach to their response.
      const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `dsar-export-${requestId}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Export bundle generated and downloaded")
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Export failed")
    } finally {
      setExporting(false)
    }
  }

  async function handleErase() {
    setErasing(true)
    try {
      const res = await fulfillDeleteRequestAction(requestId)
      // Read the verdict before claiming anything. The server refuses an
      // unverified erasure (data-subject-requests.ts:565) and refuses another
      // tenant's request outright; a silent close here would report a deletion
      // that never happened on a record with a legal clock on it.
      if (!res.ok) {
        toast.error(res.error ?? "Could not complete the erasure")
        return
      }
      const n = res.contactsAnonymized ?? 0
      toast.success(
        `${n} contact record(s) anonymized. Transaction records retained per state real-estate retention rules.`,
      )
      setEraseOpen(false)
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not complete the erasure")
    } finally {
      setErasing(false)
    }
  }

  async function handleDeny() {
    setDenying(true)
    try {
      const res = await denyDSARRequestAction({ requestId, reason })
      if (!res.ok) {
        toast.error(res.error ?? "Could not deny the request")
        return
      }
      toast.success("Request denied and the lawful basis recorded")
      setDenyOpen(false)
      setReason("")
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not deny the request")
    } finally {
      setDenying(false)
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {!identityVerified && (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setVerifyOpen(true)}>
          <BadgeCheck className="h-3.5 w-3.5" />
          Verify ID
        </Button>
      )}

      {identityVerified && EXPORTABLE.has(requestType) && (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={handleExport} disabled={exporting}>
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Export
        </Button>
      )}

      {identityVerified && ERASABLE.has(requestType) && (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setEraseOpen(true)}>
          <Eraser className="h-3.5 w-3.5" />
          Erase
        </Button>
      )}

      <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-red-600" onClick={() => setDenyOpen(true)}>
        <Ban className="h-3.5 w-3.5" />
        Deny
      </Button>

      {/* ── Verify identity ─────────────────────────────────────────────── */}
      <Dialog open={verifyOpen} onOpenChange={setVerifyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Verify the subject&apos;s identity</DialogTitle>
            <DialogDescription>
              Record how you confirmed that {subjectEmail} is who they say they are.
              No export can be generated until this is done.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Verification method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as DSARIdentityMethod)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {IDENTITY_METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {IDENTITY_METHODS.find((m) => m.value === method)?.hint}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setVerifyOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleVerify} disabled={verifying} className="gap-1.5">
              {verifying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Mark verified
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Deny ────────────────────────────────────────────────────────── */}
      <Dialog open={denyOpen} onOpenChange={setDenyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Deny this request</DialogTitle>
            <DialogDescription>
              A denial must cite a lawful basis (CCPA §1798.145 exemptions, an
              unverifiable requester, a manifestly unfounded or repetitive
              request). This text is retained on the record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Reason (10+ characters)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="Requester could not be verified after two attempts; record retained under state real-estate retention rules."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDenyOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDeny}
              disabled={denying || reason.trim().length < 10}
              className="gap-1.5"
            >
              {denying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Record denial
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Erase (right to be forgotten) ────────────────────────────────── */}
      <Dialog open={eraseOpen} onOpenChange={setEraseOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Erase {subjectEmail}&apos;s personal data</DialogTitle>
            <DialogDescription>
              This anonymizes the contact record in place — names, email, phones,
              address, demographics, financial bands and enrichment data are
              redacted per CCPA §1798.105 / GDPR Art. 17. It cannot be undone.
              Transaction records are retained for NAR and state real-estate
              retention rules (3&ndash;7 years post-close); only the personal data
              is removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEraseOpen(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={handleErase} disabled={erasing} className="gap-1.5">
              {erasing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Erase permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
