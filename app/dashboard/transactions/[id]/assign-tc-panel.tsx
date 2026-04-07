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
import { Loader2, UserCog, CheckCircle2 } from "lucide-react"
import { assignTransactionCoordinator } from "@/app/actions/multi-persona"
import { useToast } from "@/hooks/use-toast"
import { useRouter } from "next/navigation"

interface TC {
  id: string
  display_name: string | null
  active_transactions_count: number | null
  max_active_deals: number | null
}

interface AssignTCPanelProps {
  transactionId: string
  currentCoordinatorId: string | null
  availableTCs: TC[]
  userRole: string
}

export function AssignTCPanel({
  transactionId,
  currentCoordinatorId,
  availableTCs,
  userRole,
}: AssignTCPanelProps) {
  const [open, setOpen] = useState(false)
  const [selectedTC, setSelectedTC] = useState<string>("")
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const canAssign = ["broker", "admin", "tc"].includes(userRole)
  if (!canAssign) return null

  const currentTC = availableTCs.find((tc) => tc.id === currentCoordinatorId)

  const handleAssign = () => {
    if (!selectedTC) return
    startTransition(async () => {
      try {
        await assignTransactionCoordinator({ transactionId, coordinatorId: selectedTC })
        toast({ title: "TC assigned", description: "Transaction coordinator has been assigned." })
        setOpen(false)
        router.refresh()
      } catch (err: any) {
        toast({ title: "Error", description: err.message || "Failed to assign TC.", variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <UserCog className="h-4 w-4" />
          Transaction Coordinator
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {currentTC ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <div>
              <p className="text-sm font-medium">{currentTC.display_name ?? "Unnamed TC"}</p>
              <p className="text-xs text-muted-foreground">
                {currentTC.active_transactions_count ?? 0} / {currentTC.max_active_deals ?? 25} active deals
              </p>
            </div>
          </div>
        ) : (
          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
            No TC assigned
          </Badge>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="w-full">
              {currentTC ? "Reassign TC" : "Assign TC"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assign Transaction Coordinator</DialogTitle>
              <DialogDescription>
                Select a TC to manage this transaction. They will gain access to all transaction details.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <Select value={selectedTC} onValueChange={setSelectedTC}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a coordinator..." />
                </SelectTrigger>
                <SelectContent>
                  {availableTCs.map((tc) => {
                    const capacity = tc.max_active_deals ?? 25
                    const used = tc.active_transactions_count ?? 0
                    const atCap = used >= capacity
                    return (
                      <SelectItem key={tc.id} value={tc.id} disabled={atCap}>
                        <span className="flex items-center gap-2">
                          {tc.display_name ?? "Unnamed TC"}
                          <span className="text-xs text-muted-foreground">
                            ({used}/{capacity}{atCap ? " — at capacity" : ""})
                          </span>
                        </span>
                      </SelectItem>
                    )
                  })}
                  {availableTCs.length === 0 && (
                    <SelectItem value="__none" disabled>
                      No coordinators available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAssign} disabled={!selectedTC || isPending}>
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
