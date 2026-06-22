"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { ScrollText, Loader2 } from "lucide-react"
import { acknowledgeBuyerCommissionAction } from "@/app/actions/buyer-offer/acknowledge-commission"
import type { CommissionPayer, DisclosureMethod } from "@/lib/offers/commission-disclosure"

/**
 * NAR-2024 buyer commission disclosure acknowledgment (agent-recorded). submit-for-signature
 * hard-blocks until this is recorded, so this is the gate-clearing step in the offer flow.
 * The agent records on the buyer's behalf → method must be a signed method (not click-through).
 */
export function CommissionDisclosureDialog({
  offerId, onDone,
}: {
  offerId: string
  onDone: (r: { ok: boolean; message: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [payer, setPayer] = useState<CommissionPayer>("seller")
  const [mode, setMode] = useState<"pct" | "flat">("pct")
  const [pct, setPct] = useState("")
  const [flat, setFlat] = useState("")
  const [notes, setNotes] = useState("")
  const [method, setMethod] = useState<DisclosureMethod>("wet_signature")
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const r = await acknowledgeBuyerCommissionAction({
        offerId,
        disclosedCommissionPayer: payer,
        disclosedBuyerCommissionPct: mode === "pct" && pct ? Number(pct) : undefined,
        disclosedBuyerCommissionFlat: mode === "flat" && flat ? Number(flat) : undefined,
        disclosedCommissionNotes: notes.trim() || undefined,
        disclosureMethod: method,
        affirmativeConsent: consent,
      })
      if (r.ok) {
        onDone({ ok: true, message: method === "esign"
          ? "Commission disclosure sent to the buyer for e-signature." : "Commission disclosure acknowledged." })
        setOpen(false)
      } else {
        onDone({ ok: false, message: r.error })
      }
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ScrollText className="h-3 w-3 mr-1" />
          Record commission disclosure
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Buyer Commission Disclosure</DialogTitle>
          <DialogDescription>
            NAR 2024: the buyer must acknowledge their agent&apos;s compensation before this offer can be
            sent for signature. Record the disclosed terms below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Who pays the buyer-agent commission?</Label>
            <Select value={payer} onValueChange={(v) => setPayer(v as CommissionPayer)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="seller">Seller</SelectItem>
                <SelectItem value="buyer">Buyer</SelectItem>
                <SelectItem value="split">Split</SelectItem>
                <SelectItem value="either">Either / TBD</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Disclosed commission</Label>
            <div className="flex gap-2">
              <Select value={mode} onValueChange={(v) => setMode(v as "pct" | "flat")}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pct">Percent</SelectItem>
                  <SelectItem value="flat">Flat $</SelectItem>
                </SelectContent>
              </Select>
              {mode === "pct" ? (
                <Input type="number" step="0.01" placeholder="2.5" value={pct} onChange={(e) => setPct(e.target.value)} />
              ) : (
                <Input type="number" step="100" placeholder="10000" value={flat} onChange={(e) => setFlat(e.target.value)} />
              )}
            </div>
          </div>
          <div className="space-y-1">
            <Label>How is it being recorded?</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as DisclosureMethod)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="wet_signature">Wet signature (on file)</SelectItem>
                <SelectItem value="esign">Send for e-signature</SelectItem>
              </SelectContent>
            </Select>
            {method === "esign" && (
              <p className="text-xs text-muted-foreground">
                Uses your brokerage&apos;s connected e-sign provider (resolved automatically).
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cd-notes">Notes (optional)</Label>
            <Textarea id="cd-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. seller offering 2.5%, buyer covers any shortfall" />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={consent} onCheckedChange={(c) => setConsent(c === true)} />
            <span>The buyer has reviewed and affirmatively acknowledges these commission terms.</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !consent}>
            {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {method === "esign" ? "Send for E-Signature" : "Record Acknowledgment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
