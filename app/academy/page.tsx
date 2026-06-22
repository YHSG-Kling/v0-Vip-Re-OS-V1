"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Search, Star, Play, FileText, BookOpen, ThumbsUp, TrendingUp, Copy, Route, Brain } from "lucide-react"
import {
  getAcademyContent,
  getMarketplaceTemplates,
  cloneTemplate,
  getTopContributors,
} from "@/app/actions/academy"
import { generateLearningPath } from "@/app/actions/ai-training-coaching"
import { getAgentPointsAndTier } from "@/app/actions/gamification"
import { getAcademyViewer, getFeaturedModule } from "@/app/actions/academy-learning"
import { useRouter } from "next/navigation"
import { useToast } from "@/hooks/use-toast"
import {
  AcademyCommandStrip,
  LearningPathPanel,
  ReadinessRadar,
  TrainingProgressPanel,
  AiTutorPanel,
  EmbeddedLeaderboardWidget,
} from "./components/os"

export default function AcademyPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [academyContent, setAcademyContent] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [contributors, setContributors] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()
  const router = useRouter()

  // OS State — identity resolved from the auth context (never a placeholder id).
  const [agentId, setAgentId] = useState("")
  const [brokerageId, setBrokerageId] = useState("")
  const [agentName, setAgentName] = useState("Agent")
  const [featured, setFeatured] = useState<{ id: string; title: string; summary: string | null; estimatedMinutes: number | null; hasQuiz: boolean } | null>(null)
  const [currentPoints, setCurrentPoints] = useState<number | undefined>(undefined)
  const [currentTier, setCurrentTier] = useState<string | undefined>(undefined)
  const [generatingPath, setGeneratingPath] = useState(false)
  const [completedContent, _setCompletedContent] = useState<any[]>([])
  const [inProgressContent, _setInProgressContent] = useState<any[]>([])

  useEffect(() => {
    loadViewer()
  }, [])

  useEffect(() => {
    loadData()
  }, [searchQuery])

  async function loadViewer() {
    try {
      const viewer = await getAcademyViewer()
      if (viewer) {
        setAgentId(viewer.agentId)
        setBrokerageId(viewer.brokerageId)
        setAgentName(viewer.agentName)
        if (viewer.agentId) {
          try {
            const data = await getAgentPointsAndTier(viewer.agentId)
            if (data) {
              setCurrentPoints(data.points)
              setCurrentTier(data.currentTier)
            }
          } catch (error) {
            console.error("Error loading gamification data:", error)
          }
        }
      }
      setFeatured(await getFeaturedModule())
    } catch (error) {
      console.error("Error loading academy viewer:", error)
    }
  }

  async function handleGenerateLearningPath() {
    setGeneratingPath(true)
    try {
      await generateLearningPath({
        agentId,
        focusAreas: ["buyer_conversion", "communication"],
        experienceLevel: "intermediate",
      })
      toast({
        title: "Learning Path Generated",
        description: "Check the My Path tab to see your personalized learning path.",
      })
    } catch (error) {
      console.error("Error generating learning path:", error)
    } finally {
      setGeneratingPath(false)
    }
  }

  async function loadData() {
    setLoading(true)
    const [content, marketplace, topContributors] = await Promise.all([
      getAcademyContent({ searchQuery }),
      getMarketplaceTemplates({ searchQuery }),
      getTopContributors(),
    ])
    setAcademyContent(content)
    setTemplates(marketplace)
    setContributors(topContributors)
    setLoading(false)
  }

  async function handleCloneTemplate(templateId: string) {
    const result = await cloneTemplate(templateId)
    if (result.error) {
      toast({
        title: "Error",
        description: result.error,
        variant: "destructive",
      })
    } else {
      toast({
        title: "Success",
        description: "Template cloned successfully! Check your playbooks.",
      })
      loadData()
    }
  }

  return (
    <div className="container mx-auto py-8">
      {/* OS Command Strip */}
      <AcademyCommandStrip
        agentName={agentName}
        completedCount={completedContent.length}
        totalContent={academyContent.length}
        currentPoints={currentPoints}
        currentTier={currentTier}
        onGenerateLearningPath={handleGenerateLearningPath}
        generating={generatingPath}
      />

      <div className="mb-6 relative">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search for SOPs, videos, templates..."
          className="pl-10"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-3">
          <Tabs defaultValue="learning" className="space-y-4">
            <TabsList>
              <TabsTrigger value="learning">Learning Center</TabsTrigger>
              <TabsTrigger value="marketplace">Template Marketplace</TabsTrigger>
              <TabsTrigger value="community">Community</TabsTrigger>
              <TabsTrigger value="mypath" className="gap-1">
                <Route className="h-4 w-4" />
                My Path
              </TabsTrigger>
              <TabsTrigger value="tutor" className="gap-1">
                <Brain className="h-4 w-4" />
                AI Tutor
              </TabsTrigger>
            </TabsList>

        {/* Learning Center Tab */}
        <TabsContent value="learning" className="space-y-6">
          {/* Featured Section — real top-priority published module */}
          {featured && (
            <Card>
              <CardHeader>
                <CardTitle>Featured Module</CardTitle>
                <CardDescription>Your brokerage's top learning pick</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-6">
                  <div className="w-48 h-32 bg-muted rounded-lg flex items-center justify-center">
                    <BookOpen className="h-12 w-12" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold mb-2">{featured.title}</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      {featured.summary || "Open this module to start learning."}
                      {featured.estimatedMinutes ? ` • ~${featured.estimatedMinutes} min` : ""}
                      {featured.hasQuiz ? " • includes a knowledge check" : ""}
                    </p>
                    <Button onClick={() => router.push(`/academy/module/${featured.id}`)}>Start Learning</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Resource Categories */}
          <div className="grid md:grid-cols-3 gap-4">
            <CategoryCard
              icon={FileText}
              title="SOPs & Guides"
              count={academyContent.filter((c) => c.type === "sop").length}
              description="Step-by-step procedures"
            />
            <CategoryCard
              icon={Play}
              title="Video Training"
              count={academyContent.filter((c) => c.type === "loom_link").length}
              description="Watch and learn"
            />
            <CategoryCard
              icon={BookOpen}
              title="Scripts & Templates"
              count={academyContent.filter((c) => c.type === "case_study").length}
              description="Ready-to-use content"
            />
          </div>

          {/* Education Videos CTA */}
          <div
            className="flex items-center justify-between p-4 border rounded-xl bg-muted/50 hover:bg-muted transition-colors cursor-pointer"
            onClick={() => window.location.href = "/dashboard/videos/education"}
          >
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Play className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold">Education Videos</p>
                <p className="text-sm text-muted-foreground">Ready-made buyer &amp; seller education videos with AI narration</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={(e: React.MouseEvent) => { e.stopPropagation(); window.location.href = "/dashboard/videos/education" }}>
              Browse Videos
            </Button>
          </div>

          <div className="space-y-3">
            <h3 className="text-lg font-semibold">Popular Resources</h3>
            {loading ? (
              <p className="text-muted-foreground">Loading...</p>
            ) : academyContent.length === 0 ? (
              <p className="text-muted-foreground">No resources found</p>
            ) : (
              academyContent
                .slice(0, 10)
                .map((content) => (
                  <ResourceCard
                    key={content.id}
                    type={content.type}
                    title={content.title}
                    author={content.created_by_name || "System"}
                    views={content.view_count}
                    estimatedMinutes={content.estimated_minutes}
                    contentId={content.id}
                    onOpen={() => router.push(`/academy/module/${content.id}`)}
                  />
                ))
            )}
          </div>
        </TabsContent>

        {/* Template Marketplace Tab */}
        <TabsContent value="marketplace" className="space-y-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold">Browse Templates</h3>
              <p className="text-sm text-muted-foreground">Clone and customize proven workflows</p>
            </div>
            <Button>
              <TrendingUp className="mr-2 h-4 w-4" />
              My Templates
            </Button>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {loading ? (
              <p className="text-muted-foreground col-span-full">Loading templates...</p>
            ) : templates.length === 0 ? (
              <p className="text-muted-foreground col-span-full">No templates found</p>
            ) : (
              templates.map((template) => (
                <TemplateCard key={template.id} template={template} onClone={() => handleCloneTemplate(template.id)} />
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="community" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Top Contributors This Month</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {contributors.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No contributors yet — publish a learning module to appear here.
                </p>
              ) : (
                contributors
                  .slice(0, 5)
                  .map((contributor) => (
                    <ContributorCard
                      key={contributor.user_id}
                      name={contributor.full_name || "Anonymous"}
                      contributions={contributor.module_count || 0}
                      upvotes={contributor.total_views || 0}
                      avatar="/placeholder.svg?height=40&width=40"
                    />
                  ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Feedback</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground py-4 text-center">
                No template feedback yet — clone a template and leave a review to get the conversation started.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* My Path Tab */}
        <TabsContent value="mypath" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <LearningPathPanel agentId={agentId} experienceLevel="intermediate" />
            <div className="space-y-6">
              <ReadinessRadar agentId={agentId} />
              <TrainingProgressPanel
                completedContent={completedContent}
                inProgressContent={inProgressContent}
                totalAvailable={academyContent.length}
              />
            </div>
          </div>
        </TabsContent>

        {/* AI Tutor Tab */}
        <TabsContent value="tutor">
          <AiTutorPanel agentId={agentId} brokerageId={brokerageId} />
        </TabsContent>
      </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <EmbeddedLeaderboardWidget agentId={agentId} />
        </div>
      </div>
    </div>
  )
}

// Component: Category Card
function CategoryCard({ icon: Icon, title, count, description }: any) {
  return (
    <Card className="cursor-pointer hover:shadow-md transition-shadow">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-semibold">{title}</h3>
            <p className="text-sm text-muted-foreground">{count} resources</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

// Component: Resource Card — opens the in-app module reader (records the view server-side)
function ResourceCard({ type, title, author, views, estimatedMinutes, onOpen }: any) {
  const icons: any = {
    video: Play,
    loom_link: Play,
    sop: FileText,
    case_study: BookOpen,
    playbook_breakdown: BookOpen,
    article: BookOpen,
  }
  const Icon = icons[type] || FileText

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-muted rounded-lg">
            <Icon className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-medium truncate">{title}</h4>
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
              <span>by {author}</span>
              {estimatedMinutes ? <span>• ~{estimatedMinutes} min</span> : null}
              {views ? <span>• {views.toLocaleString()} views</span> : null}
            </div>
          </div>
          <Button size="sm" onClick={onOpen}>
            Open
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// Component: Template Card
function TemplateCard({ template, onClone }: any) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-lg">{template.name}</CardTitle>
        <CardDescription>{template.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <div className="flex items-center gap-2 mb-3">
          <Avatar className="h-6 w-6">
            <AvatarFallback>{template.creator_name?.[0] || "S"}</AvatarFallback>
          </Avatar>
          <span className="text-sm text-muted-foreground">{template.creator_name || "System"}</span>
        </div>
        <div className="flex flex-wrap gap-1 mb-3">
          {template.tags?.slice(0, 3).map((tag: string) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{template.clone_count || 0} uses</span>
          <div className="flex items-center gap-1">
            <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
            <span>{template.average_rating?.toFixed(1) || "N/A"}</span>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between">
        <span className="font-bold text-lg">{template.price || "Free"}</span>
        <Button size="sm" onClick={onClone}>
          <Copy className="mr-2 h-3 w-3" />
          Clone Template
        </Button>
      </CardFooter>
    </Card>
  )
}

// Component: Contributor Card
function ContributorCard({ name, contributions, upvotes, avatar }: any) {
  return (
    <div className="flex items-center justify-between p-3 border rounded-lg">
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarImage src={avatar || "/placeholder.svg"} />
          <AvatarFallback>{name[0]}</AvatarFallback>
        </Avatar>
        <div>
          <p className="font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">{contributions} contributions</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <ThumbsUp className="h-4 w-4" />
        <span className="font-medium">{upvotes}</span>
      </div>
    </div>
  )
}

