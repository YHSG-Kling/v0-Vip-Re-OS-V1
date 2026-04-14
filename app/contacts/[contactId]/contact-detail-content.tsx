"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Progress } from "@/components/ui/progress"
import { Phone, Mail, MessageSquare, Video, DollarSign, Lightbulb, TrendingUp, Bot } from "lucide-react"
import {
  getContactCreditAccounts,
  getContactVideoEngagement,
  getContactTransactions,
  getContactCopilotSuggestions,
  getContactActivity,
} from "@/app/actions/contact-details"
import { useEffect } from "react"
import {
  HandoffContextCard,
  FirstHumanTouchCard,
  OriginalLeadAccessCard,
  ConversionCoachingCard,
} from "@/app/dashboard/agent/components/conversion"

interface ContactDetailContentProps {
  contact: any
}

export default function ContactDetailContent({ contact }: ContactDetailContentProps) {
  const [creditAccounts, setCreditAccounts] = useState<any[]>([])
  const [videos, setVideos] = useState<any[]>([])
  const [transactions, setTransactions] = useState<any[]>([])
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [activity, setActivity] = useState<any[]>([])

  useEffect(() => {
    async function loadData() {
      try {
        const [credit, video, trans, sugg, act] = await Promise.all([
          getContactCreditAccounts(contact.id),
          getContactVideoEngagement(contact.id),
          getContactTransactions(contact.id),
          getContactCopilotSuggestions(contact.id),
          getContactActivity(contact.id),
        ])

        setCreditAccounts(credit?.accounts ?? [])
        setVideos(video?.videos ?? [])
        setTransactions(trans?.transactions ?? [])
        setSuggestions(sugg?.suggestions ?? [])
        setActivity(act?.activity ?? [])
      } catch (err) {
        console.error("[ContactDetail] Failed to load contact data:", err)
        // Keep empty arrays — component renders gracefully with no data
      }
    }
    loadData()
  }, [contact.id])

  const initials = `${contact.first_name?.[0] || ""}${contact.last_name?.[0] || ""}`.toUpperCase()

  return (
    <div className="container mx-auto py-8">
      <div className="grid lg:grid-cols-4 gap-6">
        {/* Main Content - 3 columns */}
        <div className="lg:col-span-3 space-y-6">
          {/* Contact Header */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                  <div>
                    <h1 className="text-2xl font-bold">
                      {contact.first_name} {contact.last_name}
                    </h1>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge>{contact.contact_persona || contact.contact_type}</Badge>
                      <Badge variant="outline">Lead Score: {contact.lead_score || 50}</Badge>
                      <Badge variant="secondary">{contact.stage}</Badge>
                    </div>
                    <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                      {contact.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          {contact.email}
                        </span>
                      )}
                      {contact.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {contact.phone}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" asChild>
                    <a href={`/dashboard/voice?contactId=${contact.id}`}>
                      <Phone className="h-4 w-4" />
                    </a>
                  </Button>
                  <Button size="sm" asChild>
                    <a href={contact.email ? `mailto:${contact.email}` : `/dashboard/inbox?compose=1&contactId=${contact.id}`}>
                      <Mail className="h-4 w-4" />
                    </a>
                  </Button>
                  <Button size="sm" asChild>
                    <a href={`/dashboard/inbox?contactId=${contact.id}`}>
                      <MessageSquare className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Enhanced Tabs */}
          <Tabs defaultValue="overview" className="space-y-4">
            <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
              <TabsList className="flex min-w-max sm:grid sm:w-full sm:grid-cols-6">
                <TabsTrigger value="overview" className="min-h-[44px] sm:min-h-0 min-w-[90px] sm:min-w-0">Overview</TabsTrigger>
                <TabsTrigger value="copilot" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">AI Copilot</TabsTrigger>
                <TabsTrigger value="credit" className="min-h-[44px] sm:min-h-0 min-w-[80px] sm:min-w-0">Credit</TabsTrigger>
                <TabsTrigger value="videos" className="min-h-[44px] sm:min-h-0 min-w-[80px] sm:min-w-0">Videos</TabsTrigger>
                <TabsTrigger value="transactions" className="min-h-[44px] sm:min-h-0 min-w-[110px] sm:min-w-0">Transactions</TabsTrigger>
                <TabsTrigger value="activity" className="min-h-[44px] sm:min-h-0 min-w-[80px] sm:min-w-0">Activity</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Contact Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Type</span>
                      <span className="font-medium">{contact.contact_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Source</span>
                      <span className="font-medium">{contact.source || "Direct"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status</span>
                      <Badge variant={contact.status === "active" ? "default" : "secondary"}>{contact.status}</Badge>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Preferences</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {contact.preferred_location && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Location</span>
                        <span className="font-medium">{contact.preferred_location}</span>
                      </div>
                    )}
                    {contact.budget_min && contact.budget_max && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Budget</span>
                        <span className="font-medium">
                          ${contact.budget_min?.toLocaleString()} - ${contact.budget_max?.toLocaleString()}
                        </span>
                      </div>
                    )}
                    {contact.move_timeline && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Timeline</span>
                        <span className="font-medium">{contact.move_timeline}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="copilot" className="space-y-4">
              {/* ISA Qualification Context Section */}
              <div className="grid md:grid-cols-2 gap-4">
                <HandoffContextCard
                  contactId={contact.id}
                  leadId={contact.source_lead_id}
                />
                <FirstHumanTouchCard
                  contactId={contact.id}
                  contactName={`${contact.first_name || ""} ${contact.last_name || ""}`.trim()}
                  contactPhone={contact.phone}
                  contactEmail={contact.email}
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <OriginalLeadAccessCard
                  contactId={contact.id}
                  leadId={contact.source_lead_id}
                />
                <ConversionCoachingCard contactId={contact.id} />
              </div>

              {/* AI Copilot Suggestions */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-violet-600" />
                    AI Copilot Suggestions
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {suggestions.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No active suggestions at the moment
                    </p>
                  ) : (
                    suggestions.map((suggestion) => (
                      <CopilotSuggestion
                        key={suggestion.id}
                        priority={suggestion.priority || "medium"}
                        title={suggestion.title}
                        description={suggestion.description}
                        action="Take Action"
                      />
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="credit" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Credit Pipeline Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {creditAccounts.length === 0 ? (
                      <div className="p-4 border rounded-lg text-center">
                        <p className="text-sm text-muted-foreground mb-2">No active credit accounts</p>
                        <Button size="sm" variant="outline">
                          Add to Credit Pipeline
                        </Button>
                      </div>
                    ) : (
                      creditAccounts.map((account) => (
                        <CreditAccountCard
                          key={account.id}
                          partner={account.lender_name || "Lender"}
                          amount={account.loan_amount || 0}
                          status={account.status}
                          stage={account.credit_pipeline_stage || "Lead"}
                        />
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="videos" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Video Engagement</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {videos.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">No videos sent yet</p>
                    ) : (
                      videos.map((video) => (
                        <VideoEngagementCard
                          key={video.id}
                          title={video.script_title || "Video"}
                          sent={new Date(video.created_at).toLocaleDateString()}
                          views={video.view_count || 0}
                          completion_rate={video.avg_completion_rate || 0}
                          last_viewed={
                            video.last_viewed_at ? new Date(video.last_viewed_at).toLocaleDateString() : "Never"
                          }
                        />
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="transactions" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Transaction History</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {transactions.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">No transactions yet</p>
                    ) : (
                      transactions.map((transaction) => (
                        <TransactionCard
                          key={transaction.id}
                          property={
                            transaction.property_address
                              ? `${transaction.property_address}${transaction.city ? `, ${transaction.city}` : ""}`
                              : "Property"
                          }
                          status={transaction.status}
                          stage={transaction.transaction_type || "Active"}
                          progress={calculateProgress(transaction.status)}
                        />
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="activity" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Activity Timeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {activity.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">No activity recorded yet</p>
                    ) : (
                      activity.map((item: any) => (
                        <div key={`${item.activity_type}-${item.id}`} className="flex gap-3 pb-4 border-b last:border-0">
                          <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-primary" />
                          <div className="flex-1 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="font-medium text-sm capitalize">
                                {item.activity_type.replace("_", " ")}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {new Date(item.activity_date).toLocaleDateString()}
                              </span>
                            </div>
                            {(item.notes || item.body || item.title || item.subject) && (
                              <p className="text-sm text-muted-foreground">
                                {item.notes || item.body || item.title || item.subject}
                              </p>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* Assistant Panel - Right Sidebar */}
        <div className="lg:col-span-1">
          <Card className="sticky top-4">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-yellow-500" />
                <CardTitle>Assistant</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {contact.lead_score > 75 && (
                <AssistantSuggestion
                  icon={TrendingUp}
                  title="Hot Lead"
                  message="High engagement in last 24 hours. Call today!"
                />
              )}
              {videos.length > 0 && (
                <AssistantSuggestion
                  icon={Video}
                  title="Video Sent"
                  message={`${videos.length} video(s) sent to this contact`}
                />
              )}
              {creditAccounts.length > 0 && (
                <AssistantSuggestion
                  icon={DollarSign}
                  title="Credit Active"
                  message="Contact has active credit accounts"
                />
              )}
              {suggestions.length > 0 && (
                <AssistantSuggestion
                  icon={Lightbulb}
                  title={`${suggestions.length} Suggestions`}
                  message="Check AI Copilot tab for actions"
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

// Helper function
function calculateProgress(stage: string): number {
  const stageMap: Record<string, number> = {
    "New Lead": 10,
    Qualified: 25,
    "Property Search": 35,
    Showing: 50,
    Offer: 65,
    "Under Contract": 80,
    Closing: 95,
    Closed: 100,
  }
  return stageMap[stage] || 35
}

// Component definitions
function CopilotSuggestion({
  priority,
  title,
  description,
  action,
}: {
  priority: string
  title: string
  description: string
  action: string
}) {
  const colors = {
    high: "border-red-500",
    medium: "border-yellow-500",
    low: "border-blue-500",
  }

  return (
    <div className={`p-4 border-l-4 ${colors[priority as keyof typeof colors]} bg-muted/30 rounded`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={priority === "high" ? "destructive" : "secondary"}>{priority}</Badge>
            <h4 className="font-medium text-sm">{title}</h4>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button size="sm">{action}</Button>
      </div>
    </div>
  )
}

function CreditAccountCard({
  partner,
  amount,
  status,
  stage,
}: {
  partner: string
  amount: number
  status: string
  stage: string
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-medium">{partner}</h4>
          <Badge>{stage}</Badge>
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-medium">${amount.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <span className="capitalize">{status}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function VideoEngagementCard({
  title,
  sent,
  views,
  completion_rate,
  last_viewed,
}: {
  title: string
  sent: string
  views: number
  completion_rate: number
  last_viewed: string
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <h4 className="font-medium mb-2">{title}</h4>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-muted-foreground">Sent</p>
            <p className="font-medium">{sent}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Views</p>
            <p className="font-medium">{views}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Completion</p>
            <p className="font-medium">{completion_rate}%</p>
          </div>
          <div>
            <p className="text-muted-foreground">Last Viewed</p>
            <p className="font-medium">{last_viewed}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function TransactionCard({
  property,
  status,
  stage,
  progress,
}: {
  property: string
  status: string
  stage: string
  progress: number
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-medium">{property}</h4>
          <Badge>{status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground mb-2">{stage}</p>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      </CardContent>
    </Card>
  )
}

function AssistantSuggestion({
  icon: Icon,
  title,
  message,
}: {
  icon: any
  title: string
  message: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <h4 className="font-medium text-sm">{title}</h4>
      </div>
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  )
}
