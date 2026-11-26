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
  userId: string
  label: string
}

interface AssignLenderPanelProps {
  transactionId: string
  currentLenderUserId: string | null
  availableLenderUsers: LenderUser[]
  userType: string
}

import { LenderStatusRequestButton } from "./lender-status-request-button"

export function AssignLenderPanel({
  transactionId,
  currentLenderUserId,
  availableLenderUsers,
  userType,
}: AssignLenderPanelProps) {
  const [open, setOpen] = useState(false)
  const [selectedLender, setSelectedLender] = useState<string>("")
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  // SCOPE LADDER (kept inline — mirrors the assignLender action in
  // app/actions/multi-persona.ts): 'superadmin' removed — dead as
  // users.user_type (0 live rows); broker_owner added.
  const canAssign = ["broker", "broker_owner", "broker_admin", "admin", "tc", "agent", "team_lead"].includes(userType)
  if (!canAssign) return null

  const currentLender = availableLenderUsers.find((l) => l.userId === currentLenderUserId)

  const handleAssign = () => {
    if (!selectedLender) return
    startTransition(async () => {
      const res = await assignLenderToTransaction({ transactionId, lenderUserId: selectedLender })
      if (res?.success) {
        toast({ title: "Lender assigned", description: "Lender has been assigned to this transaction." })
        setOpen(false)
        router.refresh()
      } else {
        toast({ title: "Error", description: res?.error || "Failed to assign lender.", variant: "destructive" })
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
            <p className="text-sm font-medium">{currentLender.label}</p>
          </div>
        ) : (
          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
            No lender assigned
          </Badge>
        )}

        {currentLender && <LenderStatusRequestButton transactionId={transactionId} />}

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
                  {availableLenderUsers.map((lender) => (
                    <SelectItem key={lender.userId} value={lender.userId}>
                      {lender.label}
                    </SelectItem>
                  ))}
                  {availableLenderUsers.length === 0 && (
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
