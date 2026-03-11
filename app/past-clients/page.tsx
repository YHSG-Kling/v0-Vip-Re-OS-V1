"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Calendar,
  Heart,
  TrendingUp,
  Gift,
  Search,
  LayoutGrid,
  List,
  Phone,
  Mail,
  MessageSquare,
  Clock,
  User,
  Home,
  DollarSign,
  Sparkles,
  AlertCircle,
  Send,
  Plus,
  X,
  Loader2,
  PartyPopper,
} from "lucide-react"
import {
  getPastClients,
  logTouchpoint,
  sendMarketUpdate,
  getTouchpointTimeline,
  getUpcomingAnniversaries,
  getAISuggestedTouchpoint,
} from "@/app/actions/past-clients"

// Types
interface PastClient {
  id: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  transactions: {
    id: string
    actual_close_date: string
    status: string
    property_address?: string
    sale_price?: number
  }[]
  client_engagement_scores?: {
    engagement_score: number
    referral_potential_score: number
    last_touchpoint_date?: string
    computed_at?: string
  }[]
}

interface Touchpoint {
  id: string
  contact_id: string
  touchpoint_type: string
  channel: string
  notes?: string
  status: string
  sent_at: string
}

interface Anniversary {
  id: string
  actual_close_date: string
  property_address: string
  sale_price?: number
  contacts: {
    id: string
    first_name: string
    last_name: string
    email?: string
    phone?: string
  }
}

interface AISuggestion {
  type: string
  message: string
  reason: string
  priority: "high" | "medium" | "low"
}

// Helper functions
function getEngagementBadge(score: number) {
  if (score >= 70) return { label: "Hot", className: "bg-green-100 text-green-700 border-green-300" }
  if (score >= 40) return { label: "Warm", className: "bg-amber-100 text-amber-700 border-amber-300" }
  return { label: "Cold", className: "bg-slate-100 text-slate-500 border-slate-300" }
}

function getDaysSinceContact(lastTouchpointDate?: string): number | null {
  if (!lastTouchpointDate) return null
  const now = new Date()
  const last = new Date(lastTouchpointDate)
  return Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24))
}

function formatCurrency(amount: number | undefined) {
  if (!amount) return "N/A"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)
}

function getTouchpointIcon(type: string) {
  switch (type) {
    case "call":
      return <Phone className="w-4 h-4" />
    case "email":
      return <Mail className="w-4 h-4" />
    case "market_update":
      return <TrendingUp className="w-4 h-4" />
    case "anniversary":
      return <PartyPopper className="w-4 h-4" />
    case "check_in":
      return <MessageSquare className="w-4 h-4" />
    default:
      return <Clock className="w-4 h-4" />
  }
}

export default function PastClientsPage() {
  const [isPending, startTransition] = useTransition()
  
  // Data state
  const [clients, setClients] = useState<PastClient[]>([])
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  // Filter state
  const [search, setSearch] = useState("")
  const [lastContactFilter, setLastContactFilter] = useState("all")
  const [engagementFilter, setEngagementFilter] = useState("all")
  const [viewMode, setViewMode] = useState<"grid" | "list">("list")
  
  // Selected client state
  const [selectedClient, setSelectedClient] = useState<PastClient | null>(null)
  const [touchpointTimeline, setTouchpointTimeline] = useState<Touchpoint[]>([])
  const [aiSuggestion, setAiSuggestion] = useState<{
    suggestion: AISuggestion
    contactName: string
    daysSinceContact: number
    engagementScore: number
  } | null>(null)
  const [loadingTimeline, setLoadingTimeline] = useState(false)
  const [loadingSuggestion, setLoadingSuggestion] = useState(false)
  
  // Modal state
  const [showLogTouchpoint, setShowLogTouchpoint] = useState(false)
  const [showSendUpdate, setShowSendUpdate] = useState(false)
  const [touchpointType, setTouchpointType] = useState("call")
  const [touchpointNotes, setTouchpointNotes] = useState("")
  const [marketUpdateMessage, setMarketUpdateMessage] = useState("")

  // Load initial data
  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [clientsResult, anniversariesResult] = await Promise.all([
          getPastClients({ search, lastContactFilter, engagementFilter }),
          getUpcomingAnniversaries(),
        ])

        if (clientsResult.success && clientsResult.clients) {
          setClients(clientsResult.clients)
        }
        if (anniversariesResult.success && anniversariesResult.anniversaries) {
          setAnniversaries(anniversariesResult.anniversaries)
        }
      } catch (e) {
        setError("Failed to load past clients")
        console.error("[v0] Error loading past clients:", e)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [search, lastContactFilter, engagementFilter])

  // Load timeline and AI suggestion when client is selected
  useEffect(() => {
    async function loadClientDetails() {
      if (!selectedClient) {
        setTouchpointTimeline([])
        setAiSuggestion(null)
        return
      }

      setLoadingTimeline(true)
      setLoadingSuggestion(true)

      try {
        const [timelineResult, suggestionResult] = await Promise.all([
          getTouchpointTimeline(selectedClient.id),
          getAISuggestedTouchpoint(selectedClient.id),
        ])

        if (timelineResult.success && timelineResult.touchpoints) {
          setTouchpointTimeline(timelineResult.touchpoints)
        }
        if (suggestionResult.success && suggestionResult.suggestion) {
          setAiSuggestion({
            suggestion: suggestionResult.suggestion,
            contactName: suggestionResult.contactName || `${selectedClient.first_name} ${selectedClient.last_name}`,
            daysSinceContact: suggestionResult.daysSinceContact || 0,
            engagementScore: suggestionResult.engagementScore || 0,
          })
        }
      } catch (e) {
        console.error("[v0] Error loading client details:", e)
      } finally {
        setLoadingTimeline(false)
        setLoadingSuggestion(false)
      }
    }

    loadClientDetails()
  }, [selectedClient])

  // Handlers
  function handleLogTouchpoint() {
    if (!selectedClient) return
    startTransition(async () => {
      const result = await logTouchpoint({
        contactId: selectedClient.id,
        touchpointType,
        notes: touchpointNotes,
      })
      if (result.success) {
        setShowLogTouchpoint(false)
        setTouchpointNotes("")
        // Reload timeline
        const timelineResult = await getTouchpointTimeline(selectedClient.id)
        if (timelineResult.success && timelineResult.touchpoints) {
          setTouchpointTimeline(timelineResult.touchpoints)
        }
      }
    })
  }

  function handleSendMarketUpdate() {
    if (!selectedClient || !marketUpdateMessage.trim()) return
    startTransition(async () => {
      const result = await sendMarketUpdate({
        contactId: selectedClient.id,
        messageBody: marketUpdateMessage,
      })
      if (result.success) {
        setShowSendUpdate(false)
        setMarketUpdateMessage("")
        // Reload timeline
        const timelineResult = await getTouchpointTimeline(selectedClient.id)
        if (timelineResult.success && timelineResult.touchpoints) {
          setTouchpointTimeline(timelineResult.touchpoints)
        }
      }
    })
  }

  function handleUseSuggestion() {
    if (!aiSuggestion) return
    if (aiSuggestion.suggestion.type === "market_update") {
      setMarketUpdateMessage(aiSuggestion.suggestion.message)
      setShowSendUpdate(true)
    } else {
      setTouchpointType(aiSuggestion.suggestion.type)
      setTouchpointNotes(aiSuggestion.suggestion.message)
      setShowLogTouchpoint(true)
    }
  }

  // Stats
  const totalClients = clients.length
  const highEngagement = clients.filter(
    (c) => (c.client_engagement_scores?.[0]?.engagement_score || 0) >= 70
  ).length
  const referralReady = clients.filter(
    (c) => (c.client_engagement_scores?.[0]?.referral_potential_score || 0) >= 75
  ).length
  const needsAttention = clients.filter((c) => {
    const days = getDaysSinceContact(c.client_engagement_scores?.[0]?.last_touchpoint_date)
    return days === null || days > 90
  }).length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Header + Filters */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Past Clients</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Client for Life touchpoint management
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 w-64"
              />
            </div>
            <Select value={lastContactFilter} onValueChange={setLastContactFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Last Contact" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Time</SelectItem>
                <SelectItem value="1m">Last 30 Days</SelectItem>
                <SelectItem value="3m">Last 90 Days</SelectItem>
                <SelectItem value="6m">Last 6 Months</SelectItem>
                <SelectItem value="1yr">Last Year</SelectItem>
                <SelectItem value="never">Never Contacted</SelectItem>
              </SelectContent>
            </Select>
            <Select value={engagementFilter} onValueChange={setEngagementFilter}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Engagement" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="hot">Hot</SelectItem>
                <SelectItem value="warm">Warm</SelectItem>
                <SelectItem value="cold">Cold</SelectItem>
              </SelectContent>
            </Select>
            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "grid" | "list")}>
              <TabsList className="h-9">
                <TabsTrigger value="list" className="px-2">
                  <List className="w-4 h-4" />
                </TabsTrigger>
                <TabsTrigger value="grid" className="px-2">
                  <LayoutGrid className="w-4 h-4" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {error && (
          <div className="p-4 bg-destructive/10 text-destructive rounded-lg flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Past Clients</p>
                <p className="text-2xl font-bold">{totalClients}</p>
              </div>
              <div className="p-3 bg-red-50 rounded-full">
                <Heart className="w-6 h-6 text-red-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">High Engagement</p>
                <p className="text-2xl font-bold">{highEngagement}</p>
              </div>
              <div className="p-3 bg-green-50 rounded-full">
                <TrendingUp className="w-6 h-6 text-green-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Referral Ready</p>
                <p className="text-2xl font-bold">{referralReady}</p>
              </div>
              <div className="p-3 bg-purple-50 rounded-full">
                <Gift className="w-6 h-6 text-purple-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Needs Attention</p>
                <p className="text-2xl font-bold text-amber-600">{needsAttention}</p>
              </div>
              <div className="p-3 bg-amber-50 rounded-full">
                <AlertCircle className="w-6 h-6 text-amber-500" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Anniversary Automation Visibility */}
        {anniversaries.length > 0 && (
          <Card className="border-purple-200 bg-purple-50/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <PartyPopper className="w-5 h-5 text-purple-600" />
                Upcoming Close Anniversaries
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                {anniversaries.length} client{anniversaries.length !== 1 ? "s" : ""} have close anniversaries coming up this month
              </p>
              <div className="grid gap-3">
                {anniversaries.slice(0, 3).map((ann) => {
                  const anniversary = new Date(ann.actual_close_date)
                  const thisYear = new Date()
                  anniversary.setFullYear(thisYear.getFullYear())
                  
                  return (
                    <div
                      key={ann.id}
                      className="flex items-center justify-between p-3 bg-background rounded-lg border"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                          <User className="w-5 h-5 text-purple-600" />
                        </div>
                        <div>
                          <p className="font-medium">
                            {ann.contacts?.first_name} {ann.contacts?.last_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {ann.property_address} • Anniversary: {anniversary.toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="bg-transparent">
                        <Send className="w-4 h-4 mr-2" />
                        Send Congrats
                      </Button>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Main Content: Client List/Grid + Detail Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Client Cards */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="border-b">
                <CardTitle className="text-base">All Past Clients ({clients.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {clients.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground">
                    <Heart className="w-12 h-12 mx-auto mb-4 opacity-30" />
                    <p>No past clients found</p>
                  </div>
                ) : viewMode === "list" ? (
                  <div className="divide-y">
                    {clients.map((client) => {
                      const engagementScore =
                        client.client_engagement_scores?.[0]?.engagement_score || 0
                      const badge = getEngagementBadge(engagementScore)
                      const lastTouchpoint =
                        client.client_engagement_scores?.[0]?.last_touchpoint_date
                      const daysSince = getDaysSinceContact(lastTouchpoint)
                      const transaction = client.transactions?.[0]
                      const isSelected = selectedClient?.id === client.id

                      return (
                        <div
                          key={client.id}
                          onClick={() => setSelectedClient(client)}
                          className={`p-4 cursor-pointer transition-colors hover:bg-accent ${
                            isSelected ? "bg-accent border-l-4 border-l-primary" : ""
                          }`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3 flex-1 min-w-0">
                              <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                                <User className="w-5 h-5 text-slate-500" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <h3 className="font-semibold truncate">
                                    {client.first_name} {client.last_name}
                                  </h3>
                                  <Badge variant="outline" className={badge.className}>
                                    {badge.label}
                                  </Badge>
                                </div>
                                {transaction && (
                                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1">
                                      <Home className="w-3 h-3" />
                                      {transaction.property_address || "Address N/A"}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <DollarSign className="w-3 h-3" />
                                      {formatCurrency(transaction.sale_price)}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Calendar className="w-3 h-3" />
                                      {new Date(transaction.actual_close_date).toLocaleDateString()}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-xs text-muted-foreground mb-1">Last Contact</p>
                              {daysSince !== null ? (
                                <p
                                  className={`text-sm font-medium ${
                                    daysSince > 90 ? "text-red-600" : ""
                                  }`}
                                >
                                  {daysSince} days ago
                                </p>
                              ) : (
                                <p className="text-sm font-medium text-amber-600">Never</p>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4 p-4">
                    {clients.map((client) => {
                      const engagementScore =
                        client.client_engagement_scores?.[0]?.engagement_score || 0
                      const badge = getEngagementBadge(engagementScore)
                      const daysSince = getDaysSinceContact(
                        client.client_engagement_scores?.[0]?.last_touchpoint_date
                      )
                      const isSelected = selectedClient?.id === client.id

                      return (
                        <div
                          key={client.id}
                          onClick={() => setSelectedClient(client)}
                          className={`p-4 border rounded-lg cursor-pointer transition-colors hover:border-primary ${
                            isSelected ? "border-primary bg-primary/5" : ""
                          }`}
                        >
                          <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center">
                              <User className="w-5 h-5 text-slate-500" />
                            </div>
                            <div>
                              <h3 className="font-semibold text-sm">
                                {client.first_name} {client.last_name}
                              </h3>
                              <Badge variant="outline" className={`${badge.className} text-xs`}>
                                {badge.label}
                              </Badge>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground space-y-1">
                            <p>Score: {engagementScore}/100</p>
                            <p className={daysSince && daysSince > 90 ? "text-red-600" : ""}>
                              Last Contact: {daysSince !== null ? `${daysSince}d ago` : "Never"}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Client Detail Panel */}
          <div className="lg:col-span-1">
            {selectedClient ? (
              <div className="space-y-4">
                {/* Client Info Card */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">Client Details</CardTitle>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedClient(null)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center">
                        <User className="w-6 h-6 text-slate-500" />
                      </div>
                      <div>
                        <h3 className="font-semibold">
                          {selectedClient.first_name} {selectedClient.last_name}
                        </h3>
                        {selectedClient.email && (
                          <p className="text-xs text-muted-foreground">{selectedClient.email}</p>
                        )}
                      </div>
                    </div>

                    {/* Engagement Score */}
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-xs text-muted-foreground mb-2">Engagement Score</p>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{
                              width: `${
                                selectedClient.client_engagement_scores?.[0]?.engagement_score || 0
                              }%`,
                            }}
                          />
                        </div>
                        <span className="text-sm font-semibold">
                          {selectedClient.client_engagement_scores?.[0]?.engagement_score || 0}
                        </span>
                      </div>
                    </div>

                    {/* Quick Actions */}
                    <div className="grid grid-cols-3 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-col h-auto py-3 bg-transparent"
                        onClick={() => setShowSendUpdate(true)}
                      >
                        <Send className="w-4 h-4 mb-1" />
                        <span className="text-xs">Update</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-col h-auto py-3 bg-transparent"
                        onClick={() => {
                          setTouchpointType("call")
                          setShowLogTouchpoint(true)
                        }}
                      >
                        <Phone className="w-4 h-4 mb-1" />
                        <span className="text-xs">Call</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-col h-auto py-3 bg-transparent"
                        onClick={() => setShowLogTouchpoint(true)}
                      >
                        <Plus className="w-4 h-4 mb-1" />
                        <span className="text-xs">Log</span>
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* AI Suggestion Card */}
                {loadingSuggestion ? (
                  <Card className="border-amber-200 bg-amber-50/30">
                    <CardContent className="p-4 flex items-center justify-center">
                      <Loader2 className="w-5 h-5 animate-spin text-amber-600" />
                    </CardContent>
                  </Card>
                ) : aiSuggestion ? (
                  <Card className="border-amber-200 bg-amber-50/30">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-amber-600" />
                        AI Suggestion
                        <Badge
                          variant="outline"
                          className={
                            aiSuggestion.suggestion.priority === "high"
                              ? "bg-red-100 text-red-700 border-red-300"
                              : aiSuggestion.suggestion.priority === "medium"
                                ? "bg-amber-100 text-amber-700 border-amber-300"
                                : "bg-slate-100 text-slate-600 border-slate-300"
                          }
                        >
                          {aiSuggestion.suggestion.priority}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm">{aiSuggestion.suggestion.message}</p>
                      <p className="text-xs text-muted-foreground">
                        {aiSuggestion.suggestion.reason}
                      </p>
                      <div className="flex items-center gap-2 pt-2">
                        <Button
                          size="sm"
                          onClick={handleUseSuggestion}
                          className="flex-1"
                        >
                          Use Suggestion
                        </Button>
                      </div>
                      <p className="text-[10px] text-muted-foreground text-center">
                        AI Suggestion — review before sending
                      </p>
                    </CardContent>
                  </Card>
                ) : null}

                {/* Touchpoint Timeline */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">Touchpoint Timeline</CardTitle>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowLogTouchpoint(true)}
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {loadingTimeline ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : touchpointTimeline.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        <p className="text-sm">No touchpoints yet</p>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => setShowLogTouchpoint(true)}
                        >
                          Add first touchpoint
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-3 max-h-80 overflow-y-auto">
                        {touchpointTimeline.map((touchpoint) => (
                          <div
                            key={touchpoint.id}
                            className="flex items-start gap-3 pb-3 border-b last:border-0 last:pb-0"
                          >
                            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                              {getTouchpointIcon(touchpoint.touchpoint_type)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium capitalize">
                                {touchpoint.touchpoint_type.replace(/_/g, " ")}
                              </p>
                              {touchpoint.notes && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {touchpoint.notes}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground mt-1">
                                {new Date(touchpoint.sent_at).toLocaleDateString()} •{" "}
                                {touchpoint.channel}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : (
              <Card className="h-full">
                <CardContent className="p-12 text-center text-muted-foreground h-full flex flex-col items-center justify-center">
                  <User className="w-12 h-12 mb-4 opacity-30" />
                  <p>Select a client to view details</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Log Touchpoint Sheet */}
        <Sheet open={showLogTouchpoint} onOpenChange={setShowLogTouchpoint}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Log Touchpoint</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 mt-6">
              <div>
                <label className="text-sm font-medium">Touchpoint Type</label>
                <Select value={touchpointType} onValueChange={setTouchpointType}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="call">Phone Call</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="text">Text Message</SelectItem>
                    <SelectItem value="in_person">In Person</SelectItem>
                    <SelectItem value="social">Social Media</SelectItem>
                    <SelectItem value="check_in">Check In</SelectItem>
                    <SelectItem value="anniversary">Anniversary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">Notes (optional)</label>
                <textarea
                  value={touchpointNotes}
                  onChange={(e) => setTouchpointNotes(e.target.value)}
                  placeholder="Add any notes about this touchpoint..."
                  className="mt-1 w-full p-3 border rounded-md text-sm min-h-24 resize-none"
                />
              </div>
              <Button
                onClick={handleLogTouchpoint}
                disabled={isPending}
                className="w-full"
              >
                {isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Logging...
                  </>
                ) : (
                  "Log Touchpoint"
                )}
              </Button>
            </div>
          </SheetContent>
        </Sheet>

        {/* Send Market Update Sheet */}
        <Sheet open={showSendUpdate} onOpenChange={setShowSendUpdate}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Send Market Update</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 mt-6">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <Sparkles className="w-4 h-4 text-amber-600 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-amber-800">Draft First</p>
                    <p className="text-xs text-amber-700">
                      Review and edit this message before sending to{" "}
                      {selectedClient?.first_name} {selectedClient?.last_name}
                    </p>
                  </div>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Message</label>
                <textarea
                  value={marketUpdateMessage}
                  onChange={(e) => setMarketUpdateMessage(e.target.value)}
                  placeholder="Write your market update message..."
                  className="mt-1 w-full p-3 border rounded-md text-sm min-h-32 resize-none"
                />
              </div>
              <Button
                onClick={handleSendMarketUpdate}
                disabled={isPending || !marketUpdateMessage.trim()}
                className="w-full"
              >
                {isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    Send Market Update
                  </>
                )}
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  )
}
