"use client"

import { useState, useTransition, useCallback, useEffect } from "react"
import { format, formatDistanceToNow } from "date-fns"
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Megaphone, Plus, Search, Filter, MoreHorizontal, Rocket, Pause,
  TrendingUp, DollarSign, Users, Target, Mail, Share2, Radio,
  MapPin, BarChart3, Sparkles, Loader2, Eye, Edit, Trash2,
  CheckCircle2, Clock, AlertCircle, Play, ChevronRight, Calendar,
  X, RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { CreateCampaignModal } from "@/app/dashboard/isa/campaigns/components/CreateCampaignModal"
import {
  createMarketingCampaign,
  updateMarketingCampaign,
  launchMarketingCampaign,
  pauseMarketingCampaign,
  endMarketingCampaign,
  deleteMarketingCampaign,
  aiSuggestCampaign,
  aiGenerateCampaignCopy,
  addCampaignTask,
  updateCampaignTaskStatus,
  getMarketingCampaign,
  type CampaignWithROI,
} from "@/app/actions/marketing-campaigns"

// ─── Types ────────────────────────────────────────────────────────────────────

interface CampaignsHubClientProps {
  userId: string
  brokerageId: string
  userRole: string
  campaigns: CampaignWithROI[]
  total: number
  summary: {
    total_campaigns: number
    active_campaigns: number
    total_spend: number
    total_leads: number
    total_conversions: number
    avg_roi: number | null
    top_channel: string | null
  } | null
}

const CAMPAIGN_TYPES = [
  { value: "email", label: "Email", icon: Mail },
  { value: "social", label: "Social Media", icon: Share2 },
  { value: "ads", label: "Paid Ads", icon: Radio },
  { value: "direct_mail", label: "Direct Mail", icon: MapPin },
  { value: "multi_channel", label: "Multi-Channel", icon: Megaphone },
]

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; color: string }> = {
  draft:    { label: "Draft",   variant: "outline",     color: "text-muted-foreground" },
  active:   { label: "Active",  variant: "default",     color: "text-green-600" },
  paused:   { label: "Paused",  variant: "secondary",   color: "text-yellow-600" },
  ended:    { label: "Ended",   variant: "secondary",   color: "text-muted-foreground" },
  archived: { label: "Archived",variant: "outline",     color: "text-muted-foreground" },
}

function fmt(n: number | null | undefined, decimals = 0) {
  if (n == null) return "—"
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals })
}

function fmtCurrency(n: number | null | undefined) {
  if (n == null) return "—"
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function fmtPct(n: number | null | undefined) {
  if (n == null) return "—"
  return `${n.toFixed(1)}%`
}

// ─── Campaign Card ─────────────────────────────────────────────────────────────

function CampaignCard({
  campaign,
  onView,
  onLaunch,
  onPause,
  onEnd,
  onDelete,
}: {
  campaign: CampaignWithROI
  onView: (c: CampaignWithROI) => void
  onLaunch: (id: string) => void
  onPause: (id: string) => void
  onEnd: (id: string) => void
  onDelete: (id: string) => void
}) {
  const status = STATUS_CONFIG[campaign.status] ?? STATUS_CONFIG.draft
  const TypeIcon = CAMPAIGN_TYPES.find((t) => t.value === campaign.campaign_type)?.icon ?? Megaphone
  const budgetPct =
    campaign.budget_total && campaign.budget_spent
      ? Math.min(100, (campaign.budget_spent / campaign.budget_total) * 100)
      : 0

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-pointer"
      onClick={() => onView(campaign)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-2 rounded-lg bg-primary/10 shrink-0">
              <TypeIcon className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base truncate">{campaign.campaign_name}</CardTitle>
              <CardDescription className="capitalize">
                {CAMPAIGN_TYPES.find((t) => t.value === campaign.campaign_type)?.label ?? campaign.campaign_type}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Badge variant={status.variant}>{status.label}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onView(campaign)}>
                  <Eye className="w-4 h-4 mr-2" /> View Details
                </DropdownMenuItem>
                {campaign.status === "draft" && (
                  <DropdownMenuItem onClick={() => onLaunch(campaign.id)}>
                    <Rocket className="w-4 h-4 mr-2" /> Launch
                  </DropdownMenuItem>
                )}
                {campaign.status === "active" && (
                  <DropdownMenuItem onClick={() => onPause(campaign.id)}>
                    <Pause className="w-4 h-4 mr-2" /> Pause
                  </DropdownMenuItem>
                )}
                {(campaign.status === "active" || campaign.status === "paused") && (
                  <DropdownMenuItem onClick={() => onEnd(campaign.id)}>
                    <CheckCircle2 className="w-4 h-4 mr-2" /> End Campaign
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDelete(campaign.id)}
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Budget Progress */}
        {campaign.budget_total != null && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Budget</span>
              <span>
                {fmtCurrency(campaign.budget_spent ?? 0)} / {fmtCurrency(campaign.budget_total)}
              </span>
            </div>
            <Progress value={budgetPct} className="h-1.5" />
          </div>
        )}

        {/* Metrics Row */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Leads</p>
            <p className="text-sm font-semibold">{fmt(campaign.roi?.total_leads)}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Conversions</p>
            <p className="text-sm font-semibold">{fmt(campaign.roi?.total_conversions)}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">ROI</p>
            <p className={cn("text-sm font-semibold", (campaign.roi?.roi_percentage ?? 0) > 0 ? "text-green-600" : "")}>
              {fmtPct(campaign.roi?.roi_percentage)}
            </p>
          </div>
        </div>

        {/* Dates */}
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
          <span>
            {campaign.launched_at
              ? `Launched ${formatDistanceToNow(new Date(campaign.launched_at), { addSuffix: true })}`
              : `Created ${formatDistanceToNow(new Date(campaign.created_at), { addSuffix: true })}`}
          </span>
          {campaign.scheduled_end_at && (
            <span>Ends {format(new Date(campaign.scheduled_end_at), "MMM d")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Create Campaign Dialog ────────────────────────────────────────────────────

function CreateCampaignDialog({
  open,
  brokerageId,
  onClose,
  onCreated,
}: {
  open: boolean
  brokerageId: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [isPending, startTransition] = useTransition()
  const [isSuggesting, setSuggesting] = useState(false)
  const [form, setForm] = useState({
    name: "",
    type: "email",
    budget: "",
    audience: "",
    startDate: "",
    endDate: "",
  })
  const [suggestions, setSuggestions] = useState<{ name: string; audience: string; description: string }[]>([])
  const [error, setError] = useState("")

  const handleSuggest = useCallback(async () => {
    setSuggesting(true)
    setError("")
    const result = await aiSuggestCampaign({
      brokerageId,
      campaignType: form.type,
      context: form.audience,
    })
    if (result.success && result.suggestions) {
      setSuggestions(result.suggestions)
    } else {
      setError(result.error ?? "Suggestion failed")
    }
    setSuggesting(false)
  }, [brokerageId, form.type, form.audience])

  const handleCreate = useCallback(() => {
    if (!form.name.trim()) {
      setError("Campaign name is required")
      return
    }
    setError("")
    startTransition(async () => {
      const result = await createMarketingCampaign({
        brokerageId,
        campaignName: form.name.trim(),
        campaignType: form.type,
        budgetTotal: form.budget ? parseFloat(form.budget) : undefined,
        targetAudience: form.audience ? { description: form.audience } : undefined,
        scheduledStartAt: form.startDate || undefined,
        scheduledEndAt: form.endDate || undefined,
      })
      if (result.success && result.campaignId) {
        onCreated(result.campaignId)
        onClose()
        setForm({ name: "", type: "email", budget: "", audience: "", startDate: "", endDate: "" })
        setSuggestions([])
      } else {
        setError(result.error ?? "Failed to create campaign")
      }
    })
  }, [brokerageId, form, onCreated, onClose])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Marketing Campaign</DialogTitle>
          <DialogDescription>
            Set up your campaign across email, social, ads, and direct mail channels.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="w-4 h-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Campaign Type</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {CAMPAIGN_TYPES.map((type) => {
                const Icon = type.icon
                return (
                  <button
                    key={type.value}
                    onClick={() => setForm((f) => ({ ...f, type: type.value }))}
                    className={cn(
                      "flex flex-col items-center gap-1.5 p-3 rounded-lg border text-xs font-medium transition-colors",
                      form.type === type.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-primary/50"
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {type.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Campaign Name</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-xs gap-1"
                onClick={handleSuggest}
                disabled={isSuggesting}
              >
                {isSuggesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                AI Suggest
              </Button>
            </div>
            <Input
              placeholder="e.g. Spring 2025 Buyer Campaign"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            {suggestions.length > 0 && (
              <div className="space-y-1.5">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => setForm((f) => ({ ...f, name: s.name, audience: s.audience }))}
                    className="w-full text-left p-2.5 rounded-md border text-sm hover:bg-accent transition-colors"
                  >
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">{s.description}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Target Audience</Label>
            <Textarea
              placeholder="Describe your target audience (e.g. first-time buyers in 75201, empty nesters 55+)"
              value={form.audience}
              onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label>Budget (optional)</Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                type="number"
                placeholder="5000"
                className="pl-9"
                value={form.budget}
                onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Start Date (optional)</Label>
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>End Date (optional)</Label>
              <Input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isPending || !form.name.trim()}>
            {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            Create Campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Campaign Detail Drawer ────────────────────────────────────────────────────

function CampaignDetailPanel({
  campaign,
  brokerageId,
  onClose,
  onLaunch,
  onPause,
  onEnd,
  onRefresh,
}: {
  campaign: CampaignWithROI
  brokerageId: string
  onClose: () => void
  onLaunch: (id: string) => void
  onPause: (id: string) => void
  onEnd: (id: string) => void
  onRefresh: () => void
}) {
  const [activeTab, setActiveTab] = useState("overview")
  const [isPending, startTransition] = useTransition()
  const [copyChannel, setCopyChannel] = useState<"email" | "social" | "ads" | "direct_mail">("email")
  const [generatedCopy, setGeneratedCopy] = useState<{ copy?: string; subject?: string } | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [newTask, setNewTask] = useState("")
  const [isAddingTask, startTaskTransition] = useTransition()
  const [editBudgetSpent, setEditBudgetSpent] = useState("")
  const [isSavingBudget, startBudgetTransition] = useTransition()
  const [tasks, setTasks] = useState<Array<{ id: string; title: string; status: string; due_at: string | null }>>([])
  const [isLoadingTasks, setIsLoadingTasks] = useState(false)

  // Load real tasks when tasks tab is activated
  useEffect(() => {
    if (activeTab !== "tasks") return
    setIsLoadingTasks(true)
    getMarketingCampaign(campaign.id).then((result) => {
      if (result.success && result.campaign) {
        setTasks(result.campaign.tasks ?? [])
      }
    }).finally(() => setIsLoadingTasks(false))
  }, [activeTab, campaign.id])

  const status = STATUS_CONFIG[campaign.status] ?? STATUS_CONFIG.draft

  const handleGenerateCopy = useCallback(async () => {
    setIsGenerating(true)
    setGeneratedCopy(null)
    const result = await aiGenerateCampaignCopy({
      brokerageId,
      campaignName: campaign.campaign_name,
      campaignType: campaign.campaign_type,
      targetAudience: (campaign.target_audience as any)?.description,
      channel: copyChannel,
    })
    if (result.success) {
      setGeneratedCopy({ copy: result.copy, subject: result.subject })
    }
    setIsGenerating(false)
  }, [brokerageId, campaign, copyChannel])

  const handleAddTask = useCallback(() => {
    if (!newTask.trim()) return
    const title = newTask.trim()
    setNewTask("")
    startTaskTransition(async () => {
      const result = await addCampaignTask({
        brokerageId,
        campaignId: campaign.id,
        title,
      })
      if (result.success && result.taskId) {
        setTasks((prev) => [{ id: result.taskId!, title, status: "pending", due_at: null }, ...prev])
      }
      onRefresh()
    })
  }, [brokerageId, campaign.id, newTask, onRefresh])

  const handleToggleTask = useCallback((taskId: string, currentStatus: string) => {
    const next = currentStatus === "done" ? "pending" : "done"
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: next } : t))
    updateCampaignTaskStatus(taskId, next as "pending" | "in_progress" | "done").catch(() => {
      // revert on failure
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: currentStatus } : t))
    })
  }, [])

  const handleSaveBudgetSpent = useCallback(() => {
    if (!editBudgetSpent) return
    startBudgetTransition(async () => {
      await updateMarketingCampaign(campaign.id, {
        budgetSpent: parseFloat(editBudgetSpent),
      })
      setEditBudgetSpent("")
      onRefresh()
    })
  }, [campaign.id, editBudgetSpent, onRefresh])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl h-full bg-background border-l shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b shrink-0">
          <div className="min-w-0">
            <h2 className="text-xl font-bold truncate">{campaign.campaign_name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={status.variant}>{status.label}</Badge>
              <span className="text-sm text-muted-foreground capitalize">
                {CAMPAIGN_TYPES.find((t) => t.value === campaign.campaign_type)?.label ?? campaign.campaign_type}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {campaign.status === "draft" && (
              <Button size="sm" onClick={() => onLaunch(campaign.id)} disabled={isPending}>
                <Rocket className="w-4 h-4 mr-1.5" /> Launch
              </Button>
            )}
            {campaign.status === "active" && (
              <Button size="sm" variant="secondary" onClick={() => onPause(campaign.id)}>
                <Pause className="w-4 h-4 mr-1.5" /> Pause
              </Button>
            )}
            {campaign.status === "paused" && (
              <Button size="sm" onClick={() => onLaunch(campaign.id)}>
                <Play className="w-4 h-4 mr-1.5" /> Resume
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="mx-6 mt-4 shrink-0">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="copy">AI Copy</TabsTrigger>
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {/* Overview Tab */}
            <TabsContent value="overview" className="space-y-4 mt-0">
              {/* Budget */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Budget</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Total Budget</span>
                    <span className="font-semibold">{fmtCurrency(campaign.budget_total)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Spent</span>
                    <span className="font-semibold">{fmtCurrency(campaign.budget_spent)}</span>
                  </div>
                  {campaign.budget_total && (
                    <Progress
                      value={
                        campaign.budget_spent
                          ? Math.min(100, (campaign.budget_spent / campaign.budget_total) * 100)
                          : 0
                      }
                      className="h-2"
                    />
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <Input
                      type="number"
                      placeholder="Update spend..."
                      className="h-8 text-sm"
                      value={editBudgetSpent}
                      onChange={(e) => setEditBudgetSpent(e.target.value)}
                    />
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={!editBudgetSpent || isSavingBudget}
                      onClick={handleSaveBudgetSpent}
                    >
                      {isSavingBudget ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Target Audience */}
              {campaign.target_audience && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Target className="w-4 h-4" /> Target Audience
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {(campaign.target_audience as any)?.description ?? JSON.stringify(campaign.target_audience)}
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* Schedule */}
              {(campaign.scheduled_start_at || campaign.scheduled_end_at) && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Calendar className="w-4 h-4" /> Schedule
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {campaign.scheduled_start_at && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Start</span>
                        <span>{format(new Date(campaign.scheduled_start_at), "PPP")}</span>
                      </div>
                    )}
                    {campaign.scheduled_end_at && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">End</span>
                        <span>{format(new Date(campaign.scheduled_end_at), "PPP")}</span>
                      </div>
                    )}
                    {campaign.launched_at && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Launched</span>
                        <span>{format(new Date(campaign.launched_at), "PPP")}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Quick Action */}
              {campaign.status === "active" && (
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => onEnd(campaign.id)}
                >
                  End Campaign
                </Button>
              )}
            </TabsContent>

            {/* Performance Tab */}
            <TabsContent value="performance" className="space-y-4 mt-0">
              {campaign.roi ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Total Spend", value: fmtCurrency(campaign.roi.total_spend), icon: DollarSign },
                      { label: "Leads Generated", value: fmt(campaign.roi.total_leads), icon: Users },
                      { label: "Conversions", value: fmt(campaign.roi.total_conversions), icon: CheckCircle2 },
                      { label: "ROI", value: fmtPct(campaign.roi.roi_percentage), icon: TrendingUp, positive: (campaign.roi.roi_percentage ?? 0) > 0 },
                    ].map((m) => {
                      const Icon = m.icon
                      return (
                        <Card key={m.label}>
                          <CardContent className="pt-4 pb-3">
                            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                              <Icon className="w-3 h-3" />
                              {m.label}
                            </div>
                            <p className={cn("text-xl font-bold", m.positive ? "text-green-600" : "")}>
                              {m.value}
                            </p>
                          </CardContent>
                        </Card>
                      )
                    })}
                  </div>
                  <Card>
                    <CardContent className="pt-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Cost per Lead</span>
                        <span className="font-medium">{fmtCurrency(campaign.roi.cost_per_lead)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Qualified Leads</span>
                        <span className="font-medium">{fmt(campaign.roi.qualified_leads)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Total Revenue</span>
                        <span className="font-medium">{fmtCurrency(campaign.roi.total_revenue)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                  <BarChart3 className="w-10 h-10 opacity-30" />
                  <p className="text-sm">Performance data will appear once the campaign is active.</p>
                </div>
              )}
            </TabsContent>

            {/* AI Copy Tab */}
            <TabsContent value="copy" className="space-y-4 mt-0">
              <div className="flex items-center gap-3">
                <Select value={copyChannel} onValueChange={(v) => setCopyChannel(v as any)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select channel" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="social">Social Media</SelectItem>
                    <SelectItem value="ads">Paid Ads</SelectItem>
                    <SelectItem value="direct_mail">Direct Mail</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={handleGenerateCopy} disabled={isGenerating}>
                  {isGenerating ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Sparkles className="w-4 h-4 mr-2" />
                  )}
                  Generate
                </Button>
              </div>

              {generatedCopy && (
                <div className="space-y-3">
                  {generatedCopy.subject && (
                    <div className="space-y-1">
                      <Label className="text-xs">Subject Line</Label>
                      <div className="p-3 bg-muted rounded-md text-sm font-medium">
                        {generatedCopy.subject}
                      </div>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Copy</Label>
                    <Textarea
                      value={generatedCopy.copy}
                      onChange={(e) => setGeneratedCopy((prev) => prev ? { ...prev, copy: e.target.value } : null)}
                      rows={10}
                      className="text-sm"
                    />
                  </div>
                </div>
              )}

              {!generatedCopy && !isGenerating && (
                <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                  <Sparkles className="w-10 h-10 opacity-30" />
                  <p className="text-sm">Select a channel and click Generate to create AI-powered copy.</p>
                </div>
              )}
            </TabsContent>

            {/* Tasks Tab */}
            <TabsContent value="tasks" className="space-y-3 mt-0">
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Add a task..."
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddTask()}
                  className="flex-1"
                />
                <Button size="sm" onClick={handleAddTask} disabled={!newTask.trim() || isAddingTask}>
                  {isAddingTask ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                </Button>
              </div>

              {isLoadingTasks ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading tasks...
                </div>
              ) : tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No tasks yet. Add your first task above.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-3 p-2.5 rounded-md hover:bg-muted text-sm cursor-pointer"
                      onClick={() => handleToggleTask(task.id, task.status)}
                    >
                      <div className={cn(
                        "w-4 h-4 rounded-full border-2 shrink-0 transition-colors",
                        task.status === "done"
                          ? "border-green-500 bg-green-500"
                          : "border-muted-foreground hover:border-primary"
                      )} />
                      <span className={task.status === "done" ? "line-through text-muted-foreground" : ""}>
                        {task.title}
                      </span>
                      {task.due_at && (
                        <span className="ml-auto text-xs text-muted-foreground shrink-0">
                          {format(new Date(task.due_at), "MMM d")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function CampaignsHubClient({
  userId,
  brokerageId,
  userRole,
  campaigns: initialCampaigns,
  total: initialTotal,
  summary,
}: CampaignsHubClientProps) {
  const [campaigns, setCampaigns] = useState<CampaignWithROI[]>(initialCampaigns)
  const [total] = useState(initialTotal)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isISACreateOpen, setIsISACreateOpen] = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignWithROI | null>(null)
  const [isPending, startTransition] = useTransition()

  // Agents can create ISA campaigns for contacts assigned to them
  const isAgent = userRole === "agent"

  const filtered = campaigns.filter((c) => {
    const matchSearch = !search || c.campaign_name.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === "all" || c.status === statusFilter
    const matchType = typeFilter === "all" || c.campaign_type === typeFilter
    return matchSearch && matchStatus && matchType
  })

  const handleLaunch = useCallback((id: string) => {
    startTransition(async () => {
      const result = await launchMarketingCampaign(id, brokerageId)
      if (result.success) {
        setCampaigns((prev) =>
          prev.map((c) => c.id === id ? { ...c, status: "active", launched_at: new Date().toISOString() } : c)
        )
        if (selectedCampaign?.id === id) {
          setSelectedCampaign((prev) => prev ? { ...prev, status: "active", launched_at: new Date().toISOString() } : null)
        }
      }
    })
  }, [brokerageId, selectedCampaign])

  const handlePause = useCallback((id: string) => {
    startTransition(async () => {
      await pauseMarketingCampaign(id, brokerageId)
      setCampaigns((prev) => prev.map((c) => c.id === id ? { ...c, status: "paused" } : c))
      if (selectedCampaign?.id === id) {
        setSelectedCampaign((prev) => prev ? { ...prev, status: "paused" } : null)
      }
    })
  }, [brokerageId, selectedCampaign])

  const handleEnd = useCallback((id: string) => {
    startTransition(async () => {
      await endMarketingCampaign(id, brokerageId)
      setCampaigns((prev) => prev.map((c) => c.id === id ? { ...c, status: "ended" } : c))
      if (selectedCampaign?.id === id) {
        setSelectedCampaign((prev) => prev ? { ...prev, status: "ended" } : null)
      }
    })
  }, [brokerageId, selectedCampaign])

  const handleDelete = useCallback((id: string) => {
    startTransition(async () => {
      const result = await deleteMarketingCampaign(id, brokerageId)
      if (result.success) {
        setCampaigns((prev) => prev.filter((c) => c.id !== id))
        if (selectedCampaign?.id === id) setSelectedCampaign(null)
      }
    })
  }, [brokerageId, selectedCampaign])

  const handleCreated = useCallback((id: string) => {
    // Optimistically add a placeholder — server will revalidate
    const newCampaign: CampaignWithROI = {
      id,
      campaign_name: "New Campaign",
      campaign_type: "email",
      status: "draft",
      budget_total: null,
      budget_spent: 0,
      scheduled_start_at: null,
      scheduled_end_at: null,
      launched_at: null,
      completed_at: null,
      target_audience: null,
      agent_user_id: userId,
      brokerage_id: brokerageId,
      listing_id: null,
      created_by: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      visibility_scope: "brokerage",
    }
    setCampaigns((prev) => [newCampaign, ...prev])
  }, [userId, brokerageId])

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Summary Stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { label: "Total Campaigns", value: summary.total_campaigns.toString(), icon: Megaphone, color: "text-primary" },
            { label: "Active", value: summary.active_campaigns.toString(), icon: Play, color: "text-green-600" },
            { label: "Total Spend", value: fmtCurrency(summary.total_spend), icon: DollarSign, color: "text-blue-600" },
            { label: "Leads Generated", value: fmt(summary.total_leads), icon: Users, color: "text-purple-600" },
            { label: "Avg ROI", value: fmtPct(summary.avg_roi), icon: TrendingUp, color: summary.avg_roi && summary.avg_roi > 0 ? "text-green-600" : "text-muted-foreground" },
          ].map((stat) => {
            const Icon = stat.icon
            return (
              <Card key={stat.label}>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
                    <Icon className={cn("w-3.5 h-3.5", stat.color)} />
                    {stat.label}
                  </div>
                  <p className={cn("text-2xl font-bold", stat.color)}>{stat.value}</p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search campaigns..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="ended">Ended</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {CAMPAIGN_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => setIsCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> New Campaign
        </Button>
        {isAgent && (
          <Button variant="outline" onClick={() => setIsISACreateOpen(true)}>
            <Radio className="w-4 h-4 mr-2" /> ISA Campaign
          </Button>
        )}
      </div>

      {/* Campaign Grid */}
      {isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Updating...
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="p-5 rounded-full bg-muted">
            <Megaphone className="w-10 h-10 text-muted-foreground" />
          </div>
          <div className="text-center">
            <h3 className="font-semibold text-lg">No campaigns found</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {search || statusFilter !== "all" || typeFilter !== "all"
                ? "Try adjusting your filters."
                : "Create your first marketing campaign to get started."}
            </p>
          </div>
          <Button onClick={() => setIsCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> Create Campaign
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((campaign) => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              onView={setSelectedCampaign}
              onLaunch={handleLaunch}
              onPause={handlePause}
              onEnd={handleEnd}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      <CreateCampaignDialog
        open={isCreateOpen}
        brokerageId={brokerageId}
        onClose={() => setIsCreateOpen(false)}
        onCreated={handleCreated}
      />

      {/* ISA Campaign modal — agents only, creates an ai_isa_campaigns row */}
      {isAgent && (
        <CreateCampaignModal
          open={isISACreateOpen}
          onClose={() => setIsISACreateOpen(false)}
          brokerageId={brokerageId}
          videoEnabled={false}
          directMailEnabled={false}
          onCreated={() => setIsISACreateOpen(false)}
        />
      )}

      {selectedCampaign && (
        <CampaignDetailPanel
          campaign={selectedCampaign}
          brokerageId={brokerageId}
          onClose={() => setSelectedCampaign(null)}
          onLaunch={handleLaunch}
          onPause={handlePause}
          onEnd={handleEnd}
          onRefresh={() => {}} // server revalidation handles this
        />
      )}
    </div>
  )
}
