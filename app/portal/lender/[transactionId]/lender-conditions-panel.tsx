"use client"

import { useState, useTransition } from "react"
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
import { submitLoanConditions } from "@/app/actions/multi-persona"
import { useToast } from "@/hooks/use-toast"
import { useRouter } from "next/navigation"

interface Condition {
  condition: string
  status: "pending" | "received" | "waived"
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
}

export function LenderConditionsPanel({ loanId, initialConditions }: LenderConditionsPanelProps) {
  const [conditions, setConditions] = useState<Condition[]>(initialConditions)
  const [newCondition, setNewCondition] = useState("")
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

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
