"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ChevronRight, Search, Filter, ArrowUpDown } from "lucide-react"

interface Loan {
  id: string
  loan_type?: string
  loan_amount?: number
  loan_status?: string
  underwriting_status?: string
  lender_email?: string
  transactions?: {
    id: string
    property_address?: string
    status?: string
    close_date?: string
    contract_price?: number
    buyer_contact_id?: string
    leads?: {
      first_name?: string
      last_name?: string
    }
    agents?: {
      first_name?: string
      last_name?: string
    }
  }
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  submitted: { label: "Submitted", color: "bg-blue-100 text-blue-800" },
  in_review: { label: "In Review", color: "bg-amber-100 text-amber-800" },
  pending_conditions: { label: "Pending Conditions", color: "bg-orange-100 text-orange-800" },
  approved: { label: "Approved", color: "bg-green-100 text-green-800" },
  clear_to_close: { label: "Clear to Close", color: "bg-emerald-100 text-emerald-800" },
  funded: { label: "Funded", color: "bg-slate-100 text-slate-600" },
  denied: { label: "Denied", color: "bg-red-100 text-red-800" },
  withdrawn: { label: "Withdrawn", color: "bg-slate-100 text-slate-500" },
}

function formatCurrency(amount: number | null | undefined): string {
  if (!amount) return "N/A"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDate(date: string | null | undefined): string {
  if (!date) return "TBD"
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function LenderLoanList({ loans }: { loans: Loan[] }) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [sortField, setSortField] = useState<"close_date" | "amount">("close_date")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc")

  // Filter and sort loans
  const filteredLoans = loans
    .filter((loan) => {
      const address = loan.transactions?.property_address?.toLowerCase() || ""
      const buyerName = `${loan.transactions?.leads?.first_name || ""} ${loan.transactions?.leads?.last_name || ""}`.toLowerCase()
      const searchLower = search.toLowerCase()

      const matchesSearch = address.includes(searchLower) || buyerName.includes(searchLower)
      const matchesStatus = statusFilter === "all" || loan.underwriting_status === statusFilter

      return matchesSearch && matchesStatus
    })
    .sort((a, b) => {
      if (sortField === "close_date") {
        const dateA = a.transactions?.close_date ? new Date(a.transactions.close_date).getTime() : 0
        const dateB = b.transactions?.close_date ? new Date(b.transactions.close_date).getTime() : 0
        return sortDirection === "asc" ? dateA - dateB : dateB - dateA
      } else {
        const amountA = a.loan_amount || 0
        const amountB = b.loan_amount || 0
        return sortDirection === "asc" ? amountA - amountB : amountB - amountA
      }
    })

  const toggleSort = (field: "close_date" | "amount") => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortDirection("asc")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Loan Pipeline</CardTitle>
        <CardDescription>All assigned loans and their current status</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by address or buyer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="submitted">Submitted</SelectItem>
              <SelectItem value="in_review">In Review</SelectItem>
              <SelectItem value="pending_conditions">Pending Conditions</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="clear_to_close">Clear to Close</SelectItem>
              <SelectItem value="funded">Funded</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 p-0 font-medium"
                    onClick={() => toggleSort("amount")}
                  >
                    Loan Amount
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                  </Button>
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 p-0 font-medium"
                    onClick={() => toggleSort("close_date")}
                  >
                    Close Date
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                  </Button>
                </TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLoans.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    <p className="text-muted-foreground">No loans found</p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredLoans.map((loan) => {
                  const status = STATUS_CONFIG[loan.underwriting_status || "submitted"] || STATUS_CONFIG.submitted
                  const transactionId = loan.transactions?.id

                  return (
                    <TableRow key={loan.id} className="hover:bg-muted/50">
                      <TableCell className="font-medium">
                        {loan.transactions?.property_address || "Address pending"}
                      </TableCell>
                      <TableCell>
                        {loan.transactions?.leads?.first_name
                          ? `${loan.transactions.leads.first_name} ${loan.transactions.leads.last_name || ""}`
                          : "N/A"}
                      </TableCell>
                      <TableCell>{formatCurrency(loan.loan_amount || loan.transactions?.contract_price)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={status.color}>
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDate(loan.transactions?.close_date)}</TableCell>
                      <TableCell>
                        {transactionId && (
                          <Button variant="ghost" size="icon" asChild>
                            <Link href={`/portal/lender/${transactionId}`}>
                              <ChevronRight className="h-4 w-4" />
                            </Link>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
