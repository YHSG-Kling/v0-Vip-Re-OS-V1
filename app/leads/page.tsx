"use client"

import { useState, useEffect, Fragment, useCallback } from "react"
import { useRouter } from "next/navigation"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Home,
  Brain,
  ExternalLink,
  Zap,
} from "lucide-react"
import { AvailableLeadsSheet } from "@/app/components/leads/AvailableLeadsSheet"
import {
  getLeads,
  enrichLead,
  convertLeadToContact,
  rejectLead,
} from "@/app/actions/lead-management"
import { getHotLeads } from "@/app/actions/ai-auto-response"
import { getTopConversionCandidates, aiPropertyMatchGenius } from "@/app/actions/ai-predictions"
import {
  getIntelligenceDashboardStats,
  getMotivatedSellers,
  getUnifiedLeadProfiles,
} from "@/app/actions/lead-intelligence"
import LeadIntelligencePanel from "@/app/components/intelligence/LeadIntelligencePanel"
import { initiateWhisperBridge, triggerVapiVoiceBot } from "@/app/actions/voice-call-bridge"
import { aiBatchReengagement } from "@/app/actions/ai-lead-nurturing"
import { HotLeadCard } from "@/app/components/shared/HotLeadCard"
import type { Lead, LeadScore, LeadIntent, LeadStatus, LeadSource } from "@/app/types/lead-management"
import { cn } from "@/lib/utils"
import { createClient } from "@/lib/supabase/client"
import { Zap } from "lucide-react"

export default function LeadsPage() {
  const router = useRouter()

  // Role resolution state
  const [isAdminOrBroker, setIsAdminOrBroker] = useState(false)
  const [roleResolved, setRoleResolved] = useState(false)

  // Available leads sheet
  const [availableSheetOpen, setAvailableSheetOpen] = useState(false)

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

  // Hot leads
  const [hotLeads, setHotLeads] = useState<any[]>([])
  const [hotLeadsLoading, setHotLeadsLoading] = useState(true)
  const [agentId, setAgentId] = useState('')
  const [brokerageId, setBrokerageId] = useState('')
  const [callingId, setCallingId] = useState<string | null>(null)

  // Top conversion candidates
  const [conversionCandidates, setConversionCandidates] = useState<any[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(true)

  // Lead intelligence dashboard
  const [intelligenceStats, setIntelligenceStats] = useState<any>(null)
  const [motivatedSellers, setMotivatedSellers] = useState<any[]>([])
  const [sellersExpanded, setSellersExpanded] = useState(false)

  // Unified lead profiles (Part C — ready for outreach, min confidence 70)
  const [unifiedProfiles, setUnifiedProfiles] = useState<any[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)

  // Selected lead for inline LeadIntelligencePanel
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null)
  const [selectedLeadData, setSelectedLeadData] = useState<any>(null)

  // Batch reengagement
  const [batchReengagementLoading, setBatchReengagementLoading] = useState(false)
  const [batchReengagementResult, setBatchReengagementResult] = useState<any>(null)

  // AI Property Match Genius per lead
  const [matchGeniusLoading, setMatchGeniusLoading] = useState<string | null>(null)
  const [matchGeniusResults, setMatchGeniusResults] = useState<Record<string, any>>({})

  const handleMatchGenius = async (leadId: string) => {
    setMatchGeniusLoading(leadId)
    try {
      const result = await aiPropertyMatchGenius(leadId)
      if (result && !result.error) {
        setMatchGeniusResults((prev) => ({ ...prev, [leadId]: result }))
      }
    } catch (err) {
      console.error("[v0] aiPropertyMatchGenius failed:", err)
    } finally {
      setMatchGeniusLoading(null)
    }
  }

  const handleBatchReengagement = async () => {
    if (!agentId) return
    setBatchReengagementLoading(true)
    setBatchReengagementResult(null)
    try {
      const res = await aiBatchReengagement({ agentId, daysInactive: 30, maxLeads: 50 })
      setBatchReengagementResult(res)
    } catch (err) {
      setBatchReengagementResult({ success: false, error: "Failed to run batch reengagement" })
    } finally {
      setBatchReengagementLoading(false)
    }
  }

  // Fetch leads — respects resolved role; waits until role is known
  const fetchLeads = useCallback(async () => {
    if (!roleResolved) return
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
      adminView: isAdminOrBroker,
    })

    if (result.success) {
      setLeads(result.leads as Lead[])
      setTotal(result.total)
      setTotalPages(result.totalPages)
    }
    setLoading(false)
  }, [roleResolved, isAdminOrBroker, search, scoreFilter, intentFilter, statusFilter, sourceFilter, page, sortBy, sortOrder])

  useEffect(() => {
    fetchLeads()
  }, [fetchLeads])

  // Load hot leads, resolve agentId, and enforce role-based access
  useEffect(() => {
    const loadHotLeads = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Resolve user role
      const { data: profile } = await supabase
        .from("users")
        .select("user_type, role")
        .eq("id", user.id)
        .single()

      const resolvedType = profile?.user_type ?? profile?.role ?? "agent"

      // TC / vendor / lender: redirect immediately
      if (["tc", "vendor", "lender"].includes(resolvedType)) {
        router.push("/dashboard")
        return
      }

      const adminBroker = ["admin", "broker", "superadmin"].includes(resolvedType)
      setIsAdminOrBroker(adminBroker)

      // Resolve brokerageId from users table
      const { data: userRow } = await supabase
        .from("users")
        .select("brokerage_id")
        .eq("id", user.id)
        .single()
      if (userRow?.brokerage_id) {
        setBrokerageId(userRow.brokerage_id)
      }

      // Resolve agentId
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()
      const resolvedAgentId = agentRow?.id || ''
      setAgentId(resolvedAgentId)

      // Mark role resolved — triggers fetchLeads
      setRoleResolved(true)

      // Load hot leads
      try {
        const leads = await getHotLeads(5)
        setHotLeads(Array.isArray(leads) ? leads : [])
      } catch {
        setHotLeads([])
      } finally {
        setHotLeadsLoading(false)
      }

      // Load top conversion candidates
      try {
        const candidates = await getTopConversionCandidates(3)
        setConversionCandidates(Array.isArray(candidates) ? candidates : [])
      } catch {
        setConversionCandidates([])
      } finally {
        setCandidatesLoading(false)
      }

      // Load intelligence stats + motivated sellers + unified profiles in parallel
      setProfilesLoading(true)
      const [statsResult, sellersResult, profilesResult] = await Promise.all([
        getIntelligenceDashboardStats().catch(() => null),
        getMotivatedSellers({ min_score: 60 }).catch(() => ({ success: false, sellers: [] })),
        getUnifiedLeadProfiles({ ready_for_outreach: true, min_confidence: 70 }).catch(() => ({ success: false, profiles: [] })),
      ])
      if (statsResult?.success) setIntelligenceStats(statsResult.stats)
      setMotivatedSellers(sellersResult?.sellers ?? [])
      setUnifiedProfiles(profilesResult?.profiles ?? [])
      setProfilesLoading(false)
    }
    loadHotLeads()
  }, [])

  // Debounced search — only runs after role is resolved
  useEffect(() => {
    if (!roleResolved) return
    const timer = setTimeout(() => {
      if (page === 1) {
        fetchLeads()
      } else {
        setPage(1)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [search, roleResolved])

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

  const handleWhisperBridge = async (contactId: string, context: string) => {
    if (!agentId) return
    setCallingId(contactId + 'whisper')
    try {
      await initiateWhisperBridge({ contactId, agentId, context })
    } catch {}
    setCallingId(null)
  }

  const handleVapiBot = async (contactId: string, triggerEvent: string) => {
    setCallingId(contactId + 'vapi')
    try {
      await triggerVapiVoiceBot({ contactId, triggerEvent })
    } catch {}
    setCallingId(null)
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

  const getLeadStatusBadge = (lead: any): { label: string; color: string } => {
    if (!lead.agent_id && !lead.assigned_agent_id) return { label: "Unassigned", color: "bg-amber-100 text-amber-800" }
    if (lead.lifecycle_state === "isa_qualifying") return { label: "AI-ISA Qualifying", color: "bg-purple-100 text-purple-800" }
    if (lead.reengagement_status === "active") return { label: "Ghost Recovery", color: "bg-red-100 text-red-800" }
    if (lead.lead_stage === "stale") return { label: "Stale", color: "bg-gray-100 text-gray-600" }
    if (lead.lead_stage === "claimed") return { label: "Claimed", color: "bg-blue-100 text-blue-800" }
    if (lead.lead_stage === "qualified") return { label: "Qualified", color: "bg-green-100 text-green-800" }
    return { label: lead.lead_stage || "New", color: "bg-slate-100 text-slate-700" }
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
          <div className="flex items-center gap-2">
            {/* Available Leads pool — visible to agents only */}
            {roleResolved && !isAdminOrBroker && (
              <Button
                variant="outline"
                onClick={() => setAvailableSheetOpen(true)}
              >
                <Zap className="h-4 w-4 mr-2 text-yellow-500" />
                Available Leads
              </Button>
            )}
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
        </div>

        {/* Role-aware context strip */}
        {roleResolved && (
          <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5">
            {isAdminOrBroker ? (
              <>
                <Badge className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100">
                  Brokerage View — All Leads
                </Badge>
                {leads.filter((l: any) => !(l.agent_id || l.assigned_agent_id)).length > 0 && (
                  <span className="text-sm text-muted-foreground">
                    {leads.filter((l: any) => !(l.agent_id || l.assigned_agent_id)).length} awaiting assignment
                  </span>
                )}
              </>
            ) : (
              <>
                <Badge className="bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-100">
                  My Leads
                </Badge>
                <span className="text-sm text-muted-foreground">Showing leads assigned to you</span>
              </>
            )}
          </div>
        )}

        <Tabs defaultValue="leads" className="space-y-6">
          <TabsList>
            <TabsTrigger value="leads">Lead List</TabsTrigger>
            <TabsTrigger value="intelligence" className="flex items-center gap-1.5">
              <Brain className="h-3.5 w-3.5" />
              Intelligence
              {intelligenceStats?.readyForOutreach > 0 && (
                <span className="ml-1 rounded-full bg-primary text-primary-foreground text-xs px-1.5 py-0.5 leading-none">
                  {intelligenceStats.readyForOutreach}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="leads" className="space-y-6 mt-0">

        {/* Admin stale/ghost recovery alert strip */}
        {isAdminOrBroker && leads.length > 0 && (() => {
          const staleLeads = leads.filter((l: any) => l.lead_stage === "stale")
          const ghostLeads = leads.filter((l: any) => l.reengagement_status === "active")
          if (staleLeads.length === 0 && ghostLeads.length === 0) return null
          return (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0 h-4 w-4 text-amber-600">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                </span>
                <p className="text-sm text-amber-900 font-medium truncate">
                  {staleLeads.length > 0 && `${staleLeads.length} stale lead${staleLeads.length !== 1 ? "s" : ""} need attention`}
                  {staleLeads.length > 0 && ghostLeads.length > 0 && " — "}
                  {ghostLeads.length > 0 && `${ghostLeads.length} in AI ghost recovery`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {staleLeads.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-300 text-amber-800 hover:bg-amber-100 text-xs h-7"
                    onClick={() => setStatusFilter("stale" as any)}
                  >
                    Review Stale
                  </Button>
                )}
                {ghostLeads.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-300 text-amber-800 hover:bg-amber-100 text-xs h-7"
                    onClick={() => setStatusFilter("ghost_recovery" as any)}
                  >
                    Review Ghost Recovery
                  </Button>
                )}
              </div>
            </div>
          )
        })()}

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

        {/* Hot Leads Section */}
        {(hotLeads.length > 0 || hotLeadsLoading) && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-5 w-5 text-amber-500" />
              <h2 className="text-base font-semibold">Hot Leads Now</h2>
              {!hotLeadsLoading && (
                <Badge variant="secondary" className="text-xs">{hotLeads.length} active signals</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              These contacts are showing real buying signals right now.
            </p>
            {hotLeadsLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {[1, 2, 3].map(i => <div key={i} className="h-28 bg-muted animate-pulse rounded-lg" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {hotLeads.map(lead => (
                  <HotLeadCard
                    key={lead.id}
                    lead={lead}
                    onWhisperBridge={handleWhisperBridge}
                    onVapiBot={handleVapiBot}
                    callingId={callingId}
                    compact={false}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Top Conversion Candidates */}
        {(conversionCandidates.length > 0 || candidatesLoading) && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-5 w-5 text-emerald-500" />
              <h2 className="text-base font-semibold">Most Likely to Convert</h2>
              <span className="text-xs text-muted-foreground">AI-ranked by conversion probability</span>
            </div>
            {candidatesLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {conversionCandidates.map((candidate: any) => {
                  const lead = candidate.leads
                  const contact = candidate.contacts
                  const name = lead
                    ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim()
                    : contact
                    ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
                    : "Unknown"
                  const probability = Math.round((candidate.conversion_probability ?? 0) * 100)
                  const tier = candidate.score_tier ?? "bronze"
                  const tierColors: Record<string, string> = {
                    platinum: "bg-violet-100 text-violet-800 border-violet-200",
                    gold: "bg-amber-100 text-amber-800 border-amber-200",
                    silver: "bg-slate-100 text-slate-700 border-slate-200",
                    bronze: "bg-orange-100 text-orange-800 border-orange-200",
                  }
                  const contactId = candidate.contacts?.id
                  return (
                    <div
                      key={candidate.lead_id}
                      className="rounded-lg border bg-card p-4 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{name || "Unnamed Lead"}</p>
                        <span className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tierColors[tier] ?? tierColors.bronze}`}>
                          {tier}
                        </span>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-2xl font-bold text-emerald-600">{probability}%</p>
                        <p className="text-xs text-muted-foreground">conversion</p>
                      </div>
                      {contactId && (
                        <a
                          href={`/crm/${contactId}`}
                          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
                        >
                          Open Contact
                        </a>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Lead Intelligence Dashboard */}
        {intelligenceStats && (
          <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Total Profiles</p>
              <p className="text-2xl font-bold">{intelligenceStats.totalLeads}</p>
              <p className="text-xs text-emerald-600">{intelligenceStats.hotLeads} hot</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Ready for Outreach</p>
              <p className="text-2xl font-bold">{intelligenceStats.readyForOutreach}</p>
              <p className="text-xs text-muted-foreground">AI-qualified</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Motivated Sellers</p>
              <p className="text-2xl font-bold">{intelligenceStats.motivatedSellers}</p>
              <p className="text-xs text-amber-600">Active signals</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Conversion Rate</p>
              <p className="text-2xl font-bold">
                {intelligenceStats.totalLeads > 0
                  ? Math.round((intelligenceStats.readyForOutreach / intelligenceStats.totalLeads) * 100)
                  : 0}%
              </p>
              <p className="text-xs text-muted-foreground">Pipeline to outreach</p>
            </Card>
          </div>
        )}

          {/* Motivated Sellers — collapsible, starts collapsed — in Lead List tab */}
          {motivatedSellers.length > 0 && (
          <div className="mb-6 rounded-lg border bg-card">
            <button
              onClick={() => setSellersExpanded((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors rounded-lg"
            >
              <span className="flex items-center gap-2">
                <Home className="h-4 w-4 text-amber-500" />
                {motivatedSellers.length} Motivated Seller{motivatedSellers.length !== 1 ? "s" : ""} detected
              </span>
              {sellersExpanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {sellersExpanded && (
              <div className="px-4 pb-4">
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {motivatedSellers.map((seller: any, i: number) => {
                    const prop = seller.property
                    const address = prop?.address ?? "Unknown address"
                    const city = prop?.city ?? ""
                    const score = seller.readiness_to_sell_score ?? 0
                    const timeframe = seller.predicted_timeframe ?? "unknown"
                    const signalType = seller.motivation_type ?? seller.signal_source ?? "signal detected"
                    const profileId = seller.unified_lead_profile_id ?? null
                    return (
                      <div
                        key={seller.id ?? i}
                        className="shrink-0 w-56 rounded-lg border bg-background p-3 flex flex-col gap-2"
                      >
                        <div>
                          <p className="text-sm font-medium leading-snug truncate">{address}</p>
                          {city && <p className="text-xs text-muted-foreground">{city}</p>}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
                            Score: {score}
                          </span>
                          <span className="text-xs text-muted-foreground capitalize">{timeframe}</span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate capitalize">{signalType}</p>
                        {profileId && (
                          <a
                            href={`/crm/${profileId}`}
                            className="mt-auto text-xs text-primary underline underline-offset-2 hover:no-underline"
                          >
                            View Profile
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

          </TabsContent>

          {/* ── INTELLIGENCE TAB ──────────────────────────────────── */}
          <TabsContent value="intelligence" className="space-y-6 mt-0">

            {/* Stats row */}
            {intelligenceStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Total Profiles</p>
                  <p className="text-2xl font-bold">{intelligenceStats.totalLeads}</p>
                  <p className="text-xs text-emerald-600">{intelligenceStats.hotLeads} hot</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Ready for Outreach</p>
                  <p className="text-2xl font-bold">{intelligenceStats.readyForOutreach}</p>
                  <p className="text-xs text-muted-foreground">AI-qualified</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Motivated Sellers</p>
                  <p className="text-2xl font-bold">{intelligenceStats.motivatedSellers}</p>
                  <p className="text-xs text-amber-600">Active signals</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Pipeline Rate</p>
                  <p className="text-2xl font-bold">
                    {intelligenceStats.totalLeads > 0
                      ? Math.round((intelligenceStats.readyForOutreach / intelligenceStats.totalLeads) * 100)
                      : 0}%
                  </p>
                  <p className="text-xs text-muted-foreground">to outreach</p>
                </Card>
              </div>
            )}

            {/* Batch Reengagement */}
            <div className="flex items-center justify-between rounded-lg border bg-card p-4">
              <div>
                <p className="text-sm font-semibold">AI Batch Reengagement</p>
                <p className="text-xs text-muted-foreground">
                  Identify and plan outreach for leads inactive for 30+ days
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBatchReengagement}
                  disabled={batchReengagementLoading || !agentId}
                  className="gap-1.5 shrink-0"
                >
                  {batchReengagementLoading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Zap className="h-3.5 w-3.5 text-amber-500" />}
                  Run Reengagement
                </Button>
                {batchReengagementResult?.success && batchReengagementResult.reengagementPlan && (
                  <Badge variant="secondary" className="text-xs">
                    {batchReengagementResult.reengagementPlan.totalLeads ?? "—"} leads queued
                  </Badge>
                )}
              </div>
            </div>
            {batchReengagementResult?.success && batchReengagementResult.reengagementPlan?.leads?.length > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs">
                <p className="font-semibold text-sm">Reengagement Plan</p>
                {batchReengagementResult.reengagementPlan.leads.slice(0, 5).map((lead: any, i: number) => (
                  <div key={i} className="flex items-start justify-between gap-2 border-b pb-2 last:border-0 last:pb-0">
                    <div>
                      <p className="font-medium">{lead.name ?? lead.email ?? `Lead ${i + 1}`}</p>
                      <p className="text-muted-foreground">{lead.recommendedAction ?? lead.action ?? "Follow up"}</p>
                    </div>
                    {lead.priority && (
                      <Badge variant="outline" className="text-xs shrink-0">
                        {lead.priority}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}

          {/* Part C — Top Profiles Ready for Outreach */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                  <h2 className="text-base font-semibold">Top Profiles Ready for Outreach</h2>
                  <span className="text-xs text-muted-foreground">min. 70% confidence · AI-qualified</span>
                </div>
              </div>
              {profilesLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : unifiedProfiles.length === 0 ? (
                <Card>
                  <CardContent className="py-10 text-center text-muted-foreground text-sm">
                    No profiles at 70%+ confidence yet. Enrich more leads to surface candidates.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {unifiedProfiles.map((profile: any) => {
                    const name =
                      profile.full_name ||
                      `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() ||
                      "Unknown"
                    const confidence = Math.round((profile.confidence_score ?? profile.min_confidence ?? 0) * 100)
                    const leadId = profile.lead_id ?? profile.id
                    const isSelected = selectedLeadId === leadId
                    return (
                      <button
                        key={profile.id}
                        onClick={() => {
                          setSelectedLeadId(isSelected ? null : leadId)
                          setSelectedLeadData(isSelected ? null : profile)
                        }}
                        className={`text-left rounded-lg border bg-card p-4 space-y-2 transition-colors hover:bg-muted/50 w-full ${
                          isSelected ? "border-primary ring-1 ring-primary" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-sm truncate">{name}</p>
                          <span className="text-xs font-bold text-emerald-600 shrink-0">
                            {confidence}%
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {profile.intent_type && (
                            <Badge variant="outline" className="text-xs capitalize">
                              {profile.intent_type}
                            </Badge>
                          )}
                          {profile.temperature && (
                            <Badge
                              className={`text-xs ${
                                profile.temperature === "hot"
                                  ? "bg-red-100 text-red-700"
                                  : profile.temperature === "warm"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {profile.temperature}
                            </Badge>
                          )}
                        </div>
                        {profile.lead_id && (
                          <a
                            href={`/leads/${profile.lead_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 text-xs text-primary underline underline-offset-2 hover:no-underline"
                          >
                            View lead <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Canonical LeadIntelligencePanel — shown when a profile is selected */}
            {selectedLeadId && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-primary" />
                  <h2 className="text-base font-semibold">Lead Intelligence</h2>
                  <button
                    onClick={() => { setSelectedLeadId(null); setSelectedLeadData(null) }}
                    className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:no-underline"
                  >
                    Close
                  </button>
                </div>
                <LeadIntelligencePanel
                  leadId={selectedLeadId}
                  initialData={selectedLeadData}
                />
              </div>
            )}

            {/* Motivated Sellers — expanded by default in Intelligence tab */}
            {motivatedSellers.length > 0 && (
              <div className="rounded-lg border bg-card">
                <div className="flex items-center gap-2 px-4 py-3">
                  <Home className="h-4 w-4 text-amber-500" />
                  <h2 className="text-sm font-semibold">
                    {motivatedSellers.length} Motivated Seller{motivatedSellers.length !== 1 ? "s" : ""} — Active Signals
                  </h2>
                </div>
                <div className="px-4 pb-4">
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {motivatedSellers.map((seller: any, i: number) => {
                      const prop = seller.property
                      const address = prop?.address ?? "Unknown address"
                      const city = prop?.city ?? ""
                      const score = seller.readiness_to_sell_score ?? 0
                      const timeframe = seller.predicted_timeframe ?? "unknown"
                      const signalType = seller.motivation_type ?? seller.signal_source ?? "signal detected"
                      const profileId = seller.unified_lead_profile_id ?? null
                      return (
                        <div
                          key={seller.id ?? i}
                          className="shrink-0 w-56 rounded-lg border bg-background p-3 flex flex-col gap-2"
                        >
                          <div>
                            <p className="text-sm font-medium leading-snug truncate">{address}</p>
                            {city && <p className="text-xs text-muted-foreground">{city}</p>}
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
                              Score: {score}
                            </span>
                            <span className="text-xs text-muted-foreground capitalize">{timeframe}</span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate capitalize">{signalType}</p>
                          {profileId && (
                            <a
                              href={`/crm/${profileId}`}
                              className="mt-auto text-xs text-primary underline underline-offset-2 hover:no-underline"
                            >
                              View Profile
                            </a>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

          </TabsContent>
        </Tabs>

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
                    <TableHead>Stage</TableHead>
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
                      <TableCell colSpan={10} className="text-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
                        <p className="text-sm text-muted-foreground mt-2">Loading leads...</p>
                      </TableCell>
                    </TableRow>
                  ) : leads.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-16">
                        <Search className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm font-medium text-foreground mb-1">No leads match your filters</p>
                        <p className="text-xs text-muted-foreground mb-4">Try clearing filters or importing new leads</p>
                        <button
                          onClick={() => { setScoreFilter("all"); setIntentFilter("all"); setStatusFilter("all"); setSourceFilter("all"); setSearch("") }}
                          className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                        >
                          Clear all filters
                        </button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    leads.map((lead) => (
                      <Fragment key={lead.id}>
                      <TableRow>
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
                          {(() => {
                            const badge = getLeadStatusBadge(lead)
                            return (
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.color}`}>
                                {badge.label}
                              </span>
                            )
                          })()}
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
                            <Button
                              variant="ghost"
                              size="sm"
                              title="AI Property Match Genius"
                              onClick={() => handleMatchGenius(lead.id)}
                              disabled={matchGeniusLoading === lead.id}
                            >
                              {matchGeniusLoading === lead.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : matchGeniusResults[lead.id] ? (
                                <Brain className="h-4 w-4 text-indigo-500" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
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
                      {/* AI Property Match Genius inline result */}
                      {matchGeniusResults[lead.id] && (
                        <TableRow className="bg-indigo-50/60">
                          <TableCell colSpan={7} className="py-3 px-4">
                            <div className="flex items-start gap-3">
                              <Brain className="h-4 w-4 text-indigo-500 mt-0.5 shrink-0" />
                              <div className="space-y-1.5 flex-1 min-w-0">
                                <p className="text-xs font-semibold text-indigo-900">
                                  Property Match Genius
                                </p>
                                {matchGeniusResults[lead.id].matchSummary && (
                                  <p className="text-xs text-indigo-800 leading-relaxed">
                                    {matchGeniusResults[lead.id].matchSummary}
                                  </p>
                                )}
                                {matchGeniusResults[lead.id].topMatches?.length > 0 && (
                                  <div className="flex flex-wrap gap-2 mt-1">
                                    {matchGeniusResults[lead.id].topMatches.slice(0, 4).map((m: any, i: number) => (
                                      <span
                                        key={i}
                                        className="inline-flex items-center gap-1 text-xs bg-white border border-indigo-200 text-indigo-700 rounded-full px-2.5 py-0.5"
                                      >
                                        <Home className="h-3 w-3" />
                                        {m.address ?? m.listing_id ?? `Match ${i + 1}`}
                                        {m.matchScore != null && (
                                          <span className="font-semibold ml-1">{m.matchScore}%</span>
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {matchGeniusResults[lead.id].recommendedAction && (
                                  <p className="text-xs text-indigo-700 font-medium">
                                    Next: {matchGeniusResults[lead.id].recommendedAction}
                                  </p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                      </Fragment>
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

      {/* Available Leads Sheet — agents claim from the brokerage pool */}
      <AvailableLeadsSheet
        open={availableSheetOpen}
        onOpenChange={setAvailableSheetOpen}
        agentId={agentId}
        brokerageId={brokerageId}
        onLeadClaimed={() => fetchLeads()}
      />
    </div>
  )
}
