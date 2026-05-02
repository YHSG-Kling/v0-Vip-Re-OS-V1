"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Plus,
  MailOpen,
  Sparkles,
  Loader2,
  Send,
  Calendar,
  Trash2,
  ExternalLink,
  Users,
  TrendingUp,
  Clock,
} from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { NewsletterAIPanel } from "./components/newsletter-ai-panel"
import {
  createEmailCampaign,
  deleteEmailCampaign,
  sendEmailCampaign,
  scheduleEmailCampaign,
  aiComposeEmail,
} from "@/app/actions/email-campaigns"
import {
  aiGenerateSubjectLines,
  aiOptimizeSendTime,
  getNewsletterAnalytics,
  aiAnalyzeNewsletterPerformance,
} from "@/app/actions/ai-newsletter"
import { format } from "date-fns"
import { toast } from "sonner"

interface Campaign {
  id: string
  status: string
  open_rate: number | null
  campaign_name: string
  subject_line: string
  created_at: string
  send_date: string | null
}

interface NewslettersClientProps {
  userId: string
  agentId: string
  brokerageId: string
  campaigns: Campaign[]
  stats: {
    activeCampaigns: number
    totalSubscribers: number
    avgOpenRate: number | null
    totalCampaigns: number
  }
}

const statusColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  scheduled: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  sent: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
}

export function NewslettersClient({
  userId,
  agentId,
  brokerageId,
  campaigns: initialCampaigns,
  stats,
}: NewslettersClientProps) {
  const router = useRouter()

  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Create form
  const [campaignName, setCampaignName] = useState("")
  const [subjectLine, setSubjectLine] = useState("")
  const [content, setContent] = useState("")

  // AI compose
  const [isComposing, setIsComposing] = useState(false)
  const [composeTopic, setComposeTopic] = useState("")

  // Send / schedule state
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [scheduleDate, setScheduleDate] = useState("")

  // AI subject line variants
  const [subjectVariants, setSubjectVariants] = useState<string[]>([])
  const [subjectVariantsLoading, setSubjectVariantsLoading] = useState(false)

  // Analytics
  const [analyticsData, setAnalyticsData] = useState<any>(null)
  const [analyticsInsights, setAnalyticsInsights] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsLoaded, setAnalyticsLoaded] = useState(false)

  async function handleGenerateSubjectVariants() {
    if (!campaignName.trim() && !composeTopic.trim()) return
    setSubjectVariantsLoading(true)
    setSubjectVariants([])
    try {
      const res = await aiGenerateSubjectLines({
        agentId,
        brokerageId,
        newsletterTopic: composeTopic.trim() || campaignName.trim(),
        tone: "professional",
      })
      if ((res as any).success && (res as any).subjectLines) {
        setSubjectVariants((res as any).subjectLines.slice(0, 5))
      }
    } finally {
      setSubjectVariantsLoading(false)
    }
  }

  async function handleLoadAnalytics() {
    if (analyticsLoaded) return
    setAnalyticsLoading(true)
    try {
      const [analyticsRes, insightsRes] = await Promise.all([
        campaigns.length > 0
          ? getNewsletterAnalytics({ newsletterId: campaigns[0].id, agentId })
          : Promise.resolve(null),
        aiAnalyzeNewsletterPerformance({ agentId }),
      ])
      setAnalyticsData(analyticsRes)
      setAnalyticsInsights(insightsRes)
      setAnalyticsLoaded(true)
    } finally {
      setAnalyticsLoading(false)
    }
  }

  async function handleCreate() {
    if (!campaignName.trim() || !subjectLine.trim()) {
      setCreateError("Campaign name and subject line are required")
      return
    }
    if (!brokerageId) {
      setCreateError("No brokerage configured. Contact your admin.")
      return
    }

    setIsCreating(true)
    setCreateError(null)

    try {
      const result = await createEmailCampaign({
        brokerageId,
        agentId: agentId || undefined,
        campaignName: campaignName.trim(),
        subjectLine: subjectLine.trim(),
        content: content.trim() || undefined,
        createdBy: userId,
      })

      if (result.success && result.campaign) {
        setIsCreateOpen(false)
        setCampaignName("")
        setSubjectLine("")
        setContent("")
        setCampaigns((prev) => [result.campaign as Campaign, ...prev])
        toast.success("Campaign created")
      } else {
        setCreateError(result.error ?? "Failed to create campaign")
      }
    } catch {
      setCreateError("Unexpected error creating campaign")
    } finally {
      setIsCreating(false)
    }
  }

  async function handleAiCompose() {
    if (!composeTopic.trim()) return
    setIsComposing(true)
    try {
      const result = await aiComposeEmail({
        brokerageId,
        agentId: agentId || undefined,
        topic: composeTopic.trim(),
        audience: "all",
        tone: "professional",
      })
      if (result.success && result.subject && result.body) {
        setSubjectLine(result.subject)
        setContent(result.body)
        toast.success("AI composed email — review and save below")
      } else {
        toast.error(result.error ?? "AI compose failed")
      }
    } catch {
      toast.error("AI compose failed")
    } finally {
      setIsComposing(false)
    }
  }

  async function handleSend(campaignId: string) {
    setSendingId(campaignId)
    try {
      const result = await sendEmailCampaign(campaignId, userId, brokerageId)
      if (result.success) {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === campaignId ? { ...c, status: "sent" } : c))
        )
        toast.success(`Campaign sent to ${result.recipientCount ?? 0} subscribers`)
      } else {
        toast.error(result.error ?? "Failed to send campaign")
      }
    } catch {
      toast.error("Unexpected error sending campaign")
    } finally {
      setSendingId(null)
    }
  }

  async function handleSchedule(campaignId: string) {
    if (!scheduleDate) {
      toast.error("Select a date before scheduling")
      return
    }
    try {
      const result = await scheduleEmailCampaign(campaignId, userId, scheduleDate)
      if (result.success) {
        setCampaigns((prev) =>
          prev.map((c) =>
            c.id === campaignId ? { ...c, status: "scheduled", send_date: scheduleDate } : c
          )
        )
        toast.success("Campaign scheduled")
        setScheduleDate("")
      } else {
        toast.error(result.error ?? "Failed to schedule campaign")
      }
    } catch {
      toast.error("Unexpected error scheduling campaign")
    }
  }

  async function handleDelete(campaignId: string) {
    setDeletingId(campaignId)
    try {
      const result = await deleteEmailCampaign(campaignId)
      if (result.success) {
        setCampaigns((prev) => prev.filter((c) => c.id !== campaignId))
        toast.success("Campaign deleted")
      } else {
        toast.error(result.error ?? "Failed to delete campaign")
      }
    } catch {
      toast.error("Unexpected error deleting campaign")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Newsletter Manager</h1>
          <p className="text-muted-foreground">
            Design, schedule, and send professional newsletters to your database
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Create Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Create Email Campaign</DialogTitle>
              <DialogDescription>
                Start a new newsletter campaign. Use AI to compose the content.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2 overflow-y-auto flex-1 min-h-0">
              {/* AI Compose */}
              <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  AI Quick Compose
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Topic, e.g. Spring market update"
                    value={composeTopic}
                    onChange={(e) => setComposeTopic(e.target.value)}
                    className="flex-1 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleAiCompose}
                    disabled={isComposing || !composeTopic.trim()}
                    className="gap-1"
                  >
                    {isComposing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    Compose
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  AI will fill in the subject line and body below.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="campaignName">Campaign Name</Label>
                <Input
                  id="campaignName"
                  placeholder="e.g. Q2 Market Update Newsletter"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="subjectLine">Subject Line</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs gap-1"
                    onClick={handleGenerateSubjectVariants}
                    disabled={subjectVariantsLoading || (!campaignName.trim() && !composeTopic.trim())}
                  >
                    {subjectVariantsLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    AI variants
                  </Button>
                </div>
                <Input
                  id="subjectLine"
                  placeholder="e.g. The market is shifting — what you need to know"
                  value={subjectLine}
                  onChange={(e) => setSubjectLine(e.target.value)}
                />
                {subjectVariants.length > 0 && (
                  <div className="space-y-1 pt-1">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pick one:</p>
                    {subjectVariants.map((v, i) => (
                      <button
                        key={i}
                        type="button"
                        className="block w-full text-left text-xs px-2 py-1.5 rounded border hover:bg-muted transition-colors"
                        onClick={() => { setSubjectLine(v); setSubjectVariants([]) }}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="content">Content</Label>
                <Textarea
                  id="content"
                  placeholder="Email body content (HTML supported)"
                  rows={5}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="text-sm font-mono"
                />
              </div>

              {createError && (
                <p className="text-sm text-destructive">{createError}</p>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={isCreating}
                >
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={isCreating}>
                  {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create Draft
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="campaigns" className="space-y-4">
        <TabsList>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="ai-writer" className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            AI Writer
          </TabsTrigger>
          <TabsTrigger value="analytics" className="flex items-center gap-1.5" onClick={handleLoadAnalytics}>
            <TrendingUp className="h-3.5 w-3.5" />
            Analytics
          </TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        {/* CAMPAIGNS TAB */}
        <TabsContent value="campaigns" className="space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-6 pb-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-primary/10 p-2">
                    <Clock className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold">{stats.activeCampaigns}</div>
                    <p className="text-xs text-muted-foreground">Scheduled</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 pb-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-primary/10 p-2">
                    <Users className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold">{stats.totalSubscribers.toLocaleString()}</div>
                    <p className="text-xs text-muted-foreground">Active Subscribers</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 pb-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-primary/10 p-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold">
                      {stats.avgOpenRate !== null
                        ? `${stats.avgOpenRate.toFixed(1)}%`
                        : "--"}
                    </div>
                    <p className="text-xs text-muted-foreground">Avg. Open Rate</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Campaign list */}
          {campaigns.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <MailOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="font-medium mb-1">No campaigns yet</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Create your first email campaign to start engaging with subscribers.
                </p>
                <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Campaign
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {campaigns.map((campaign) => (
                <Card key={campaign.id}>
                  <CardContent className="py-4">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium truncate">{campaign.campaign_name}</p>
                          <Badge
                            className={`text-xs ${
                              statusColors[campaign.status] ?? "bg-muted text-muted-foreground"
                            }`}
                            variant="secondary"
                          >
                            {campaign.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground truncate mt-0.5">
                          {campaign.subject_line}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Created {format(new Date(campaign.created_at), "MMM d, yyyy")}
                          {campaign.send_date &&
                            ` · Send: ${format(new Date(campaign.send_date), "MMM d, yyyy")}`}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {/* Schedule */}
                        {campaign.status === "draft" && (
                          <div className="flex items-center gap-1.5">
                            <Input
                              type="datetime-local"
                              className="h-8 text-xs w-44"
                              value={scheduleDate}
                              onChange={(e) => setScheduleDate(e.target.value)}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1 h-8"
                              onClick={() => handleSchedule(campaign.id)}
                              disabled={!scheduleDate}
                            >
                              <Calendar className="h-3.5 w-3.5" />
                              Schedule
                            </Button>
                          </div>
                        )}

                        {/* Send now */}
                        {(campaign.status === "draft" || campaign.status === "scheduled") && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="sm"
                                className="gap-1 h-8"
                                disabled={sendingId === campaign.id}
                              >
                                {sendingId === campaign.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Send className="h-3.5 w-3.5" />
                                )}
                                Send
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Send Campaign Now?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will immediately send &quot;{campaign.campaign_name}&quot; to all active
                                  subscribers. This cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleSend(campaign.id)}>
                                  Send Now
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}

                        {/* Open rate badge */}
                        {campaign.status === "sent" && campaign.open_rate !== null && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <TrendingUp className="h-3 w-3" />
                            {campaign.open_rate.toFixed(1)}% open
                          </Badge>
                        )}

                        {/* Delete */}
                        {campaign.status !== "sent" && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                                disabled={deletingId === campaign.id}
                              >
                                {deletingId === campaign.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete Campaign?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently delete &quot;{campaign.campaign_name}&quot;. This cannot
                                  be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleDelete(campaign.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* AI WRITER TAB */}
        <TabsContent value="ai-writer" className="space-y-4">
          {agentId ? (
            <NewsletterAIPanel agentId={agentId} brokerageId={brokerageId} />
          ) : (
            <Alert>
              <MailOpen className="h-4 w-4" />
              <AlertDescription>
                Sign in as an agent to use the AI newsletter tools.
              </AlertDescription>
            </Alert>
          )}
        </TabsContent>

        {/* ANALYTICS TAB */}
        <TabsContent value="analytics" className="space-y-4">
          {analyticsLoading ? (
            <div className="flex items-center gap-2 py-12 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading analytics…
            </div>
          ) : (
            <>
              {/* Per-newsletter stats */}
              {analyticsData?.success && (analyticsData as any).metrics && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: "Open Rate", value: `${((analyticsData as any).metrics.openRate ?? 0).toFixed(1)}%` },
                    { label: "Click Rate", value: `${((analyticsData as any).metrics.clickRate ?? 0).toFixed(1)}%` },
                    { label: "Unsubscribes", value: (analyticsData as any).metrics.unsubscribeCount ?? 0 },
                    { label: "Bounces", value: (analyticsData as any).metrics.bounceCount ?? 0 },
                  ].map((m) => (
                    <Card key={m.label}>
                      <CardContent className="pt-4 pb-4">
                        <p className="text-xs text-muted-foreground">{m.label}</p>
                        <p className="text-2xl font-bold tabular-nums">{m.value}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {/* AI performance insights */}
              {analyticsInsights && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-amber-500" />
                      AI Performance Insights
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {(analyticsInsights as any).insights?.map((insight: string, i: number) => (
                      <p key={i} className="text-muted-foreground">• {insight}</p>
                    ))}
                    {(analyticsInsights as any).recommendations?.map((rec: string, i: number) => (
                      <p key={i} className="text-foreground font-medium">→ {rec}</p>
                    ))}
                    {!(analyticsInsights as any).insights?.length && !(analyticsInsights as any).recommendations?.length && (
                      <p className="text-muted-foreground">No insights available yet. Send more campaigns to generate analysis.</p>
                    )}
                  </CardContent>
                </Card>
              )}

              {!analyticsLoaded && (
                <Card>
                  <CardContent className="py-12 text-center">
                    <TrendingUp className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                    <p className="text-muted-foreground text-sm">Click the Analytics tab to load your data.</p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* OVERVIEW TAB */}
        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MailOpen className="h-5 w-5" />
                Getting Started
              </CardTitle>
              <CardDescription>
                Set up your newsletter system to start engaging with contacts
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                {[
                  {
                    step: "1",
                    title: "Create Your First Campaign",
                    desc: "Use the Create Campaign button to draft your first newsletter.",
                    action: () => setIsCreateOpen(true),
                    label: "Create Campaign",
                  },
                  {
                    step: "2",
                    title: "Use AI to Write Content",
                    desc: "Let the AI Writer generate professional email copy for any topic.",
                    href: "#",
                    label: "Open AI Writer",
                  },
                  {
                    step: "3",
                    title: "Schedule or Send",
                    desc: "Pick a date to schedule or send immediately to all active subscribers.",
                    href: "/dashboard/marketing/studio",
                    label: "Open Marketing Studio",
                    external: true,
                  },
                ].map(({ step, title, desc, action, href, label, external }) => (
                  <div key={step} className="flex items-start gap-3">
                    <div className="rounded-full bg-primary/10 p-2 w-8 h-8 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-semibold text-primary">{step}</span>
                    </div>
                    <div>
                      <p className="font-medium">{title}</p>
                      <p className="text-sm text-muted-foreground">{desc}</p>
                      {action ? (
                        <Button variant="link" className="px-0 mt-2 gap-1" onClick={action}>
                          {label}
                        </Button>
                      ) : (
                        <Link href={href ?? "#"}>
                          <Button variant="link" className="px-0 mt-2 gap-1">
                            {label}
                            {external && <ExternalLink className="h-3 w-3" />}
                          </Button>
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
