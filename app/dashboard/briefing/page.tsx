"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  RefreshCw,
  Calendar,
  Home,
  AlertTriangle,
  User,
  Clock,
  ArrowRight,
  MessageSquare,
  CheckCircle,
  AlertCircle,
  Loader2,
  MapPin,
  DollarSign,
  TrendingUp,
  Sparkles,
  Users,
  UserX,
  Target,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  getTodaysBriefing,
  generateBriefing,
  markBriefingViewed,
  getAgentName,
  getUpcomingShowings,
  getActiveTransactions,
  getPipelineSummary,
  getBuyerMatchCount,
  getChurnRiskContacts,
} from "@/app/actions/briefing-actions"
import { generateContactInsights } from "@/app/actions/ai-insights"
import type { ContactInsight } from "@/app/actions/ai-insights"
import type { DailyBriefing, PriorityAction, HotLead, DealAtRisk } from "@/lib/intelligence/daily-briefing-generator"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"
import { MarketInsightWidget } from "@/app/components/dashboard/market-insight-widget"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Showing {
  id: string
  scheduled_at: string
  status: string
  notes: string | null
  listing: { id: string; address: string; city: string; state: string } | null
  contact: { id: string; first_name: string; last_name: string; phone: string; email: string } | null
}

interface Transaction {
  id: string
  deal_name: string
  property_address: string
  stage: string
  purchase_price: number
  close_date: string
  health_score: number | null
  contact: { id: string; first_name: string; last_name: string } | null
  deal_health: { transaction_id: string; overall_score: number; risk_level: string } | null
}

interface PipelineSummaryData {
  activeCount: number
  approachingClose: { id: string; property_address: string; close_date: string } | null
}

interface ChurnRiskContact {
  id: string
  first_name: string | null
  last_name: string | null
  last_contact_date: string | null
  lead_stage: string | null
}

// ─── Priority Colors ──────────────────────────────────────────────────────────

function getPriorityColor(priority: string): string {
  switch (priority) {
    case "high":
      return "bg-red-500"
    case "medium":
      return "bg-amber-500"
    case "low":
      return "bg-emerald-500"
    default:
      return "bg-slate-500"
  }
}

function getPriorityBadgeVariant(priority: string): "destructive" | "secondary" | "default" {
  switch (priority) {
    case "high":
      return "destructive"
    case "medium":
      return "secondary"
    default:
      return "default"
  }
}

// ─── Health Score Ring Component ──────────────────────────────────────────────

function DealHealthRing({ score, size = 48 }: { score: number; size?: number }) {
  const radius = (size - 8) / 2
  const circumference = 2 * Math.PI * radius
  const progress = (score / 100) * circumference
  const offset = circumference - progress

  let color = "text-emerald-500"
  if (score < 50) color = "text-red-500"
  else if (score < 70) color = "text-amber-500"

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90" width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth="4"
          fill="none"
          className="text-muted/30"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth="4"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={color}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-semibold">{score}</span>
      </div>
    </div>
  )
}

// ─── Loading Skeletons ────────────────────────────────────────────────────────

function HeroSkeleton() {
  return (
    <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl p-8 text-white">
      <Skeleton className="h-6 w-48 bg-white/20 mb-4" />
      <Skeleton className="h-8 w-80 bg-white/20 mb-2" />
      <Skeleton className="h-5 w-full bg-white/20 mb-1" />
      <Skeleton className="h-5 w-3/4 bg-white/20" />
    </div>
  )
}

function PriorityStackSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-40" />
      </CardHeader>
      <CardContent className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

function ShowingsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-36" />
      </CardHeader>
      <CardContent className="space-y-3">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

function DealsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-32" />
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function LeadsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-28" />
      </CardHeader>
      <CardContent className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

// ─── Empty States ─────────────────────────────────────────────────────────────

function EmptyState({ icon: Icon, message }: { icon: React.ElementType; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <Icon className="h-10 w-10 mb-3 opacity-40" />
      <p className="text-sm">{message}</p>
    </div>
  )
}

// ─── Main Briefing Page ───────────────────────────────────────────────────────

export default function BriefingPage() {
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null)
  const [agentName, setAgentName] = useState<string>("Agent")
  const [showings, setShowings] = useState<Showing[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [priorityContacts, setPriorityContacts] = useState<ContactInsight[]>([])
  // New enhancement state
  const [pipelineSummary, setPipelineSummary] = useState<PipelineSummaryData | null>(null)
  const [buyerMatchCount, setBuyerMatchCount] = useState<number>(0)
  const [churnRiskContacts, setChurnRiskContacts] = useState<ChurnRiskContact[]>([])
  const [churnRiskTotal, setChurnRiskTotal] = useState<number>(0)

  // Get greeting based on time of day
  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return "Good morning"
    if (hour < 17) return "Good afternoon"
    return "Good evening"
  }

  // Format date
  const formatDate = () => {
    return new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  }

  // Format time
  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
  }

  // Load initial data
  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const [
        nameResult,
        briefingResult,
        showingsResult,
        transactionsResult,
        pipelineResult,
        buyerMatchResult,
        churnResult,
      ] = await Promise.all([
        getAgentName(),
        getTodaysBriefing(),
        getUpcomingShowings(),
        getActiveTransactions(),
        getPipelineSummary(),
        getBuyerMatchCount(),
        getChurnRiskContacts(),
      ])

      setAgentName(nameResult.name)
      setShowings(showingsResult.showings as Showing[])
      setTransactions(transactionsResult.transactions as Transaction[])
      setPipelineSummary({
        activeCount: pipelineResult.activeCount,
        approachingClose: pipelineResult.approachingClose,
      })
      setBuyerMatchCount(buyerMatchResult.matchCount)
      setChurnRiskContacts(churnResult.contacts as ChurnRiskContact[])
      setChurnRiskTotal(churnResult.totalCount)

      // Load AI priority contacts non-blocking — resolve user from session
      const supabase = createClient()
      supabase.auth.getSession().then(({ data: { session } }: { data: { session: any } }) => {
        if (session?.user?.id) {
          generateContactInsights(session.user.id, "agent")
            .then((insights) => setPriorityContacts(insights.slice(0, 3)))
            .catch(() => {/* non-blocking */})
        }
      })

      if (briefingResult.briefing) {
        setBriefing(briefingResult.briefing)
        // Mark as viewed
        await markBriefingViewed()
      } else {
        // Auto-generate if no briefing exists
        const generated = await generateBriefing(false)
        if (generated.briefing) {
          setBriefing(generated.briefing)
          await markBriefingViewed()
        } else if (generated.error) {
          setError(generated.error)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load briefing")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Regenerate briefing
  const handleRegenerate = async () => {
    setRegenerating(true)
    try {
      const result = await generateBriefing(true)
      if (result.briefing) {
        setBriefing(result.briefing)
      } else if (result.error) {
        setError(result.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate")
    } finally {
      setRegenerating(false)
    }
  }

  // Identify deals at risk from briefing
  const dealsAtRiskIds = new Set(briefing?.deals_at_risk?.map((d) => d.transaction_id) || [])

  if (error && !briefing) {
    return (
      <div className="container max-w-6xl mx-auto py-8 px-4">
        <Card className="border-destructive">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="h-12 w-12 text-destructive mb-4" />
            <h2 className="text-lg font-semibold mb-2">Failed to Load Briefing</h2>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button onClick={loadData}>Try Again</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container max-w-6xl mx-auto py-8 px-4 space-y-6">
      {/* HERO SUMMARY */}
      {loading ? (
        <HeroSkeleton />
      ) : (
        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl p-8 text-white relative overflow-hidden">
          <div className="absolute inset-0 bg-[url('/grid.svg')] opacity-10" />
          <div className="relative">
            <p className="text-slate-400 text-sm mb-1">{formatDate()}</p>
            <h1 className="text-2xl md:text-3xl font-bold mb-4">
              {getGreeting()}, {agentName.split(" ")[0]}
            </h1>
            <p className="text-slate-300 text-lg leading-relaxed max-w-3xl">
              {briefing?.summary || "Your daily briefing is being prepared..."}
            </p>
            {briefing?.market_pulse && (
              <div className="mt-4 flex items-center gap-2 text-slate-400">
                <TrendingUp className="h-4 w-4" />
                <span className="text-sm">{briefing.market_pulse}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MAIN GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT COLUMN - Priority Stack */}
        <div className="lg:col-span-2 space-y-6">
          {/* PRIORITY STACK */}
          {loading ? (
            <PriorityStackSkeleton />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-primary" />
                  Priority Actions
                  {briefing?.tasks_overdue && briefing.tasks_overdue > 0 && (
                    <Badge variant="destructive" className="ml-2">
                      {briefing.tasks_overdue} overdue
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {briefing?.top_priority_actions && briefing.top_priority_actions.length > 0 ? (
                  <div className="space-y-3">
                    {briefing.top_priority_actions.map((action, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-3 p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                      >
                        <div
                          className={cn("w-2 h-2 rounded-full mt-2 shrink-0", getPriorityColor(action.priority))}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={getPriorityBadgeVariant(action.priority)} className="text-xs">
                              {action.priority}
                            </Badge>
                          </div>
                          <p className="font-medium text-foreground">{action.action}</p>
                          <p className="text-sm text-muted-foreground mt-1">{action.context}</p>
                        </div>
                        <Button variant="ghost" size="sm" className="shrink-0">
                          <MessageSquare className="h-4 w-4 mr-1" />
                          Draft
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={CheckCircle} message="No priority actions for today" />
                )}
              </CardContent>
            </Card>
          )}

          {/* TODAY'S SHOWINGS */}
          {loading ? (
            <ShowingsSkeleton />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-primary" />
                  Upcoming Showings
                </CardTitle>
                <CardDescription>Next 48 hours</CardDescription>
              </CardHeader>
              <CardContent>
                {showings.length > 0 ? (
                  <div className="space-y-3">
                    {showings.map((showing) => (
                      <div
                        key={showing.id}
                        className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex flex-col items-center text-center min-w-[60px]">
                          <span className="text-lg font-bold">{formatTime(showing.scheduled_at)}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(showing.scheduled_at).toLocaleDateString("en-US", {
                              weekday: "short",
                            })}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">
                            {showing.listing?.address || "Unknown Address"}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {showing.contact
                              ? `${showing.contact.first_name} ${showing.contact.last_name}`
                              : "No contact"}
                          </p>
                        </div>
                        <Button variant="outline" size="sm" asChild>
                          <a href={`/dashboard/showings/${showing.id}`}>
                            View
                            <ArrowRight className="h-4 w-4 ml-1" />
                          </a>
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={Calendar} message="No showings in the next 48 hours" />
                )}
              </CardContent>
            </Card>
          )}

          {/* ACTIVE DEALS */}
          {loading ? (
            <DealsSkeleton />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Home className="h-5 w-5 text-primary" />
                  Active Deals
                </CardTitle>
              </CardHeader>
              <CardContent>
                {transactions.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {transactions.map((tx) => {
                      const isAtRisk = dealsAtRiskIds.has(tx.id)
                      const healthScore = tx.deal_health?.overall_score ?? tx.health_score ?? 0

                      return (
                        <div
                          key={tx.id}
                          className={cn(
                            "p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors relative",
                            isAtRisk && "border-destructive/50"
                          )}
                        >
                          {isAtRisk && (
                            <Badge
                              variant="destructive"
                              className="absolute -top-2 -right-2 text-xs"
                            >
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              At Risk
                            </Badge>
                          )}
                          <div className="flex items-start gap-3">
                            <DealHealthRing score={healthScore} />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">
                                {tx.property_address || tx.deal_name || "Unnamed Deal"}
                              </p>
                              <p className="text-sm text-muted-foreground capitalize">
                                {tx.stage?.replace(/_/g, " ") || "In Progress"}
                              </p>
                              {tx.close_date && (
                                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  Close: {(() => { const [y, m, d] = tx.close_date.split("T")[0].split("-"); return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) })()}
                                </p>
                              )}
                              {tx.purchase_price && (
                                <p className="text-xs text-muted-foreground flex items-center gap-1">
                                  <DollarSign className="h-3 w-3" />
                                  {new Intl.NumberFormat("en-US", {
                                    style: "currency",
                                    currency: "USD",
                                    maximumFractionDigits: 0,
                                  }).format(tx.purchase_price)}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <EmptyState icon={Home} message="No active deals" />
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* RIGHT COLUMN - Pipeline Summary + Buyer Matches + Churn Risk + Hot Leads + Market Pulse */}
        <div className="space-y-6">
          {/* PIPELINE SUMMARY */}
          {!loading && pipelineSummary !== null && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Target className="h-4 w-4 text-primary" />
                  Pipeline Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Active transactions</span>
                  <Badge variant="secondary" className="font-semibold">
                    {pipelineSummary.activeCount}
                  </Badge>
                </div>
                {pipelineSummary.approachingClose ? (
                  <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200/70">
                    <p className="text-xs font-semibold text-emerald-700 mb-0.5">Approaching Close</p>
                    <p className="text-sm font-medium text-emerald-800 leading-snug">
                      {pipelineSummary.approachingClose.property_address}
                    </p>
                    <p className="text-xs text-emerald-600 mt-0.5 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Close: {new Date(`${pipelineSummary.approachingClose.close_date}T00:00:00`).toLocaleDateString()}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No closings in the next 14 days</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* BUYER MATCHES */}
          {!loading && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Users className="h-4 w-4 text-primary" />
                  Buyer Matches
                </CardTitle>
              </CardHeader>
              <CardContent>
                {buyerMatchCount > 0 ? (
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      Buyers with active criteria
                    </p>
                    <Badge className="bg-blue-100 text-blue-700 border-blue-200 font-semibold">
                      {buyerMatchCount}
                    </Badge>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No active buyers with search criteria on file
                  </p>
                )}
                <Button variant="ghost" size="sm" className="w-full mt-3 text-xs h-7" asChild>
                  <Link href="/dashboard/buyers">View Buyers <ArrowRight className="h-3 w-3 ml-1" /></Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {/* CHURN RISK */}
          {!loading && churnRiskTotal > 0 && (
            <Card className="border-amber-200/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm text-amber-700">
                  <UserX className="h-4 w-4" />
                  Churn Risk
                  <Badge variant="outline" className="ml-auto border-amber-200 text-amber-700 bg-amber-50 text-xs">
                    {churnRiskTotal} contacts
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  Not contacted in 30+ days
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {churnRiskContacts.slice(0, 5).map((contact) => (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between gap-2 py-1 border-b last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Unknown"}
                      </p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {contact.lead_stage || "contact"} &middot;{" "}
                        {contact.last_contact_date
                          ? `Last: ${new Date(contact.last_contact_date.split("T")[0] + "T00:00:00").toLocaleDateString()}`
                          : "Never contacted"}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="shrink-0 text-xs h-7" asChild>
                      <Link href={`/crm?contact=${contact.id}`}>Touch</Link>
                    </Button>
                  </div>
                ))}
                {churnRiskTotal > 5 && (
                  <Button variant="ghost" size="sm" className="w-full text-xs h-7" asChild>
                    <Link href="/dashboard/contacts?filter=churn-risk">
                      +{churnRiskTotal - 5} more
                    </Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* HOT LEADS */}
          {loading ? (
            <LeadsSkeleton />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5 text-primary" />
                  Hot Leads
                </CardTitle>
              </CardHeader>
              <CardContent>
                {briefing?.hot_leads && briefing.hot_leads.length > 0 ? (
                  <div className="space-y-3">
                    {briefing.hot_leads.map((lead, idx) => (
                      <div
                        key={idx}
                        className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <p className="font-medium">{lead.name}</p>
                          <Badge variant="secondary" className="text-xs">
                            {lead.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mb-3">
                          {lead.suggested_action}
                        </p>
                        <Button variant="outline" size="sm" className="w-full">
                          <MessageSquare className="h-4 w-4 mr-2" />
                          Draft Message
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={User} message="No hot leads right now" />
                )}
              </CardContent>
            </Card>
          )}

          {/* DEALS AT RISK */}
          {briefing?.deals_at_risk && briefing.deals_at_risk.length > 0 && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  Deals at Risk
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {briefing.deals_at_risk.map((deal, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-lg bg-destructive/10 border border-destructive/20"
                    >
                      <p className="font-medium text-sm flex items-center gap-2">
                        <MapPin className="h-4 w-4" />
                        {deal.address}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">{deal.reason}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* TOP 3 CONTACTS TO WORK TODAY */}
          {priorityContacts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Top Contacts to Work Today
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {priorityContacts.map((insight, idx) => (
                    <div
                      key={insight.contactId}
                      className="flex items-start justify-between py-2 border-b last:border-0 gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground line-clamp-1">
                          {insight.action.charAt(0).toUpperCase() + insight.action.slice(1)} — Priority {idx + 1}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {insight.reason}
                        </p>
                        <p className="text-xs font-medium text-primary mt-0.5">{insight.suggestion}</p>
                      </div>
                      <Button size="sm" variant="outline" className="shrink-0 text-xs h-7" asChild>
                        <Link href={`/crm?contact=${insight.contactId}`}>Open</Link>
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* MARKET PULSE WIDGET */}
          <MarketInsightWidget />

          {/* FOOTER */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col gap-4">
                <Button
                  onClick={handleRegenerate}
                  disabled={regenerating}
                  variant="outline"
                  className="w-full"
                >
                  {regenerating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Regenerating...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Regenerate Briefing
                    </>
                  )}
                </Button>
                {briefing?.generated_at && (
                  <p className="text-xs text-muted-foreground text-center">
                    Last generated:{" "}
                    {new Date(briefing.generated_at).toLocaleString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
