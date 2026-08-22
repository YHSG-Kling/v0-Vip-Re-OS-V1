"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Separator } from "@/components/ui/separator"
import {
  Search,
  Plus,
  TrendingUp,
  FileText,
  Loader2,
  Target,
  BarChart3,
  Filter,
  Sparkles,
  AlertCircle,
  ChevronRight,
  ArrowRight,
  RefreshCw,
} from "lucide-react"
import {
  addSeoKeyword,
  toggleKeywordActive,
  discoverKeywordsAI,
  getSeoKeywords,
  type DiscoveredKeyword,
} from "@/app/actions/blog"
import { toast } from "sonner"

interface Keyword {
  id: string
  keyword: string
  keyword_type: string
  search_intent: string
  target_location: string | null
  search_volume: number | null
  competition: number | null
  difficulty_score: number | null
  priority_score: number | null
  is_active: boolean
  created_at: string
}

interface SeoKeywordsDashboardClientProps {
  userId: string
  brokerageId: string
  initialKeywords: Keyword[]
  /** Pre-filled territory from brokerage city/state */
  defaultTerritory?: string
}

const keywordTypeColors: Record<string, string> = {
  primary:   "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  secondary: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  long_tail: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
}

const intentColors: Record<string, string> = {
  informational: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  transactional: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  navigational:  "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  commercial:    "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
}

function DifficultyBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">--</span>

  const color =
    score <= 30 ? "text-green-600 dark:text-green-400"
    : score <= 60 ? "text-amber-600 dark:text-amber-400"
    : "text-red-600 dark:text-red-400"

  const label = score <= 30 ? "Easy" : score <= 60 ? "Medium" : "Hard"

  return (
    <div className={`flex items-center gap-1 ${color}`}>
      <span className="font-medium">{score}</span>
      <span className="text-xs">({label})</span>
    </div>
  )
}

/** Horizontal popularity bar — shown in the AI discovery panel */
function PopularityBar({ pct, isCompetitor }: { pct: number; isCompetitor: boolean }) {
  const color =
    pct >= 75 ? "bg-green-500"
    : pct >= 45 ? "bg-amber-500"
    : "bg-slate-400"

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-semibold tabular-nums w-9 text-right">{pct}%</span>
      {isCompetitor && (
        <span title="Competitor is ranking for this keyword">
          <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        </span>
      )}
    </div>
  )
}

// Content type options the agent can generate using a keyword
const CONTENT_TYPES = [
  { value: "blog_post",      label: "Blog Post" },
  { value: "email_campaign", label: "Email Campaign" },
  { value: "social_post",    label: "Social Post" },
  { value: "newsletter",     label: "Newsletter" },
]

export function SeoKeywordsDashboardClient({
  userId,
  brokerageId,
  initialKeywords,
  defaultTerritory,
}: SeoKeywordsDashboardClientProps) {
  const router = useRouter()
  const [keywords, setKeywords] = useState<Keyword[]>(initialKeywords)
  const [searchQuery, setSearchQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [intentFilter, setIntentFilter] = useState<string>("all")
  // ── SERVER TRUTH FOR THE LIST ──────────────────────────────────────────────
  // Every mutation below updates `keywords` OPTIMISTICALLY, and the added row is
  // RECONSTRUCTED from what was typed into the form — not from what the table
  // stored. That is fine for the instant feedback it buys, and wrong as the
  // lasting answer: the insert also sets columns the form never named, and this
  // list is BROKERAGE-WIDE, so a keyword a colleague added in the meantime is
  // simply absent until a full page reload. app/actions/blog.ts:getSeoKeywords
  // re-reads the same projection the page server-rendered, scoped to the session
  // brokerage, in the same priority order.
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  // ── Manual add dialog ───────────────────────────────────────────────────────
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [newKeyword, setNewKeyword] = useState("")
  const [keywordType, setKeywordType] = useState<"primary" | "secondary" | "long_tail">("primary")
  const [searchIntent, setSearchIntent] = useState<
    "informational" | "transactional" | "navigational" | "commercial"
  >("informational")
  const [targetLocation, setTargetLocation] = useState("")
  const [searchVolume, setSearchVolume] = useState("")
  const [competition, setCompetition] = useState("")
  const [difficultyScore, setDifficultyScore] = useState("")
  const [priorityScore, setPriorityScore] = useState("")

  // ── AI discovery panel ──────────────────────────────────────────────────────
  const [isDiscoverOpen, setIsDiscoverOpen] = useState(false)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [territory, setTerritory] = useState(defaultTerritory ?? "")
  const [competitors, setCompetitors] = useState("")
  const [focusArea, setFocusArea] = useState("")
  const [discoveredKeywords, setDiscoveredKeywords] = useState<DiscoveredKeyword[]>([])

  // ── Pick-to-use workflow ────────────────────────────────────────────────────
  // After discovering keywords, agent selects one and picks a content type
  const [selectedDiscovered, setSelectedDiscovered] = useState<DiscoveredKeyword | null>(null)
  const [contentType, setContentType] = useState<string>("blog_post")
  const [isSavingSelected, setIsSavingSelected] = useState(false)

  // ── Filters ─────────────────────────────────────────────────────────────────
  const filteredKeywords = keywords.filter((kw) => {
    const matchesSearch  = kw.keyword.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesType    = typeFilter   === "all" || kw.keyword_type  === typeFilter
    const matchesIntent  = intentFilter === "all" || kw.search_intent === intentFilter
    return matchesSearch && matchesType && matchesIntent
  })

  // ── Re-read the list from the table ──────────────────────────────────────────
  // `silent` is used for the automatic pass that follows a successful add: the row
  // is already on screen optimistically, so a spinner and an error banner there
  // would report a problem the agent does not have. An explicit Refresh is loud.
  const refreshKeywords = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setIsRefreshing(true)
      setRefreshError(null)
    }
    try {
      const result = await getSeoKeywords()
      if (!result.success) {
        // A refused read is NOT an empty keyword list. Leave the rows on screen.
        if (!opts?.silent) setRefreshError(result.error ?? "The keyword list could not be re-read")
        return
      }
      setKeywords(result.keywords ?? [])
    } catch (err) {
      if (!opts?.silent) {
        setRefreshError(
          err instanceof Error ? `The keyword list could not be re-read: ${err.message}` : "The keyword list could not be re-read",
        )
      }
    } finally {
      if (!opts?.silent) setIsRefreshing(false)
    }
  }

  // ── Manual add handler ───────────────────────────────────────────────────────
  const handleAddKeyword = async () => {
    if (!newKeyword.trim()) { setAddError("Keyword is required"); return }
    setIsAdding(true)
    setAddError(null)
    try {
      const result = await addSeoKeyword(userId, {
        brokerageId,
        keyword:         newKeyword.trim(),
        keywordType,
        searchIntent,
        targetLocation:  targetLocation   || undefined,
        searchVolume:    searchVolume     ? parseInt(searchVolume)    : undefined,
        competition:     competition      ? parseFloat(competition)   : undefined,
        difficultyScore: difficultyScore  ? parseInt(difficultyScore) : undefined,
        priorityScore:   priorityScore    ? parseInt(priorityScore)   : undefined,
      })

      if (result.success && result.keywordId) {
        setKeywords((prev) => [
          {
            id:               result.keywordId!,
            keyword:          newKeyword.trim(),
            keyword_type:     keywordType,
            search_intent:    searchIntent,
            target_location:  targetLocation || null,
            search_volume:    searchVolume ? parseInt(searchVolume) : null,
            competition:      competition  ? parseFloat(competition) : null,
            difficulty_score: difficultyScore ? parseInt(difficultyScore) : null,
            priority_score:   priorityScore   ? parseInt(priorityScore)   : null,
            is_active:        true,
            created_at:       new Date().toISOString(),
          },
          ...prev,
        ])
        setNewKeyword(""); setKeywordType("primary"); setSearchIntent("informational")
        setTargetLocation(""); setSearchVolume(""); setCompetition("")
        setDifficultyScore(""); setPriorityScore(""); setIsAddOpen(false)
        toast.success("Keyword added")
        // Replace the reconstructed row with the stored one. Silent: the add
        // itself already succeeded and is already rendered.
        void refreshKeywords({ silent: true })
      } else {
        setAddError(result.error || "Failed to add keyword")
      }
    } catch {
      setAddError("An unexpected error occurred")
    } finally {
      setIsAdding(false)
    }
  }

  // ── AI discovery handler ─────────────────────────────────────────────────────
  const handleDiscoverKeywords = async () => {
    setIsDiscovering(true)
    setDiscoverError(null)
    setDiscoveredKeywords([])
    setSelectedDiscovered(null)
    try {
      const competitorNames = competitors.split(",").map(s => s.trim()).filter(Boolean)
      const result = await discoverKeywordsAI(userId, {
        brokerageId,
        territory:       territory || undefined,
        competitorNames: competitorNames.length ? competitorNames : undefined,
        focusArea:       focusArea  || undefined,
      })

      if (result.success && result.keywords) {
        setDiscoveredKeywords(result.keywords)
      } else {
        setDiscoverError(result.error || "Failed to discover keywords")
      }
    } catch {
      setDiscoverError("An unexpected error occurred")
    } finally {
      setIsDiscovering(false)
    }
  }

  // ── Save selected keyword + route to content type ────────────────────────────
  const handleUseKeyword = async (kw: DiscoveredKeyword) => {
    setSelectedDiscovered(kw)
  }

  const handleConfirmUseKeyword = async () => {
    if (!selectedDiscovered) return
    setIsSavingSelected(true)

    // Save the keyword to seo_keywords table
    const result = await addSeoKeyword(userId, {
      brokerageId,
      keyword:        selectedDiscovered.keyword,
      keywordType:    selectedDiscovered.keyword_type,
      searchIntent:   selectedDiscovered.search_intent,
      priorityScore:  selectedDiscovered.popularity_pct,
    })

    if (result.success && result.keywordId) {
      // Add to local state
      setKeywords((prev) => [
        {
          id:               result.keywordId!,
          keyword:          selectedDiscovered.keyword,
          keyword_type:     selectedDiscovered.keyword_type,
          search_intent:    selectedDiscovered.search_intent,
          target_location:  null,
          search_volume:    null,
          competition:      null,
          difficulty_score: null,
          priority_score:   selectedDiscovered.popularity_pct,
          is_active:        true,
          created_at:       new Date().toISOString(),
        },
        ...prev,
      ])
    }

    setIsSavingSelected(false)
    setIsDiscoverOpen(false)
    setSelectedDiscovered(null)
    setDiscoveredKeywords([])

    // Route to the appropriate content generator
    const kw = encodeURIComponent(selectedDiscovered.keyword)
    if (contentType === "blog_post") {
      router.push(`/dashboard/marketing/blog?keyword=${kw}`)
    } else if (contentType === "email_campaign" || contentType === "newsletter") {
      // Both routed to non-existent pages (/dashboard/marketing/campaigns,
      // /dashboard/marketing/newsletter → 404). The real email/newsletter surface
      // is /newsletters.
      router.push(`/newsletters?keyword=${kw}`)
    } else if (contentType === "social_post") {
      router.push(`/dashboard/marketing/studio?keyword=${kw}`)
    } else {
      toast.success(`Keyword "${selectedDiscovered.keyword}" saved`)
    }
  }

  const handleToggleActive = async (keywordId: string, currentState: boolean) => {
    const newState = !currentState
    setKeywords((prev) => prev.map((kw) => kw.id === keywordId ? { ...kw, is_active: newState } : kw))
    const result = await toggleKeywordActive(keywordId, newState)
    if (!result.success) {
      setKeywords((prev) => prev.map((kw) => kw.id === keywordId ? { ...kw, is_active: currentState } : kw))
    }
  }

  const handleGenerateBlog = (keyword: Keyword) => {
    router.push(`/dashboard/marketing/blog?keyword=${encodeURIComponent(keyword.keyword)}`)
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      <div className="flex flex-col gap-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SEO Keywords</h1>
            <p className="text-muted-foreground">
              Discover high-impact keywords from your market and competitors, then use them to generate content
            </p>
          </div>
          <div className="flex gap-2">
            {/* AI Discover */}
            <Dialog open={isDiscoverOpen} onOpenChange={(open) => {
              setIsDiscoverOpen(open)
              if (!open) { setDiscoveredKeywords([]); setSelectedDiscovered(null) }
            }}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Sparkles className="h-4 w-4 mr-2" />
                  Research Keywords
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-violet-500" />
                    AI Keyword Discovery
                  </DialogTitle>
                  <DialogDescription>
                    AI analyzes your territory and competitors to surface the most popular keywords — ranked by search demand. Select one to immediately generate content.
                  </DialogDescription>
                </DialogHeader>

                {!discoveredKeywords.length ? (
                  /* ── Discovery form ── */
                  <div className="space-y-4 py-2">
                    <div className="space-y-2">
                      <Label htmlFor="territory">Territory / Market Area</Label>
                      <Input
                        id="territory"
                        placeholder="e.g. Austin, TX"
                        value={territory}
                        onChange={(e) => setTerritory(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Defaults to your brokerage location if left blank
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="competitors">
                        Competitor Names
                        <span className="text-muted-foreground ml-1 font-normal">(optional, comma-separated)</span>
                      </Label>
                      <Input
                        id="competitors"
                        placeholder="e.g. Keller Williams Austin, RE/MAX Capital City"
                        value={competitors}
                        onChange={(e) => setCompetitors(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="focusArea">
                        Focus Area
                        <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
                      </Label>
                      <Input
                        id="focusArea"
                        placeholder="e.g. luxury listings, first-time buyers, investment properties"
                        value={focusArea}
                        onChange={(e) => setFocusArea(e.target.value)}
                      />
                    </div>

                    {discoverError && (
                      <p className="text-sm text-destructive">{discoverError}</p>
                    )}

                    <Button
                      onClick={handleDiscoverKeywords}
                      disabled={isDiscovering}
                      className="w-full"
                    >
                      {isDiscovering ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analyzing market...</>
                      ) : (
                        <><Sparkles className="h-4 w-4 mr-2" />Discover Keywords</>
                      )}
                    </Button>
                  </div>
                ) : selectedDiscovered ? (
                  /* ── Pick content type step ── */
                  <div className="space-y-4 py-2">
                    <div className="rounded-lg border bg-muted/40 px-4 py-3">
                      <p className="text-xs text-muted-foreground mb-1">Selected keyword</p>
                      <p className="font-semibold text-base">{selectedDiscovered.keyword}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge className={keywordTypeColors[selectedDiscovered.keyword_type] || ""}>
                          {selectedDiscovered.keyword_type.replace("_", " ")}
                        </Badge>
                        <Badge variant="outline" className={intentColors[selectedDiscovered.search_intent] || ""}>
                          {selectedDiscovered.search_intent}
                        </Badge>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {selectedDiscovered.popularity_pct}% popularity
                        </span>
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label>Generate content type</Label>
                      <Select value={contentType} onValueChange={setContentType}>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose content type" />
                        </SelectTrigger>
                        <SelectContent>
                          {CONTENT_TYPES.map((ct) => (
                            <SelectItem key={ct.value} value={ct.value}>
                              {ct.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        This keyword will be saved to your library and you will be taken to the generator.
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setSelectedDiscovered(null)}
                        className="flex-1"
                      >
                        Back
                      </Button>
                      <Button
                        onClick={handleConfirmUseKeyword}
                        disabled={isSavingSelected}
                        className="flex-1"
                      >
                        {isSavingSelected ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
                        ) : (
                          <>Use Keyword <ArrowRight className="h-4 w-4 ml-2" /></>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* ── Results list ── */
                  <div className="space-y-3 py-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">
                        {discoveredKeywords.length} keywords found — sorted by search demand
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDiscoveredKeywords([])}
                      >
                        Start over
                      </Button>
                    </div>

                    {/* Legend */}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground pb-1">
                      <span className="flex items-center gap-1">
                        <AlertCircle className="h-3 w-3 text-amber-500" />
                        Competitor targets this keyword
                      </span>
                    </div>

                    <div className="space-y-2">
                      {discoveredKeywords.map((kw, i) => (
                        <div
                          key={i}
                          className="group rounded-lg border bg-card hover:bg-accent/30 transition-colors p-3 flex flex-col gap-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">{kw.keyword}</p>
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                                {kw.rationale}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="shrink-0 group-hover:bg-primary group-hover:text-primary-foreground transition-colors"
                              onClick={() => handleUseKeyword(kw)}
                            >
                              Use <ChevronRight className="h-3 w-3 ml-1" />
                            </Button>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={`text-xs ${keywordTypeColors[kw.keyword_type] || ""}`}
                            >
                              {kw.keyword_type.replace("_", " ")}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={`text-xs ${intentColors[kw.search_intent] || ""}`}
                            >
                              {kw.search_intent}
                            </Badge>
                            <div className="flex-1 ml-2">
                              <PopularityBar pct={kw.popularity_pct} isCompetitor={kw.competitor_usage} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Bulk save all */}
                    <Separator />
                    <p className="text-xs text-muted-foreground">
                      Click "Use" next to any keyword to save it and choose a content type to generate.
                    </p>
                  </div>
                )}
              </DialogContent>
            </Dialog>

            {/* Manual add */}
            <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Keyword
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add SEO Keyword</DialogTitle>
                  <DialogDescription>
                    Add a keyword manually to your library
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="keyword">Keyword *</Label>
                    <Input
                      id="keyword"
                      placeholder="e.g., homes for sale in Austin"
                      value={newKeyword}
                      onChange={(e) => setNewKeyword(e.target.value)}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Keyword Type</Label>
                      <Select value={keywordType} onValueChange={(v) => setKeywordType(v as typeof keywordType)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="primary">Primary</SelectItem>
                          <SelectItem value="secondary">Secondary</SelectItem>
                          <SelectItem value="long_tail">Long Tail</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Search Intent</Label>
                      <Select value={searchIntent} onValueChange={(v) => setSearchIntent(v as typeof searchIntent)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="informational">Informational</SelectItem>
                          <SelectItem value="transactional">Transactional</SelectItem>
                          <SelectItem value="navigational">Navigational</SelectItem>
                          <SelectItem value="commercial">Commercial</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="targetLocation">Target Location</Label>
                    <Input
                      id="targetLocation"
                      placeholder="e.g., Austin, TX"
                      value={targetLocation}
                      onChange={(e) => setTargetLocation(e.target.value)}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="searchVolume">Search Volume</Label>
                      <Input
                        id="searchVolume"
                        type="number"
                        placeholder="e.g., 1000"
                        value={searchVolume}
                        onChange={(e) => setSearchVolume(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="competition">Competition (0-1)</Label>
                      <Input
                        id="competition"
                        type="number"
                        step="0.01"
                        min="0"
                        max="1"
                        placeholder="e.g., 0.65"
                        value={competition}
                        onChange={(e) => setCompetition(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="difficultyScore">Difficulty (0-100)</Label>
                      <Input
                        id="difficultyScore"
                        type="number"
                        min="0"
                        max="100"
                        placeholder="e.g., 45"
                        value={difficultyScore}
                        onChange={(e) => setDifficultyScore(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="priorityScore">Priority (0-100)</Label>
                      <Input
                        id="priorityScore"
                        type="number"
                        min="0"
                        max="100"
                        placeholder="e.g., 80"
                        value={priorityScore}
                        onChange={(e) => setPriorityScore(e.target.value)}
                      />
                    </div>
                  </div>

                  {addError && <p className="text-sm text-destructive">{addError}</p>}
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                  <Button onClick={handleAddKeyword} disabled={isAdding}>
                    {isAdding ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Adding...</>
                    ) : (
                      <><Plus className="h-4 w-4 mr-2" />Add Keyword</>
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-2xl font-bold">{keywords.length}</p>
                  <p className="text-xs text-muted-foreground">Total Keywords</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-green-600" />
                <div>
                  <p className="text-2xl font-bold">{keywords.filter((k) => k.is_active).length}</p>
                  <p className="text-xs text-muted-foreground">Active</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-blue-600" />
                <div>
                  <p className="text-2xl font-bold">{keywords.filter((k) => k.keyword_type === "primary").length}</p>
                  <p className="text-xs text-muted-foreground">Primary</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-purple-600" />
                <div>
                  <p className="text-2xl font-bold">{keywords.filter((k) => k.keyword_type === "long_tail").length}</p>
                  <p className="text-xs text-muted-foreground">Long Tail</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search keywords..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="primary">Primary</SelectItem>
                <SelectItem value="secondary">Secondary</SelectItem>
                <SelectItem value="long_tail">Long Tail</SelectItem>
              </SelectContent>
            </Select>
            <Select value={intentFilter} onValueChange={setIntentFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Intent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Intents</SelectItem>
                <SelectItem value="informational">Informational</SelectItem>
                <SelectItem value="transactional">Transactional</SelectItem>
                <SelectItem value="navigational">Navigational</SelectItem>
                <SelectItem value="commercial">Commercial</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => void refreshKeywords()} disabled={isRefreshing}>
              {isRefreshing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          </div>
        </div>

        {/* A refused re-read leaves the previous rows on screen — say so, rather
            than letting a stale list read as current. */}
        {refreshError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{refreshError} — the keywords below are the last list that loaded successfully.</span>
          </div>
        )}

        {/* Keywords Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Keyword</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Intent</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                  <TableHead className="text-right">Difficulty</TableHead>
                  <TableHead className="text-right">Priority</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredKeywords.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12">
                      <div className="flex flex-col items-center gap-3">
                        <Target className="h-10 w-10 text-muted-foreground" />
                        <p className="text-muted-foreground font-medium">No keywords found</p>
                        {!searchQuery && typeFilter === "all" && intentFilter === "all" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setIsDiscoverOpen(true)}
                          >
                            <Sparkles className="h-4 w-4 mr-2" />
                            Discover keywords with AI
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredKeywords.map((kw) => (
                    <TableRow key={kw.id}>
                      <TableCell className="font-medium">{kw.keyword}</TableCell>
                      <TableCell>
                        <Badge className={keywordTypeColors[kw.keyword_type] || ""}>
                          {kw.keyword_type.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={intentColors[kw.search_intent] || ""}>
                          {kw.search_intent}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {kw.search_volume?.toLocaleString() || "--"}
                      </TableCell>
                      <TableCell className="text-right">
                        <DifficultyBadge score={kw.difficulty_score} />
                      </TableCell>
                      <TableCell className="text-right">
                        {kw.priority_score !== null ? (
                          <span className="font-medium">{kw.priority_score}</span>
                        ) : "--"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={kw.is_active}
                          onCheckedChange={() => handleToggleActive(kw.id, kw.is_active)}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleGenerateBlog(kw)}
                          title="Generate blog post from this keyword"
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
