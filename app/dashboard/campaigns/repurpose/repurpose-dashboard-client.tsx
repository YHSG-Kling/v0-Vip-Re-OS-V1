"use client"

// app/dashboard/campaigns/repurpose/repurpose-dashboard-client.tsx
// Layer 9.11 — Omni-Presence Repurposer Dashboard Client
// Two-panel layout: Pipeline Builder (left) + Source Picker & History (right)

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Plus,
  RefreshCw,
  Play,
  Trash2,
  Video,
  FileText,
  Mic,
  ScrollText,
  Instagram,
  Youtube,
  Facebook,
  Linkedin,
  Twitter,
  CheckCircle,
  Clock,
  AlertCircle,
  Loader2,
  Layers,
  Zap,
  ArrowRight,
  ChevronRight,
  Sparkles,
  Copy,
  History,
  Wand2,
  Link2,
} from "lucide-react"
import {
  executePipeline,
  createRepurposePipeline,
  togglePipelineActive,
  deletePipeline,
} from "@/lib/repurpose/actions"
import type { SourceType, OutputFormat } from "@/lib/repurpose/types"
import { toast } from "sonner"
import { SnippetWizardPanel } from "./components/snippet-wizard-panel"
import { getFilteredRepurposeHistory } from "@/app/actions/video-repurposing"
import {
  REPURPOSE_LOG_STATUSES,
  REPURPOSE_LOG_APPROVAL_STATUSES,
} from "@/app/actions/video-repurposing.utils"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Pipeline {
  id: string
  pipeline_name: string
  source_type: string
  output_config: {
    formats?: OutputFormat[]
    auto_approve?: boolean
    brand_voice_override?: string | null
    hashtag_presets?: string[]
  } | null
  is_active: boolean
  created_at: string
  updated_at: string
}

interface HistoryItem {
  id: string
  source_type: string
  source_id: string
  output_type: string
  output_ref_table: string
  platform_target: string | null
  status: string
  approval_status: string
  notes: string | null
  created_at: string
}

interface SourceItem {
  id: string
  title: string
  status?: string
  publish_status?: string
  script_type?: string
  duration_seconds?: number
  created_at: string
}

interface Sources {
  video_project: SourceItem[]
  blog_post: SourceItem[]
  podcast_episode: SourceItem[]
  script: SourceItem[]
}

interface RepurposeDashboardClientProps {
  userId: string
  brokerageId: string
  teamId?: string | null
  userRole: string
  pipelines: Pipeline[]
  history: HistoryItem[]
  sources: Sources
  // Deep-link (e.g. Podcast Studio "Send to Omnipresence"): preselect a source.
  initialSourceType?: string | null
  initialSourceId?: string | null
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SOURCE_TYPE_CONFIG: Record<SourceType, { label: string; icon: React.ReactNode; color: string }> = {
  video_project: { label: "Video Project", icon: <Video className="h-4 w-4" />, color: "bg-purple-100 text-purple-700" },
  blog_post: { label: "Blog Post", icon: <FileText className="h-4 w-4" />, color: "bg-blue-100 text-blue-700" },
  podcast_episode: { label: "Podcast", icon: <Mic className="h-4 w-4" />, color: "bg-green-100 text-green-700" },
  social_post: { label: "Social Post", icon: <Instagram className="h-4 w-4" />, color: "bg-pink-100 text-pink-700" },
  script: { label: "Script", icon: <ScrollText className="h-4 w-4" />, color: "bg-amber-100 text-amber-700" },
  newsletter: { label: "Newsletter", icon: <FileText className="h-4 w-4" />, color: "bg-cyan-100 text-cyan-700" },
  video_url: { label: "Video URL", icon: <Link2 className="h-4 w-4" />, color: "bg-orange-100 text-orange-700" },
}

const OUTPUT_FORMAT_UI: Record<OutputFormat, { label: string; icon: React.ReactNode; color: string }> = {
  instagram_reels: { label: "IG Reels", icon: <Instagram className="h-4 w-4" />, color: "bg-gradient-to-r from-purple-500 to-pink-500 text-white" },
  instagram_story: { label: "IG Story", icon: <Instagram className="h-4 w-4" />, color: "bg-gradient-to-r from-yellow-500 to-pink-500 text-white" },
  instagram_carousel: { label: "IG Carousel", icon: <Instagram className="h-4 w-4" />, color: "bg-pink-100 text-pink-700" },
  tiktok: { label: "TikTok", icon: <Video className="h-4 w-4" />, color: "bg-gray-900 text-white" },
  youtube_shorts: { label: "YT Shorts", icon: <Youtube className="h-4 w-4" />, color: "bg-red-600 text-white" },
  facebook_reels: { label: "FB Reels", icon: <Facebook className="h-4 w-4" />, color: "bg-blue-600 text-white" },
  linkedin_post: { label: "LinkedIn", icon: <Linkedin className="h-4 w-4" />, color: "bg-blue-700 text-white" },
  twitter_thread: { label: "X Thread", icon: <Twitter className="h-4 w-4" />, color: "bg-gray-900 text-white" },
  email_snippet: { label: "Email", icon: <FileText className="h-4 w-4" />, color: "bg-emerald-100 text-emerald-700" },
  blog_excerpt: { label: "Blog Excerpt", icon: <FileText className="h-4 w-4" />, color: "bg-indigo-100 text-indigo-700" },
  quote_graphic: { label: "Quote Card", icon: <Copy className="h-4 w-4" />, color: "bg-violet-100 text-violet-700" },
  google_business_post: { label: "Google Business", icon: <Link2 className="h-4 w-4" />, color: "bg-emerald-100 text-emerald-700" },
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  pending: { icon: <Clock className="h-3 w-3" />, color: "bg-yellow-100 text-yellow-700" },
  pending_review: { icon: <Clock className="h-3 w-3" />, color: "bg-yellow-100 text-yellow-700" },
  draft: { icon: <Clock className="h-3 w-3" />, color: "bg-gray-100 text-gray-700" },
  approved: { icon: <CheckCircle className="h-3 w-3" />, color: "bg-green-100 text-green-700" },
  rejected: { icon: <AlertCircle className="h-3 w-3" />, color: "bg-red-100 text-red-700" },
  created: { icon: <CheckCircle className="h-3 w-3" />, color: "bg-blue-100 text-blue-700" },
  blocked: { icon: <AlertCircle className="h-3 w-3" />, color: "bg-red-100 text-red-700" },
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function RepurposeDashboardClient({
  userId,
  brokerageId,
  teamId,
  userRole,
  pipelines,
  history: initialHistory,
  sources,
  initialSourceType = null,
  initialSourceId = null,
}: RepurposeDashboardClientProps) {
  const router = useRouter()
  // TOMBSTONE — `const [pipelines, setPipelines] = useState(initialPipelines)`.
  // The setter was never called, and create / toggle / delete / execute all end
  // in router.refresh(): React ignores a changed useState initializer after
  // mount, so the refreshed server prop never reached the table and every
  // mutation looked like a no-op until a hard reload. The PROP is the survivor
  // (`pipelines`, destructured above) — it re-renders with each refresh.
  // `history` keeps its local state on purpose: the filter bar below replaces it
  // from getFilteredRepurposeHistory between refreshes.
  const [history, setHistory] = useState(initialHistory)
  
  // UI State
  const [activeTab, setActiveTab] = useState<"pipelines" | "execute" | "history" | "wizard">("execute")
  const [isLoading, setIsLoading] = useState(false)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  
  // Pipeline Builder State
  const [newPipeline, setNewPipeline] = useState({
    pipelineName: "",
    sourceType: "video_project" as SourceType,
    sourceId: "" as string,
    outputFormats: [] as OutputFormat[],
    autoApprove: false,
  })
  
  // History filters. The first paint comes from lib/repurpose/actions'
  // getRepurposeHistory (unfiltered, 100 rows); narrowing it goes through
  // getRepurposedContentLogs, which derives the tenant from the SESSION rather
  // than trusting a brokerageId argument, and validates the status tokens
  // against the live CHECK constraints before it queries.
  const ALL = "__all__"
  const [historyFilterSource, setHistoryFilterSource] = useState<string>(ALL)
  const [historyFilterStatus, setHistoryFilterStatus] = useState<string>(ALL)
  const [historyFilterApproval, setHistoryFilterApproval] = useState<string>(ALL)
  const [historyFiltering, setHistoryFiltering] = useState(false)
  const [historyFilterError, setHistoryFilterError] = useState<string | null>(null)
  const [historyIsFiltered, setHistoryIsFiltered] = useState(false)

  const applyHistoryFilters = async (
    next?: { source?: string; status?: string; approval?: string }
  ) => {
    const source = next?.source ?? historyFilterSource
    const status = next?.status ?? historyFilterStatus
    const approval = next?.approval ?? historyFilterApproval

    setHistoryFiltering(true)
    setHistoryFilterError(null)
    try {
      const result = await getFilteredRepurposeHistory({
        sourceType: source === ALL ? undefined : source,
        status: status === ALL ? undefined : status,
        approvalStatus: approval === ALL ? undefined : approval,
      })
      if (!result.success) {
        // The server's verdict, surfaced. An empty table over a refused query
        // reads identically to "no results", which is the failure mode this
        // avoids.
        setHistoryFilterError(result.error ?? "Could not load history.")
        return
      }
      setHistory(result.history as unknown as HistoryItem[])
      setHistoryIsFiltered(source !== ALL || status !== ALL || approval !== ALL)
    } catch (err: any) {
      setHistoryFilterError(err?.message ?? "Could not load history.")
    } finally {
      setHistoryFiltering(false)
    }
  }

  const clearHistoryFilters = async () => {
    setHistoryFilterSource(ALL)
    setHistoryFilterStatus(ALL)
    setHistoryFilterApproval(ALL)
    await applyHistoryFilters({ source: ALL, status: ALL, approval: ALL })
    setHistoryIsFiltered(false)
  }

  // Execution State
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null)
  const [selectedSource, setSelectedSource] = useState<{ type: SourceType; id: string; title: string } | null>(null)
  const [executionResult, setExecutionResult] = useState<{
    success: boolean
    outputs?: any[]
    error?: string
  } | null>(null)

  // Deep-link handoff (e.g. Podcast Studio "Send to Omnipresence" →
  // ?source=podcast&episodeId=…): land the user ON the Execute tab with the
  // work pre-staged instead of a bare dashboard. If an active pipeline already
  // matches the source type, auto-select it and preselect the exact source so
  // one click executes; otherwise pre-seed the Create-Pipeline dialog with the
  // right source type so the user builds the correct pipeline in one step.
  useEffect(() => {
    if (!initialSourceType) return
    const type = initialSourceType as SourceType
    const typedSources =
      type === "video_project" ? sources.video_project
      : type === "blog_post" ? sources.blog_post
      : type === "podcast_episode" ? sources.podcast_episode
      : type === "script" ? sources.script
      : []
    const match = initialSourceId
      ? typedSources.find((s) => s.id === initialSourceId)
      : undefined

    setActiveTab("execute")

    const activePipeline = pipelines.find((p) => p.is_active && p.source_type === type)
    if (activePipeline) {
      setSelectedPipeline(activePipeline)
      if (match) setSelectedSource({ type, id: match.id, title: match.title })
    } else {
      // No pipeline yet — pre-seed creation with this source type.
      setNewPipeline((prev) => ({ ...prev, sourceType: type, sourceId: match?.id ?? prev.sourceId }))
    }
    // Run once on mount for the deep-link; subsequent selection is user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Available formats for video vs text sources
  const VIDEO_FORMATS: OutputFormat[] = ["instagram_reels", "instagram_story", "tiktok", "youtube_shorts", "facebook_reels"]
  const TEXT_FORMATS: OutputFormat[] = ["instagram_carousel", "linkedin_post", "twitter_thread", "email_snippet", "blog_excerpt", "quote_graphic"]
  
  const getAvailableFormats = (sourceType: SourceType): OutputFormat[] => {
    if (sourceType === "video_project" || sourceType === "podcast_episode") {
      return [...VIDEO_FORMATS, ...TEXT_FORMATS]
    }
    return TEXT_FORMATS
  }

  // ─── HANDLERS ───────────────────────────────────────────────────────────────

  const handleCreatePipeline = async () => {
    if (!newPipeline.pipelineName || newPipeline.outputFormats.length === 0) {
      toast.error("Provide a name and at least one output format")
      return
    }

    setIsLoading(true)
    const result = await createRepurposePipeline({
      pipelineName: newPipeline.pipelineName,
      sourceType: newPipeline.sourceType,
      sourceId: (newPipeline as any).sourceId || "",
      outputFormats: newPipeline.outputFormats,
      brokerageId: brokerageId,
      agentUserId: userId,
      teamId: teamId || undefined,
      // The switch on this dialog was set and then not sent — it governed nothing.
      autoApprove: newPipeline.autoApprove,
    })

    if (result.success) {
      setIsCreateDialogOpen(false)
      setNewPipeline({
        pipelineName: "",
        sourceType: "video_project",
        sourceId: "",
        outputFormats: [],
        autoApprove: false,
      })
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  const handleTogglePipeline = async (pipelineId: string, isActive: boolean) => {
    setIsLoading(true)
    const result = await togglePipelineActive(userId, pipelineId, brokerageId, !isActive)
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  const handleDeletePipeline = async (pipelineId: string) => {
    if (!confirm("Are you sure you want to delete this pipeline?")) return
    
    setIsLoading(true)
    const result = await deletePipeline(userId, pipelineId, brokerageId)
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  const handleExecutePipeline = async () => {
    if (!selectedPipeline || !selectedSource) {
      toast.error("Select a pipeline and source content")
      return
    }

    setIsLoading(true)
    setExecutionResult(null)

    // The selection the button already required is now actually sent. It gated
    // the click and was rendered in the run summary, but never left the client,
    // so the run generated from the source TYPE alone.
    const result = await executePipeline({
      pipelineId: selectedPipeline.id,
      brokerageId,
      sourceType: selectedSource.type,
      sourceId: selectedSource.id,
    })

    setExecutionResult(result)
    if (result.success) {
      router.refresh()
    }
    setIsLoading(false)
  }

  const toggleOutputFormat = (format: OutputFormat) => {
    setNewPipeline((prev) => ({
      ...prev,
      outputFormats: prev.outputFormats.includes(format)
        ? prev.outputFormats.filter((f) => f !== format)
        : [...prev.outputFormats, format],
    }))
  }

  // Get sources for selected source type
  const getSourcesForType = (type: SourceType): SourceItem[] => {
    switch (type) {
      case "video_project":
        return sources.video_project
      case "blog_post":
        return sources.blog_post
      case "podcast_episode":
        return sources.podcast_episode
      case "script":
        return sources.script
      default:
        return []
    }
  }

  // Stats
  const activePipelines = pipelines.filter((p) => p.is_active).length
  const totalOutputs = history.length
  const approvedOutputs = history.filter((h) => h.approval_status === "approved").length

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Layers className="h-6 w-6 text-primary" />
            Omni-Presence Repurposer
          </h1>
          <p className="text-muted-foreground">Transform your content across all social platforms with one click</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Pipeline
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              <span className="text-sm text-muted-foreground">Active Pipelines</span>
            </div>
            <div className="text-2xl font-bold">{activePipelines}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-blue-500" />
              <span className="text-sm text-muted-foreground">Total Pipelines</span>
            </div>
            <div className="text-2xl font-bold">{pipelines.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Copy className="h-4 w-4 text-purple-500" />
              <span className="text-sm text-muted-foreground">Content Generated</span>
            </div>
            <div className="text-2xl font-bold">{totalOutputs}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <span className="text-sm text-muted-foreground">Approved</span>
            </div>
            <div className="text-2xl font-bold">{approvedOutputs}</div>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
        <TabsList className="mb-4">
          <TabsTrigger value="execute">
            <Play className="h-4 w-4 mr-2" />
            Repurpose
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="h-4 w-4 mr-2" />
            History ({history.length})
          </TabsTrigger>
          <TabsTrigger value="wizard">
            <Wand2 className="h-4 w-4 mr-2" />
            Snippet Wizard
          </TabsTrigger>
        </TabsList>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* EXECUTE TAB - Two Panel Layout */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="execute">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left Panel - Pipelines: select an active one to run, and manage
                (create / activate / delete) inline — no separate tab. */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Zap className="h-5 w-5 text-amber-500" />
                      Pipelines
                    </CardTitle>
                    <CardDescription>Toggle a pipeline on, then select it to transform your content</CardDescription>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setIsCreateDialogOpen(true)}>
                    <Plus className="h-4 w-4 mr-1.5" />
                    New Pipeline
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {pipelines.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No pipelines yet</p>
                    <Button variant="link" onClick={() => setIsCreateDialogOpen(true)}>
                      Create your first pipeline
                    </Button>
                  </div>
                ) : (
                  <ScrollArea className="h-[320px]">
                    <div className="space-y-2">
                      {pipelines.map((pipeline) => {
                        const sourceConfig = SOURCE_TYPE_CONFIG[pipeline.source_type as SourceType]
                        const isSelected = selectedPipeline?.id === pipeline.id
                        const selectable = pipeline.is_active
                        return (
                          <div
                            key={pipeline.id}
                            onClick={() => {
                              if (!selectable) return // inactive pipelines aren't runnable
                              setSelectedPipeline(pipeline)
                              setSelectedSource(null) // Reset source when pipeline changes
                            }}
                            className={`p-4 rounded-lg border transition-all ${
                              !selectable
                                ? "border-dashed border-border opacity-60"
                                : isSelected
                                  ? "border-primary bg-primary/5 cursor-pointer"
                                  : "border-border hover:border-primary/50 cursor-pointer"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-2 gap-2">
                              <span className="font-medium truncate">{pipeline.pipeline_name}</span>
                              <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                                {isSelected && <CheckCircle className="h-4 w-4 text-primary" />}
                                {/* activate / deactivate */}
                                <Switch
                                  checked={pipeline.is_active}
                                  onCheckedChange={() => handleTogglePipeline(pipeline.id, pipeline.is_active)}
                                  disabled={isLoading}
                                  aria-label="Pipeline active"
                                />
                                {/* delete */}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => handleDeletePipeline(pipeline.id)}
                                  disabled={isLoading}
                                  aria-label="Delete pipeline"
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                                </Button>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mb-2">
                              <Badge variant="secondary" className={sourceConfig?.color}>
                                {sourceConfig?.icon}
                                <span className="ml-1">{sourceConfig?.label}</span>
                              </Badge>
                              {!selectable && <span className="text-[10px] text-muted-foreground">inactive</span>}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {(pipeline.output_config?.formats || []).slice(0, 4).map((format) => {
                                const formatConfig = OUTPUT_FORMAT_UI[format]
                                return (
                                  <Badge key={format} variant="outline" className="text-xs">
                                    {formatConfig?.label}
                                  </Badge>
                                )
                              })}
                              {(pipeline.output_config?.formats || []).length > 4 && (
                                <Badge variant="outline" className="text-xs">
                                  +{(pipeline.output_config?.formats || []).length - 4}
                                </Badge>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>

            {/* Right Panel - Source Picker */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-blue-500" />
                  Select Source Content
                </CardTitle>
                <CardDescription>
                  {selectedPipeline
                    ? `Choose ${SOURCE_TYPE_CONFIG[selectedPipeline.source_type as SourceType]?.label} to repurpose`
                    : "First select a pipeline from the left"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!selectedPipeline ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <ArrowRight className="h-12 w-12 mx-auto mb-4 opacity-50 rotate-180" />
                    <p>Select a pipeline to see available sources</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-2">
                      {getSourcesForType(selectedPipeline.source_type as SourceType).length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                          <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                          <p>No {SOURCE_TYPE_CONFIG[selectedPipeline.source_type as SourceType]?.label} content found</p>
                        </div>
                      ) : (
                        getSourcesForType(selectedPipeline.source_type as SourceType).map((source) => {
                          const isSelected = selectedSource?.id === source.id
                          return (
                            <div
                              key={source.id}
                              onClick={() =>
                                setSelectedSource({
                                  type: selectedPipeline.source_type as SourceType,
                                  id: source.id,
                                  title: source.title,
                                })
                              }
                              className={`p-4 rounded-lg border cursor-pointer transition-all ${
                                isSelected
                                  ? "border-primary bg-primary/5"
                                  : "border-border hover:border-primary/50"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium truncate">{source.title}</p>
                                  <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                                    {source.duration_seconds && (
                                      <span>{Math.floor(source.duration_seconds / 60)}:{(source.duration_seconds % 60).toString().padStart(2, "0")}</span>
                                    )}
                                    <span>{new Date(source.created_at).toLocaleDateString()}</span>
                                  </div>
                                </div>
                                {isSelected && <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />}
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Execute Button & Results */}
          <div className="mt-6">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    {selectedPipeline && selectedSource ? (
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{selectedPipeline.pipeline_name}</Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="outline">{selectedSource.title}</Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">
                          {(selectedPipeline.output_config?.formats || []).length} outputs
                        </span>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">Select a pipeline and source to execute</p>
                    )}
                  </div>
                  <Button
                    onClick={handleExecutePipeline}
                    disabled={!selectedPipeline || !selectedSource || isLoading}
                    size="lg"
                    className="gap-2"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Execute Pipeline
                      </>
                    )}
                  </Button>
                </div>

                {/* Execution Result */}
                {executionResult && (
                  <div className="mt-4 p-4 rounded-lg bg-muted">
                    {executionResult.success ? (
                      <>
                        <div className="flex items-center gap-2 text-green-600 mb-2">
                          <CheckCircle className="h-5 w-5" />
                          <span className="font-medium">Pipeline executed successfully!</span>
                        </div>
                        {executionResult.outputs && executionResult.outputs.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">Created {executionResult.outputs.length} outputs:</p>
                            <div className="flex flex-wrap gap-2">
                              {executionResult.outputs.map((output, i) => (
                                <Badge key={i} variant="secondary">
                                  {OUTPUT_FORMAT_UI[output.outputType as OutputFormat]?.label || output.outputType}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="flex items-center gap-2 text-red-600">
                        <AlertCircle className="h-5 w-5" />
                        <span>{executionResult.error || "Execution failed"}</span>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* PIPELINES TAB */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* ══════════════════════════════════════════════════════════���════════ */}
        {/* HISTORY TAB */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Repurpose History</CardTitle>
              <CardDescription>
                Recent content transformations
                {historyIsFiltered ? " · filtered" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Refine — server-side filtering of repurposed_content_log */}
              <div className="flex flex-wrap items-end gap-3 mb-4">
                <div className="space-y-1">
                  <Label className="text-xs">Source</Label>
                  <Select
                    value={historyFilterSource}
                    onValueChange={(v) => { setHistoryFilterSource(v); applyHistoryFilters({ source: v }) }}
                  >
                    <SelectTrigger className="h-8 w-[170px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL} className="text-xs">All sources</SelectItem>
                      {(Object.keys(SOURCE_TYPE_CONFIG) as SourceType[]).map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {SOURCE_TYPE_CONFIG[t].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Status</Label>
                  <Select
                    value={historyFilterStatus}
                    onValueChange={(v) => { setHistoryFilterStatus(v); applyHistoryFilters({ status: v }) }}
                  >
                    <SelectTrigger className="h-8 w-[150px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL} className="text-xs">Any status</SelectItem>
                      {REPURPOSE_LOG_STATUSES.map((s) => (
                        <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Approval</Label>
                  <Select
                    value={historyFilterApproval}
                    onValueChange={(v) => { setHistoryFilterApproval(v); applyHistoryFilters({ approval: v }) }}
                  >
                    <SelectTrigger className="h-8 w-[160px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL} className="text-xs">Any approval</SelectItem>
                      {REPURPOSE_LOG_APPROVAL_STATUSES.map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">{s.replace(/_/g, " ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {historyIsFiltered && (
                  <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearHistoryFilters}>
                    Clear
                  </Button>
                )}

                {historyFiltering && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Filtering…
                  </span>
                )}
              </div>

              {historyFilterError && (
                <div className="mb-4 flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  <span>{historyFilterError}</span>
                </div>
              )}

              {history.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <History className="h-16 w-16 mx-auto mb-4 opacity-50" />
                  <p>{historyIsFiltered ? "Nothing matches those filters" : "No repurposed content yet"}</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead>Output</TableHead>
                      <TableHead>Platform</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((item) => {
                      const sourceConfig = SOURCE_TYPE_CONFIG[item.source_type as SourceType]
                      const statusConfig = STATUS_CONFIG[item.approval_status] || STATUS_CONFIG.pending
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            <Badge variant="secondary" className={sourceConfig?.color}>
                              {sourceConfig?.icon}
                              <span className="ml-1">{sourceConfig?.label}</span>
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {OUTPUT_FORMAT_UI[item.output_type as OutputFormat]?.label || item.output_type}
                          </TableCell>
                          <TableCell>{item.platform_target || "-"}</TableCell>
                          <TableCell>
                            <Badge variant="secondary" className={statusConfig.color}>
                              {statusConfig.icon}
                              <span className="ml-1 capitalize">{item.approval_status}</span>
                            </Badge>
                          </TableCell>
                          <TableCell>{new Date(item.created_at).toLocaleString()}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* SNIPPET WIZARD TAB                                                  */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <TabsContent value="wizard">
          <SnippetWizardPanel brokerageId={brokerageId} userId={userId} />
        </TabsContent>
      </Tabs>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* CREATE PIPELINE DIALOG */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Pipeline</DialogTitle>
            <DialogDescription>
              Configure a reusable workflow to transform your content across platforms
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Pipeline Name */}
            <div className="space-y-2">
              <Label htmlFor="pipelineName">Pipeline Name</Label>
              <Input
                id="pipelineName"
                placeholder="e.g., Video to Social Suite"
                value={newPipeline.pipelineName}
                onChange={(e) => setNewPipeline((prev) => ({ ...prev, pipelineName: e.target.value }))}
              />
            </div>

            {/* Source Type */}
            <div className="space-y-2">
              <Label>Source Content Type</Label>
              <Select
                value={newPipeline.sourceType}
                onValueChange={(v) =>
                  setNewPipeline((prev) => ({
                    ...prev,
                    sourceType: v as SourceType,
                    outputFormats: [], // Reset formats when source changes
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SOURCE_TYPE_CONFIG) as SourceType[])
                    .filter((type) => type !== "newsletter" && type !== "social_post")
                    .map((type) => (
                      <SelectItem key={type} value={type}>
                        <div className="flex items-center gap-2">
                          {SOURCE_TYPE_CONFIG[type].icon}
                          {SOURCE_TYPE_CONFIG[type].label}
                        </div>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* Output Formats */}
            <div className="space-y-2">
              <Label>Output Formats</Label>
              <p className="text-sm text-muted-foreground mb-3">Select which platforms to create content for</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {getAvailableFormats(newPipeline.sourceType).map((format) => {
                  const formatConfig = OUTPUT_FORMAT_UI[format]
                  const isSelected = newPipeline.outputFormats.includes(format)
                  return (
                    <div
                      key={format}
                      onClick={() => toggleOutputFormat(format)}
                      className={`p-3 rounded-lg border cursor-pointer transition-all flex items-center gap-2 ${
                        isSelected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                      }`}
                    >
                      <Checkbox checked={isSelected} />
                      <span className="text-sm">{formatConfig.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Auto Approve */}
            <div className="flex items-center justify-between p-4 rounded-lg border">
              <div>
                <Label>Auto-approve outputs</Label>
                <p className="text-sm text-muted-foreground">Skip manual review for generated content</p>
              </div>
              <Switch
                checked={newPipeline.autoApprove}
                onCheckedChange={(checked) => setNewPipeline((prev) => ({ ...prev, autoApprove: checked }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreatePipeline} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Pipeline
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
