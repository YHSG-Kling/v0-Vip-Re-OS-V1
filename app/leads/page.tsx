"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Upload,
  Search,
  Eye,
  Sparkles,
  UserPlus,
  X,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react"
import {
  getLeads,
  enrichLead,
  convertLeadToContact,
  rejectLead,
  type Lead,
  type LeadScore,
  type LeadIntent,
  type LeadStatus,
  type LeadSource,
} from "@/app/actions/lead-management"
import { cn } from "@/lib/utils"

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)

  // Filters
  const [search, setSearch] = useState("")
  const [scoreFilter, setScoreFilter] = useState<LeadScore | "all">("all")
  const [intentFilter, setIntentFilter] = useState<LeadIntent | "all">("all")
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">("all")
  const [sourceFilter, setSourceFilter] = useState<LeadSource | "all">("all")

  // Sorting
  const [sortBy, setSortBy] = useState("created_at")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc")

  // Actions
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Fetch leads
  const fetchLeads = async () => {
    setLoading(true)
    const result = await getLeads({
      search: search || undefined,
      score: scoreFilter !== "all" ? scoreFilter : undefined,
      intent: intentFilter !== "all" ? intentFilter : undefined,
      status: statusFilter !== "all" ? statusFilter : undefined,
      source: sourceFilter !== "all" ? sourceFilter : undefined,
      page,
      limit: 10,
      sortBy,
      sortOrder,
    })

    if (result.success) {
      setLeads(result.leads as Lead[])
      setTotal(result.total)
      setTotalPages(result.totalPages)
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchLeads()
  }, [page, scoreFilter, intentFilter, statusFilter, sourceFilter, sortBy, sortOrder])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (page === 1) {
        fetchLeads()
      } else {
        setPage(1)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [search])

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortBy(column)
      setSortOrder("desc")
    }
  }

  const handleEnrich = async (leadId: string) => {
    setActionLoading(leadId)
    const result = await enrichLead(leadId)
    if (result.success) {
      fetchLeads()
    }
    setActionLoading(null)
  }

  const handleConvert = async (leadId: string) => {
    setActionLoading(leadId)
    const result = await convertLeadToContact(leadId)
    if (result.success) {
      fetchLeads()
    }
    setActionLoading(null)
  }

  const handleReject = async (leadId: string) => {
    setActionLoading(leadId)
    const result = await rejectLead(leadId)
    if (result.success) {
      fetchLeads()
    }
    setActionLoading(null)
  }

  const getScoreColor = (score: LeadScore) => {
    if (score <= 2) return "text-destructive"
    if (score === 3) return "text-warning"
    return "text-success"
  }

  const getScoreBadgeVariant = (score: LeadScore) => {
    if (score <= 2) return "destructive"
    if (score === 3) return "secondary"
    return "default"
  }

  const getSourceColor = (source: LeadSource) => {
    const colors: Record<LeadSource, string> = {
      scraped: "bg-primary text-primary-foreground",
      website_form: "bg-accent text-accent-foreground",
      ghl: "bg-muted text-muted-foreground",
      manual: "bg-secondary text-secondary-foreground",
    }
    return colors[source]
  }

  const getStatusColor = (status: LeadStatus) => {
    const colors: Record<LeadStatus, "default" | "secondary" | "destructive" | "outline"> = {
      new: "secondary",
      enriched: "default",
      qualified: "default",
      converted: "default",
      rejected: "destructive",
    }
    return colors[status]
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Lead Management</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {total} total leads · Page {page} of {totalPages}
            </p>
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <Button>
                <Upload className="h-4 w-4 mr-2" />
                Import Leads
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Import Leads</DialogTitle>
                <DialogDescription>Upload a CSV file or paste lead data to import</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                  <Upload className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-foreground font-medium">Drop CSV file here or click to browse</p>
                  <p className="text-xs text-muted-foreground mt-1">CSV format: name, email, phone, source</p>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Filters Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              {/* Search */}
              <div className="md:col-span-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name, email, or phone..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              {/* Score Filter */}
              <Select value={scoreFilter.toString()} onValueChange={(v) => setScoreFilter(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="All Scores" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scores</SelectItem>
                  <SelectItem value="1">Score 1 (Low)</SelectItem>
                  <SelectItem value="2">Score 2</SelectItem>
                  <SelectItem value="3">Score 3 (Medium)</SelectItem>
                  <SelectItem value="4">Score 4</SelectItem>
                  <SelectItem value="5">Score 5 (High)</SelectItem>
                </SelectContent>
              </Select>

              {/* Intent Filter */}
              <Select value={intentFilter} onValueChange={(v) => setIntentFilter(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="All Intents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Intents</SelectItem>
                  <SelectItem value="buying">Buying</SelectItem>
                  <SelectItem value="selling">Selling</SelectItem>
                  <SelectItem value="distress">Distress</SelectItem>
                  <SelectItem value="investor">Investor</SelectItem>
                </SelectContent>
              </Select>

              {/* Status Filter */}
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="enriched">Enriched</SelectItem>
                  <SelectItem value="qualified">Qualified</SelectItem>
                  <SelectItem value="converted">Converted</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Active Filters */}
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              {scoreFilter !== "all" && (
                <Badge variant="secondary" className="gap-1">
                  Score: {scoreFilter}
                  <button onClick={() => setScoreFilter("all")} className="ml-1 hover:bg-muted rounded-full">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {intentFilter !== "all" && (
                <Badge variant="secondary" className="gap-1">
                  Intent: {intentFilter}
                  <button onClick={() => setIntentFilter("all")} className="ml-1 hover:bg-muted rounded-full">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {statusFilter !== "all" && (
                <Badge variant="secondary" className="gap-1">
                  Status: {statusFilter}
                  <button onClick={() => setStatusFilter("all")} className="ml-1 hover:bg-muted rounded-full">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Leads Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <button
                        onClick={() => handleSort("source")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Source
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() => handleSort("first_name")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Name
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>
                      <button
                        onClick={() => handleSort("ai_score")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        AI Score
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>Intent</TableHead>
                    <TableHead>
                      <button
                        onClick={() => handleSort("status")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Status
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() => handleSort("created_at")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Created
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
                        <p className="text-sm text-muted-foreground mt-2">Loading leads...</p>
                      </TableCell>
                    </TableRow>
                  ) : leads.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-12">
                        <p className="text-sm text-muted-foreground">No leads found</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    leads.map((lead) => (
                      <TableRow key={lead.id}>
                        <TableCell>
                          <Badge className={cn("capitalize", getSourceColor(lead.source))}>{lead.source}</Badge>
                        </TableCell>
                        <TableCell className="font-medium">
                          {lead.first_name} {lead.last_name}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{lead.email || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{lead.phone || "—"}</TableCell>
                        <TableCell>
                          <Badge variant={getScoreBadgeVariant(lead.ai_score)} className={getScoreColor(lead.ai_score)}>
                            {lead.ai_score}/5
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {lead.intent ? (
                            <Badge variant="outline" className="capitalize">
                              {lead.intent}
                            </Badge>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={getStatusColor(lead.status)} className="capitalize">
                            {lead.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(lead.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" disabled={actionLoading === lead.id}>
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEnrich(lead.id)}
                              disabled={actionLoading === lead.id || lead.status === "enriched"}
                            >
                              {actionLoading === lead.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Sparkles className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleConvert(lead.id)}
                              disabled={actionLoading === lead.id || lead.status === "converted"}
                            >
                              <UserPlus className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleReject(lead.id)}
                              disabled={actionLoading === lead.id || lead.status === "rejected"}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {(page - 1) * 10 + 1} to {Math.min(page * 10, total)} of {total} leads
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(page - 1)} disabled={page === 1}>
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const pageNum = i + 1
                  return (
                    <Button
                      key={pageNum}
                      variant={page === pageNum ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPage(pageNum)}
                    >
                      {pageNum}
                    </Button>
                  )
                })}
              </div>
              <Button variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={page === totalPages}>
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
