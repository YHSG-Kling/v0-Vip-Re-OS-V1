"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Loader2, Building2, CheckCircle2 } from "lucide-react"
import { assignLenderToTransaction } from "@/app/actions/multi-persona"
import { useToast } from "@/hooks/use-toast"
import { useRouter } from "next/navigation"

interface LenderUser {
  id: string
  lender_company: string | null
}

interface AssignLenderPanelProps {
  transactionId: string
  currentLenderId: string | null
  availableLenders: LenderUser[]
  userRole: string
}

export function AssignLenderPanel({
  transactionId,
  currentLenderId,
  availableLenders,
  userRole,
}: AssignLenderPanelProps) {
  const [open, setOpen] = useState(false)
  const [selectedLender, setSelectedLender] = useState<string>("")
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const canAssign = ["broker", "admin", "tc", "agent"].includes(userRole)
  if (!canAssign) return null

  const currentLender = availableLenders.find((l) => l.id === currentLenderId)

  const handleAssign = () => {
    if (!selectedLender) return
    startTransition(async () => {
      try {
        await assignLenderToTransaction({ transactionId, lenderId: selectedLender })
        toast({ title: "Lender assigned", description: "Lender has been assigned to this transaction." })
        setOpen(false)
        router.refresh()
      } catch (err: any) {
        toast({ title: "Error", description: err.message || "Failed to assign lender.", variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          Lender
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {currentLender ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <p className="text-sm font-medium">{currentLender.lender_company ?? "Lender assigned"}</p>
          </div>
        ) : (
          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
            No lender assigned
          </Badge>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="w-full">
              {currentLender ? "Reassign Lender" : "Assign Lender"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assign Lender</DialogTitle>
              <DialogDescription>
                Select a lender portal user to assign to this transaction.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <Select value={selectedLender} onValueChange={setSelectedLender}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a lender..." />
                </SelectTrigger>
                <SelectContent>
                  {availableLenders.map((lender) => (
                    <SelectItem key={lender.id} value={lender.id}>
                      {lender.lender_company ?? lender.id}
                    </SelectItem>
                  ))}
                  {availableLenders.length === 0 && (
                    <SelectItem value="__none" disabled>
                      No lenders available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAssign} disabled={!selectedLender || isPending}>
                {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Assign
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
