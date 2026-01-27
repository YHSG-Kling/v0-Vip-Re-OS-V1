"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Search, Star, Play, FileText, BookOpen, ThumbsUp, TrendingUp, Copy } from "lucide-react"
import {
  getAcademyContent,
  getMarketplaceTemplates,
  cloneTemplate,
  incrementViewCount,
  getTopContributors,
} from "@/app/actions/academy"
import { useToast } from "@/hooks/use-toast"

export default function AcademyPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [academyContent, setAcademyContent] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [contributors, setContributors] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  useEffect(() => {
    loadData()
  }, [searchQuery])

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
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Academy & Marketplace</h1>
        <p className="text-muted-foreground">Learn, share, and grow your skills</p>
      </div>

      <div className="mb-6 relative">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search for SOPs, videos, templates..."
          className="pl-10"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <Tabs defaultValue="learning" className="space-y-4">
        <TabsList>
          <TabsTrigger value="learning">Learning Center</TabsTrigger>
          <TabsTrigger value="marketplace">Template Marketplace</TabsTrigger>
          <TabsTrigger value="community">Community</TabsTrigger>
        </TabsList>

        {/* Learning Center Tab */}
        <TabsContent value="learning" className="space-y-6">
          {/* Featured Section */}
          <Card>
            <CardHeader>
              <CardTitle>Featured Course</CardTitle>
              <CardDescription>Master the "Them First" approach</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-6">
                <div className="w-48 h-32 bg-muted rounded-lg flex items-center justify-center">
                  <Play className="h-12 w-12" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold mb-2">Empathy-First Communication Mastery</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Learn how to build trust and close more deals by leading with feelings, not solutions. 12 video
                    lessons, 3 hours total.
                  </p>
                  <Button>Start Learning</Button>
                </div>
              </div>
            </CardContent>
          </Card>

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
                    downloads={content.downloads || 0}
                    rating={content.rating || 4.5}
                    duration={content.duration || ""}
                    videoUrl={content.video_url}
                    contentId={content.id}
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
                <>
                  <ContributorCard
                    name="Sarah Johnson"
                    contributions={12}
                    upvotes={456}
                    avatar="/placeholder.svg?height=40&width=40"
                  />
                  <ContributorCard
                    name="Mike Chen"
                    contributions={8}
                    upvotes={389}
                    avatar="/placeholder.svg?height=40&width=40"
                  />
                  <ContributorCard
                    name="Lisa Park"
                    contributions={6}
                    upvotes={267}
                    avatar="/placeholder.svg?height=40&width=40"
                  />
                </>
              ) : (
                contributors
                  .slice(0, 5)
                  .map((contributor) => (
                    <ContributorCard
                      key={contributor.id}
                      name={contributor.name || "Anonymous"}
                      contributions={contributor.contribution_count || 0}
                      upvotes={contributor.upvotes || 0}
                      avatar={contributor.avatar_url || "/placeholder.svg?height=40&width=40"}
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
              <FeedbackCard
                author="Tom Wilson"
                resource="Listing Launch Playbook"
                comment="This template saved me hours! The pre-listing checklist is gold."
                rating={5}
                date="2 days ago"
              />
              <FeedbackCard
                author="Emily Davis"
                resource="Objection Handling Video"
                comment="The empathy approach really works. Closed 3 deals using these techniques."
                rating={5}
                date="5 days ago"
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
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

// Component: Resource Card
function ResourceCard({ type, title, author, views, downloads, rating, duration, videoUrl, contentId }: any) {
  const icons: any = {
    video: Play,
    loom_link: Play,
    sop: FileText,
    case_study: BookOpen,
    playbook_breakdown: BookOpen,
  }
  const Icon = icons[type] || FileText

  const handleView = async () => {
    await incrementViewCount(contentId)
    if (videoUrl) {
      window.open(videoUrl, "_blank")
    }
  }

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
              {duration && <span>• {duration}</span>}
              {views && <span>• {views.toLocaleString()} views</span>}
              {downloads > 0 && <span>• {downloads} downloads</span>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />
            <span className="font-medium">{rating.toFixed(1)}</span>
          </div>
          <Button size="sm" onClick={handleView}>
            {type === "video" || type === "loom_link" ? "Watch" : "Download"}
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

// Component: Feedback Card
function FeedbackCard({ author, resource, comment, rating, date }: any) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Avatar className="h-8 w-8">
            <AvatarFallback>{author[0]}</AvatarFallback>
          </Avatar>
          <div>
            <p className="font-medium text-sm">{author}</p>
            <p className="text-xs text-muted-foreground">on {resource}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {[...Array(rating)].map((_, i) => (
            <Star key={i} className="h-3 w-3 fill-yellow-500 text-yellow-500" />
          ))}
        </div>
      </div>
      <p className="text-sm">{comment}</p>
      <p className="text-xs text-muted-foreground">{date}</p>
    </div>
  )
}
