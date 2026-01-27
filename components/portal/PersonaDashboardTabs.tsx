"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  CheckCircle2,
  Circle,
  ChevronRight,
  Calendar,
  FileText,
  MessageSquare,
  Home,
  TrendingUp,
  AlertCircle,
  Target,
  DollarSign,
  Building,
  BarChart3,
  Send,
  Star,
  Play,
} from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import type { PersonaConfig } from "@/lib/portal/persona-config"
import { TaskCompletionDialog } from "./TaskCompletionDialog"

interface PersonaDashboardTabsProps {
  contact: any
  persona: string
  config: PersonaConfig
  journeyStages: any[]
  currentStageIndex: number
  pendingTasks: any[]
  milestones: any[]
  showings: any[]
  documents: any[]
  messages: any[]
  savedProperties: any[]
  offers: any[]
  transactions: any[]
  taskCompletions?: any[]
}

export default function PersonaDashboardTabs({
  contact,
  persona,
  config,
  journeyStages,
  currentStageIndex,
  pendingTasks,
  milestones,
  showings,
  documents,
  messages,
  savedProperties,
  offers,
  transactions,
  taskCompletions = [],
}: PersonaDashboardTabsProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const PersonaIcon = config.icon

  // Get persona-specific tab labels
  const getTabLabels = () => {
    if (persona === "investor") {
      return { overview: "Pipeline", journey: "Deal Flow", activity: "Portfolio" }
    } else if (config.isSeller) {
      return { overview: "Listing", journey: "Selling Process", activity: "Showings & Offers" }
    } else {
      return { overview: "Overview", journey: "My Journey", activity: "Activity" }
    }
  }
  const tabLabels = getTabLabels()

  // Get persona-specific empty state messages
  const getEmptyMessage = (section: string) => {
    const emptyMessages: Record<string, Record<string, string>> = {
      investor: {
        tasks: "No active deals in your pipeline. Let's find your next investment opportunity!",
        properties: "Start building your deal pipeline by analyzing potential investment properties.",
        showings: "Schedule property tours to evaluate potential investments.",
      },
      default: {
        tasks: "All caught up! No pending tasks right now.",
        properties: "Start your property search to find your perfect home.",
        showings: "No upcoming showings scheduled.",
      },
    }
    return emptyMessages[persona]?.[section] || emptyMessages.default[section]
  }

  // Personalized messages based on contact data
  const getPersonalizedGreeting = () => {
    const customFields = contact.custom_fields || {}

    if (persona === "investor") {
      const portfolioSize = customFields.portfolio_size || 0
      const strategy = customFields.investment_strategy || "growing your portfolio"
      if (portfolioSize > 0) {
        return `With ${portfolioSize} properties in your portfolio, let's focus on ${strategy.toLowerCase()}.`
      }
      return `Ready to start building your real estate portfolio with a ${strategy.toLowerCase()} strategy.`
    } else if (persona === "military_buyer") {
      const branch = customFields.military_branch || "military"
      return `Thank you for your service! Let's find the perfect home for your ${branch} family.`
    } else if (persona === "divorce") {
      return "We're here to help make this transition as smooth as possible."
    } else if (persona === "senior") {
      return "Let's find the perfect next chapter for you, at your pace."
    }
    return config.greeting
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
      <TabsList className={cn("grid w-full grid-cols-4", config.bgColor)}>
        <TabsTrigger value="overview" className="data-[state=active]:bg-white">
          <Home className="w-4 h-4 mr-2" />
          {tabLabels.overview}
        </TabsTrigger>
        <TabsTrigger value="journey" className="data-[state=active]:bg-white">
          <Target className="w-4 h-4 mr-2" />
          {tabLabels.journey}
        </TabsTrigger>
        <TabsTrigger value="activity" className="data-[state=active]:bg-white">
          <BarChart3 className="w-4 h-4 mr-2" />
          {tabLabels.activity}
        </TabsTrigger>
        <TabsTrigger value="messages" className="data-[state=active]:bg-white">
          <MessageSquare className="w-4 h-4 mr-2" />
          Messages
          {messages.filter((m: any) => !m.read_at && m.sender_type !== "client").length > 0 && (
            <Badge className="ml-2 bg-red-500 text-white text-xs px-1.5 py-0">
              {messages.filter((m: any) => !m.read_at && m.sender_type !== "client").length}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>

      {/* OVERVIEW TAB - Persona-specific content */}
      <TabsContent value="overview" className="space-y-6">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left Column - What's Next */}
          <div className="lg:col-span-2 space-y-6">
            {/* Personalized Context Card */}
            <Card className={cn("border-l-4", config.borderColor)}>
              <CardContent className="p-4">
                <p className={cn("text-sm", config.color)}>{getPersonalizedGreeting()}</p>
              </CardContent>
            </Card>

            {/* Current Stage Tasks */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <AlertCircle className={cn("w-5 h-5", config.color)} />
                      {persona === "investor" ? "Active Deal Tasks" : "What's Next"}
                    </CardTitle>
                    <CardDescription>
                      Current stage: <span className="font-medium">{journeyStages[currentStageIndex]?.name}</span>
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className={config.borderColor}>
                    Stage {currentStageIndex + 1} of {journeyStages.length}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {journeyStages[currentStageIndex]?.tasks?.slice(0, 4).map((task: any, idx: number) => (
                  <TaskCompletionDialog
                    key={task.id || idx}
                    task={{
                      id: task.id || `${journeyStages[currentStageIndex].id}-task-${idx}`,
                      title: task.title,
                      description: task.description || `Complete this task to progress in your ${config.title.toLowerCase()} journey.`,
                      stageId: journeyStages[currentStageIndex].id,
                      stageName: journeyStages[currentStageIndex].name,
                      required: task.required,
                      type: task.type || 'checkbox',
                      estimatedMinutes: task.estimatedMinutes,
                    }}
                    contactId={contact.id}
                    persona={persona}
                    onComplete={() => window.location.reload()}
                  >
                    <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer border border-transparent hover:border-slate-200">
                      <div className="flex items-center gap-3">
                        {task.completed ? (
                          <CheckCircle2 className="w-5 h-5 text-green-500" />
                        ) : task.required ? (
                          <AlertCircle className="w-5 h-5 text-orange-500" />
                        ) : (
                          <Play className="w-5 h-5 text-blue-500" />
                        )}
                        <span className={cn("text-sm", task.completed && "line-through text-muted-foreground")}>
                          {task.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {task.required && !task.completed && (
                          <Badge variant="destructive" className="text-xs">
                            Required
                          </Badge>
                        )}
                        {!task.completed && (
                          <Badge variant="outline" className="text-xs">
                            Start
                          </Badge>
                        )}
                      </div>
                    </div>
                  </TaskCompletionDialog>
                )) || (
                  <div className="text-center py-6 text-muted-foreground">
                    <CheckCircle2 className="w-12 h-12 mx-auto mb-2 text-green-500" />
                    <p>{getEmptyMessage("tasks")}</p>
                  </div>
                )}
                <Button variant="outline" className="w-full mt-2 bg-transparent" asChild>
                  <Link href={`/portal/${contact.id}/journey`}>
                    View Full {persona === "investor" ? "Deal Flow" : "Journey"}{" "}
                    <ChevronRight className="w-4 h-4 ml-2" />
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* Persona-specific secondary card */}
            {persona === "investor" && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-indigo-600" />
                    Deal Pipeline
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {savedProperties.length > 0 ? (
                    <div className="space-y-3">
                      {savedProperties.slice(0, 3).map((prop: any) => (
                        <div key={prop.id} className="flex items-center justify-between p-3 border rounded-lg">
                          <div>
                            <p className="font-medium text-sm">{prop.property_address || prop.mls_number}</p>
                            <p className="text-xs text-muted-foreground">
                              {prop.property_data?.price
                                ? `$${prop.property_data.price.toLocaleString()}`
                                : "Price TBD"}
                            </p>
                          </div>
                          <Badge variant="secondary">{prop.status || "Analyzing"}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-6 text-muted-foreground">
                      <Building className="w-12 h-12 mx-auto mb-2 text-slate-300" />
                      <p>{getEmptyMessage("properties")}</p>
                    </div>
                  )}
                  <Button variant="outline" className="w-full mt-4 bg-transparent" asChild>
                    <Link href={`/portal/${contact.id}/properties`}>
                      {savedProperties.length > 0 ? "View All Deals" : "Find Investment Properties"}
                      <ChevronRight className="w-4 h-4 ml-2" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Active Transactions */}
            {transactions.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2">
                    <Building className="w-5 h-5 text-green-600" />
                    Active Transactions
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {transactions.slice(0, 3).map((transaction: any) => {
                      const statusColors: Record<string, string> = {
                        offer: "bg-blue-100 text-blue-800",
                        inspection: "bg-yellow-100 text-yellow-800",
                        appraisal: "bg-purple-100 text-purple-800",
                        financing: "bg-orange-100 text-orange-800",
                        clear_to_close: "bg-green-100 text-green-800",
                        closed: "bg-gray-100 text-gray-800",
                      }
                      const statusColor = statusColors[transaction.status] || "bg-slate-100 text-slate-800"
                      
                      return (
                        <Link 
                          key={transaction.id} 
                          href={`/portal/${contact.id}/transaction/${transaction.id}`}
                          className="block"
                        >
                          <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                                <Home className="w-5 h-5 text-green-600" />
                              </div>
                              <div>
                                <p className="font-medium text-sm">
                                  {transaction.property_address || transaction.listings?.address || "Transaction"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {transaction.closing_date
                                    ? `Closing: ${new Date(transaction.closing_date).toLocaleDateString()}`
                                    : transaction.current_stage || "In Progress"}
                                </p>
                              </div>
                            </div>
                            <Badge className={statusColor}>
                              {transaction.status?.replace(/_/g, " ") || "Active"}
                            </Badge>
                          </div>
                        </Link>
                      )
                    })}
                  </div>
                  {transactions.length > 3 && (
                    <Button variant="outline" className="w-full mt-4 bg-transparent" asChild>
                      <Link href={`/portal/${contact.id}/journey`}>
                        View All Transactions <ChevronRight className="w-4 h-4 ml-2" />
                      </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Showings for non-investors */}
            {persona !== "investor" && showings.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-blue-600" />
                    {config.isSeller ? "Scheduled Showings" : "Upcoming Showings"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {showings.slice(0, 3).map((showing: any) => (
                      <div key={showing.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                            <Home className="w-5 h-5 text-blue-600" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">{showing.property_address || "Property"}</p>
                            <p className="text-xs text-muted-foreground">
                              {showing.confirmed_date
                                ? new Date(showing.confirmed_date).toLocaleDateString("en-US", {
                                    weekday: "short",
                                    month: "short",
                                    day: "numeric",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })
                                : "Pending confirmation"}
                            </p>
                          </div>
                        </div>
                        <Badge variant={showing.status === "confirmed" ? "default" : "secondary"}>
                          {showing.status || "Pending"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                  <Button variant="outline" className="w-full mt-4 bg-transparent" asChild>
                    <Link href={`/portal/${contact.id}/showings`}>
                      Manage Showings <ChevronRight className="w-4 h-4 ml-2" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Column - Quick Actions & Features */}
          <div className="space-y-6">
            {/* Quick Actions */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Star className={cn("w-5 h-5", config.color)} />
                  Quick Actions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  {config.quickActions?.map((action: any, idx: number) => {
                    const ActionIcon = action.icon
                    return (
                      <Button
                        key={idx}
                        variant="outline"
                        className={cn("h-auto py-4 flex flex-col items-center gap-2", config.borderColor)}
                        asChild
                      >
                        <Link href={action.href.replace("{contactId}", contact.id)}>
                          <ActionIcon className={cn("w-6 h-6", config.color)} />
                          <span className="text-xs text-center">{action.label}</span>
                        </Link>
                      </Button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Persona-specific resources */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">
                  {persona === "investor" ? "Investment Tools" : "Your Resources"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {config.resources?.slice(0, 4).map((resource: any, idx: number) => {
                  const ResourceIcon = resource.icon
                  return (
                    <Button key={idx} variant="ghost" className="w-full justify-start h-auto py-3" asChild>
                      <Link href={`/portal/${contact.id}/journey`}>
                        <ResourceIcon className={cn("w-5 h-5 mr-3", config.color)} />
                        <div className="text-left">
                          <p className="text-sm font-medium">{resource.title}</p>
                          <p className="text-xs text-muted-foreground">{resource.description}</p>
                        </div>
                      </Link>
                    </Button>
                  )
                })}
              </CardContent>
            </Card>
          </div>
        </div>
      </TabsContent>

      {/* JOURNEY TAB */}
      <TabsContent value="journey" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{persona === "investor" ? "Investment Deal Flow" : "Your Journey Progress"}</CardTitle>
            <CardDescription>
              {persona === "investor"
                ? "Track your deals from sourcing to closing"
                : `${journeyStages.length} stages to ${config.isSeller ? "selling" : "homeownership"}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Journey Progress Bar */}
            <div className="mb-8">
              <div className="flex justify-between text-sm mb-2">
                <span>Overall Progress</span>
                <span className="font-medium">
                  Stage {currentStageIndex + 1} of {journeyStages.length}
                </span>
              </div>
              <Progress value={((currentStageIndex + 1) / journeyStages.length) * 100} className="h-3" />
            </div>

            {/* Journey Stages */}
            <div className="space-y-4">
              {journeyStages.map((stage: any, idx: number) => {
                const isComplete = idx < currentStageIndex
                const isCurrent = idx === currentStageIndex
                const StageIcon = isComplete ? CheckCircle2 : isCurrent ? Target : Circle

                return (
                  <div
                    key={stage.id}
                    className={cn(
                      "p-4 rounded-lg border-2 transition-all",
                      isComplete && "bg-green-50 border-green-200",
                      isCurrent && cn(config.bgColor, config.borderColor),
                      !isComplete && !isCurrent && "bg-slate-50 border-slate-200 opacity-60",
                    )}
                  >
                    <div className="flex items-start gap-4">
                      <div
                        className={cn(
                          "p-2 rounded-full",
                          isComplete && "bg-green-100",
                          isCurrent && "bg-white",
                          !isComplete && !isCurrent && "bg-slate-100",
                        )}
                      >
                        <StageIcon
                          className={cn(
                            "w-6 h-6",
                            isComplete && "text-green-600",
                            isCurrent && config.color,
                            !isComplete && !isCurrent && "text-slate-400",
                          )}
                        />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="font-semibold">{stage.name}</h3>
                          {stage.estimatedDays && (
                            <Badge variant="outline" className="text-xs">
                              ~{stage.estimatedDays} days
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mb-3">{stage.description}</p>

                        {/* Show tasks for current stage - with completion dialog */}
                        {isCurrent && stage.tasks && (
                          <div className="space-y-2 mt-4">
                            <p className="text-xs font-medium text-muted-foreground uppercase">Tasks</p>
                            {stage.tasks.map((task: any, taskIdx: number) => (
                              <TaskCompletionDialog
                                key={task.id || taskIdx}
                                task={{
                                  id: task.id || `${stage.id}-task-${taskIdx}`,
                                  title: task.title,
                                  description: task.description || `Complete this task to progress in your ${config.title.toLowerCase()} journey.`,
                                  stageId: stage.id,
                                  stageName: stage.name,
                                  required: task.required,
                                  type: task.type || 'checkbox',
                                  estimatedMinutes: task.estimatedMinutes,
                                }}
                                contactId={contact.id}
                                persona={persona}
                                onComplete={() => {
                                  // Refresh the page to show updated progress
                                  window.location.reload()
                                }}
                              >
                                <div className="flex items-center gap-2 text-sm p-2 bg-white rounded cursor-pointer hover:bg-slate-50 transition-colors border border-transparent hover:border-slate-200">
                                  {task.completed ? (
                                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                                  ) : (
                                    <Play className="w-4 h-4 text-blue-500" />
                                  )}
                                  <span className={cn(task.completed && "line-through text-muted-foreground")}>{task.title}</span>
                                  {task.required && !task.completed && (
                                    <Badge variant="destructive" className="text-xs ml-auto">
                                      Required
                                    </Badge>
                                  )}
                                  {!task.required && !task.completed && (
                                    <Badge variant="outline" className="text-xs ml-auto">
                                      Start
                                    </Badge>
                                  )}
                                </div>
                              </TaskCompletionDialog>
                            ))}
                          </div>
                        )}

                        {/* Show resources for current stage */}
                        {isCurrent && stage.resources && stage.resources.length > 0 && (
                          <div className="mt-4 pt-4 border-t">
                            <p className="text-xs font-medium text-muted-foreground uppercase mb-2">Resources</p>
                            <div className="flex flex-wrap gap-2">
                              {stage.resources.map((resource: any, rIdx: number) => (
                                <Badge key={rIdx} variant="secondary" className="cursor-pointer hover:bg-slate-200">
                                  {resource.title}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* ACTIVITY TAB */}
      <TabsContent value="activity" className="space-y-6">
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Recent Documents */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-600" />
                Recent Documents
              </CardTitle>
            </CardHeader>
            <CardContent>
              {documents.length > 0 ? (
                <div className="space-y-3">
                  {documents.slice(0, 5).map((doc: any) => (
                    <div key={doc.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex items-center gap-3">
                        <FileText className="w-5 h-5 text-slate-400" />
                        <div>
                          <p className="text-sm font-medium">{doc.name || doc.document_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(doc.created_at).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <Badge variant="secondary">{doc.status || "Received"}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <FileText className="w-12 h-12 mx-auto mb-2 text-slate-300" />
                  <p>No documents yet</p>
                </div>
              )}
              <Button variant="outline" className="w-full mt-4 bg-transparent" asChild>
                <Link href={`/portal/${contact.id}/documents`}>
                  View All Documents <ChevronRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          {/* Showings/Offers based on persona */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                {persona === "investor" ? (
                  <>
                    <TrendingUp className="w-5 h-5 text-indigo-600" />
                    Active Offers
                  </>
                ) : config.isSeller ? (
                  <>
                    <DollarSign className="w-5 h-5 text-green-600" />
                    Offers Received
                  </>
                ) : (
                  <>
                    <Calendar className="w-5 h-5 text-blue-600" />
                    Showing History
                  </>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {persona === "investor" || config.isSeller ? (
                offers.length > 0 ? (
                  <div className="space-y-3">
                    {offers.slice(0, 5).map((offer: any) => (
                      <div key={offer.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div>
                          <p className="text-sm font-medium">{offer.property_address || "Property"}</p>
                          <p className="text-xs text-muted-foreground">
                            ${offer.offer_amount?.toLocaleString() || "TBD"}
                          </p>
                        </div>
                        <Badge variant={offer.status === "accepted" ? "default" : "secondary"}>
                          {offer.status || "Pending"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-6 text-muted-foreground">
                    <DollarSign className="w-12 h-12 mx-auto mb-2 text-slate-300" />
                    <p>No offers yet</p>
                  </div>
                )
              ) : showings.length > 0 ? (
                <div className="space-y-3">
                  {showings.slice(0, 5).map((showing: any) => (
                    <div key={showing.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="text-sm font-medium">{showing.property_address || "Property"}</p>
                        <p className="text-xs text-muted-foreground">
                          {showing.confirmed_date ? new Date(showing.confirmed_date).toLocaleDateString() : "Pending"}
                        </p>
                      </div>
                      <Badge variant={showing.status === "completed" ? "outline" : "secondary"}>
                        {showing.status || "Pending"}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <Calendar className="w-12 h-12 mx-auto mb-2 text-slate-300" />
                  <p>{getEmptyMessage("showings")}</p>
                </div>
              )}
              <Button variant="outline" className="w-full mt-4 bg-transparent" asChild>
                <Link
                  href={`/portal/${contact.id}/${persona === "investor" || config.isSeller ? "offers" : "showings"}`}
                >
                  View All <ChevronRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      {/* MESSAGES TAB - Personalized */}
      <TabsContent value="messages" className="space-y-6">
        <Card className="h-[600px] flex flex-col">
          <CardHeader className="pb-3 border-b">
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                Messages with Your {persona === "investor" ? "Investment Advisor" : "Agent"}
              </span>
              {messages.filter((m: any) => !m.read_at && m.sender_type !== "client").length > 0 && (
                <Badge className="bg-red-500">
                  {messages.filter((m: any) => !m.read_at && m.sender_type !== "client").length} unread
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <ScrollArea className="flex-1 p-4">
            {messages.length > 0 ? (
              <div className="space-y-4">
                {messages.map((msg: any) => (
                  <div
                    key={msg.id}
                    className={cn("flex", msg.sender_type === "client" ? "justify-end" : "justify-start")}
                  >
                    <div
                      className={cn(
                        "max-w-[80%] rounded-lg p-3",
                        msg.sender_type === "client"
                          ? "bg-blue-600 text-white"
                          : msg.sender_type === "system"
                            ? "bg-slate-100 text-slate-600 text-center w-full"
                            : "bg-slate-100",
                      )}
                    >
                      {msg.sender_type !== "client" && msg.sender_type !== "system" && (
                        <p className="text-xs font-medium mb-1">{msg.sender_name || "Your Agent"}</p>
                      )}
                      <p className="text-sm">{msg.message_content}</p>
                      <p
                        className={cn(
                          "text-xs mt-1",
                          msg.sender_type === "client" ? "text-blue-200" : "text-muted-foreground",
                        )}
                      >
                        {new Date(msg.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <MessageSquare className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="font-medium mb-2">Start a conversation</h3>
                <p className="text-sm text-muted-foreground">
                  {persona === "investor"
                    ? "Ask about investment opportunities, market analysis, or deal structure."
                    : "Send a message to your agent. They typically respond within a few hours."}
                </p>
              </div>
            )}
          </ScrollArea>
          <div className="p-4 border-t">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={
                  persona === "investor" ? "Ask about cap rates, ROI, or market trends..." : "Type a message..."
                }
                className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Button>
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
