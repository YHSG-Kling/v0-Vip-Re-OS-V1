"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ChevronRight,
  Search,
  FileText,
  AlertTriangle,
  DollarSign,
  CheckCircle2,
} from "lucide-react"

interface Transaction {
  id: string
  transaction_id: string
  title_company?: string
  escrow_number?: string
  title_status?: string
  earnest_money_status?: string
  earnest_money_amount?: number
  title_issues?: any[]
  transactions?: {
    id: string
    property_address?: string
    status?: string
    close_date?: string
    closing_date?: string
    purchase_price?: number
    agents?: {
      first_name?: string
      last_name?: string
    }
  }
}

const TITLE_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  title_search: { label: "Title Search", color: "bg-blue-100 text-blue-800" },
  pending: { label: "Pending", color: "bg-slate-100 text-slate-800" },
  commitment_issued: { label: "Commitment Issued", color: "bg-amber-100 text-amber-800" },
  closing_ready: { label: "Closing Ready", color: "bg-green-100 text-green-800" },
  clear: { label: "Clear", color: "bg-emerald-100 text-emerald-800" },
  closed: { label: "Closed", color: "bg-slate-100 text-slate-600" },
}

const EMD_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "bg-orange-100 text-orange-800" },
  received: { label: "Received", color: "bg-green-100 text-green-800" },
  released: { label: "Released", color: "bg-slate-100 text-slate-600" },
}

function formatDate(date: string | null | undefined): string {
  if (!date) return "TBD"
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function formatCurrency(amount: number | null | undefined): string {
  if (!amount) return "N/A"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)
}

export function TitleTransactionList({ transactions }: { transactions: Transaction[] }) {
  const [search, setSearch] = useState("")
  const [activeTab, setActiveTab] = useState("all")

  // Filter transactions
  const filteredTransactions = transactions.filter((txn) => {
    const address = txn.transactions?.property_address?.toLowerCase() || ""
    const escrowNum = txn.escrow_number?.toLowerCase() || ""
    const searchLower = search.toLowerCase()

    const matchesSearch = address.includes(searchLower) || escrowNum.includes(searchLower)

    if (activeTab === "all") return matchesSearch
    if (activeTab === "issues") return matchesSearch && (txn.title_issues?.length || 0) > 0
    if (activeTab === "pending_emd") return matchesSearch && txn.earnest_money_status === "pending"
    if (activeTab === "ready")
      return matchesSearch && (txn.title_status === "closing_ready" || txn.title_status === "clear")

    return matchesSearch
  })

  const issuesCount = transactions.filter((t) => (t.title_issues?.length || 0) > 0).length
  const pendingEmdCount = transactions.filter((t) => t.earnest_money_status === "pending").length
  const readyCount = transactions.filter(
    (t) => t.title_status === "closing_ready" || t.title_status === "clear"
  ).length

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <TabsList>
          <TabsTrigger value="all">All Files ({transactions.length})</TabsTrigger>
          <TabsTrigger value="issues">
            <AlertTriangle className="h-4 w-4 mr-1" />
            Issues ({issuesCount})
          </TabsTrigger>
          <TabsTrigger value="pending_emd">
            <DollarSign className="h-4 w-4 mr-1" />
            Pending EMD ({pendingEmdCount})
          </TabsTrigger>
          <TabsTrigger value="ready">
            <CheckCircle2 className="h-4 w-4 mr-1" />
            Ready ({readyCount})
          </TabsTrigger>
        </TabsList>

        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search address or escrow #..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Transaction Files</CardTitle>
          <CardDescription>
            {activeTab === "all" && "All assigned title and escrow files"}
            {activeTab === "issues" && "Transactions with unresolved title issues"}
            {activeTab === "pending_emd" && "Awaiting earnest money deposits"}
            {activeTab === "ready" && "Clear title, ready for closing"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Property</TableHead>
                  <TableHead>Escrow #</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Title Status</TableHead>
                  <TableHead>EMD Status</TableHead>
                  <TableHead>Close Date</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTransactions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-muted-foreground">No transactions found</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTransactions.map((txn) => {
                    const titleStatus = TITLE_STATUS_CONFIG[txn.title_status || "pending"] || TITLE_STATUS_CONFIG.pending
                    const emdStatus = EMD_STATUS_CONFIG[txn.earnest_money_status || "pending"] || EMD_STATUS_CONFIG.pending
                    const hasIssues = (txn.title_issues?.length || 0) > 0
                    const closeDate = txn.transactions?.close_date || txn.transactions?.closing_date

                    return (
                      <TableRow key={txn.id} className="hover:bg-muted/50">
                        <TableCell>
                          <div className="flex items-start gap-2">
                            <div className="min-w-0">
                              <p className="font-medium truncate">
                                {txn.transactions?.property_address || "Address pending"}
                              </p>
                              {hasIssues && (
                                <div className="flex items-center gap-1 text-red-600 text-xs mt-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  {txn.title_issues?.length} issue(s)
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {txn.escrow_number || "—"}
                        </TableCell>
                        <TableCell>
                          {txn.transactions?.agents?.first_name
                            ? `${txn.transactions.agents.first_name} ${txn.transactions.agents.last_name || ""}`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={titleStatus.color}>
                            {titleStatus.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={emdStatus.color}>
                            {emdStatus.label}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatDate(closeDate)}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" asChild>
                            <Link href={`/portal/title/${txn.transaction_id}`}>
                              <ChevronRight className="h-4 w-4" />
                            </Link>
                          </Button>
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
    </Tabs>
  )
}
