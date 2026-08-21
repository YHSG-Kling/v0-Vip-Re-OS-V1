"use client"

import { useState, useEffect, Suspense } from "react"
import { useRouter } from "next/navigation"
import { useLocalStorage } from "@/hooks/use-local-storage"
import { useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  FileText,
  Plus,
  Search,
  Grid,
  List,
  MoreVertical,
  Eye,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Copy,
  Trash2,
  GitBranch,
  Shield,
  Home,
  User,
  TrendingUp,
  Users,
  PresentationIcon,
  Sparkles,
  Filter,
  Share2,
  Kanban,
  BarChart3,
} from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"
import {
  getVideoScriptLibrary,
  getVideoScriptById,
  getScriptVariations,
  createScriptVariation,
  updateScriptApprovalStatus,
  recordVideoEngagementEvent,
} from "@/app/actions/video-generation"
import { VideoGenerationButtons } from "@/app/components/video/VideoGenerationButtons"

// ─── TYPES ───────────────────────────────────────────────────────────────────
//
// TOMBSTONE: the local `VideoScript` and `ScriptVariation` interfaces that stood
// here are deleted. Survivor: app/types/video-generation.ts:46 / :81, which
// app/actions/video-generation.ts — the module every read on this page comes
// from — imports and now declares as its return types. The three fields only
// this copy carried (`variation_count`, `template`, `script_variations`) were
// merged onto the survivor FIRST; nothing was lost, and the double casts that
// existed only to bridge the two shapes are gone with them.
//
// Only `VideoScript` is named here. `ScriptVariation` reaches this file through
// it — `VideoScript.script_variations` (app/types/video-generation.ts:81) and
// `getScriptVariations`'s declared return type carry it, so every variation on
// this page is typed without a second import. Naming it as well would be a dead
// import, which is the census category this edit came out of.
import type { VideoScript } from "@/app/types/video-generation"

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const SCRIPT_TYPE_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  property_tour: { label: "Property Tour", icon: Home, color: "bg-blue-100 text-blue-700" },
  buyer_education: { label: "Buyer Education", icon: Users, color: "bg-green-100 text-green-700" },
  market_update: { label: "Market Update", icon: TrendingUp, color: "bg-purple-100 text-purple-700" },
  agent_intro: { label: "Agent Intro", icon: User, color: "bg-amber-100 text-amber-700" },
  listing_presentation: { label: "Listing Presentation", icon: PresentationIcon, color: "bg-rose-100 text-rose-700" },
}

const APPROVAL_STATUS_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  draft: { label: "Draft", icon: FileText, color: "bg-slate-100 text-slate-700" },
  pending_review: { label: "Pending Review", icon: Clock, color: "bg-amber-100 text-amber-700" },
  approved: { label: "Approved", icon: CheckCircle2, color: "bg-green-100 text-green-700" },
  rejected: { label: "Rejected", icon: XCircle, color: "bg-red-100 text-red-700" },
}

// ─── LOADING COMPONENT ───────────────────────────────────────────────────────

const Loading = () => (
  <div className="flex items-center justify-center py-16">
    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
  </div>
)

// ─── MAIN CONTENT COMPONENT ──────────────────────────────────────────────────

function VideoLibraryContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, userContext } = useAuth()
  const brokerage = userContext?.brokerageId ? { id: userContext.brokerageId } : null
  const supabase = createClient()

  // State
  const [scripts, setScripts] = useState<VideoScript[]>([])
  const [loading, setLoading] = useState(true)
  // PERSISTED (orphan burn-down, lane E). This was `useState("grid")`, so the
  // library reset to grid on every visit and an agent who works in list view
  // re-picked it every single time. hooks/use-local-storage.ts:18 was written
  // for exactly this — its own header scopes it to "user preferences and
  // non-critical data ... for data persistence, use a proper database
  // integration" — and had no caller anywhere in the tree.
  //
  // A view toggle is the correct side of that line: it is worth nothing to
  // anyone but this browser, so it must NOT become a users-table column or a
  // round-trip. The hook seeds from `initialValue` and only reads storage in a
  // mount effect, so the server and the first client render agree and there is
  // no hydration mismatch; a private-mode browser that throws on localStorage
  // is caught inside the hook and just keeps the default.
  const [viewMode, setViewMode] = useLocalStorage<"grid" | "list">("videos-library-view", "grid")
  const [searchQuery, setSearchQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [templateFilter, setTemplateFilter] = useState<string>("all")

  // Detail drawer state
  const [selectedScript, setSelectedScript] = useState<VideoScript | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Variation dialog state
  const [variationDialogOpen, setVariationDialogOpen] = useState(false)
  const [variationScript, setVariationScript] = useState<VideoScript | null>(null)
  const [variationLabel, setVariationLabel] = useState("")
  const [variationGoal, setVariationGoal] = useState("")
  const [variationContent, setVariationContent] = useState("")
  const [variationCta, setVariationCta] = useState("")
  const [variationAudience, setVariationAudience] = useState("")
  const [variationIsAbTest, setVariationIsAbTest] = useState(false)
  const [creatingVariation, setCreatingVariation] = useState(false)

  // Approval decision state — the library showed approval badges with no way to
  // move a script through them.
  const [approvingScriptId, setApprovingScriptId] = useState<string | null>(null)

  // Distribution performance for the video a script produced.
  const [performance, setPerformance] = useState<{
    title: string
    projectId: string
    views: number
    engagement: number
    comments: number
    shares: number
    generatedAt: string
  } | null>(null)

  // ─── Load Scripts ──────────────────────────────────────────────────────────

  useEffect(() => {
    loadScripts()
  }, [brokerage?.id])

  async function loadScripts() {
    if (!brokerage?.id) return

    setLoading(true)
    try {
      // Server action rather than the /api/video-scripts fetch: it derives the
      // brokerage from the session instead of trusting the URL, and it is the
      // same reader the rest of the video surface uses.
      const rows = await getVideoScriptLibrary()
      setScripts(rows)
    } catch (error) {
      console.error("Error loading scripts:", error)
    } finally {
      setLoading(false)
    }
  }

  // ─── Filter Scripts ────────────────────────────────────────────────────────

  const filteredScripts = scripts.filter((script) => {
    const matchesSearch =
      script.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      script.script_content.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesType = typeFilter === "all" || script.script_type === typeFilter
    const matchesStatus = statusFilter === "all" || script.approval_status === statusFilter
    const matchesTemplate =
      templateFilter === "all" ||
      (templateFilter === "template" && script.template_id) ||
      (templateFilter === "custom" && !script.template_id)
    return matchesSearch && matchesType && matchesStatus && matchesTemplate
  })

  // ─── Stats ─────────────────────────────────────────────────────────────────

  const stats = {
    total: scripts.length,
    approved: scripts.filter((s) => s.approval_status === "approved").length,
    pending: scripts.filter((s) => s.approval_status === "pending_review").length,
    draft: scripts.filter((s) => s.approval_status === "draft").length,
  }

  // ─── Open Script Detail ────────────────────────────────────────────────────

  async function openScriptDetail(script: VideoScript) {
    // Full details including variations, brokerage-scoped from the session.
    const full = await getVideoScriptById(script.id)

    if (full) {
      setSelectedScript(full)
      setDrawerOpen(true)
    } else {
      const { toast } = await import("sonner")
      toast.error("Could not load this script.")
    }
  }

  // ─── Create Variation ──────────────────────────────────────────────────────

  function openVariationDialog(script: VideoScript) {
    setVariationScript(script)
    setVariationLabel("")
    setVariationGoal("")
    setVariationContent(script.script_content)
    setVariationCta("")
    setVariationAudience("")
    setVariationIsAbTest(false)
    setVariationDialogOpen(true)
  }

  async function handleCreateVariation() {
    if (!variationScript || !variationLabel || !variationContent || !brokerage?.id) return

    const { toast } = await import("sonner")
    setCreatingVariation(true)
    try {
      // Server action, not a raw insert: it verifies the parent script belongs to
      // the caller's brokerage and writes the lifecycle event + kernel event the
      // client-side insert silently skipped, so a variation now actually shows up
      // as SCRIPT_VARIATION_CREATED in the OS.
      await createScriptVariation({
        scriptLibraryId: variationScript.id,
        variationLabel,
        variationGoal: variationGoal || undefined,
        scriptContent: variationContent,
        callToAction: variationCta || undefined,
        audienceSegment: variationAudience || undefined,
        isAbTest: variationIsAbTest,
      })

      setVariationDialogOpen(false)

      // Refresh the open drawer's variation list in place if it is the same script.
      if (selectedScript?.id === variationScript.id) {
        const variations = await getScriptVariations(variationScript.id)
        setSelectedScript((prev) =>
          prev ? { ...prev, script_variations: variations } : prev
        )
      }

      loadScripts()
      toast.success("Variation created")
    } catch (error: any) {
      console.error("Error creating variation:", error)
      toast.error(error?.message ?? "Could not create variation")
    } finally {
      setCreatingVariation(false)
    }
  }

  // ─── Approval Decision ─────────────────────────────────────────────────────

  async function handleApprovalDecision(
    script: VideoScript,
    approvalStatus: "approved" | "rejected" | "pending_review"
  ) {
    const { toast } = await import("sonner")
    setApprovingScriptId(script.id)
    try {
      let notes: string | undefined
      if (approvalStatus === "rejected") {
        const entered = window.prompt("Why is this script being rejected? (shown to the author)")
        if (entered === null) return
        notes = entered.trim() || undefined
      }

      const updated = await updateScriptApprovalStatus(
        script.id,
        brokerage?.id ?? "",
        approvalStatus,
        notes
      )

      setScripts((prev) =>
        prev.map((s) =>
          s.id === script.id
            ? { ...s, approval_status: approvalStatus, compliance_review_notes: notes ?? null }
            : s
        )
      )
      if (selectedScript?.id === script.id) {
        setSelectedScript((prev) =>
          prev ? { ...prev, approval_status: approvalStatus, compliance_review_notes: notes ?? null } : prev
        )
      }
      toast.success(
        approvalStatus === "approved"
          ? "Script approved — it can now be used to generate a video"
          : approvalStatus === "rejected"
          ? "Script rejected"
          : "Script sent for review"
      )
      void updated
    } catch (error: any) {
      console.error("Error updating approval status:", error)
      toast.error(error?.message ?? "Could not update approval status")
    } finally {
      setApprovingScriptId(null)
    }
  }

  // ─── Video Performance ─────────────────────────────────────────────────────

  /**
   * The distribution numbers for the video this script produced — views,
   * engagement, comments and shares aggregated from the social posts carrying
   * its video_url. loadVideoPerformanceAction is the only path to these; there
   * is no API route for it, so before this the aggregate was computed for
   * nobody.
   */
  async function handleShowPerformance(script: VideoScript) {
    const { toast } = await import("sonner")

    const projectId = await resolveProjectIdForScript(script)
    if (!projectId) {
      toast.error("No video project found for this script. Generate a video first.")
      return
    }

    const { loadVideoPerformanceAction } = await import("@/app/actions/video")
    const result = await loadVideoPerformanceAction({ projectId })
    if (!result.success || !result.data) {
      toast.error(result.error ?? "Could not load performance")
      return
    }

    const p = result.data
    setPerformance({ title: script.title, ...p })
  }

  /** The ai_video_projects row this script-library entry produced. */
  async function resolveProjectIdForScript(script: VideoScript): Promise<string | null> {
    const { data: project, error } = await supabase
      .from("ai_video_projects")
      .select("id")
      // source_type/source_id live inside the video_metadata jsonb (no real columns)
      .eq("video_metadata->>source_type", "script_library")
      .eq("video_metadata->>source_id", script.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !project) return null
    return project.id as string
  }

  // ─── Distribute Script ─────────────────────────────────────────────────────

  async function handleDistribute(script: VideoScript) {
    const { toast } = await import("sonner")

    // Look up the ai_video_projects record linked to this script-library entry
    const projectId = await resolveProjectIdForScript(script)
    if (!projectId) {
      toast.error("No video project found for this script. Generate a video first.")
      return
    }
    const project = { id: projectId }

    const { distributeVideoProjectAction } = await import("@/app/actions/video")
    const result = await distributeVideoProjectAction({
      projectId: project.id,
      channels: ["youtube", "linkedin"],
      title: script.title,
      description: script.script_content.slice(0, 200),
    })

    if (!result.success) {
      toast.error(result.error ?? "Distribution failed")
      return
    }

    const distributions = result.data?.distributions ?? []
    const failed = distributions.filter(d => d.status === "failed")
    const succeeded = distributions.filter(d => d.status !== "failed")

    // A successful distribution IS a share of this video project. Recording it
    // is what feeds video_performance_tracking.share_rate — the number
    // /dashboard/videos/analytics already renders and which, with no writer
    // anywhere, could only ever read 0.
    if (succeeded.length > 0) {
      try {
        await recordVideoEngagementEvent({
          videoProjectId: project.id,
          // Same id space: contact-details.ts joins video_asset_id against
          // ai_video_projects.id, so this is the project's id in both columns.
          videoAssetId: project.id,
          eventType: "share",
          metadata: { channels: succeeded.map((d) => d.channel) },
        })
      } catch (err) {
        console.error("[videos/library] Could not record share engagement:", err)
      }
    }

    if (failed.length === 0) {
      toast.success("Video queued for distribution")
    } else if (succeeded.length === 0) {
      toast.error(`Distribution failed on all channels: ${failed.map(d => d.channel).join(", ")}`)
    } else {
      toast.warning(
        `Partial distribution: ${succeeded.length} succeeded, ${failed.length} failed (${failed.map(d => `${d.channel}: ${d.error ?? "error"}`).join("; ")})`
      )
    }
  }

  // ─── Delete Script ─────────────────────────────────────────────────────────

  async function handleDeleteScript(scriptId: string) {
    if (!confirm("Are you sure you want to delete this script?")) return

    try {
      await fetch(`/api/video-scripts?id=${scriptId}`, { method: "DELETE" })
      setScripts((prev) => prev.filter((s) => s.id !== scriptId))
      if (selectedScript?.id === scriptId) {
        setDrawerOpen(false)
        setSelectedScript(null)
      }
    } catch (error) {
      console.error("Error deleting script:", error)
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-foreground">My Videos</h1>
            <p className="text-muted-foreground mt-1">
              Manage your scripts, pipeline, and video analytics
            </p>
          </div>
          <Button onClick={() => router.push("/dashboard/videos/create")}>
            <Plus className="h-4 w-4 mr-2" />
            Create Video
          </Button>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-1 border-b mb-8">
          <Link
            href="/dashboard/videos/library"
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 border-primary text-primary"
          >
            <FileText className="h-4 w-4" />
            Scripts
          </Link>
          <Link
            href="/dashboard/videos/board"
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground transition-colors"
          >
            <Kanban className="h-4 w-4" />
            Pipeline
          </Link>
          <Link
            href="/dashboard/videos/analytics"
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground transition-colors"
          >
            <BarChart3 className="h-4 w-4" />
            Analytics
          </Link>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-100">
                  <FileText className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Scripts</p>
                  <p className="text-2xl font-bold">{stats.total}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-100">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Approved</p>
                  <p className="text-2xl font-bold">{stats.approved}</p>
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
                  <p className="text-sm text-muted-foreground">Pending Review</p>
                  <p className="text-2xl font-bold">{stats.pending}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-slate-100">
                  <FileText className="h-5 w-5 text-slate-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Drafts</p>
                  <p className="text-2xl font-bold">{stats.draft}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search scripts..."
                  className="pl-10"
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Script Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {Object.entries(SCRIPT_TYPE_CONFIG).map(([key, config]) => (
                    <SelectItem key={key} value={key}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="pending_review">Pending Review</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
              <Select value={templateFilter} onValueChange={setTemplateFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="template">Template-based</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Button
                  variant={viewMode === "grid" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("grid")}
                >
                  <Grid className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "list" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("list")}
                >
                  <List className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Script Grid/List */}
        {loading ? (
          <Loading />
        ) : filteredScripts.length === 0 ? (
          <Card>
            <CardContent className="p-16 text-center">
              <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No scripts found</h3>
              <p className="text-muted-foreground mb-4">
                Create your first AI-generated script
              </p>
              <Button onClick={() => router.push("/dashboard/videos/create")}>
                <Plus className="h-4 w-4 mr-2" />
                Create Script
              </Button>
            </CardContent>
          </Card>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredScripts.map((script) => {
              const typeConfig = SCRIPT_TYPE_CONFIG[script.script_type]
              const statusConfig = APPROVAL_STATUS_CONFIG[script.approval_status]
              const TypeIcon = typeConfig?.icon || FileText
              const StatusIcon = statusConfig?.icon || FileText

              return (
                <Card
                  key={script.id}
                  className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer"
                  onClick={() => openScriptDetail(script)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Badge className={cn("text-xs", typeConfig?.color)}>
                          <TypeIcon className="h-3 w-3 mr-1" />
                          {typeConfig?.label || script.script_type}
                        </Badge>
                        {script.ai_generated && (
                          <Badge variant="outline" className="text-xs">
                            <Sparkles className="h-3 w-3 mr-1" />
                            AI
                          </Badge>
                        )}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openScriptDetail(script) }}>
                            <Eye className="h-4 w-4 mr-2" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openVariationDialog(script) }}>
                            <GitBranch className="h-4 w-4 mr-2" />
                            Create Variation
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(script.script_content) }}>
                            <Copy className="h-4 w-4 mr-2" />
                            Copy Script
                          </DropdownMenuItem>
                          {script.approval_status === "approved" && (
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDistribute(script) }}>
                              <Share2 className="h-4 w-4 mr-2" />
                              Distribute
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleShowPerformance(script) }}>
                            <BarChart3 className="h-4 w-4 mr-2" />
                            Video Performance
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-red-600"
                            onClick={(e) => { e.stopPropagation(); handleDeleteScript(script.id) }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <h3 className="font-medium text-foreground mb-2 line-clamp-1">
                      {script.title}
                    </h3>

                    <p className="text-sm text-muted-foreground line-clamp-3 mb-4">
                      {script.script_content.slice(0, 150)}...
                    </p>

                    <div className="flex items-center justify-between pt-3 border-t">
                      <Badge className={cn("text-xs", statusConfig?.color)}>
                        <StatusIcon className="h-3 w-3 mr-1" />
                        {statusConfig?.label || script.approval_status}
                      </Badge>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {script.variation_count ? (
                          <span className="flex items-center gap-1">
                            <GitBranch className="h-3 w-3" />
                            {script.variation_count}
                          </span>
                        ) : null}
                        <span>
                          {new Date(script.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        ) : (
          <Card>
            <div className="divide-y">
              {filteredScripts.map((script) => {
                const typeConfig = SCRIPT_TYPE_CONFIG[script.script_type]
                const statusConfig = APPROVAL_STATUS_CONFIG[script.approval_status]
                const TypeIcon = typeConfig?.icon || FileText
                const StatusIcon = statusConfig?.icon || FileText

                return (
                  <div
                    key={script.id}
                    className="p-4 hover:bg-muted/50 cursor-pointer flex items-center gap-4"
                    onClick={() => openScriptDetail(script)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium text-foreground truncate">
                          {script.title}
                        </h3>
                        {script.ai_generated && (
                          <Badge variant="outline" className="text-xs shrink-0">
                            <Sparkles className="h-3 w-3 mr-1" />
                            AI
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground truncate">
                        {script.script_content.slice(0, 100)}...
                      </p>
                    </div>
                    <Badge className={cn("text-xs shrink-0", typeConfig?.color)}>
                      <TypeIcon className="h-3 w-3 mr-1" />
                      {typeConfig?.label}
                    </Badge>
                    <Badge className={cn("text-xs shrink-0", statusConfig?.color)}>
                      <StatusIcon className="h-3 w-3 mr-1" />
                      {statusConfig?.label}
                    </Badge>
                    {script.variation_count ? (
                      <span className="flex items-center gap-1 text-sm text-muted-foreground">
                        <GitBranch className="h-3 w-3" />
                        {script.variation_count}
                      </span>
                    ) : null}
                    <span className="text-sm text-muted-foreground shrink-0">
                      {new Date(script.created_at).toLocaleDateString()}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openVariationDialog(script) }}>
                          <GitBranch className="h-4 w-4 mr-2" />
                          Create Variation
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(script.script_content) }}>
                          <Copy className="h-4 w-4 mr-2" />
                          Copy Script
                        </DropdownMenuItem>
                        {script.approval_status === "approved" && (
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDistribute(script) }}>
                            <Share2 className="h-4 w-4 mr-2" />
                            Distribute
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleShowPerformance(script) }}>
                          <BarChart3 className="h-4 w-4 mr-2" />
                          Video Performance
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={(e) => { e.stopPropagation(); handleDeleteScript(script.id) }}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )
              })}
            </div>
          </Card>
        )}
      </div>

      {/* Script Detail Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {selectedScript && (
            <>
              <SheetHeader>
                <SheetTitle>{selectedScript.title}</SheetTitle>
                <SheetDescription>
                  Created {new Date(selectedScript.created_at).toLocaleDateString()}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* Status and Type */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={cn("text-xs", SCRIPT_TYPE_CONFIG[selectedScript.script_type]?.color)}>
                    {SCRIPT_TYPE_CONFIG[selectedScript.script_type]?.label}
                  </Badge>
                  <Badge className={cn("text-xs", APPROVAL_STATUS_CONFIG[selectedScript.approval_status]?.color)}>
                    {APPROVAL_STATUS_CONFIG[selectedScript.approval_status]?.label}
                  </Badge>
                  {selectedScript.ai_generated && (
                    <Badge variant="outline" className="text-xs">
                      <Sparkles className="h-3 w-3 mr-1" />
                      AI Generated
                    </Badge>
                  )}
                  {selectedScript.template && (
                    <Badge variant="secondary" className="text-xs">
                      Template: {selectedScript.template.template_name}
                    </Badge>
                  )}
                </div>

                {/* Compliance Notes */}
                {selectedScript.compliance_review_notes && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-amber-800">Compliance Notes</p>
                        <p className="text-sm text-amber-700 mt-1">
                          {selectedScript.compliance_review_notes}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Script Content */}
                <div className="space-y-2">
                  <Label>Script Content</Label>
                  <div className="p-4 bg-muted rounded-lg">
                    <p className="text-sm whitespace-pre-wrap font-mono">
                      {selectedScript.script_content}
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      {selectedScript.script_content.split(/\s+/).length} words
                    </span>
                    {selectedScript.duration_target_seconds && (
                      <span>Target: {selectedScript.duration_target_seconds}s</span>
                    )}
                  </div>
                </div>

                {/* Render this script.
                    `scriptId` is passed, so the action reads the script text and
                    tenant from the STORED row and does not mint a duplicate
                    library entry for a script that is already in the library.
                    Gated on `approved` for the same reason the approval control
                    below exists — an unapproved script must not reach a paid
                    provider render. */}
                <div className="space-y-2 pt-4 border-t">
                  <Label>Generate video</Label>
                  {selectedScript.approval_status === "approved" ? (
                    <VideoGenerationButtons
                      scriptId={selectedScript.id}
                      script={selectedScript.script_content}
                      title={selectedScript.title}
                      size="sm"
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Approve this script first — rendering spends provider credits.
                    </p>
                  )}
                </div>

                {/* Variations */}
                {selectedScript.script_variations && selectedScript.script_variations.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Variations ({selectedScript.script_variations.length})</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openVariationDialog(selectedScript)}
                      >
                        <GitBranch className="h-3 w-3 mr-1" />
                        Add Variation
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {selectedScript.script_variations.map((variation) => (
                        <div
                          key={variation.id}
                          className="p-3 border rounded-lg hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium text-sm">
                              {variation.variation_label}
                            </span>
                            <div className="flex items-center gap-2">
                              {variation.is_ab_test && (
                                <Badge variant="secondary" className="text-xs">
                                  A/B Test
                                </Badge>
                              )}
                              {variation.audience_segment && (
                                <Badge variant="outline" className="text-xs">
                                  {variation.audience_segment}
                                </Badge>
                              )}
                            </div>
                          </div>
                          {variation.variation_goal && (
                            <p className="text-xs text-muted-foreground mb-2">
                              Goal: {variation.variation_goal}
                            </p>
                          )}
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {variation.script_content.slice(0, 100)}...
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Approval decision — a script must be `approved` before the
                    create wizard will offer it, so this is the gate that was
                    missing between the badge and the video. */}
                <div className="space-y-2 pt-4 border-t">
                  <Label>Approval</Label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {selectedScript.approval_status !== "approved" && (
                      <Button
                        size="sm"
                        disabled={approvingScriptId === selectedScript.id}
                        onClick={() => handleApprovalDecision(selectedScript, "approved")}
                      >
                        {approvingScriptId === selectedScript.id ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 mr-2" />
                        )}
                        Approve
                      </Button>
                    )}
                    {selectedScript.approval_status !== "pending_review" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={approvingScriptId === selectedScript.id}
                        onClick={() => handleApprovalDecision(selectedScript, "pending_review")}
                      >
                        <Clock className="h-4 w-4 mr-2" />
                        Send for Review
                      </Button>
                    )}
                    {selectedScript.approval_status !== "rejected" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 border-red-200 hover:bg-red-50"
                        disabled={approvingScriptId === selectedScript.id}
                        onClick={() => handleApprovalDecision(selectedScript, "rejected")}
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Reject
                      </Button>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-4 border-t">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => openVariationDialog(selectedScript)}
                  >
                    <GitBranch className="h-4 w-4 mr-2" />
                    Create Variation
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => navigator.clipboard.writeText(selectedScript.script_content)}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Copy
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Create Variation Dialog */}
      <Dialog open={variationDialogOpen} onOpenChange={setVariationDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Script Variation</DialogTitle>
            <DialogDescription>
              Create a new variation of "{variationScript?.title}"
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Variation Label *</Label>
              <Input
                value={variationLabel}
                onChange={(e) => setVariationLabel(e.target.value)}
                placeholder="e.g., Version B - Shorter CTA"
              />
            </div>

            <div className="space-y-2">
              <Label>Variation Goal</Label>
              <Input
                value={variationGoal}
                onChange={(e) => setVariationGoal(e.target.value)}
                placeholder="e.g., Test shorter call to action"
              />
            </div>

            <div className="space-y-2">
              <Label>Audience Segment</Label>
              <Input
                value={variationAudience}
                onChange={(e) => setVariationAudience(e.target.value)}
                placeholder="e.g., First-time buyers"
              />
            </div>

            <div className="space-y-2">
              <Label>Call to Action</Label>
              <Input
                value={variationCta}
                onChange={(e) => setVariationCta(e.target.value)}
                placeholder="e.g., Schedule a viewing today"
              />
            </div>

            <div className="space-y-2">
              <Label>Script Content *</Label>
              <Textarea
                value={variationContent}
                onChange={(e) => setVariationContent(e.target.value)}
                rows={8}
                className="font-mono text-sm"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="ab-test"
                checked={variationIsAbTest}
                onChange={(e) => setVariationIsAbTest(e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="ab-test" className="text-sm font-normal">
                Mark as A/B test variant
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setVariationDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateVariation}
              disabled={!variationLabel || !variationContent || creatingVariation}
            >
              {creatingVariation ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <GitBranch className="h-4 w-4 mr-2" />
                  Create Variation
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* VIDEO PERFORMANCE — real aggregate from the social posts carrying this
          project's video_url. Zeroes are shown as zeroes, not hidden. */}
      <Dialog open={!!performance} onOpenChange={(open) => { if (!open) setPerformance(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Video Performance</DialogTitle>
            <DialogDescription>{performance?.title}</DialogDescription>
          </DialogHeader>
          {performance && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Views", value: performance.views },
                  { label: "Engagement", value: performance.engagement },
                  { label: "Comments", value: performance.comments },
                  { label: "Shares", value: performance.shares },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                    <p className="text-xl font-semibold">{stat.value.toLocaleString()}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Aggregated from published social posts carrying this video. All zeroes means it
                has not been distributed yet, or no platform has reported metrics back.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

    </div>
  )
}

// ─── PAGE COMPONENT ──────────────────────────────────────────────────────────

export default function VideoLibraryPage() {
  return (
    <Suspense fallback={<Loading />}>
      <VideoLibraryContent />
    </Suspense>
  )
}
