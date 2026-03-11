"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Users,
  Search,
  Phone,
  Mail,
  Calendar,
  TrendingUp,
  AlertTriangle,
  MessageSquare,
  Clock,
  Sparkles,
  ChevronRight,
  Home,
  DollarSign,
  Gift,
  Send,
  Plus,
  Grid,
  List,
  Loader2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  getPastClients,
  getTouchpointTimeline,
  logTouchpoint,
  sendMarketUpdate,
  getUpcomingAnniversaries,
  getAISuggestedTouchpoint,
} from "@/app/actions/past-clients"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface PastClient {
  id: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  transactions: {
    id: string
    actual_close_date: string
    property_address: string
    sale_price: number
  }[]
  client_engagement_scores: {
    engagement_score: number
    referral_potential_score: number
    last_touchpoint_date: string | null
    computed_at: string
  }[]
}

interface Touchpoint {
  id: string
  touchpoint_type: string
  sent_at: string
  opened_at: string | null
  notes: string | null
  channel: string
}

interface AISuggestion {
  type: string
  message: string
  reason: string
  priority: "high" | "medium" | "low"
}

interface Anniversary {
  id: string
  actual_close_date: string
  property_address: string
  sale_price: number
  contacts: {
    id: string
    first_name: string
    last_name: string
    email: string
    phone: string
  }
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const TOUCHPOINT_TYPES = [
  { value: "call", label: "Phone Call", icon: Phone },
  { value: "email", label: "Email", icon: Mail },
  { value: "market_update", label: "Market Update", icon: TrendingUp },
  { value: "anniversary", label: "Anniversary", icon: Gift },
  { value: "check_in", label: "Check-in", icon: MessageSquare },
  { value: "other", label: "Other", icon: Calendar },
]

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function PastClientsPage() {
  const [clients, setClients] = useState<PastClient[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [lastContactFilter, setLastContactFilter] = useState("all")
  const [engagementFilter, setEngagementFilter] = useState("all")
  const [viewMode, setViewMode] = useState<"grid" | "list">("list")
  const [isPending, startTransition] = useTransition()

  // Selected client for detail panel
  const [selectedClient, setSelectedClient] = useState<PastClient | null>(null)
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([])
  const [aiSuggestion, setAiSuggestion] = useState<{
    suggestion: AISuggestion
    contactName: string
    daysSinceContact: number
    engagementScore: number
  } | null>(null)
  const [loadingTouchpoints, setLoadingTouchpoints] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  // Modals
  const [logTouchpointOpen, setLogTouchpointOpen] = useState(false)
  const [sendUpdateOpen, setSendUpdateOpen] = useState(false)

  // Form states
  const [touchpointType, setTouchpointType] = useState("call")
  const [touchpointNotes, setTouchpointNotes] = useState("")
  const [updateMessage, setUpdateMessage] = useState("")

  // Anniversaries
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([])

  // ─── Load Data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    loadClients()
    loadAnniversaries()
  }, [])

  async function loadClients() {
    setLoading(true)
    try {
      const result = await getPastClients({
        search: searchQuery || undefined,
        lastContactFilter: lastContactFilter !== "all" ? lastContactFilter : undefined,
        engagementFilter: engagementFilter !== "all" ? engagementFilter : undefined,
      })
      if (result.success && result.clients) {
        setClients(result.clients)
      }
    } catch (error) {
      console.error("Error loading past clients:", error)
    } finally {
      setLoading(false)
    }
  }

  async function loadAnniversaries() {
    try {
      const result = await getUpcomingAnniversaries()
      if (result.success && result.anniversaries) {
        setAnniversaries(result.anniversaries)
      }
    } catch (error) {
      console.error("Error loading anniversaries:", error)
    }
  }

  // Reload when filters change
  useEffect(() => {
    const timer = setTimeout(() => {
      loadClients()
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, lastContactFilter, engagementFilter])

  // ─── Open Client Detail ─────────────────────────────────────────────────────

  async function openClientDetail(client: PastClient) {
    setSelectedClient(client)
    setDetailOpen(true)
    setLoadingTouchpoints(true)

    try {
      const [touchpointResult, suggestionResult] = await Promise.all([
        getTouchpointTimeline(client.id),
        getAISuggestedTouchpoint(client.id),
      ])

      if (touchpointResult.success) {
        setTouchpoints(touchpointResult.touchpoints || [])
      }
      if (suggestionResult.success) {
        setAiSuggestion(suggestionResult as any)
      }
    } catch (error) {
      console.error("Error loading client detail:", error)
    } finally {
      setLoadingTouchpoints(false)
    }
  }

  // ─── Log Touchpoint ─────────────────────────────────────────────────────────

  async function handleLogTouchpoint() {
    if (!selectedClient) return

    startTransition(async () => {
      try {
        await logTouchpoint({
          contactId: selectedClient.id,
          touchpointType,
          notes: touchpointNotes || undefined,
        })
        setLogTouchpointOpen(false)
        setTouchpointType("call")
        setTouchpointNotes("")
        // Reload touchpoints
        const result = await getTouchpointTimeline(selectedClient.id)
        if (result.success) {
          setTouchpoints(result.touchpoints || [])
        }
        loadClients()
      } catch (error) {
        console.error("Error logging touchpoint:", error)
      }
    })
  }

  // ─── Send Market Update ─────────────────────────────────────────────────────

  async function handleSendUpdate() {
    if (!selectedClient || !updateMessage.trim()) return

    startTransition(async () => {
      try {
        await sendMarketUpdate({
          contactId: selectedClient.id,
          messageBody: updateMessage,
        })
        setSendUpdateOpen(false)
        setUpdateMessage("")
        // Reload touchpoints
        const result = await getTouchpointTimeline(selectedClient.id)
        if (result.success) {
          setTouchpoints(result.touchpoints || [])
        }
        loadClients()
      } catch (error) {
        console.error("Error sending update:", error)
      }
    })
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function getEngagementBadge(score: number) {
    if (score >= 70) return { label: "Hot", color: "bg-green-100 text-green-700 border-green-200" }
    if (score >= 40) return { label: "Warm", color: "bg-amber-100 text-amber-700 border-amber-200" }
    return { label: "Cold", color: "bg-slate-100 text-slate-700 border-slate-200" }
  }

  function getDaysSinceContact(lastDate: string | null): number {
    if (!lastDate) return 999
    return Math.floor((Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24))
  }

  function getTouchpointIcon(type: string) {
    const tp = TOUCHPOINT_TYPES.find((t) => t.value === type)
    return tp?.icon || MessageSquare
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  const stats = {
    total: clients.length,
    hot: clients.filter((c) => (c.client_engagement_scores?.[0]?.engagement_score || 0) >= 70).length,
    warm: clients.filter((c) => {
      const score = c.client_engagement_scores?.[0]?.engagement_score || 0
      return score >= 40 && score < 70
    }).length,
    cold: clients.filter((c) => (c.client_engagement_scores?.[0]?.engagement_score || 0) < 40).length,
    needsContact: clients.filter((c) => {
      const lastDate = c.client_engagement_scores?.[0]?.last_touchpoint_date
      return getDaysSinceContact(lastDate) > 90
    }).length,
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Past Clients</h1>
            <p className="text-muted-foreground mt-1">
              Client for Life touchpoint management
            </p>
          </div>
          <Button variant="outline" onClick={() => window.location.href = "/dashboard/past-clients/calendar"}>
            <Calendar className="h-4 w-4 mr-2" />
            View Calendar
          </Button>
        </div>

        {/* Section 1: Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-100">
                  <Users className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Past Clients</p>
                  <p className="text-2xl font-bold">{stats.total}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-100">
                  <TrendingUp className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">High Engagement</p>
                  <p className="text-2xl font-bold">{stats.hot}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-100">
                  <Clock className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Warm</p>
                  <p className="text-2xl font-bold">{stats.warm}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-slate-100">
                  <AlertTriangle className="h-5 w-5 text-slate-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Cold</p>
                  <p className="text-2xl font-bold">{stats.cold}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-red-100">
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Needs Contact</p>
                  <p className="text-2xl font-bold text-red-600">{stats.needsContact}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Section 6: Anniversary Automation Visibility */}
        {anniversaries.length > 0 && (
          <Card className="mb-8 border-amber-200 bg-amber-50/50">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Gift className="h-6 w-6 text-amber-600" />
                  <div>
                    <p className="font-medium text-foreground">
                      {anniversaries.length} client{anniversaries.length !== 1 ? "s" : ""} have close anniversaries coming up this month
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Send a personalized message to celebrate their home anniversary
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm">
                  View All
                </Button>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {anniversaries.slice(0, 3).map((a) => (
                  <Badge key={a.id} variant="secondary" className="text-sm py-1 px-3">
                    {a.contacts.first_name} {a.contacts.last_name} - {new Date(a.actual_close_date).toLocaleDateString()}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Section 1: Header + Filters */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by name..."
                  className="pl-10"
                />
              </div>
              <Select value={lastContactFilter} onValueChange={setLastContactFilter}>
                <SelectTrigger className="w-[180px]">
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
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Engagement" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scores</SelectItem>
                  <SelectItem value="hot">Hot (70+)</SelectItem>
                  <SelectItem value="warm">Warm (40-69)</SelectItem>
                  <SelectItem value="cold">Cold (Under 40)</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Button
                  variant={viewMode === "list" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("list")}
                >
                  <List className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "grid" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("grid")}
                >
                  <Grid className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Past Client Cards */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : clients.length === 0 ? (
          <Card>
            <CardContent className="p-16 text-center">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No past clients found</h3>
              <p className="text-muted-foreground">
                Past clients will appear here once you have closed transactions
              </p>
            </CardContent>
          </Card>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {clients.map((client) => {
              const engagementScore = client.client_engagement_scores?.[0]?.engagement_score || 0
              const lastTouchpointDate = client.client_engagement_scores?.[0]?.last_touchpoint_date
              const daysSince = getDaysSinceContact(lastTouchpointDate)
              const transaction = client.transactions?.[0]
              const badge = getEngagementBadge(engagementScore)

              return (
                <Card
                  key={client.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow"
                  onClick={() => openClientDetail(client)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-foreground">
                          {client.first_name} {client.last_name}
                        </h3>
                        {transaction && (
                          <p className="text-sm text-muted-foreground truncate max-w-[200px]">
                            {transaction.property_address}
                          </p>
                        )}
                      </div>
                      <Badge className={cn("text-xs", badge.color)}>{badge.label}</Badge>
                    </div>

                    {transaction && (
                      <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                        <div>
                          <p className="text-muted-foreground">Close Date</p>
                          <p className="font-medium">{new Date(transaction.actual_close_date).toLocaleDateString()}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Close Price</p>
                          <p className="font-medium">${transaction.sale_price?.toLocaleString()}</p>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-3 border-t">
                      <div className="flex items-center gap-1 text-sm">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className={cn(daysSince > 90 ? "text-red-600 font-medium" : "text-muted-foreground")}>
                          {lastTouchpointDate
                            ? `${daysSince} days ago`
                            : "Never contacted"}
                        </span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        ) : (
          <Card>
            <div className="divide-y">
              {clients.map((client) => {
                const engagementScore = client.client_engagement_scores?.[0]?.engagement_score || 0
                const lastTouchpointDate = client.client_engagement_scores?.[0]?.last_touchpoint_date
                const daysSince = getDaysSinceContact(lastTouchpointDate)
                const transaction = client.transactions?.[0]
                const badge = getEngagementBadge(engagementScore)

                return (
                  <div
                    key={client.id}
                    className="p-4 hover:bg-muted/50 transition-colors cursor-pointer flex items-center gap-4"
                    onClick={() => openClientDetail(client)}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-foreground">
                          {client.first_name} {client.last_name}
                        </h3>
                        <Badge className={cn("text-xs", badge.color)}>{badge.label}</Badge>
                      </div>
                      {transaction && (
                        <p className="text-sm text-muted-foreground">
                          {transaction.property_address} | Closed {new Date(transaction.actual_close_date).toLocaleDateString()} | ${transaction.sale_price?.toLocaleString()}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-4">
                      <div className={cn(
                        "text-sm",
                        daysSince > 90 ? "text-red-600 font-medium" : "text-muted-foreground"
                      )}>
                        {lastTouchpointDate
                          ? `${daysSince}d ago`
                          : "Never"}
                      </div>

                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedClient(client)
                            setSendUpdateOpen(true)
                          }}
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation()
                            window.open(`tel:${client.phone}`)
                          }}
                        >
                          <Phone className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedClient(client)
                            setLogTouchpointOpen(true)
                          }}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        )}

        {/* Section 3: Touchpoint Timeline (Right Panel on Click) */}
        <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
          <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
            {selectedClient && (
              <>
                <SheetHeader>
                  <SheetTitle>
                    {selectedClient.first_name} {selectedClient.last_name}
                  </SheetTitle>
                  <SheetDescription>
                    {selectedClient.email} | {selectedClient.phone}
                  </SheetDescription>
                </SheetHeader>

                <div className="mt-6 space-y-6">
                  {/* Section 4: Engagement Score Chart (simplified) */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Engagement Score</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-4">
                        <div className="text-4xl font-bold text-foreground">
                          {selectedClient.client_engagement_scores?.[0]?.engagement_score || 0}
                        </div>
                        <div className="flex-1">
                          <div className="h-3 bg-muted rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                (selectedClient.client_engagement_scores?.[0]?.engagement_score || 0) >= 70
                                  ? "bg-green-500"
                                  : (selectedClient.client_engagement_scores?.[0]?.engagement_score || 0) >= 40
                                  ? "bg-amber-500"
                                  : "bg-slate-400"
                              )}
                              style={{ width: `${selectedClient.client_engagement_scores?.[0]?.engagement_score || 0}%` }}
                            />
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            Referral Potential: {selectedClient.client_engagement_scores?.[0]?.referral_potential_score || 0}/100
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Section 5: AI Suggested Next Touchpoint */}
                  {aiSuggestion && (
                    <Card className="border-blue-200 bg-blue-50/50">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-blue-600" />
                          AI Suggestion — review before sending
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-foreground mb-2">{aiSuggestion.suggestion.message}</p>
                        <p className="text-sm text-muted-foreground mb-4">{aiSuggestion.suggestion.reason}</p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => {
                              setUpdateMessage(`Hi ${selectedClient.first_name}, I wanted to reach out with a quick market update...`)
                              setSendUpdateOpen(true)
                            }}
                          >
                            Use Suggestion
                          </Button>
                          <Badge
                            variant="outline"
                            className={cn(
                              aiSuggestion.suggestion.priority === "high"
                                ? "border-red-300 text-red-700"
                                : aiSuggestion.suggestion.priority === "medium"
                                ? "border-amber-300 text-amber-700"
                                : "border-slate-300 text-slate-700"
                            )}
                          >
                            {aiSuggestion.suggestion.priority} priority
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Quick Actions */}
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => setSendUpdateOpen(true)}
                    >
                      <Send className="h-4 w-4 mr-2" />
                      Send Update
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => setLogTouchpointOpen(true)}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Log Touchpoint
                    </Button>
                  </div>

                  {/* Touchpoint Timeline */}
                  <div>
                    <h3 className="font-semibold text-foreground mb-4">Touchpoint History</h3>
                    {loadingTouchpoints ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : touchpoints.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">
                        No touchpoints recorded yet
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {touchpoints.map((tp) => {
                          const Icon = getTouchpointIcon(tp.touchpoint_type)
                          return (
                            <div key={tp.id} className="flex gap-3 p-3 bg-muted/50 rounded-lg">
                              <div className="p-2 bg-background rounded-lg">
                                <Icon className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center justify-between mb-1">
                                  <p className="font-medium text-sm text-foreground capitalize">
                                    {tp.touchpoint_type.replace(/_/g, " ")}
                                  </p>
                                  <span className="text-xs text-muted-foreground">
                                    {new Date(tp.sent_at).toLocaleDateString()}
                                  </span>
                                </div>
                                {tp.notes && (
                                  <p className="text-sm text-muted-foreground">{tp.notes}</p>
                                )}
                                {tp.opened_at && (
                                  <Badge variant="secondary" className="text-xs mt-1">
                                    Opened {new Date(tp.opened_at).toLocaleDateString()}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>

        {/* Log Touchpoint Modal */}
        <Dialog open={logTouchpointOpen} onOpenChange={setLogTouchpointOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log Touchpoint</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Touchpoint Type</Label>
                <Select value={touchpointType} onValueChange={setTouchpointType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOUCHPOINT_TYPES.map((tp) => (
                      <SelectItem key={tp.value} value={tp.value}>
                        {tp.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Textarea
                  value={touchpointNotes}
                  onChange={(e) => setTouchpointNotes(e.target.value)}
                  placeholder="Add any notes about this touchpoint..."
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setLogTouchpointOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleLogTouchpoint} disabled={isPending}>
                {isPending ? "Saving..." : "Log Touchpoint"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Send Update Modal */}
        <Dialog open={sendUpdateOpen} onOpenChange={setSendUpdateOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Send Market Update</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">
                  To: {selectedClient?.first_name} {selectedClient?.last_name}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Message</Label>
                <Textarea
                  value={updateMessage}
                  onChange={(e) => setUpdateMessage(e.target.value)}
                  placeholder="Write your market update message..."
                  rows={6}
                />
                <p className="text-xs text-muted-foreground">
                  This message will be sent to the client portal and logged as a touchpoint
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSendUpdateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSendUpdate} disabled={isPending || !updateMessage.trim()}>
                {isPending ? "Sending..." : "Send Update"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
