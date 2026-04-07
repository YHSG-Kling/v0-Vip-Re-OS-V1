// app/components/features/financial/FinancialExportDialog.tsx
"use client"

import { useState, useTransition } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { FileText, Download } from "lucide-react"
import { exportFinancialReportAction } from "@/app/actions/financial-kernel"

interface FinancialExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  brokerageId: string
}

export function FinancialExportDialog({ open, onOpenChange, brokerageId }: FinancialExportDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [format, setFormat] = useState<"csv" | "pdf">("csv")
  const [reportType, setReportType] = useState("summary")

  const handleExport = () => {
    startTransition(async () => {
      const result = await exportFinancialReportAction({
        brokerageId,
        format,
        reportType,
      })

      if (result.success && result.data) {
        // Trigger browser download
        const a = document.createElement("a")
        a.href = result.data.fileUrl
        a.download = `financial-report-${reportType}.${format}`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        onOpenChange(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export Financial Report</DialogTitle>
          <DialogDescription>Download your financial data</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Report Type</Label>
            <Select value={reportType} onValueChange={setReportType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="summary">Summary</SelectItem>
                <SelectItem value="commissions">Commissions</SelectItem>
                <SelectItem value="expenses">Expenses</SelectItem>
                <SelectItem value="full">Full Report</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Format</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as "csv" | "pdf")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="pdf">PDF</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="bg-transparent">
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isPending}>
            <Download className="h-4 w-4 mr-2" />
            {isPending ? "Generating..." : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
