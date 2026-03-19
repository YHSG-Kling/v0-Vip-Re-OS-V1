"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import {
  Search,
  Plus,
  TrendingUp,
  FileText,
  Loader2,
  Target,
  BarChart3,
  Filter,
} from "lucide-react"
import { addSeoKeyword, toggleKeywordActive } from "@/app/actions/blog"

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
}

const keywordTypeColors: Record<string, string> = {
  primary: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  secondary: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  long_tail: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
}

const intentColors: Record<string, string> = {
  informational: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  transactional: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  navigational: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  commercial: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
}

function DifficultyBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">--</span>

  const getColor = () => {
    if (score <= 30) return "text-green-600 dark:text-green-400"
    if (score <= 60) return "text-amber-600 dark:text-amber-400"
    return "text-red-600 dark:text-red-400"
  }

  const getLabel = () => {
    if (score <= 30) return "Easy"
    if (score <= 60) return "Medium"
    return "Hard"
  }

  return (
    <div className={`flex items-center gap-1 ${getColor()}`}>
      <span className="font-medium">{score}</span>
      <span className="text-xs">({getLabel()})</span>
    </div>
  )
}

export function SeoKeywordsDashboardClient({
  userId,
  brokerageId,
  initialKeywords,
}: SeoKeywordsDashboardClientProps) {
  const router = useRouter()
  const [keywords, setKeywords] = useState<Keyword[]>(initialKeywords)
  const [searchQuery, setSearchQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [intentFilter, setIntentFilter] = useState<string>("all")
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Add form state
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

  // Filter keywords
  const filteredKeywords = keywords.filter((kw) => {
    const matchesSearch = kw.keyword.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesType = typeFilter === "all" || kw.keyword_type === typeFilter
    const matchesIntent = intentFilter === "all" || kw.search_intent === intentFilter
    return matchesSearch && matchesType && matchesIntent
  })

  const handleAddKeyword = async () => {
    if (!newKeyword.trim()) {
      setAddError("Keyword is required")
      return
    }

    setIsAdding(true)
    setAddError(null)

    try {
      const result = await addSeoKeyword(userId, {
        brokerageId,
        keyword: newKeyword.trim(),
        keywordType,
        searchIntent,
        targetLocation: targetLocation || undefined,
        searchVolume: searchVolume ? parseInt(searchVolume) : undefined,
        competition: competition ? parseFloat(competition) : undefined,
        difficultyScore: difficultyScore ? parseInt(difficultyScore) : undefined,
        priorityScore: priorityScore ? parseInt(priorityScore) : undefined,
      })

      if (result.success && result.keywordId) {
        // Add to local state
        setKeywords((prev) => [
          {
            id: result.keywordId!,
            keyword: newKeyword.trim(),
            keyword_type: keywordType,
            search_intent: searchIntent,
            target_location: targetLocation || null,
            search_volume: searchVolume ? parseInt(searchVolume) : null,
            competition: competition ? parseFloat(competition) : null,
            difficulty_score: difficultyScore ? parseInt(difficultyScore) : null,
            priority_score: priorityScore ? parseInt(priorityScore) : null,
            is_active: true,
            created_at: new Date().toISOString(),
          },
          ...prev,
        ])

        // Reset form
        setNewKeyword("")
        setKeywordType("primary")
        setSearchIntent("informational")
        setTargetLocation("")
        setSearchVolume("")
        setCompetition("")
        setDifficultyScore("")
        setPriorityScore("")
        setIsAddOpen(false)
      } else {
        setAddError(result.error || "Failed to add keyword")
      }
    } catch (err) {
      console.error("[SeoKeywords] Add error:", err)
      setAddError("An unexpected error occurred")
    } finally {
      setIsAdding(false)
    }
  }

  const handleToggleActive = async (keywordId: string, currentState: boolean) => {
    const newState = !currentState

    // Optimistic update
    setKeywords((prev) =>
      prev.map((kw) => (kw.id === keywordId ? { ...kw, is_active: newState } : kw))
    )

    const result = await toggleKeywordActive(keywordId, newState)

    if (!result.success) {
      // Revert on failure
      setKeywords((prev) =>
        prev.map((kw) => (kw.id === keywordId ? { ...kw, is_active: currentState } : kw))
      )
    }
  }

  const handleGenerateBlog = (keyword: Keyword) => {
    // Navigate to blog page with keyword pre-selected
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
              Manage your keyword library for blog optimization
            </p>
          </div>
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
                  Add a new keyword to your library for blog optimization
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
                    <Select
                      value={keywordType}
                      onValueChange={(v) => setKeywordType(v as typeof keywordType)}
                    >
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
                    <Select
                      value={searchIntent}
                      onValueChange={(v) => setSearchIntent(v as typeof searchIntent)}
                    >
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
                <Button variant="outline" onClick={() => setIsAddOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAddKeyword} disabled={isAdding}>
                  {isAdding ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Adding...
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Keyword
                    </>
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
                  <p className="text-2xl font-bold">
                    {keywords.filter((k) => k.is_active).length}
                  </p>
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
                  <p className="text-2xl font-bold">
                    {keywords.filter((k) => k.keyword_type === "primary").length}
                  </p>
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
                  <p className="text-2xl font-bold">
                    {keywords.filter((k) => k.keyword_type === "long_tail").length}
                  </p>
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
            <Filter className="h-4 w-4 text-muted-foreground" />
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
          </div>
        </div>

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
                    <TableCell colSpan={8} className="text-center py-8">
                      <div className="flex flex-col items-center">
                        <Target className="h-10 w-10 text-muted-foreground mb-2" />
                        <p className="text-muted-foreground">No keywords found</p>
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
                        ) : (
                          "--"
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={kw.is_active}
                          onCheckedChange={() => handleToggleActive(kw.id, kw.is_active)}
                        />
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => handleGenerateBlog(kw)}>
                          <FileText className="h-4 w-4 mr-1" />
                          Generate Blog
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
