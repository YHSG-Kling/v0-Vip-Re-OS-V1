// app/components/features/financial/ExpenseForm.tsx
"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Plus } from "lucide-react"
import { createExpenseRecordAction } from "@/app/actions/financial-kernel"

interface ExpenseFormProps {
  agentId: string
  onCreated?: () => void
}

const EXPENSE_CATEGORIES = [
  { value: "marketing", label: "Marketing" },
  { value: "training", label: "Training" },
  { value: "technology", label: "Technology" },
  { value: "office_supplies", label: "Office Supplies" },
  { value: "travel", label: "Travel" },
  { value: "professional_services", label: "Professional Services" },
  { value: "other", label: "Other" },
]

export function ExpenseForm({ agentId, onCreated }: ExpenseFormProps) {
  const [isPending, startTransition] = useTransition()
  const [category, setCategory] = useState("")
  const [amount, setAmount] = useState("")
  const [description, setDescription] = useState("")
  const [receiptUrl, setReceiptUrl] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess(false)

    if (!category || !amount) {
      setError("Category and amount are required")
      return
    }

    startTransition(async () => {
      const result = await createExpenseRecordAction({
        agentId,
        category,
        amount: parseFloat(amount),
        description: description || undefined,
        receiptUrl: receiptUrl || undefined,
      })

      if (!result.success) {
        setError(result.error ?? "Failed to create expense")
        return
      }

      setSuccess(true)
      setCategory("")
      setAmount("")
      setDescription("")
      setReceiptUrl("")
      onCreated?.()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record Expense</CardTitle>
        <CardDescription>Add a new business expense</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Category *</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount ($) *</Label>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes about this expense..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label>Receipt URL</Label>
            <Input
              type="url"
              value={receiptUrl}
              onChange={(e) => setReceiptUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-green-600">Expense recorded successfully</p>}

          <Button type="submit" disabled={isPending} className="w-full">
            <Plus className="h-4 w-4 mr-2" />
            {isPending ? "Recording..." : "Record Expense"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
