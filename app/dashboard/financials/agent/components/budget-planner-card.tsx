"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Target, Loader2, Sparkles, Save } from "lucide-react"
import { aiCreateBudget } from "@/app/actions/ai-financial-management"
import { createClient } from "@/lib/supabase/client"
import { useToast } from "@/hooks/use-toast"

interface CategoryBudget {
  category: string
  monthlyBudget: number
  annualBudget: number
  rationale?: string
}

interface BudgetData {
  annualBudget?: {
    projectedIncome: number
    targetProfit: number
    targetProfitMargin: number
  }
  categoryBudgets?: CategoryBudget[]
  taxSetAside?: {
    percentage: number
    monthlyAmount: number
    quarterlyPayment: number
  }
  emergencyFund?: {
    recommended: number
    monthsOfExpenses: number
  }
}

interface ExistingBudget {
  id: string
  income_goal: number
  budget_data: BudgetData
}

interface BudgetPlannerCardProps {
  agentId: string
  initialBudget: ExistingBudget | null
  ytdGCI: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

// Category display names mapped to spec
const CATEGORY_LABELS: Record<string, string> = {
  Marketing: "Marketing",
  "Lead Generation": "Lead Generation",
  Technology: "Tech/Tools",
  "Professional Development": "Education",
  Administrative: "Emergency Reserve",
  // Fallback handled below
}

export function BudgetPlannerCard({ agentId, initialBudget, ytdGCI }: BudgetPlannerCardProps) {
  const currentYear = new Date().getFullYear()
  const [budget, setBudget] = useState<BudgetData | null>(initialBudget?.budget_data ?? null)
  const [budgetId, setBudgetId] = useState<string | null>(initialBudget?.id ?? null)
  const [editedCategories, setEditedCategories] = useState<Record<string, number>>({})
  const [incomeGoal, setIncomeGoal] = useState<string>(
    initialBudget?.income_goal ? String(initialBudget.income_goal) : ""
  )
  const [isPending, startTransition] = useTransition()
  const [isSaving, startSaving] = useTransition()
  const { toast } = useToast()

  const categories = budget?.categoryBudgets ?? []

  function handleGenerateBudget() {
    startTransition(async () => {
      try {
        const result = await aiCreateBudget({
          agentId,
          year: currentYear,
          incomeGoal: incomeGoal ? parseFloat(incomeGoal) : undefined,
        })
        if (result.success) {
          setBudget(result.budget as BudgetData)
          setBudgetId(result.budgetId as string)
          setEditedCategories({})
          toast({ title: "Budget generated", description: `AI budget plan for ${currentYear} is ready.` })
        } else {
          toast({ title: "Error", description: (result as any).error || "Failed to generate budget.", variant: "destructive" })
        }
      } catch (e: any) {
        toast({ title: "Error", description: e.message || "Failed to generate budget.", variant: "destructive" })
      }
    })
  }

  function handleCategoryEdit(category: string, value: string) {
    setEditedCategories((prev) => ({ ...prev, [category]: parseFloat(value) || 0 }))
  }

  function handleSaveBudget() {
    if (!budgetId || !budget) return
    const supabase = createClient()
    startSaving(async () => {
      try {
        // Merge edits back into budget_data categoryBudgets
        const updatedCategories = categories.map((cat) => ({
          ...cat,
          monthlyBudget: editedCategories[cat.category] ?? cat.monthlyBudget,
          annualBudget: (editedCategories[cat.category] ?? cat.monthlyBudget) * 12,
        }))
        const updatedBudget = { ...budget, categoryBudgets: updatedCategories }

        const { error } = await supabase
          .from("budgets")
          .update({ budget_data: updatedBudget })
          .eq("id", budgetId)

        if (error) throw error
        setBudget(updatedBudget)
        setEditedCategories({})
        toast({ title: "Budget saved", description: "Your category adjustments have been saved." })
      } catch (e: any) {
        toast({ title: "Error", description: e.message || "Failed to save budget.", variant: "destructive" })
      }
    })
  }

  const hasEdits = Object.keys(editedCategories).length > 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-violet-600" />
            <div>
              <CardTitle>AI Budget Planner</CardTitle>
              <CardDescription>{currentYear} business budget recommendations</CardDescription>
            </div>
          </div>
          {budget && (
            <Badge variant="outline" className="bg-violet-50 text-violet-700 border-violet-200 text-xs">
              {currentYear}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Income goal input + generate button */}
        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="income-goal">Income Goal (optional)</Label>
            <Input
              id="income-goal"
              type="number"
              placeholder={`e.g. ${fmt(ytdGCI > 0 ? ytdGCI * 1.2 : 150000)}`}
              value={incomeGoal}
              onChange={(e) => setIncomeGoal(e.target.value)}
            />
          </div>
          <Button
            onClick={handleGenerateBudget}
            disabled={isPending}
            className="gap-1.5 shrink-0"
            variant={budget ? "outline" : "default"}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {budget ? "Regenerate" : "AI Create Budget"}
          </Button>
        </div>

        {/* Category breakdown */}
        {categories.length > 0 && (
          <div className="space-y-4">
            <Separator />
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-muted-foreground">Monthly Allocations</p>
              {hasEdits && (
                <Button size="sm" variant="outline" onClick={handleSaveBudget} disabled={isSaving} className="gap-1.5">
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save Budget
                </Button>
              )}
            </div>

            <div className="space-y-3">
              {categories.map((cat) => {
                const currentValue = editedCategories[cat.category] ?? cat.monthlyBudget
                const isEdited = editedCategories[cat.category] !== undefined
                return (
                  <div key={cat.category} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {CATEGORY_LABELS[cat.category] ?? cat.category}
                      </p>
                      {cat.rationale && (
                        <p className="text-xs text-muted-foreground truncate">{cat.rationale}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs text-muted-foreground">$</span>
                      <Input
                        type="number"
                        className={`w-24 h-8 text-sm text-right ${isEdited ? "border-violet-400 ring-1 ring-violet-200" : ""}`}
                        value={currentValue}
                        onChange={(e) => handleCategoryEdit(cat.category, e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">/mo</span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Summary stats */}
            {budget?.annualBudget && (
              <>
                <Separator />
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-lg font-bold text-violet-600">
                      {fmt(budget.annualBudget.projectedIncome)}
                    </p>
                    <p className="text-xs text-muted-foreground">Income Goal</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-green-600">
                      {fmt(budget.annualBudget.targetProfit)}
                    </p>
                    <p className="text-xs text-muted-foreground">Target Profit</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-amber-600">
                      {budget.taxSetAside ? fmt(budget.taxSetAside.monthlyAmount) : "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">Tax Set-Aside/mo</p>
                  </div>
                </div>
              </>
            )}

            {!hasEdits && (
              <p className="text-xs text-muted-foreground text-center">
                Edit any category amount to enable Save Budget
              </p>
            )}
          </div>
        )}

        {!budget && !isPending && (
          <p className="text-sm text-muted-foreground text-center py-2">
            Generate an AI-recommended budget based on your {currentYear} history and income goals.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
