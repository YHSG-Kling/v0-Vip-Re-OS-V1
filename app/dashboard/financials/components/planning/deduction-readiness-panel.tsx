"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { FileCheck, AlertCircle, Download, Loader2, ChevronDown, ChevronUp, Upload } from "lucide-react"
import { getTaxCategories } from "@/app/actions/accounting-sync"
import { aiGenerateProfitLossReport } from "@/app/actions/ai-financial-management"
import { attachExpenseReceipt } from "@/app/actions/financials"
import { toast } from "sonner"

interface Expense {
  id: string
  category: string
  amount: number
  description: string
  receipt_url?: string
  date: string
}

interface DeductionReadinessPanelProps {
  agentId: string
  brokerageId: string
  expenses: Expense[]
}

export function DeductionReadinessPanel({
  agentId,
  brokerageId,
  expenses,
}: DeductionReadinessPanelProps) {
  const [taxCategories, setTaxCategories] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [showMissingReceipts, setShowMissingReceipts] = useState(false)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pendingExpenseId = useRef<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    loadTaxCategories()
  }, [brokerageId])

  const loadTaxCategories = async () => {
    try {
      const result = await getTaxCategories(brokerageId)
      if (Array.isArray(result)) {
        setTaxCategories(result)
      }
    } catch (error) {
      console.error("Error loading tax categories:", error)
    } finally {
      setLoading(false)
    }
  }

  // Calculate stats
  const totalTracked = expenses.reduce((sum, e) => sum + e.amount, 0)
  const withReceipts = expenses.filter((e) => e.receipt_url).length
  const missingReceipts = expenses.filter((e) => !e.receipt_url)
  const uncategorizedExpenses = expenses.filter((e) => e.category === "uncategorized" || !e.category)

  // Group expenses by category
  const expensesByCategory = expenses.reduce((acc: Record<string, { total: number; count: number }>, expense) => {
    const category = expense.category || "Uncategorized"
    if (!acc[category]) {
      acc[category] = { total: 0, count: 0 }
    }
    acc[category].total += expense.amount
    acc[category].count += 1
    return acc
  }, {})

  const receiptCompleteness = expenses.length > 0 ? (withReceipts / expenses.length) * 100 : 0

  const handleExportForTaxPrep = async () => {
    setGenerating(true)
    try {
      const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().split("T")[0]
      const today = new Date().toISOString().split("T")[0]

      const result = await aiGenerateProfitLossReport({
        agentId,
        startDate: yearStart,
        endDate: today,
        includeProjections: false,
      })

      const resultAny = result as any
      // Read the outcome: a refused or empty report used to leave the button
      // spinning back to idle with no message at all.
      if (!resultAny?.success || !resultAny?.report) {
        toast.error(resultAny?.error ?? "The P&L report was not generated")
        return
      }
      const reportText = typeof resultAny.report === "string"
        ? resultAny.report
        : JSON.stringify(resultAny.report, null, 2)
      await navigator.clipboard.writeText(reportText)
      toast.success("P&L Report copied to clipboard", {
        description: "Ready for your tax preparer",
      })
    } catch (error: any) {
      toast.error(error?.message ?? "The P&L report was not generated")
    } finally {
      setGenerating(false)
    }
  }

  // ── Attach a receipt to an expense that has none ───────────────────────────
  // One hidden <input type="file"> serves every row; the row we are filling is
  // held in a ref so the change handler knows which expense to write to.
  const pickReceiptFor = (expenseId: string) => {
    pendingExpenseId.current = expenseId
    fileInputRef.current?.click()
  }

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error("The file could not be read"))
      reader.onload = () => {
        const result = String(reader.result ?? "")
        const comma = result.indexOf(",")
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      }
      reader.readAsDataURL(file)
    })

  const handleReceiptSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const expenseId = pendingExpenseId.current
    // Reset immediately so re-picking the SAME file still fires a change event.
    e.target.value = ""
    pendingExpenseId.current = null
    if (!file || !expenseId) return

    setUploadingId(expenseId)
    try {
      const base64 = await fileToBase64(file)
      const res = await attachExpenseReceipt({
        expenseId,
        base64,
        mimeType: file.type,
        fileName: file.name,
      })
      if (!res.success) {
        toast.error(res.error ?? "The receipt was not attached")
        return
      }
      toast.success("Receipt attached")
      // The expenses list is a server prop — re-fetch it so the missing-receipt
      // count actually comes down.
      router.refresh()
    } catch (err: any) {
      toast.error(err?.message ?? "The receipt was not attached")
    } finally {
      setUploadingId(null)
    }
  }

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileCheck className="h-5 w-5 text-blue-600" />
          Deduction Readiness
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          className="hidden"
          onChange={handleReceiptSelected}
        />
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-xs text-muted-foreground">Total Tracked</p>
            <p className="text-lg font-semibold">{formatCurrency(totalTracked)}</p>
          </div>
          <div className="p-3 rounded-lg bg-green-50 text-center">
            <p className="text-xs text-muted-foreground">With Receipts</p>
            <p className="text-lg font-semibold text-green-700">{withReceipts}</p>
          </div>
          <div className={`p-3 rounded-lg text-center ${missingReceipts.length > 0 ? "bg-amber-50" : "bg-muted/50"}`}>
            <p className="text-xs text-muted-foreground">Missing Receipts</p>
            <p className={`text-lg font-semibold ${missingReceipts.length > 0 ? "text-amber-700" : ""}`}>
              {missingReceipts.length}
            </p>
          </div>
        </div>

        {/* Receipt completeness */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Receipt completeness</span>
            <span className="font-medium">{receiptCompleteness.toFixed(0)}%</span>
          </div>
          <Progress value={receiptCompleteness} className="h-2" />
        </div>

        {/* Uncategorized alert */}
        {uncategorizedExpenses.length > 0 && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-700">
              {uncategorizedExpenses.length} expense{uncategorizedExpenses.length !== 1 ? "s" : ""} need categorization
            </p>
          </div>
        )}

        {/* Category breakdown */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Category Breakdown</p>
          {Object.entries(expensesByCategory).map(([category, data]) => (
            <div key={category} className="flex items-center justify-between p-2 rounded bg-muted/30">
              <div className="flex items-center gap-2">
                <span className="text-sm">{category}</span>
                <Badge variant="secondary" className="text-xs">
                  {data.count}
                </Badge>
              </div>
              <span className="text-sm font-medium">{formatCurrency(data.total)}</span>
            </div>
          ))}
        </div>

        {/* Missing receipts expandable */}
        {missingReceipts.length > 0 && (
          <div className="border rounded-lg">
            <button
              onClick={() => setShowMissingReceipts(!showMissingReceipts)}
              className="w-full p-3 flex items-center justify-between hover:bg-muted/50"
            >
              <span className="text-sm font-medium">Review Missing Receipts</span>
              {showMissingReceipts ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
            {showMissingReceipts && (
              <div className="p-3 border-t space-y-2 max-h-48 overflow-y-auto">
                {missingReceipts.map((expense) => (
                  <div key={expense.id} className="flex items-center justify-between p-2 rounded bg-amber-50">
                    <div>
                      <p className="text-sm font-medium">{expense.description}</p>
                      <p className="text-xs text-muted-foreground">{formatCurrency(expense.amount)}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Attach a receipt to ${expense.description}`}
                      disabled={uploadingId === expense.id}
                      onClick={() => pickReceiptFor(expense.id)}
                    >
                      {uploadingId === expense.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Export button */}
        <Button
          onClick={handleExportForTaxPrep}
          disabled={generating}
          className="w-full"
          variant="outline"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Export for Tax Prep
        </Button>
      </CardContent>
    </Card>
  )
}
