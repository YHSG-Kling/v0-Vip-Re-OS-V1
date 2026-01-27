"use client"

import Link from "next/link"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Phone,
  Mail,
  MessageSquare,
  Video,
  Calendar,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  Clock,
  CheckCircle,
  Send,
  Eye,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { generateDailyGameplan } from "@/app/actions/copilot"
import { generateAssistantSuggestions } from "@/app/actions/assistant"

export default function DashboardPage() {
  const [gameplan, setGameplan] = useState<any>(null)
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [currentTime, setCurrentTime] = useState(new Date())

  useEffect(() => {
    loadGameplan()
    subscribeToUpdates()

    const timer = setInterval(() => setCurrentTime(new Date()), 60000)
    return () => clearInterval(timer)
  }, [])

  async function loadGameplan() {
    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const plan = await generateDailyGameplan(user.id)
      setGameplan(plan)

      const { suggestions: sug } = await generateAssistantSuggestions(user.id, {
        page: "dashboard",
      })
      setSuggestions(sug || [])

      setLoading(false)
    } catch (error) {
      console.error("Failed to load gameplan:", error)
      setLoading(false)
    }
  }

  function subscribeToUpdates() {
    const supabase = createClient()

    const channel = supabase
      .channel("dashboard_updates")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "contacts",
        },
        () => {
          loadGameplan()
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "transaction_milestones",
        },
        () => {
          loadGameplan()
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "video_scripts",
        },
        () => {
          loadGameplan()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading your gameplan...</p>
          </div>
        </div>
      </div>
    )
  }

  const greeting =
    currentTime.getHours() < 12 ? "Good morning" : currentTime.getHours() < 18 ? "Good afternoon" : "Good evening"

  return (
    <div className="container mx-auto py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">{greeting}!</h1>
        <p className="text-muted-foreground">
          {currentTime.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}{" "}
          - Here&apos;s your gameplan for today
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <QuickStatCard
          icon={Phone}
          label="Contacts to Call"
          value={gameplan?.people_to_call?.length || 0}
          color="text-blue-600"
          bgColor="bg-blue-100"
        />
        <QuickStatCard
          icon={AlertTriangle}
          label="At-Risk Deals"
          value={gameplan?.deals_to_protect?.length || 0}
          color="text-red-600"
          bgColor="bg-red-100"
        />
        <QuickStatCard
          icon={Video}
          label="Content Ready"
          value={gameplan?.content_to_post?.length || 0}
          color="text-purple-600"
          bgColor="bg-purple-100"
        />
        <QuickStatCard
          icon={CheckCircle}
          label="Tasks Today"
          value={12}
          color="text-green-600"
          bgColor="bg-green-100"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-blue-100 rounded-lg">
                    <Phone className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <CardTitle>People to Call</CardTitle>
                    <CardDescription>Hot leads that need your attention today</CardDescription>
                  </div>
                </div>
                <Badge variant="secondary" className="text-lg">
                  {gameplan?.people_to_call?.length || 0}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[350px] pr-4">
                {gameplan?.people_to_call && gameplan.people_to_call.length > 0 ? (
                  <div className="space-y-3">
                    {gameplan.people_to_call.map((contact: any) => (
                      <ContactCard key={contact.id} contact={contact} />
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={Phone} title="No calls scheduled" description="Great! You're all caught up." />
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-red-100 rounded-lg">
                    <AlertTriangle className="h-5 w-5 text-red-600" />
                  </div>
                  <div>
                    <CardTitle>Deals to Protect</CardTitle>
                    <CardDescription>Transactions requiring immediate action</CardDescription>
                  </div>
                </div>
                <Badge variant="destructive" className="text-lg">
                  {gameplan?.deals_to_protect?.length || 0}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[350px] pr-4">
                {gameplan?.deals_to_protect && gameplan.deals_to_protect.length > 0 ? (
                  <div className="space-y-3">
                    {gameplan.deals_to_protect.map((deal: any) => (
                      <DealCard key={deal.id} deal={deal} />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={CheckCircle}
                    title="All deals on track"
                    description="No at-risk transactions. Keep up the great work!"
                  />
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-purple-100 rounded-lg">
                    <Video className="h-5 w-5 text-purple-600" />
                  </div>
                  <div>
                    <CardTitle>Content to Post</CardTitle>
                    <CardDescription>Approved content ready to share</CardDescription>
                  </div>
                </div>
                <Badge variant="secondary" className="text-lg">
                  {gameplan?.content_to_post?.length || 0}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[350px] pr-4">
                {gameplan?.content_to_post && gameplan.content_to_post.length > 0 ? (
                  <div className="space-y-3">
                    {gameplan.content_to_post.map((content: any) => (
                      <ContentCard key={content.id} content={content} />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={Video}
                    title="No content ready"
                    description="Review and approve video scripts to get started."
                  />
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-1">
          <Card className="sticky top-4">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-yellow-500" />
                <CardTitle>AI Assistant</CardTitle>
              </div>
              <CardDescription>Smart suggestions for you</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[calc(100vh-250px)]">
                <div className="space-y-4">
                  {suggestions && suggestions.length > 0 ? (
                    suggestions.map((suggestion, i) => <SuggestionCard key={i} suggestion={suggestion} />)
                  ) : (
                    <div className="text-center py-8">
                      <Lightbulb className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">No suggestions right now. Check back soon!</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function QuickStatCard({ icon: Icon, label, value, color, bgColor }: any) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground mb-1">{label}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
          <div className={`p-3 rounded-lg ${bgColor}`}>
            <Icon className={`h-6 w-6 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ContactCard({ contact }: any) {
  return (
    <div className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent transition-colors group">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Avatar className="h-10 w-10">
          <AvatarImage src={contact.avatar_url || "/placeholder.svg"} />
          <AvatarFallback>
            {contact.first_name?.[0]}
            {contact.last_name?.[0]}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">
            {contact.first_name} {contact.last_name}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-xs">
              Score: {contact.lead_score}
            </Badge>
            <span className="text-xs text-muted-foreground truncate">{contact.stage}</span>
          </div>
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
          <Phone className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
          <MessageSquare className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
          <Mail className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function DealCard({ deal }: any) {
  return (
    <div className="p-4 border rounded-lg hover:bg-accent transition-colors space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="font-medium">{deal.listings?.address || "Transaction"}</p>
          <p className="text-sm text-muted-foreground">{deal.title}</p>
        </div>
        <Badge variant="destructive">At Risk</Badge>
      </div>

      <div className="flex items-start gap-2 text-sm">
        <Clock className="h-4 w-4 text-orange-500 mt-0.5 flex-shrink-0" />
        <span className="text-muted-foreground">Due: {new Date(deal.due_date).toLocaleDateString()}</span>
      </div>

      <div className="flex gap-2 pt-2">
        <Button size="sm" variant="outline" className="flex-1 bg-transparent" asChild>
          <Link href={`/transactions/${deal.id}`}>
            <Eye className="h-3 w-3 mr-1" />
            View Details
          </Link>
        </Button>
        <Button size="sm" className="flex-1">
          <CheckCircle className="h-3 w-3 mr-1" />
          Take Action
        </Button>
      </div>
    </div>
  )
}

function ContentCard({ content }: any) {
  return (
    <div className="p-4 border rounded-lg hover:bg-accent transition-colors space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-20 h-20 bg-muted rounded-lg flex items-center justify-center flex-shrink-0">
          <Video className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{content.script_purpose || "Video Content"}</p>
          <p className="text-sm text-muted-foreground">For: {content.contacts?.first_name || "Social Media"}</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="outline" className="text-xs">
              Ready
            </Badge>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1 bg-transparent">
          <Eye className="h-3 w-3 mr-1" />
          Preview
        </Button>
        <Button size="sm" className="flex-1">
          <Send className="h-3 w-3 mr-1" />
          Post Now
        </Button>
      </div>
    </div>
  )
}

function SuggestionCard({ suggestion }: any) {
  const icons: any = {
    action: Phone,
    insight: TrendingUp,
    reminder: Calendar,
    ai_suggestion: Lightbulb,
    alert: AlertTriangle,
  }

  const Icon = icons[suggestion.suggestion_type] || Lightbulb

  const priorityConfig: any = {
    critical: { color: "text-red-500", bgColor: "bg-red-50", borderColor: "border-red-200" },
    high: { color: "text-orange-500", bgColor: "bg-orange-50", borderColor: "border-orange-200" },
    medium: { color: "text-blue-500", bgColor: "bg-blue-50", borderColor: "border-blue-200" },
    low: { color: "text-gray-500", bgColor: "bg-gray-50", borderColor: "border-gray-200" },
  }

  const config = priorityConfig[suggestion.priority] || priorityConfig.medium

  return (
    <div className={`p-3 border rounded-lg ${config.borderColor} ${config.bgColor} space-y-2`}>
      <div className="flex items-start gap-2">
        <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${config.color}`} />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm">{suggestion.title}</p>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{suggestion.description}</p>
        </div>
      </div>
      {suggestion.action_payload?.action && (
        <Button size="sm" variant="outline" className="w-full text-xs bg-transparent">
          {suggestion.action_payload.action.replace(/_/g, " ")}
        </Button>
      )}
    </div>
  )
}

function EmptyState({ icon: Icon, title, description }: any) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="p-3 bg-muted rounded-full mb-3">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="font-medium mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
