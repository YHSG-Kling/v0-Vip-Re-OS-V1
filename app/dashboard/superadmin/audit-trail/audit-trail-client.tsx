"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  FileText,
  DollarSign,
  Phone,
  Award,
  RefreshCw,
  Download,
  Search,
  MessageSquare,
  Shield,
  Activity,
  Eye,
  Calendar,
  Filter,
} from "lucide-react"
import { AuditEventRow } from "@/app/components/admin/AuditEventRow"
import { AuditEventDrawer } from "@/app/components/admin/AuditEventDrawer"

interface AuditEvent {
  id: string
  timestamp: string
  entity_type: string
  entity_id: string | null
  event_type: string
  actor_name: string
  subject_name: string | null
  summary: string
  metadata_json: Record<string, unknown>
  source_table: string
}

interface PaginationInfo {
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  hasMore: boolean
}

export function AuditTrailClient() {
  const router = useRouter()
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [pagination, setPagination] = useState<PaginationInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Filter state
  const [entityType, setEntityType] = useState("all")
  const [dateRange, setDateRange] = useState("last_7_days")
  const [customStartDate, setCustomStartDate] = useState("")
  const [customEndDate, setCustomEndDate] = useState("")
  const [category, setCategory] = useState("all")
  const [search, setSearch] = useState("")
  const [complianceOnly, setComplianceOnly] = useState(false)
  const [agentId, setAgentId] = useState("")

  const observerTarget = useRef<HTMLDivElement>(null)

  const fetchEvents = useCallback(async (page = 1, append = false) => {
    if (page === 1) {
      setLoading(true)
    } else {
      setLoadingMore(true)
    }

    try {
      const params = new URLSearchParams({
        entity_type: entityType,
        date_range: dateRange,
        category,
        search,
        compliance_only: complianceOnly.toString(),
        page: page.toString(),
      })

      if (dateRange === "custom") {
        if (customStartDate) params.set("start_date", customStartDate)
        if (customEndDate) params.set("end_date", customEndDate)
      }
      if (agentId) params.set("agent_id", agentId)

      const response = await fetch(`/api/admin/audit-events?${params}`)
      
      if (!response.ok) {
        if (response.redirected) {
          router.push("/dashboard")
          return
        }
        throw new Error("Failed to fetch events")
      }

      const data = await response.json()

      if (append) {
        setEvents(prev => [...prev, ...data.events])
      } else {
        setEvents(data.events)
      }
      setPagination(data.pagination)
    } catch (error) {
      console.error("Error fetching audit events:", error)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [entityType, dateRange, customStartDate, customEndDate, category, search, complianceOnly, agentId, router])

  useEffect(() => {
    fetchEvents(1)
  }, [fetchEvents])

  // Infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && pagination?.hasMore && !loadingMore) {
          fetchEvents(pagination.page + 1, true)
        }
      },
      { threshold: 0.1 }
    )

    if (observerTarget.current) {
      observer.observe(observerTarget.current)
    }

    return () => observer.disconnect()
  }, [pagination, loadingMore, fetchEvents])

  const handleExportCSV = async () => {
    const params = new URLSearchParams({
      entity_type: entityType,
      date_range: dateRange,
      category,
      search,
      compliance_only: complianceOnly.toString(),
      format: "csv",
    })

    if (dateRange === "custom") {
      if (customStartDate) params.set("start_date", customStartDate)
      if (customEndDate) params.set("end_date", customEndDate)
    }
    if (agentId) params.set("agent_id", agentId)

    window.open(`/api/admin/audit-events?${params}`, "_blank")
  }

  const handleEventClick = (event: AuditEvent) => {
    setSelectedEvent(event)
    setDrawerOpen(true)
  }

  const getEntityIcon = (entityType: string) => {
    switch (entityType) {
      case "message": return <MessageSquare className="h-4 w-4" />
      case "document": return <FileText className="h-4 w-4" />
      case "commission": return <DollarSign className="h-4 w-4" />
      case "voice_call": return <Phone className="h-4 w-4" />
      case "isa_call": return <Phone className="h-4 w-4" />
      case "badge": return <Award className="h-4 w-4" />
      case "accounting_sync": return <RefreshCw className="h-4 w-4" />
      case "portal_access": return <Eye className="h-4 w-4" />
      default: return <Activity className="h-4 w-4" />
    }
  }

  const isComplianceSensitive = (entityType: string) => {
    return ["commission", "document", "voice_call", "isa_call", "portal_access"].includes(entityType)
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Admin Audit Trail</h1>
            <p className="text-muted-foreground">
              Unified event timeline for compliance and admin review
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/superadmin/audit">Platform action ledger</Link>
            </Button>
            <Button onClick={handleExportCSV} variant="outline">
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Filter Bar */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Filter className="h-5 w-5" />
              Filters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {/* Entity Type */}
              <div className="space-y-2">
                <Label>Entity Type</Label>
                <Select value={entityType} onValueChange={setEntityType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="message">Message</SelectItem>
                    <SelectItem value="document">Document</SelectItem>
                    <SelectItem value="commission">Commission</SelectItem>
                    <SelectItem value="voice_call">Voice Call</SelectItem>
                    <SelectItem value="isa_call">ISA Call</SelectItem>
                    <SelectItem value="badge">Badge</SelectItem>
                    <SelectItem value="accounting_sync">Sync</SelectItem>
                    <SelectItem value="portal_access">Portal Access</SelectItem>
                    <SelectItem value="event">Event</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Date Range */}
              <div className="space-y-2">
                <Label>Date Range</Label>
                <Select value={dateRange} onValueChange={setDateRange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="last_7_days">Last 7 Days</SelectItem>
                    <SelectItem value="last_30_days">Last 30 Days</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Category */}
              <div className="space-y-2">
                <Label>Event Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="financial">Financial</SelectItem>
                    <SelectItem value="communication">Communication</SelectItem>
                    <SelectItem value="compliance">Compliance</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Search */}
              <div className="space-y-2">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search events..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>

              {/* Agent — `agentId` was already sent as `agent_id` on every fetch
                  and on the CSV export, and the route narrows on it
                  (app/api/admin/audit-events/route.ts:443 — metadata agent_id
                  match OR actor-name substring), but no control ever set it, so
                  the filter existed only in the query string. Same shape as
                  Search; the placeholder names both things the route accepts. */}
              <div className="space-y-2">
                <Label>Agent</Label>
                <Input
                  placeholder="Agent id or name"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                />
              </div>
            </div>

            {/* Custom Date Range */}
            {dateRange === "custom" && (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Start Date</Label>
                  <Input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>End Date</Label>
                  <Input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Compliance Toggle */}
            <div className="mt-4 flex items-center gap-3">
              <Switch
                id="compliance-only"
                checked={complianceOnly}
                onCheckedChange={setComplianceOnly}
              />
              <Label htmlFor="compliance-only" className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-amber-600" />
                Show Compliance Events Only
              </Label>
            </div>
          </CardContent>
        </Card>

        {/* Audit Timeline */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Event Timeline
              </span>
              {pagination && (
                <Badge variant="secondary">
                  {pagination.totalCount} events
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[...Array(10)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Activity className="h-12 w-12 text-muted-foreground" />
                <h3 className="mt-4 text-lg font-semibold">No events found</h3>
                <p className="text-muted-foreground">
                  No events found for the selected filters
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {events.map((event) => (
                  <AuditEventRow
                    key={event.id}
                    event={event}
                    icon={getEntityIcon(event.entity_type)}
                    isComplianceSensitive={isComplianceSensitive(event.entity_type)}
                    onClick={() => handleEventClick(event)}
                  />
                ))}

                {/* Infinite scroll observer */}
                <div ref={observerTarget} className="h-4" />

                {loadingMore && (
                  <div className="flex justify-center py-4">
                    <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Event Drawer */}
      <AuditEventDrawer
        event={selectedEvent}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  )
}
