"use client"

// The button behind the "Domain record missing" banner.
//
// This page has flagged users whose role requires an `agents` row and who do not
// have one, and told the admin to "edit each flagged user and save to trigger
// automatic repair, or they will be repaired on first login". Neither was true
// from here: ensureAgentContextInPlace only ever heals the CALLER's own account,
// so an admin looking at somebody else's broken account had no way to fix it and
// had to wait for that person to log in. createAgent is the writer that was
// missing its button.
//
// It runs on the service client server-side, because RLS on `agents` is
// `agents_insert_own` — WITH CHECK (user_id = auth.uid()) — which refuses an
// admin creating a record for anybody but themselves. The tenant and role checks
// therefore live in the action and run before the write.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { UserPlus, Loader2 } from "lucide-react"
import { createAgent } from "@/app/actions/agents"

export function CreateAgentRecordButton({
  userId,
  userName,
}: {
  userId: string
  userName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const [licenseNumber, setLicenseNumber] = useState("")
  const [licenseState, setLicenseState] = useState("")
  const [licenseExpiry, setLicenseExpiry] = useState("")
  const [commissionSplit, setCommissionSplit] = useState("")
  const [capAmount, setCapAmount] = useState("")
  const [error, setError] = useState("")
  // The brokerage's auto-provision toggle is honored server-side by createAgent.
  // Whatever it did (or could not do) is reported here — a purchased Twilio
  // number is real money and a failed purchase is not a silent non-event.
  const [phoneNote, setPhoneNote] = useState("")

  const handleCreate = () => {
    setError("")
    setPhoneNote("")
    startTransition(async () => {
      const result = await createAgent({
        user_id: userId,
        license_number: licenseNumber || undefined,
        license_state: licenseState || undefined,
        license_expiry: licenseExpiry || undefined,
        commission_split: commissionSplit ? parseFloat(commissionSplit) : undefined,
        cap_amount: capAmount ? parseFloat(capAmount) : undefined,
      })
      // Read the server's verdict before anything closes. A refusal here is a
      // real outcome — a user in another brokerage, or one who already has a row.
      const refusal = (result as { error?: string }).error
      if ("error" in result && refusal) {
        setError(refusal)
        return
      }
      const prov = (result as { phoneProvisioning?: { phoneNumber?: string; error?: string } })
        .phoneProvisioning
      if (prov?.error) {
        // The agent row IS created — keep the dialog open only long enough to
        // say what did not happen, rather than reporting a clean success.
        setPhoneNote(prov.error)
        router.refresh()
        return
      }
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="bg-transparent"
        onClick={() => setOpen(true)}
      >
        <UserPlus className="w-3.5 h-3.5 mr-1.5" />
        Create agent record
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create agent record</DialogTitle>
            <DialogDescription>
              Provision the missing <code>agents</code> row for {userName}. Everything below is
              optional and can be edited later — the record itself is what unblocks their deals,
              contacts and commissions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>License number</Label>
                <Input value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>License state</Label>
                <Input
                  value={licenseState}
                  onChange={(e) => setLicenseState(e.target.value)}
                  placeholder="e.g., TX"
                  maxLength={2}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>License expiry</Label>
              <Input type="date" value={licenseExpiry} onChange={(e) => setLicenseExpiry(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Commission split (%)</Label>
                <Input
                  type="number"
                  value={commissionSplit}
                  onChange={(e) => setCommissionSplit(e.target.value)}
                  placeholder="70"
                />
              </div>
              <div className="space-y-2">
                <Label>Cap amount ($)</Label>
                <Input
                  type="number"
                  value={capAmount}
                  onChange={(e) => setCapAmount(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {phoneNote && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                {phoneNote}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="bg-transparent"
              onClick={() => {
                setOpen(false)
                setError("")
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isPending}>
              {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Create record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
