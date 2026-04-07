"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DollarSign,
  TrendingUp,
  Calendar,
  CheckCircle2,
  Clock,
  ChevronRight,
  Download,
} from "lucide-react"
import Link from "next/link"

interface EarningRecord {
  id: string
  transactionId?: string
  jobId?: string
  propertyAddress?: string
  description: string
  amount: number
  status: "pending" | "approved" | "paid" | "processing"
  paidDate?: string
  invoiceDate?: string
}

interface ExternalBillingEarningsPanelProps {
  partnerType: "vendor" | "lender" | "title"
  partnerId: string
  earnings: EarningRecord[]
  totals: {
    pending: number
    paid: number
    mtd: number
    ytd: number
  }
}

export function ExternalBillingEarningsPanel({
  partnerType,
  partnerId,
  earnings,
  totals,
}: ExternalBillingEarningsPanelProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  const handleDownloadStatement = async () => {
    try {
      // Create CSV content from earnings with partner metadata
      const headers = ["Date", "Description", "Property/Reference", "Amount", "Status"]
      const rows = earnings.map((record) => [
        record.invoiceDate || record.paidDate || "N/A",
        record.description,
        record.propertyAddress || record.jobId || "N/A",
        formatCurrency(record.amount),
        record.status,
      ])

      // Build CSV with metadata header including partnerId for audit trail
      const csvContent = [
        `Partner ID: ${partnerId}`,
        `Export Date: ${new Date().toISOString()}`,
        `Partner Type: ${partnerType}`,
        "",
        headers.join(","),
        ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
      ].join("\n")

      // Create and download blob with partner ID in filename
      const blob = new Blob([csvContent], { type: "text/csv" })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${partnerType}-${partnerId}-${new Date().toISOString().split("T")[0]}-statement.csv`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch (error) {
      console.error("Failed to download statement:", error)
    }
  }

  const getStatusBadge = (status: EarningRecord["status"]) => {
    switch (status) {
      case "paid":
        return <Badge className="bg-green-100 text-green-700 border-green-200">Paid</Badge>
      case "approved":
        return <Badge className="bg-blue-100 text-blue-700 border-blue-200">Approved</Badge>
      case "processing":
        return <Badge className="bg-purple-100 text-purple-700 border-purple-200">Processing</Badge>
      default:
        return <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200">Pending</Badge>
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            {partnerType === "vendor" ? "Earnings" : "Billing"}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={handleDownloadStatement}
              title="Download statement as CSV"
            >
              <Download className="h-3 w-3" />
            </Button>
            <Link href={partnerType === "vendor" ? "/vendor/earnings" : "#"}>
              <Button variant="ghost" size="sm" className="h-7 text-xs">
                View All
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="p-3 bg-green-50 rounded-lg border border-green-100">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-xs text-green-700">Paid</span>
            </div>
            <p className="text-lg font-bold text-green-700 mt-1">{formatCurrency(totals.paid)}</p>
          </div>
          <div className="p-3 bg-yellow-50 rounded-lg border border-yellow-100">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-yellow-600" />
              <span className="text-xs text-yellow-700">Pending</span>
            </div>
            <p className="text-lg font-bold text-yellow-700 mt-1">{formatCurrency(totals.pending)}</p>
          </div>
          <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-600" />
              <span className="text-xs text-blue-700">This Month</span>
            </div>
            <p className="text-lg font-bold text-blue-700 mt-1">{formatCurrency(totals.mtd)}</p>
          </div>
          <div className="p-3 bg-purple-50 rounded-lg border border-purple-100">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-purple-600" />
              <span className="text-xs text-purple-700">Year to Date</span>
            </div>
            <p className="text-lg font-bold text-purple-700 mt-1">{formatCurrency(totals.ytd)}</p>
          </div>
        </div>

        {/* Recent Earnings/Invoices */}
        <div className="border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">Recent</p>
          {earnings.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No records yet</p>
          ) : (
            <div className="space-y-2">
              {earnings.slice(0, 4).map((record) => (
                <div
                  key={record.id}
                  className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{record.description}</p>
                    {record.propertyAddress && (
                      <p className="text-xs text-muted-foreground truncate">{record.propertyAddress}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-2">
                    <span className="text-sm font-semibold">{formatCurrency(record.amount)}</span>
                    {getStatusBadge(record.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
