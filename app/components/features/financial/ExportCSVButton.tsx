"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Download, Loader2 } from "lucide-react"
import { exportCommissionsCSV, exportExpensesCSV } from "@/app/actions/financials"

interface ExportCSVButtonProps {
  agentId: string
  type: "commissions" | "expenses"
  variant?: "default" | "outline" | "ghost"
  size?: "default" | "sm" | "lg"
}

export function ExportCSVButton({ agentId, type, variant = "outline", size = "sm" }: ExportCSVButtonProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleExport() {
    setError(null)
    startTransition(async () => {
      const result = type === "commissions"
        ? await exportCommissionsCSV(agentId)
        : await exportExpensesCSV(agentId)

      if (!result.success || !result.csv) {
        setError(result.error ?? "Export failed")
        return
      }

      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8;" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = result.filename ?? `${type}-export.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    })
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant={variant} size={size} onClick={handleExport} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Download className="h-3.5 w-3.5 mr-1" />}
        Export CSV
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
