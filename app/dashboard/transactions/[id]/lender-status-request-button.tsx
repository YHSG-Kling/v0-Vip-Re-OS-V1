"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { MailQuestion, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { requestLenderStatusUpdateAction } from "@/app/actions/lender-status-request"
import { REQUESTABLE_ITEMS, ITEM_LABEL, type RequestableItem } from "@/lib/lenders/status-request-items"

/**
 * Agent → loan-officer "request a status update". B2B-transactional: the action is on the
 * egress-send-guard allowlist (gated-inline) and asks the lender to log into the existing
 * lender portal to update the loan — it does not reach a consumer.
 */
export function LenderStatusRequestButton({ transactionId }: { transactionId: string }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<RequestableItem[]>(["clear_to_close_eta"])
  const [note, setNote] = useState("")
  const [channel, setChannel] = useState<"email" | "sms" | "both">("email")
  const [busy, setBusy] = useState(false)

  function toggle(i: RequestableItem) {
    setItems((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))
  }

  async function submit() {
    if (items.length === 0) { toast({ title: "Pick at least one item", variant: "destructive" }); return }
    setBusy(true)
    try {
      const r = await requestLenderStatusUpdateAction({ transactionId, items, note: note.trim() || undefined, channel })
      if (r.success) {
        toast({ title: "Status request sent to the lender", description: "They'll update the loan via the lender portal." })
        setOpen(false)
      } else {
        const why: Record<string, string> = {
          no_lender_contact_on_file: "No loan-officer email/phone on file for this transaction.",
          transaction_not_found: "Transaction not found.",
          no_items: "Pick at least one item.",
          unauthenticated: "Please sign in again.",
        }
        toast({ title: "Could not send request", description: why[r.error] ?? r.error, variant: "destructive" })
      }
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="w-full">
          <MailQuestion className="h-4 w-4 mr-1" />Request Status Update
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a Loan Status Update</DialogTitle>
          <DialogDescription>Ask the loan officer to update the items below via the lender portal.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>What do you need?</Label>
            {REQUESTABLE_ITEMS.map((i) => (
              <label key={i} className="flex items-center gap-2 text-sm capitalize">
                <Checkbox checked={items.includes(i)} onCheckedChange={() => toggle(i)} />
                {ITEM_LABEL[i]}
              </label>
            ))}
          </div>
          <div className="space-y-1">
            <Label>Channel</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as "email" | "sms" | "both")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="sms">SMS</SelectItem>
                <SelectItem value="both">Email + SMS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lsr-note">Note (optional)</Label>
            <Textarea id="lsr-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. closing is Friday — need the CTC ETA today" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Send Request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
