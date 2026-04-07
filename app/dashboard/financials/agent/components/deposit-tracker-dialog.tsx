"use client"

import { useState, useTransition } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Landmark, Loader2 } from "lucide-react"
import { trackDeposit } from "@/app/actions/ai-financial-management"
import { useToast } from "@/hooks/use-toast"

interface DepositTrackerDialogProps {
  agentId: string
  transactionId: string
  propertyAddress?: string
  trigger?: React.ReactNode
}

export function DepositTrackerDialog({
  agentId,
  transactionId,
  propertyAddress,
  trigger,
}: DepositTrackerDialogProps) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    amount: "",
    depositType: "earnest_money" as "earnest_money" | "option_fee" | "additional_deposit",
    receivedDate: new Date().toISOString().split("T")[0],
    dueDate: "",
    escrowCompany: "",
    checkNumber: "",
    notes: "",
  })
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  function handleSubmit() {
    if (!form.amount || !form.receivedDate) {
      toast({
        title: "Missing fields",
        description: "Amount and received date are required.",
        variant: "destructive",
      })
      return
    }

    startTransition(async () => {
      try {
        const result = await trackDeposit({
          agentId,
          transactionId,
          amount: parseFloat(form.amount),
          depositType: form.depositType,
          receivedDate: form.receivedDate,
          dueDate: form.dueDate || undefined,
          escrowCompany: form.escrowCompany || undefined,
          checkNumber: form.checkNumber || undefined,
          notes: form.notes || undefined,
        })

        if (result.success) {
          toast({ title: "Deposit recorded", description: "Compliance task created for escrow delivery." })
          setOpen(false)
          setForm({
            amount: "",
            depositType: "earnest_money",
            receivedDate: new Date().toISOString().split("T")[0],
            dueDate: "",
            escrowCompany: "",
            checkNumber: "",
            notes: "",
          })
        } else {
          toast({ title: "Error", description: (result as any).error || "Failed to record deposit.", variant: "destructive" })
        }
      } catch (e: any) {
        toast({ title: "Error", description: e.message || "Failed to record deposit.", variant: "destructive" })
      }
    })
  }

  const depositTypeLabels = {
    earnest_money: "Earnest Money",
    option_fee: "Option Fee",
    additional_deposit: "Additional Deposit",
  }

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)} className="cursor-pointer">
          {trigger}
        </span>
      ) : (
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs h-7" onClick={() => setOpen(true)}>
          <Landmark className="h-3.5 w-3.5" />
          Track Deposit
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Track Deposit</DialogTitle>
            <DialogDescription>
              {propertyAddress
                ? `Record a deposit for ${propertyAddress}`
                : "Record a deposit for this transaction"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="deposit-amount">Amount ($)</Label>
                <Input
                  id="deposit-amount"
                  type="number"
                  placeholder="5000"
                  value={form.amount}
                  onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="deposit-type">Deposit Type</Label>
                <Select
                  value={form.depositType}
                  onValueChange={(v) =>
                    setForm((p) => ({ ...p, depositType: v as typeof form.depositType }))
                  }
                >
                  <SelectTrigger id="deposit-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(depositTypeLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="received-date">Received Date</Label>
                <Input
                  id="received-date"
                  type="date"
                  value={form.receivedDate}
                  onChange={(e) => setForm((p) => ({ ...p, receivedDate: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="due-date">Escrow Due Date</Label>
                <Input
                  id="due-date"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="escrow-company">Escrow Company</Label>
                <Input
                  id="escrow-company"
                  placeholder="Optional"
                  value={form.escrowCompany}
                  onChange={(e) => setForm((p) => ({ ...p, escrowCompany: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="check-number">Check Number</Label>
                <Input
                  id="check-number"
                  placeholder="Optional"
                  value={form.checkNumber}
                  onChange={(e) => setForm((p) => ({ ...p, checkNumber: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="deposit-notes">Notes</Label>
              <Textarea
                id="deposit-notes"
                placeholder="Optional notes..."
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isPending} className="gap-1.5">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />}
              Record Deposit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
