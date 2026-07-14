"use client"

/**
 * VENDOR REQUEST DIALOG — the vendor's structured "I need something from the
 * deal team" (owner rule: vendors act on their owned area of the transaction).
 * One form → the agent gets a due-dated task; if the ask is really for the
 * client, a GATED draft rides the agent's approval rail — the vendor never
 * messages a client directly.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Loader2, CheckCircle2 } from "lucide-react"
import { submitVendorTransactionRequest } from "@/app/actions/vendor-requests"
import { VENDOR_REQUEST_TYPES } from "@/lib/kernel/vendor-request"

export function VendorRequestDialog(props: {
  vendorId: string
  transactionId: string
  propertyAddress?: string | null
  onClose: () => void
}) {
  const [requestType, setRequestType] = useState<string>("document")
  const [details, setDetails] = useState("")
  const [neededBy, setNeededBy] = useState("")
  const [askClient, setAskClient] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const r = await submitVendorTransactionRequest({
        vendorId: props.vendorId,
        transactionId: props.transactionId,
        requestType,
        details,
        neededBy: neededBy || null,
        askClient,
      })
      if (r.success) setDone(true)
      else setError(r.error ?? "Request failed")
    })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Request from the deal team{props.propertyAddress ? ` — ${props.propertyAddress}` : ""}
          </DialogTitle>
        </DialogHeader>
        {done ? (
          <div className="py-6 text-center space-y-2">
            <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto" />
            <p className="text-sm">
              Request sent — the agent has a task for it{askClient ? " and a client message is queued for their approval" : ""}.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>What do you need?</Label>
              <Select value={requestType} onValueChange={setRequestType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(VENDOR_REQUEST_TYPES).map(([k, label]) => (
                    <SelectItem key={k} value={k}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Details</Label>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                placeholder='e.g. "Need utilities on and the lockbox code for Thursday inspection"'
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Needed by (optional)</Label>
              <input
                type="date"
                value={neededBy}
                onChange={(e) => setNeededBy(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={askClient} onChange={(e) => setAskClient(e.target.checked)} />
              This needs the client — draft them a message (the agent approves it first)
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {done ? (
            <Button onClick={props.onClose}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={props.onClose}>Cancel</Button>
              <Button onClick={submit} disabled={pending || details.trim().length < 10}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send request"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
