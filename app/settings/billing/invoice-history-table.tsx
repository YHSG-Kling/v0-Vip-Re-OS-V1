"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
// TOMBSTONE (orphan doctrine §1.3): `ExternalLink` was imported here and rendered
// NOWHERE. It had nothing to point at — `billing_invoices` carries exactly one URL
// column, `pdf_url` (verified live against hrvaqgvukzxfskkcrwbt; there is no
// hosted_invoice_url), and that link is already rendered by the SURVIVOR at
// invoice-history-table.tsx:135, the `Download` anchor with target="_blank". A second
// icon for the same single destination would be two spellings of one action (§6).
import { FileText, Download } from "lucide-react"

interface Invoice {
  id: string
  invoice_date: string
  amount_cents: number
  status: string
  pdf_url?: string | null
}

interface InvoiceHistoryTableProps {
  invoices: Invoice[]
}

export function InvoiceHistoryTable({ invoices }: InvoiceHistoryTableProps) {
  const currentYear = new Date().getFullYear()
  const [selectedYear, setSelectedYear] = useState<string>("all")

  // Get unique years from invoices
  const years = [...new Set(invoices.map(inv => 
    new Date(inv.invoice_date).getFullYear()
  ))].sort((a, b) => b - a)

  // Filter invoices by selected year
  const filteredInvoices = selectedYear === "all"
    ? invoices
    : invoices.filter(inv => 
        new Date(inv.invoice_date).getFullYear() === parseInt(selectedYear)
      )

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "paid":
        return <Badge className="bg-green-100 text-green-800">Paid</Badge>
      case "open":
        return <Badge className="bg-amber-100 text-amber-800">Pending</Badge>
      case "void":
        return <Badge className="bg-gray-100 text-gray-800">Void</Badge>
      case "uncollectible":
        return <Badge className="bg-red-100 text-red-800">Uncollectible</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Invoice History
            </CardTitle>
            <CardDescription>View and download past invoices</CardDescription>
          </div>
          <Select value={selectedYear} onValueChange={setSelectedYear}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder="Filter year" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Years</SelectItem>
              {years.map(year => (
                <SelectItem key={year} value={year.toString()}>
                  {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {filteredInvoices.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No invoices found for this period.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredInvoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    {new Date(invoice.invoice_date).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </TableCell>
                  <TableCell className="font-medium">
                    ${(invoice.amount_cents / 100).toFixed(2)}
                  </TableCell>
                  <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                  <TableCell className="text-right">
                    {invoice.pdf_url ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        asChild
                      >
                        <a
                          href={invoice.pdf_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1"
                        >
                          <Download className="h-4 w-4" />
                          PDF
                        </a>
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
