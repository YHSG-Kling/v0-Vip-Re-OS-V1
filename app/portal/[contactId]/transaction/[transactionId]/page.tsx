"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { loadClientDashboard } from "@/app/actions/transactions"
import { createClient } from "@/lib/supabase/client"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import {
  CheckCircle2,
  Circle,
  Loader2,
  Home,
  Search,
  DollarSign,
  FileText,
  CheckSquare,
  PartyPopper,
  AlertTriangle,
  Info,
  Flag,
  Bell,
  HelpCircle,
  ChevronDown,
  Phone,
  Mail,
  MessageCircle,
  Clock,
  Shield,
} from "lucide-react"
import { ClientFeedbackWidget } from "./client-feedback-widget"
import { LoanChecklistCard } from "./loan-checklist-card"
import { ContinuityReceiptCard } from "@/app/components/portal/continuity-receipt-card"
import { BuyerClosingCostsCard } from "@/app/components/portal/buyer-closing-costs-card"
import { cn } from "@/lib/utils"
import { format } from "date-fns"

interface DashboardData {
  persona: string
  personaConfig: {
    theme: string
    primaryColor: string
    title: string
    icon: string
    welcomeMessage: string
  }
  hero: {
    property_address: string
    current_stage_display: string
    status_message: string
    progress_percent: number
    health_indicator: string
    days_until_closing: number
    persona_theme: string
  }
  timeline: Array<{
    id: string
    name: string
    date: string
    status: string
    icon: string
    description: string
  }>
  next_actions: Array<{
    id: string
    task: string
    due_date: string | null
    priority: string
    help_url?: string | null
  }>
  earnestMoney: {
    received: boolean
    heldBy: string
    receivedDate: string | null
  } | null
  checklistSummary: {
    totalRequired: number
    completed: number
    pendingItems: Array<{ id: string; name: string; category: string }>
  }
  delayInfo: {
    hasDelays: boolean
    impactOnClosing: number
    reasons: string[]
  } | null
  updates: Array<{
    id: string
    text: string
    type: string
    timestamp: string
    icon: string
    source?: string
    nextStep?: string
    nextStepDate?: string
  }>
  // Contact details are OPTIONAL because they are legitimately absent, not
  // because the data is sloppy. Two reasons, both deliberate:
  //   · a party may simply have no company / phone on file;
  //   · this is a CLIENT portal, and the counterparty's contact details are
  //     redacted before they ever reach it (rosterForPrincipal) — a buyer must
  //     not read the seller's email off their own dashboard.
  // Declaring these `string` made the type claim something the redaction
  // guarantees is false, so every consumer below must handle the absence.
  team: Array<{
    id: string
    role: string
    name: string
    company: string | null
    email: string | null
    phone: string | null
  }>
  personaTools: Array<{
    name: string
    url: string
    icon: string
  }>
  educationalContent: {
    title: string
    content: string
    type?: string
    isRead?: boolean
    videoUrl?: string
  } | null
  contactAgent: {
    message: string
    action: string
  }
}

const iconMap: Record<string, any> = {
  home: Home,
  search: Search,
  "dollar-sign": DollarSign,
  "file-text": FileText,
  "check-square": CheckSquare,
  "check-circle": CheckCircle2,
  circle: Circle,
  "party-popper": PartyPopper,
  "alert-triangle": AlertTriangle,
  info: Info,
  flag: Flag,
  bell: Bell,
}

export default function TransactionDashboard() {
  const params = useParams()
  const contactId = params.contactId as string
  const transactionId = params.transactionId as string
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [transparencyUpdates, setTransparencyUpdates] = useState<Array<{
    id: string
    message: string | null
    update_type: string | null
    created_at: string
  }>>([])

  useEffect(() => {
    async function loadData() {
      try {
        const dashboardData = await loadClientDashboard(transactionId, contactId)
        setData(dashboardData)
      } catch (error) {
        console.error("Failed to load dashboard:", error)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [transactionId, contactId])

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("transparency_updates")
      .select("id, message, update_type, created_at")
      .eq("transaction_id", transactionId)
      .eq("is_visible_to_client", true)
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data: rows }: { data: Array<{ id: string; message: string | null; update_type: string | null; created_at: string }> | null }) => {
        if (rows) setTransparencyUpdates(rows)
      })
  }, [transactionId])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Transaction not found</p>
      </div>
    )
  }

  const getThemeColors = (theme: string) => {
    const themes: Record<string, string> = {
      buyer: "from-blue-600 to-indigo-600",
      seller: "from-green-600 to-emerald-600",
      luxury: "from-purple-600 to-pink-600",
      investor: "from-amber-600 to-orange-600",
      relocation: "from-teal-600 to-cyan-600",
    }
    return themes[theme] || "from-blue-600 to-indigo-600"
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section - Persona Themed */}
      <div className={cn("relative h-48 bg-gradient-to-r overflow-hidden", getThemeColors(data.personaConfig.theme))}>
        <div className="absolute inset-0 bg-black/20" />
        <div className="relative h-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col justify-center">
          <div className="flex items-center gap-2 mb-2">
            <Badge className="w-fit bg-white/20 text-white border-0">{data.personaConfig.title}</Badge>
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">{data.hero.property_address}</h1>
          <Badge className="w-fit bg-white/20 text-white border-0 mb-3">{data.hero.current_stage_display}</Badge>
          <Progress value={data.hero.progress_percent} className="w-full h-2 bg-white/20 mb-2" />
          <p className="text-white/90 text-lg">{data.hero.status_message}</p>
          {data.hero.days_until_closing > 0 && (
            <p className="text-white/80 text-sm mt-1">{data.hero.days_until_closing} days until closing</p>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Timeline Widget */}
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-6">Your Journey</h2>
              <div className="relative">
                {data.timeline.map((milestone, index) => {
                  const Icon = iconMap[milestone.icon] || Circle
                  const isCompleted = milestone.status === "completed"
                  const isInProgress = milestone.status === "in_progress"
                  const isLast = index === data.timeline.length - 1

                  return (
                    <div key={index} className="flex items-start mb-8 last:mb-0">
                      {!isLast && <div className="absolute left-6 top-12 bottom-0 w-0.5 bg-border" style={{ height: "calc(100% - 3rem)" }} />}

                      <div
                        className={cn(
                          "relative z-10 flex items-center justify-center w-12 h-12 rounded-full border-4",
                          isCompleted && "bg-green-500 border-green-100",
                          isInProgress && "bg-blue-500 border-blue-100 animate-pulse",
                          !isCompleted && !isInProgress && "bg-muted border-border",
                        )}
                      >
                        <Icon className="w-6 h-6 text-white" />
                      </div>

                      <div className="ml-6 flex-1">
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold text-lg">{milestone.name}</h3>
                          <span className="text-sm text-muted-foreground">
                            {isCompleted ? "✓ Complete" : isInProgress ? "In Progress" : new Date(milestone.date).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="text-muted-foreground mt-1">{milestone.description}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>

            {/* Next Actions Widget */}
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">What You Need To Do</h2>
              {data.next_actions.length === 0 ? (
                <div className="text-center py-8">
                  <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
                  <p className="text-muted-foreground">All caught up! Nothing needed from you right now.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {data.next_actions.map((action) => (
                    <div
                      key={action.id}
                      className={cn(
                        "border-l-4 p-4 rounded-r-lg",
                        action.priority === "critical" && "border-red-500 bg-red-50 dark:bg-red-950/20",
                        action.priority === "high" && "border-orange-500 bg-orange-50 dark:bg-orange-950/20",
                        action.priority !== "critical" && action.priority !== "high" && "border-blue-500 bg-blue-50 dark:bg-blue-950/20",
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h4 className="font-semibold">{action.task}</h4>
                          <p className="text-sm text-muted-foreground mt-1">Due: {action.due_date ? new Date(action.due_date).toLocaleDateString() : "TBD"}</p>
                          {action.help_url && (
                            <a href={action.help_url} className="text-blue-600 dark:text-blue-400 text-sm mt-2 inline-flex items-center hover:underline">
                              <HelpCircle className="w-4 h-4 mr-1" />
                              How to do this
                            </a>
                          )}
                        </div>
                        <Button size="sm" className="bg-green-500 hover:bg-green-600 text-white" asChild>
                          <a href={`/portal/${contactId}/documents`}>Upload</a>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Continuity receipt — the OS proves the file is in sync (real checks run at read time) */}
            <ContinuityReceiptCard contactId={contactId} transactionId={transactionId} />

            {/* Loan conditions — what the lender still needs (renders only with real loan state) */}
            <LoanChecklistCard contactId={contactId} transactionId={transactionId} />

            {/* Closing-cost breakdown — honest ranges grounded in this deal's numbers */}
            <BuyerClosingCostsCard contactId={contactId} transactionId={transactionId} />

            {/* Earnest Money & Checklist Status */}
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">Transaction Status</h2>
              <div className="space-y-4">
                {/* Earnest Money Status */}
                {data.earnestMoney && (
                  <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center",
                        data.earnestMoney.received ? "bg-green-100 dark:bg-green-950/30" : "bg-amber-100 dark:bg-amber-950/30"
                      )}>
                        <Shield className={cn("w-5 h-5", data.earnestMoney.received ? "text-green-600" : "text-amber-600")} />
                      </div>
                      <div>
                        <p className="font-medium">Earnest Money Deposit</p>
                        <p className="text-sm text-muted-foreground">
                          {data.earnestMoney.received 
                            ? `Received - Held by ${data.earnestMoney.heldBy}`
                            : `Pending - Will be held by ${data.earnestMoney.heldBy}`
                          }
                        </p>
                      </div>
                    </div>
                    {data.earnestMoney.received && (
                      <Badge className="bg-green-100 text-green-700 border-0">Secured</Badge>
                    )}
                  </div>
                )}

                {/* Closing Checklist Summary */}
                <div className="border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium">Closing Checklist</h3>
                    <span className="text-sm text-muted-foreground">
                      {data.checklistSummary.completed} of {data.checklistSummary.totalRequired} complete
                    </span>
                  </div>
                  <Progress 
                    value={(data.checklistSummary.completed / Math.max(data.checklistSummary.totalRequired, 1)) * 100} 
                    className="h-2 mb-3" 
                  />
                  {data.checklistSummary.pendingItems.length > 0 && (
                    <details className="group">
                      <summary className="cursor-pointer flex items-center justify-between text-sm text-muted-foreground hover:text-foreground">
                        {data.checklistSummary.pendingItems.length} items remaining
                        <ChevronDown className="w-4 h-4 group-open:rotate-180 transition-transform" />
                      </summary>
                      <ul className="mt-3 space-y-2">
                        {data.checklistSummary.pendingItems.slice(0, 5).map((item) => (
                          <li key={item.id} className="flex items-center gap-2 text-sm">
                            <Circle className="w-3 h-3 text-muted-foreground" />
                            <span>{item.name}</span>
                            <Badge variant="outline" className="ml-auto text-xs">{item.category}</Badge>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>

                {/* Delay Info if present */}
                {data.delayInfo?.hasDelays && (
                  <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
                    <Clock className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-800 dark:text-amber-200">Timeline Update</p>
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        {data.delayInfo.impactOnClosing > 0 
                          ? `Closing may be delayed by approximately ${data.delayInfo.impactOnClosing} days.`
                          : "There are some items that need attention. Your agent will keep you updated."
                        }
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Right Column - Updates Feed & Persona Tools */}
          <div className="lg:col-span-1 space-y-6">
            {/* Persona-Specific Tools */}
            {data.personaTools && data.personaTools.length > 0 && (
              <Card className="p-6">
                <h2 className="text-xl font-semibold mb-4">Your Tools</h2>
                <div className="space-y-2">
                  {data.personaTools.map((tool, index) => (
                    <Button key={index} variant="outline" className="w-full justify-start bg-transparent" asChild>
                      <a href={tool.url}>
                        <span className="mr-2">{tool.name}</span>
                      </a>
                    </Button>
                  ))}
                </div>
              </Card>
            )}

            {/* Educational Content */}
            {data.educationalContent && (
              <Card className="p-6">
                <h2 className="text-xl font-semibold mb-2">{data.educationalContent.title}</h2>
                <p className="text-sm text-muted-foreground mb-4">{data.educationalContent.content}</p>
                <Button className="w-full" variant="default" asChild>
                  <a href={data.educationalContent.videoUrl || `/portal/${contactId}/learn`}>
                    {data.educationalContent.videoUrl ? "Watch Video Guide" : "Open in your learning center"}
                  </a>
                </Button>
              </Card>
            )}

            {/* Important Delay Notices from agent */}
            {transparencyUpdates.length > 0 && (
              <Card className="p-6 border-amber-200 bg-amber-50 dark:bg-amber-950/20">
                <h2 className="text-xl font-semibold mb-4">Important Updates</h2>
                <div className="space-y-2">
                  {transparencyUpdates.map((u) => (
                    <div
                      key={u.id}
                      className="rounded-lg bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 p-3"
                    >
                      <p className="text-sm text-amber-800 dark:text-amber-200">{u.message}</p>
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        {format(new Date(u.created_at), "MMM d, h:mm a")}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Updates Feed */}
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">Recent Updates</h2>
              <div className="space-y-4">
                {data.updates.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No updates yet. Check back soon!</p>
                ) : (
                  data.updates.map((update, index) => {
                    const Icon = iconMap[update.icon] || Bell
                    return (
                      <div key={update.id || index} className="flex items-start">
                        <div
                          className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center mr-4 flex-shrink-0",
                            update.type === "celebration" && "bg-green-100 dark:bg-green-950/20",
                            update.type === "urgent" && "bg-red-100 dark:bg-red-950/20",
                            update.type !== "celebration" && update.type !== "urgent" && "bg-blue-100 dark:bg-blue-950/20",
                          )}
                        >
                          <Icon className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm">{update.text}</p>
                          {update.nextStep && (
                            <p className="text-xs text-primary mt-1">Next: {update.nextStep}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">{new Date(update.timestamp).toLocaleDateString()}</p>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </Card>

            {/* Team Contacts */}
            {data.team && data.team.length > 0 && (
              <Card className="p-6">
                <h2 className="text-xl font-semibold mb-4">Your Team</h2>
                <div className="space-y-4">
                  {data.team.map((member) => (
                    <div key={member.id} className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                        <span className="text-sm font-medium">{member.name?.charAt(0) || "?"}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{member.name}</p>
                        <p className="text-sm text-muted-foreground">{member.role}</p>
                        {member.company && <p className="text-xs text-muted-foreground">{member.company}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Client Feedback — shown once progress is at 80%+ (near or at closing) */}
            {data.hero.progress_percent >= 80 && data.team && data.team.length > 0 && (
              <ClientFeedbackWidget
                contactId={contactId}
                transactionId={transactionId}
                agentId={data.team.find((m) => m.role.toLowerCase().includes("agent"))?.id ?? data.team[0].id}
              />
            )}
          </div>
        </div>

        {/* Contact Agent CTA - Sticky on mobile */}
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur border-t lg:relative lg:bottom-auto lg:left-auto lg:right-auto lg:p-0 lg:bg-transparent lg:backdrop-blur-none lg:border-0 lg:mt-8">
          <Card className="p-4 lg:p-6 bg-gradient-to-r from-primary/10 to-primary/5 border-primary/20">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="text-center sm:text-left">
                <h3 className="font-semibold">Have Questions?</h3>
                <p className="text-sm text-muted-foreground">{data.contactAgent?.message || "Your agent is here to help with any questions."}</p>
              </div>
              <div className="flex gap-2 w-full sm:w-auto">
                {(() => {
                  const agent = data.team?.find((m) => m.role?.toLowerCase().includes("agent")) ?? data.team?.[0]
                  return (
                    <>
                      {agent?.phone && (
                        <Button variant="outline" size="sm" className="flex-1 sm:flex-initial" asChild>
                          <a href={`tel:${agent.phone}`}>
                            <Phone className="w-4 h-4 mr-2" />
                            Call
                          </a>
                        </Button>
                      )}
                      {agent?.email && (
                        <Button variant="outline" size="sm" className="flex-1 sm:flex-initial" asChild>
                          <a href={`mailto:${agent.email}`}>
                            <Mail className="w-4 h-4 mr-2" />
                            Email
                          </a>
                        </Button>
                      )}
                      <Button size="sm" className="flex-1 sm:flex-initial" asChild>
                        <a href={`/portal/${contactId}/messages`}>
                          <MessageCircle className="w-4 h-4 mr-2" />
                          Message
                        </a>
                      </Button>
                    </>
                  )
                })()}
              </div>
            </div>
          </Card>
        </div>

        {/* Bottom padding for mobile sticky CTA */}
        <div className="h-24 lg:h-0" />
      </div>
    </div>
  )
}
