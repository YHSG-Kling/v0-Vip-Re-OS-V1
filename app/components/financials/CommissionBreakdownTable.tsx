"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, FileText } from "lucide-react"

interface Distribution {
  id: string
  distribution_type: string
  calculated_amount: number
  recipient_type: string
}

interface EarningsRecord {
  id: string
  transaction_id: string
  property_address?: string
  paid_date: string
  gross_commission: number
  agent_net: number
  brokerage_net: number
  total_fees: number
  distributions?: Distribution[]
}

interface CommissionBreakdownTableProps {
  earningsHistory: EarningsRecord[]
}

export function CommissionBreakdownTable({ earningsHistory }: CommissionBreakdownTableProps) {
  const [filter, setFilter] = useState<string>("all")
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 20

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }

  // Filter data based on selected filter
  const filteredData = earningsHistory.filter((record) => {
    if (filter === "all") return true
    const recordDate = new Date(record.paid_date)
    const currentYear = new Date().getFullYear()
    
    if (filter === "this_year") {
      return recordDate.getFullYear() === currentYear
    }
    if (filter === "last_year") {
      return recordDate.getFullYear() === currentYear - 1
    }
    return true
  })

  // Pagination
  const totalPages = Math.ceil(filteredData.length / pageSize)
  const paginatedData = filteredData.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  )

  const toggleRow = (id: string) => {
    const newExpanded = new Set(expandedRows)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedRows(newExpanded)
  }

  if (earningsHistory.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Commission Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              No closed transactions yet — your earnings will appear here once you close your first deal
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Commission Breakdown
            </CardTitle>
            <CardDescription>
              {filteredData.length} transaction{filteredData.length !== 1 ? "s" : ""}
            </CardDescription>
          </div>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="this_year">This Year</SelectItem>
              <SelectItem value="last_year">Last Year</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]"></TableHead>
                <TableHead>Property</TableHead>
                <TableHead>Close Date</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Agent Net</TableHead>
                <TableHead className="text-right">Brokerage Net</TableHead>
                <TableHead className="text-right">Fees</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedData.map((record) => (
                <Collapsible key={record.id} asChild>
                  <>
                    <CollapsibleTrigger asChild>
                      <TableRow 
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleRow(record.id)}
                      >
                        <TableCell>
                          {expandedRows.has(record.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </TableCell>
                        <TableCell className="font-medium">
                          {record.property_address || "Transaction"}
                        </TableCell>
                        <TableCell>{formatDate(record.paid_date)}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(record.gross_commission)}
                        </TableCell>
                        <TableCell className="text-right text-green-600 font-medium">
                          {formatCurrency(record.agent_net)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(record.brokerage_net)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatCurrency(record.total_fees)}
                        </TableCell>
                      </TableRow>
                    </CollapsibleTrigger>
                    <CollapsibleContent asChild>
                      {expandedRows.has(record.id) && record.distributions && record.distributions.length > 0 ? (
                        <TableRow className="bg-muted/30">
                          <TableCell colSpan={7} className="p-0">
                            <div className="p-4 space-y-2">
                              <p className="text-sm font-medium text-muted-foreground mb-2">
                                Distribution Breakdown
                              </p>
                              <div className="grid grid-cols-3 gap-2">
                                {record.distributions.map((dist) => (
                                  <div
                                    key={dist.id}
                                    className="flex items-center justify-between p-2 bg-background rounded border"
                                  >
                                    <div className="flex items-center gap-2">
                                      <Badge variant="outline" className="text-xs">
                                        {dist.distribution_type}
                                      </Badge>
                                      <span className="text-sm text-muted-foreground">
                                        {dist.recipient_type}
                                      </span>
                                    </div>
                                    <span className="text-sm font-medium">
                                      {formatCurrency(dist.calculated_amount)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </CollapsibleContent>
                  </>
                </Collapsible>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-muted-foreground">
              Showing {(currentPage - 1) * pageSize + 1} to{" "}
              {Math.min(currentPage * pageSize, filteredData.length)} of{" "}
              {filteredData.length}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
