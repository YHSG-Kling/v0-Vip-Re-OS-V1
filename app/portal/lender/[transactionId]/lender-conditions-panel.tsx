"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { CheckCircle2, Loader2, Plus, Trash2, ClipboardList } from "lucide-react"
import { submitLoanConditions, trackConditionClearance } from "@/app/actions/multi-persona"
import { useToast } from "@/hooks/use-toast"
import { useRouter } from "next/navigation"

/**
 * "Cleared" is the status the SERVER side of this feature has always keyed on:
 * trackConditionClearance measures the clearance rate off `status === "cleared"`
 * and promotes the loan to clear_to_close at 100%, and submitLoanConditions
 * treats anything not "cleared" as still outstanding when it decides whether to
 * task the agent and draft the buyer's document request. This panel offered only
 * pending / received / waived, so no condition could ever reach the status the
 * server was waiting for: the clearance tracker was unreachable and every save
 * re-notified about conditions the lender had already collected. Adding it here
 * is what connects the two halves.
 */
interface Condition {
  condition: string
  status: "pending" | "received" | "waived" | "cleared"
  documents: string[]
}

interface LenderConditionsPanelProps {
  loanId: string
  initialConditions: Condition[]
}

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  pending: { label: "Pending", variant: "secondary" },
  received: { label: "Received", variant: "default" },
  waived: { label: "Waived", variant: "outline" },
  cleared: { label: "Cleared", variant: "default" },
}

export function LenderConditionsPanel({ loanId, initialConditions }: LenderConditionsPanelProps) {
  const [conditions, setConditions] = useState<Condition[]>(initialConditions)
  const [newCondition, setNewCondition] = useState("")
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

  // Server-side clearance verdict for this loan. Read from the persisted
  // conditions, not from local edits, so it reports what the file actually says.
  const [clearance, setClearance] = useState<{
    pendingConditions: any[]
    clearedConditions: any[]
    clearanceRate: number
  } | null>(null)

  async function refreshClearance() {
    try {
      setClearance(await trackConditionClearance(loanId))
    } catch {
      setClearance(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    trackConditionClearance(loanId)
      .then((c) => { if (!cancelled) setClearance(c) })
      .catch(() => { if (!cancelled) setClearance(null) })
    return () => { cancelled = true }
  }, [loanId])

  const addCondition = () => {
    if (!newCondition.trim()) return
    setConditions((prev) => [
      ...prev,
      { condition: newCondition.trim(), status: "pending", documents: [] },
    ])
    setNewCondition("")
    setSaved(false)
  }

  const removeCondition = (index: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== index))
    setSaved(false)
  }

  const updateStatus = (index: number, status: Condition["status"]) => {
    setConditions((prev) =>
      prev.map((c, i) => (i === index ? { ...c, status } : c))
    )
    setSaved(false)
  }

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        await submitLoanConditions({ loanId, conditions })
        setSaved(true)
        toast({ title: "Conditions saved", description: "Loan conditions have been submitted." })
        // Re-measure clearance against what was just persisted — at 100% cleared
        // this is also what advances the loan's underwriting status.
        await refreshClearance()
        router.refresh()
      } catch (err: any) {
        toast({ title: "Error", description: err.message || "Failed to save conditions.", variant: "destructive" })
      }
    })
  }

  const pendingCount = conditions.filter((c) => c.status === "pending").length
  const receivedCount = conditions.filter((c) => c.status === "received").length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5" />
          Loan Conditions
        </CardTitle>
        <CardDescription>
          {conditions.length === 0
            ? "No conditions added yet."
            : `${pendingCount} pending · ${receivedCount} received`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Clearance verdict — measured server-side from the saved file */}
        {clearance && (clearance.clearedConditions.length + clearance.pendingConditions.length) > 0 && (
          <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">Condition clearance</span>
              <span className="text-muted-foreground">
                {clearance.clearedConditions.length} of{" "}
                {clearance.clearedConditions.length + clearance.pendingConditions.length} cleared
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${clearance.clearanceRate === 100 ? "bg-emerald-500" : "bg-amber-500"}`}
                style={{ width: `${Math.min(100, Math.max(0, clearance.clearanceRate))}%` }}
              />
            </div>
            {clearance.clearanceRate === 100 ? (
              <p className="text-xs text-emerald-700">
                All conditions cleared — the loan has been advanced to clear to close.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {clearance.pendingConditions.length} condition
                {clearance.pendingConditions.length === 1 ? "" : "s"} still outstanding.
              </p>
            )}
          </div>
        )}

        {/* Conditions List */}
        {conditions.length > 0 && (
          <div className="space-y-2">
            {conditions.map((cond, index) => (
              <div
                key={index}
                className="flex items-center gap-3 p-3 rounded-lg border bg-muted/20"
              >
                <Checkbox
                  id={`cond-${index}`}
                  checked={cond.status === "received"}
                  onCheckedChange={(checked) =>
                    updateStatus(index, checked ? "received" : "pending")
                  }
                />
                <label
                  htmlFor={`cond-${index}`}
                  className="flex-1 text-sm cursor-pointer"
                >
                  {cond.condition}
                </label>
                <Select
                  value={cond.status}
                  onValueChange={(v) => updateStatus(index, v as Condition["status"])}
                >
                  <SelectTrigger className="w-28 h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="received">Received</SelectItem>
                    <SelectItem value="waived">Waived</SelectItem>
                    <SelectItem value="cleared">Cleared</SelectItem>
                  </SelectContent>
                </Select>
                <Badge
                  variant={STATUS_LABELS[cond.status]?.variant ?? "outline"}
                  className="text-xs hidden sm:inline-flex"
                >
                  {STATUS_LABELS[cond.status]?.label}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => removeCondition(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add new condition */}
        <div className="flex gap-2">
          <Input
            placeholder="Add condition..."
            value={newCondition}
            onChange={(e) => setNewCondition(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCondition()}
            className="text-sm"
          />
          <Button size="sm" variant="outline" onClick={addCondition} disabled={!newCondition.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Submit */}
        <Button
          className="w-full"
          onClick={handleSubmit}
          disabled={isPending || conditions.length === 0}
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : saved ? (
            <CheckCircle2 className="h-4 w-4 mr-2 text-green-600" />
          ) : null}
          {saved ? "Conditions Saved" : "Submit Conditions"}
        </Button>
      </CardContent>
    </Card>
  )
}
