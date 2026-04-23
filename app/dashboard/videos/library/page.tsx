"use client"

import { useState, useEffect, Suspense } from "react"
import { useRouter } from "next/navigation"
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
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface VideoScript {
  id: string
  brokerage_id: string
  agent_id: string | null
  listing_id: string | null
  contact_id: string | null
  template_id: string | null
  script_type: string
  title: string
  script_content: string
  duration_target_seconds: number | null
  brand_voice_tone: string | null
  approval_status: "draft" | "pending_review" | "approved" | "rejected"
  compliance_review_notes: string | null
  required_brand_assets: Record<string, any> | null
  ai_generated: boolean
  is_active: boolean
  created_at: string
  updated_at: string
  variation_count?: number
  template?: { id: string; template_name: string; category: string } | null
  script_variations?: ScriptVariation[]
}

interface ScriptVariation {
  id: string
  script_library_id: string
  variation_label: string
  variation_goal: string | null
  script_content: string
  call_to_action: string | null
  audience_segment: string | null
  is_ab_test: boolean
  created_at: string
}

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
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
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

  // ─── Load Scripts ──────────────────────────────────────────────────────────

  useEffect(() => {
    loadScripts()
  }, [brokerage?.id])

  async function loadScripts() {
    if (!brokerage?.id) return

    setLoading(true)
    try {
      const response = await fetch("/api/video-scripts")
      const data = await response.json()

      if (data.scripts) {
        setScripts(data.scripts)
      }
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
    // Fetch full details including variations
    const response = await fetch(`/api/video-scripts?id=${script.id}`)
    const data = await response.json()

    if (data.script) {
      setSelectedScript(data.script)
      setDrawerOpen(true)
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

    setCreatingVariation(true)
    try {
      const { data, error } = await supabase.from("script_variations").insert({
        script_library_id: variationScript.id,
        brokerage_id: brokerage.id,
        variation_label: variationLabel,
        variation_goal: variationGoal || null,
        script_content: variationContent,
        call_to_action: variationCta || null,
        audience_segment: variationAudience || null,
        is_ab_test: variationIsAbTest,
        created_by: user?.id,
      })

      if (error) throw error

      setVariationDialogOpen(false)
      loadScripts()
    } catch (error) {
      console.error("Error creating variation:", error)
    } finally {
      setCreatingVariation(false)
    }
  }

  // ─── Distribute Script ─────────────────────────────────────────────────────

  async function handleDistribute(script: VideoScript) {
    const { distributeVideoProjectAction } = await import("@/app/actions/video")
    const result = await distributeVideoProjectAction({
      projectId: script.id,
      channels: ["youtube", "linkedin"],
      title: script.title,
      description: script.script_content.slice(0, 200),
    })
    if (result.success) {
      const { toast } = await import("sonner")
      toast.success("Video queued for distribution")
    } else {
      const { toast } = await import("sonner")
      toast.error(result.error ?? "Distribution failed")
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
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Script Library</h1>
            <p className="text-muted-foreground mt-1">
              Manage your AI-generated video scripts
            </p>
          </div>
          <Button onClick={() => router.push("/dashboard/videos/create")}>
            <Plus className="h-4 w-4 mr-2" />
            Create Script
          </Button>
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
