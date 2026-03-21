"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Plus, Sparkles, Loader2, CheckCircle2 } from "lucide-react"
import { aiCategorizeExpense, createExpense } from "@/app/actions/ai-financial-management"
import { useRouter } from "next/navigation"

const EXPENSE_CATEGORIES = [
  "Marketing",
  "Advertising",
  "Transportation",
  "Meals & Entertainment",
  "Office Supplies",
  "Technology",
  "Professional Development",
  "Professional Services",
  "Photography",
  "Staging",
  "Signs & Lockboxes",
  "MLS Fees",
  "Licensing",
  "Insurance",
  "Other",
]

interface AddExpenseDialogProps {
  agentId: string
}

export function AddExpenseDialog({ agentId }: AddExpenseDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  // Form state
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [category, setCategory] = useState("")
  const [vendor, setVendor] = useState("")
  const [date, setDate] = useState(new Date().toISOString().split("T")[0])

  // AI state
  const [categorizingAI, setCategorizingAI] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState<{
    category: string
    confidence?: number
    explanation?: string
  } | null>(null)

  // Save state
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function resetForm() {
    setDescription("")
    setAmount("")
    setCategory("")
    setVendor("")
    setDate(new Date().toISOString().split("T")[0])
    setAiSuggestion(null)
    setSaveError(null)
  }

  async function handleAICategorize() {
    if (!description || !amount || isNaN(Number(amount))) return
    setCategorizingAI(true)
    setAiSuggestion(null)
    const result = await aiCategorizeExpense({
      agentId,
      description,
      amount: Number(amount),
      vendor: vendor || undefined,
    })
    if (result.success && result.categorization?.category) {
      setAiSuggestion(result.categorization)
      setCategory(result.categorization.category)
    }
    setCategorizingAI(false)
  }

  async function handleSave() {
    if (!description || !amount || !category || !date) return
    setSaving(true)
    setSaveError(null)
    const result = await createExpense({
      agentId,
      description,
      amount: Number(amount),
      category,
      vendor: vendor || undefined,
      date,
    })
    if (result.success) {
      setOpen(false)
      resetForm()
      router.refresh()
    } else {
      setSaveError((result as any).error ?? "Failed to save expense")
    }
    setSaving(false)
  }

  return (
    <>
      <Button
        size="sm"
        className="bg-blue-600 hover:bg-blue-700 text-white"
        onClick={() => setOpen(true)}
      >
        <Plus className="w-4 h-4 mr-2" />
        Add Expense
      </Button>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) resetForm()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Log New Expense</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="expense-desc">Description</Label>
              <Textarea
                id="expense-desc"
                rows={2}
                placeholder="e.g. Facebook ads for 123 Main St listing"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Amount + Date row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="expense-amount">Amount ($)</Label>
                <Input
                  id="expense-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="expense-date">Date</Label>
                <Input
                  id="expense-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
            </div>

            {/* Vendor */}
            <div className="space-y-1.5">
              <Label htmlFor="expense-vendor">Vendor (optional)</Label>
              <Input
                id="expense-vendor"
                placeholder="e.g. Facebook, Canva, Staples"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              />
            </div>

            {/* Category row with AI button */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="expense-category">Category</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs text-primary"
                  onClick={handleAICategorize}
                  disabled={categorizingAI || !description || !amount}
                >
                  {categorizingAI ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  AI Suggest
                </Button>
              </div>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="expense-category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* AI suggestion pill */}
              {aiSuggestion && (
                <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-emerald-900 leading-snug">
                    <span className="font-medium">AI suggests: {aiSuggestion.category}</span>
                    {aiSuggestion.confidence != null && (
                      <span className="text-emerald-700"> ({Math.round(aiSuggestion.confidence * 100)}% confident)</span>
                    )}
                    {aiSuggestion.explanation && (
                      <p className="mt-0.5 text-emerald-800">{aiSuggestion.explanation}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {saveError && (
              <p className="text-sm text-destructive">{saveError}</p>
            )}
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => { setOpen(false); resetForm() }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !description || !amount || !category || !date}
            >
              {saving ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
              ) : (
                "Save Expense"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
