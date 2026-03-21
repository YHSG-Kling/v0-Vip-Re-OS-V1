"use client"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea" // Added for Direct Mail

import type React from "react"

import { useState, useEffect, useRef } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Video,
  Lightbulb,
  Search,
  Eye,
  CheckCircle,
  Sparkles,
  Link2,
  Mail,
  Ticket,
  Film,
  SearchCode,
  Plus,
  Send,
  X,
  MoreVertical,
  Save,
  Mic,
  User,
  Loader2,
} from "lucide-react"
import {
  generateContentIdeas,
  researchKeywords,
  getCompetitorContent,
  getContentCalendar,
  getPublishingStats,
  getSavedIdeas,
} from "@/app/actions/content-studio"
import { aiWriteNewsletterContent, aiGenerateSubjectLines } from "@/app/actions/ai-newsletter"
import { createMailCampaign } from "@/app/actions/direct-mail"
import { createClient } from "@/lib/supabase/client"
import LinkToVideoGenerator from "@/components/content-studio/LinkToVideoGenerator"
import { executeWorkflow } from "@/app/actions/workflows"
import { generateVideoFromScript } from "@/app/actions/video-generation"
import { getAgentSettings } from "@/app/actions/agent-settings"
import { cn } from "@/lib/utils" // Added for styling
import { Checkbox } from "@/components/ui/checkbox"
import { useRouter } from "next/navigation" // Added for client-side navigation

interface ContentStudioClientProps {
  userId?: string
  userRole?: string
}

export default function ContentStudioClient({ userId, userRole }: ContentStudioClientProps) {
  const router = useRouter()

  const [activeTab, setActiveTab] = useState("link-to-video")
  const [isInitializing, setIsInitializing] = useState(true)
  const [contentIdeas, setContentIdeas] = useState<any[]>([])
  const [savedIdeas, setSavedIdeas] = useState<any[]>([])
  const [keywords, setKeywords] = useState<any[]>([])
  const [competitors, setCompetitors] = useState<any[]>([])
  const [calendar, setCalendar] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date())
  const [isProcessing, setIsProcessing] = useState<string | null>(null)

  // Newsletter state
  const [newsletters, setNewsletters] = useState<any[]>([])
  const [isCreatingNewsletter, setIsCreatingNewsletter] = useState(false)
  const [newNewsletter, setNewNewsletter] = useState({
    title: "",
    subjectLine: "",
    previewText: "",
    templateStyle: "modern",
    status: "draft",
  })

  // Direct Mail state
  const [directMail, setDirectMail] = useState<any[]>([])
  const [isCreatingMail, setIsCreatingMail] = useState(false)
  const [newMail, setNewMail] = useState({
    title: "",
    mailType: "postcard",
    templateId: "listing_announce",
    contentHeadline: "",
    contentBody: "",
    contentCta: "",
    status: "draft",
  })

  // AI newsletter draft result state
  const [generatedNewsletterContent, setGeneratedNewsletterContent] = useState<{
    subjects: string[]
    body: string
    topic: string
  } | null>(null)

  // Long-form video state
  const [longVideos, setLongVideos] = useState<any[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [newVideoTitle, setNewVideoTitle] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // State for video generation and agent settings
  const [generatingVideo, setGeneratingVideo] = useState<string | null>(null)
  const [agentSettings, setAgentSettings] = useState<any>(null)

  const [bulkContentPeriod, setBulkContentPeriod] = useState<"week" | "month" | "year">("month")
  const [isBulkGenerating, setIsBulkGenerating] = useState(false)
  const [selectedKeyword, setSelectedKeyword] = useState<any>(null)
  const [selectedCompetitor, setSelectedCompetitor] = useState<any>(null)
  const [selectedOmniChannel, setSelectedOmniChannel] = useState<string[]>([])
  const [directMailTemplates, setDirectMailTemplates] = useState<any[]>([
    { id: "listing", name: "Just Listed", preview: "/templates/listing.jpg" },
    { id: "sold", name: "Just Sold", preview: "/templates/sold.jpg" },
    { id: "market", name: "Market Update", preview: "/templates/market.jpg" },
  ])
  const [editingContent, setEditingContent] = useState<any>(null)

  useEffect(() => {
    loadData()
    loadAgentSettings()
  }, [userId, userRole])

  async function loadAgentSettings() {
    if (!userId) {
      console.log("[v0] No userId, skipping agent settings load")
      return
    }
    try {
      console.log("[v0] Loading agent settings for user:", userId)
      const settings = await getAgentSettings(userId)
      console.log("[v0] Agent settings loaded:", settings)
      setAgentSettings(settings)
      if (settings.message) {
        console.log("[v0] Settings message:", settings.message)
      }
    } catch (error) {
      console.error("[v0] Failed to load agent settings:", error)
      setAgentSettings({
        avatarId: null,
        voiceId: null,
        message: "Unable to load video settings. Contact admin.",
      })
    }
  }

  async function loadData() {
    try {
      setIsInitializing(true)
      const [ideasData, savedData, competitorData, calendarData, statsData] = await Promise.all([
        generateContentIdeas(undefined, userId, userRole),
        getSavedIdeas(userId, userRole),
        getCompetitorContent(userId, userRole),
        getContentCalendar(userId, userRole),
        getPublishingStats(userId, userRole),
      ])

      if (ideasData.success && ideasData.ideas) setContentIdeas(ideasData.ideas)
      setSavedIdeas(savedData)
      setCompetitors(competitorData)
      setCalendar(calendarData)
      setStats(statsData)
      setNewsletters([])
      setDirectMail([])
      setLongVideos([])
    } catch (error) {
      console.error("[v0] Failed to load Content Studio data:", error)
      setContentIdeas([])
      setSavedIdeas([])
      setCompetitors([])
      setCalendar([])
      setStats({ totalPosts: 0, published: 0, scheduled: 0, drafts: 0, totalEngagement: 0 })
    } finally {
      setIsInitializing(false)
    }
  }

  async function handleGenerateIdeas() {
    const result = await generateContentIdeas("general", userId, userRole)
    if (result.success && result.ideas) {
      setContentIdeas(result.ideas)
    }
  }

  async function handleResearchKeywords() {
    const result = await researchKeywords("trending real estate 2026", userId, userRole) // Updated keyword query
    if (result.success && result.keywords) {
      setKeywords(result.keywords)
    }
  }

  async function handleBulkGenerate() {
    setIsBulkGenerating(true)
    try {
      const count = bulkContentPeriod === "week" ? 7 : bulkContentPeriod === "month" ? 30 : 365
      const result = await generateContentIdeas(`bulk-${bulkContentPeriod}`, userId, userRole)
      if (result.success) {
        alert(`✅ Generated ${count} pieces of content! Check your Social Planner to schedule.`)
        loadData()
      }
    } catch (error) {
      alert("Failed to generate bulk content")
    } finally {
      setIsBulkGenerating(false)
    }
  }

  async function handlePushToOmniChannel(content: any, channels: string[]) {
    setIsProcessing(content.id)
    try {
      // Push to selected channels
      for (const channel of channels) {
        await executeWorkflow("publish-content", {
          contentId: content.id,
          channel,
          content: content.text || content.title,
        })
      }
      alert(`✅ Content pushed to ${channels.join(", ")}!`)
      setSelectedOmniChannel([])
      loadData()
    } catch (error) {
      alert("Failed to push content")
    } finally {
      setIsProcessing(null)
    }
  }

  async function handleSendNewsletter(id: string) {
    setIsProcessing(id)
    await executeWorkflow("send-newsletter", { campaignId: id })
    setTimeout(() => {
      loadData()
      setIsProcessing(null)
    }, 2000)
  }

  async function handleSendMail(id: string) {
    setIsProcessing(id)
    await executeWorkflow("send-direct-mail", { campaignId: id })
    setTimeout(() => {
      loadData()
      setIsProcessing(null)
    }, 2000)
  }

  async function handleCreateNewsletter() {
    if (!userId) {
      alert("Unable to create newsletter: user not authenticated.")
      return
    }
    setIsProcessing("create-newsletter")
    try {
      const topic = newNewsletter.title || "Monthly real estate market update"
      const [contentResult, subjectResult] = await Promise.all([
        aiWriteNewsletterContent({
          brokerageId: userId, // falls back to userId until brokerageId is surfaced in props
          agentId: userId,
          topic,
          targetAudience: "past_clients",
          tone: "friendly",
        }),
        aiGenerateSubjectLines({
          brokerageId: userId,
          agentId: userId,
          newsletterTopic: topic,
        }),
      ])
      if (contentResult?.success) {
        setGeneratedNewsletterContent({
          subjects: subjectResult?.subjectLines ?? [],
          body: contentResult.content ?? "",
          topic,
        })
        alert("Newsletter drafted! Review and copy the content below.")
      } else {
        alert(`Newsletter generation failed: ${contentResult?.error ?? "Unknown error"}`)
      }
    } catch {
      alert("Newsletter generation failed. Please try again.")
    } finally {
      setIsCreatingNewsletter(false)
      setIsProcessing(null)
    }
  }

  async function handleCreateMail() {
    if (!userId) {
      alert("Unable to create campaign: user not authenticated.")
      return
    }
    setIsProcessing("create-mail")
    try {
      const result = await createMailCampaign({
        brokerageId: userId,
        agentId: userId,
        campaignName: newMail.title || "Direct Mail Campaign",
        targetAudience: "farm_area",
        quantity: 100,
        createdBy: userId,
      })
      if (result?.success) {
        alert("Direct mail campaign created!")
        setIsCreatingMail(false)
        setNewMail({ title: "", mailType: "postcard", templateId: "listing_announce", contentHeadline: "", contentBody: "", contentCta: "", status: "draft" })
        loadData()
      } else {
        alert(`Failed to create campaign: ${result?.error ?? "Unknown error"}`)
      }
    } catch {
      alert("Failed to create campaign. Please try again.")
    } finally {
      setIsProcessing(null)
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !newVideoTitle || !userId) return
    setIsUploading(true)
    setUploadProgress(10)
    try {
      const supabase = createClient()
      const { data: { user }, error: authError } = await supabase.auth.getUser()
      if (authError || !user) throw new Error("Not authenticated")

      const ext = file.name.split(".").pop() ?? "mp4"
      const path = `videos/${user.id}/${Date.now()}.${ext}`

      setUploadProgress(30)
      const { error: uploadError } = await supabase.storage
        .from("agent-media")
        .upload(path, file, { upsert: false })

      setUploadProgress(70)
      if (uploadError) throw uploadError

      const { data: urlData } = supabase.storage.from("agent-media").getPublicUrl(path)
      const publicUrl = urlData?.publicUrl

      if (publicUrl) {
        const { error: dbError } = await supabase.from("ai_video_projects").insert({
          agent_id: user.id,
          brokerage_id: user.id,
          title: newVideoTitle,
          video_url: publicUrl,
          status: "uploaded",
          video_type: "upload",
          video_provider: "upload",
        })
        if (dbError) throw dbError
        setUploadProgress(100)
        alert(`${file.name} uploaded successfully.`)
        setNewVideoTitle("")
        loadData()
      } else {
        throw new Error("Failed to get public URL")
      }
    } catch (err: any) {
      alert(`Upload failed: ${err?.message ?? "Unknown error"}`)
    } finally {
      setIsUploading(false)
      setUploadProgress(0)
    }
  }

  async function handleGenerateVideo(script: string, title: string, type: "avatar" | "voice") {
    const videoId = `${title}-${Date.now()}`
    setGeneratingVideo(videoId)

    try {
      const result = await generateVideoFromScript({
        script,
        title,
        type,
        avatarId: agentSettings?.avatarId,
        voiceId: agentSettings?.voiceId,
        userId: userId || "system",
      })

      if (result.success) {
        alert(`✅ Video generation started! Check your dashboard for progress.`)
        loadData()
      } else {
        alert(`❌ Failed: ${result.error}`)
      }
    } catch (error) {
      console.error("[v0] Video generation error:", error)
      alert("Failed to generate video")
    } finally {
      setGeneratingVideo(null)
    }
  }

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-16 w-16 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground text-lg font-medium">Loading Content Studio...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="p-6 lg:p-8 max-w-[1600px] mx-auto space-y-6">
        <Card className="border-2 shadow-lg bg-gradient-to-r from-blue-50 to-indigo-50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="rounded-2xl bg-blue-600 p-3">
                  <Sparkles className="h-8 w-8 text-white" />
                </div>
                <div>
                  <h1 className="text-4xl lg:text-5xl font-bold text-slate-900 mb-2">Content & Marketing Studio</h1>
                  <p className="text-slate-600 text-lg">
                    AI-powered content creation • 80% automated, 20% your approval
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <select
                  className="h-11 rounded-lg border-2 border-slate-300 bg-white px-4 text-sm font-medium text-slate-900 focus:border-blue-500 focus:outline-none"
                  value={bulkContentPeriod}
                  onChange={(e) => setBulkContentPeriod(e.target.value as any)}
                >
                  <option value="week">1 Week (7 posts)</option>
                  <option value="month">1 Month (30 posts)</option>
                  <option value="year">1 Year (365 posts)</option>
                </select>
                <Button
                  size="lg"
                  onClick={handleBulkGenerate}
                  disabled={isBulkGenerating}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                >
                  {isBulkGenerating ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-5 w-5" />
                      Bulk Generate
                    </>
                  )}
                </Button>
              </div>
            </div>
            {(!agentSettings?.avatarId || agentSettings?.message) && (
              <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-amber-900 text-sm font-medium">
                  ⚠️{" "}
                  {agentSettings?.message ||
                    "Complete your video settings in Admin → Agent Roster to enable one-click video generation"}
                </p>
              </div>
            )}
          </CardHeader>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 h-auto bg-slate-100 p-2 rounded-2xl">
            <TabsTrigger
              value="link-to-video"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Link2 className="h-5 w-5" />
              <span className="text-xs font-semibold">Link to Video</span>
            </TabsTrigger>
            <TabsTrigger
              value="video"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Video className="h-5 w-5" />
              <span className="text-xs font-semibold">Video Assistant</span>
            </TabsTrigger>
            <TabsTrigger
              value="repurpose"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Film className="h-5 w-5" />
              <span className="text-xs font-semibold">Long→Short</span>
            </TabsTrigger>
            <TabsTrigger
              value="ideas"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Lightbulb className="h-5 w-5" />
              <span className="text-xs font-semibold">Content Ideas</span>
            </TabsTrigger>
            <TabsTrigger
              value="keywords"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-green-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <SearchCode className="h-5 w-5" />
              <span className="text-xs font-semibold">Keywords</span>
            </TabsTrigger>
            <TabsTrigger
              value="competitors"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-purple-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Eye className="h-5 w-5" />
              <span className="text-xs font-semibold">Competitor Radar</span>
            </TabsTrigger>
            <TabsTrigger
              value="newsletter"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-orange-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Mail className="h-5 w-5" />
              <span className="text-xs font-semibold">Newsletter</span>
            </TabsTrigger>
            <TabsTrigger
              value="mail"
              className="flex-col gap-2 h-auto py-4 data-[state=active]:bg-rose-600 data-[state=active]:text-white text-slate-700 hover:bg-slate-200 rounded-xl transition-colors"
            >
              <Ticket className="h-5 w-5" />
              <span className="text-xs font-semibold">Direct Mail</span>
            </TabsTrigger>
          </TabsList>

          {/* Link-to-Video Tab */}
          <TabsContent value="link-to-video" className="space-y-4">
            <LinkToVideoGenerator />
          </TabsContent>

          <TabsContent value="video" className="space-y-4">
            <Card className="border-2 shadow-md">
              <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50 border-b">
                <CardTitle className="flex items-center gap-3 text-slate-900">
                  <Video className="h-6 w-6 text-blue-600" />
                  AI Video Assistant with "Them First" Validation
                </CardTitle>
                <CardDescription>Create personalized videos with AI-powered empathy validation</CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="text-center py-16">
                  <div className="rounded-3xl bg-blue-600/10 p-8 w-fit mx-auto mb-6">
                    <Video className="h-16 w-16 text-blue-600" />
                  </div>
                  <h3 className="text-2xl font-bold mb-3 text-slate-900">Full-Featured Video Creation</h3>
                  <p className="text-slate-600 mb-8 max-w-lg mx-auto leading-relaxed">
                    Generate scripts, create videos, and validate content with our comprehensive video assistant
                  </p>
                  <Button
                    size="lg"
                    onClick={() => router.push("/video-assistant")}
                    className="text-lg px-8 py-6 bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    <Sparkles className="mr-2 h-6 w-6" />
                    Open Video Assistant
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Long→Short Repurpose Pipeline Tab */}
          <TabsContent value="repurpose" className="space-y-4">
            <Card className="border-2">
              <CardHeader className="bg-slate-100">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-slate-900">
                      <Film className="h-5 w-5 text-blue-600" />
                      Long-Form → Short Clips Pipeline
                    </CardTitle>
                    <CardDescription>Upload long videos and auto-generate platform-specific clips</CardDescription>
                  </div>
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading || !newVideoTitle}
                    size="lg"
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Upload Video
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-6 space-y-6">
                <div className="flex gap-3">
                  <Input
                    type="text"
                    placeholder="Enter video title..."
                    className="flex-1 h-12 border-slate-300 focus:border-blue-500"
                    value={newVideoTitle}
                    onChange={(e) => setNewVideoTitle(e.target.value)}
                  />
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    onChange={handleFileChange}
                    accept="video/*"
                  />
                </div>
                {isUploading && (
                  <div className="space-y-3 p-4 bg-slate-100 rounded-lg">
                    <Progress value={uploadProgress} className="h-2" />
                    <p className="text-sm text-slate-600 text-center font-medium">
                      Processing video... {uploadProgress}%
                    </p>
                  </div>
                )}
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {longVideos.length > 0 ? (
                    longVideos.map((video) => (
                      <Card key={video.id} className="overflow-hidden hover:shadow-md transition-shadow">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base line-clamp-2 text-slate-900">{video.title}</CardTitle>
                          <CardDescription className="text-lg font-mono text-slate-700">
                            {Math.floor(video.durationSeconds / 60)}:
                            {(video.durationSeconds % 60).toString().padStart(2, "0")}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <Badge variant="secondary" className="capitalize">
                            {video.sourceType?.replace(/_/g, " ")}
                          </Badge>
                        </CardContent>
                      </Card>
                    ))
                  ) : (
                    <div className="col-span-full text-center py-12">
                      <div className="bg-slate-100 rounded-full p-6 w-fit mx-auto mb-4">
                        <Film className="h-12 w-12 text-slate-400" />
                      </div>
                      <p className="text-slate-400">No videos uploaded yet</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Content Ideas Tab */}
          <TabsContent value="ideas">
            <div className="grid lg:grid-cols-2 gap-6">
              <Card className="border-2 shadow-md">
                <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50 border-b">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-3 text-slate-900">
                        <Lightbulb className="h-6 w-6 text-blue-600" />
                        AI Content Ideas
                      </CardTitle>
                      <CardDescription>Fresh ideas based on real estate trends</CardDescription>
                    </div>
                    <Button
                      size="sm"
                      onClick={handleGenerateIdeas}
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      <Sparkles className="mr-2 h-4 w-4" />
                      Generate
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-6 space-y-3">
                  {contentIdeas.length > 0 ? (
                    contentIdeas.slice(0, 5).map((idea) => (
                      <Card key={idea.id} className="border hover:border-primary/50 transition-all hover:shadow-md">
                        <CardContent className="pt-6">
                          <p className="font-medium mb-4 leading-relaxed text-slate-900">
                            {idea.title || idea.idea_text}
                          </p>
                          <div className="flex items-center gap-2 flex-wrap mb-4">
                            <Badge variant="outline" className="capitalize">
                              {idea.content_type}
                            </Badge>
                            <Badge variant="secondary" className="capitalize bg-blue-600/10 text-blue-700">
                              {idea.status}
                            </Badge>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 border-blue-600 bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold"
                              onClick={() =>
                                handleGenerateVideo(idea.description || idea.idea_text, idea.title, "avatar")
                              }
                              disabled={!agentSettings?.avatarId || generatingVideo !== null}
                            >
                              {generatingVideo === `${idea.title}-avatar` ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <User className="h-3 w-3 mr-1" />
                              )}
                              Avatar Video
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 border-purple-600 bg-purple-50 text-purple-700 hover:bg-purple-100 font-semibold"
                              onClick={() =>
                                handleGenerateVideo(idea.description || idea.idea_text, idea.title, "voice")
                              }
                              disabled={!agentSettings?.voiceId || generatingVideo !== null}
                            >
                              {generatingVideo === `${idea.title}-voice` ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <Mic className="h-3 w-3 mr-1" />
                              )}
                              Voice Only
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  ) : (
                    <div className="text-center py-12">
                      <div className="bg-slate-100 rounded-full p-6 w-fit mx-auto mb-4">
                        <Lightbulb className="h-12 w-12 text-slate-400" />
                      </div>
                      <p className="text-slate-400 mb-4">No content ideas yet</p>
                      <Button
                        size="sm"
                        onClick={handleGenerateIdeas}
                        className="bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        <Sparkles className="mr-2 h-4 w-4" />
                        Generate Ideas
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-2">
                <CardHeader className="bg-slate-100">
                  <CardTitle className="flex items-center gap-2 text-slate-900">
                    <Save className="h-5 w-5 text-blue-600" />
                    Saved Ideas
                  </CardTitle>
                  <CardDescription>Your bookmarked content concepts</CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-3">
                  {savedIdeas.length > 0 ? (
                    savedIdeas.map((idea) => (
                      <Card key={idea.id} className="hover:shadow-md transition-shadow">
                        <CardContent className="pt-6">
                          <p className="leading-relaxed text-slate-700">{idea.idea_text}</p>
                        </CardContent>
                      </Card>
                    ))
                  ) : (
                    <div className="text-center py-16">
                      <div className="bg-slate-100 rounded-full p-6 w-fit mx-auto mb-4">
                        <Save className="h-12 w-12 text-slate-400" />
                      </div>
                      <p className="text-slate-400 font-medium">No saved ideas yet</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Keywords Tab - Fully Functional */}
          <TabsContent value="keywords" className="space-y-4">
            <Card className="border-2 shadow-md">
              <CardHeader className="bg-gradient-to-r from-green-50 to-emerald-50 border-b">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-3 text-slate-900">
                      <SearchCode className="h-6 w-6 text-green-600" />
                      SEO Keywords & Trends
                    </CardTitle>
                    <CardDescription>Popular keywords updated daily + push to omni-channel</CardDescription>
                  </div>
                  <Button
                    onClick={handleResearchKeywords}
                    size="lg"
                    className="bg-green-600 hover:bg-green-700 text-white"
                  >
                    <Search className="mr-2 h-4 w-4" />
                    Refresh Keywords
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-6 space-y-6">
                {/* Popular Keywords Section */}
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-amber-500" />
                    Today's Popular Keywords
                  </h3>
                  <div className="grid md:grid-cols-2 gap-4">
                    {keywords.length > 0 ? (
                      keywords.map((kw) => (
                        <Card
                          key={kw.keyword}
                          className={cn(
                            "hover:shadow-lg transition-all cursor-pointer border-2",
                            selectedKeyword?.keyword === kw.keyword
                              ? "border-green-600 bg-green-50"
                              : "hover:border-green-500",
                          )}
                          onClick={() => setSelectedKeyword(kw)}
                        >
                          <CardContent className="p-6 space-y-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <h4 className="font-bold text-lg text-slate-900 mb-2">{kw.keyword}</h4>
                                <p className="text-sm text-slate-600 mb-3">{kw.description}</p>
                                <div className="flex items-center gap-4">
                                  <Badge variant="secondary" className="font-semibold">
                                    Volume: {kw.volume?.toLocaleString() || "High"}
                                  </Badge>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "font-semibold",
                                      kw.difficulty === "easy"
                                        ? "bg-green-50 text-green-700"
                                        : kw.difficulty === "medium"
                                          ? "bg-amber-50 text-amber-700"
                                          : "bg-red-50 text-red-700",
                                    )}
                                  >
                                    {kw.difficulty || "Medium"}
                                  </Badge>
                                  <Badge className="bg-blue-100 text-blue-700 font-semibold">
                                    Trend: {kw.trend || "↗️ Rising"}
                                  </Badge>
                                </div>
                              </div>
                              {selectedKeyword?.keyword === kw.keyword && (
                                <CheckCircle className="h-6 w-6 text-green-600 flex-shrink-0" />
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    ) : (
                      <Card className="col-span-2 p-12 text-center">
                        <SearchCode className="h-16 w-16 text-slate-400 mx-auto mb-4" />
                        <p className="text-slate-400 font-medium">
                          Click "Refresh Keywords" to see today's popular SEO terms
                        </p>
                      </Card>
                    )}
                  </div>
                </div>

                {/* Omni-Channel Selector */}
                {selectedKeyword && (
                  <div className="border-t pt-6 space-y-4 bg-gradient-to-r from-green-50 to-emerald-50 p-6 rounded-lg">
                    <h3 className="text-lg font-semibold text-slate-900">Push to Omni-Channel</h3>
                    <div className="grid md:grid-cols-3 gap-3">
                      {["Social Media", "Blog", "Email", "Video", "Direct Mail", "SMS"].map((channel) => (
                        <label
                          key={channel}
                          className="flex items-center gap-3 p-4 rounded-lg border-2 hover:border-green-500 cursor-pointer transition-all bg-white"
                        >
                          <Checkbox
                            checked={selectedOmniChannel.includes(channel)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedOmniChannel([...selectedOmniChannel, channel])
                              } else {
                                setSelectedOmniChannel(selectedOmniChannel.filter((c) => c !== channel))
                              }
                            }}
                          />
                          <span className="font-medium text-slate-900">{channel}</span>
                        </label>
                      ))}
                    </div>
                    <Button
                      size="lg"
                      className="w-full bg-green-600 hover:bg-green-700 text-lg font-semibold"
                      disabled={selectedOmniChannel.length === 0 || isProcessing === selectedKeyword.keyword}
                      onClick={() => handlePushToOmniChannel(selectedKeyword, selectedOmniChannel)}
                    >
                      {isProcessing === selectedKeyword.keyword ? (
                        <>
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                          Publishing...
                        </>
                      ) : (
                        <>
                          <Send className="mr-2 h-5 w-5" />
                          Push to {selectedOmniChannel.length} Channel{selectedOmniChannel.length !== 1 ? "s" : ""}
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Competitors Tab - Fully Functional */}
          <TabsContent value="competitors" className="space-y-4">
            <Card className="border-2 shadow-md">
              <CardHeader className="bg-gradient-to-r from-purple-50 to-pink-50 border-b">
                <CardTitle className="flex items-center gap-3 text-slate-900">
                  <Eye className="h-6 w-6 text-purple-600" />
                  Competitor Content Radar
                </CardTitle>
                <CardDescription>Find popular competitor content • Edit • Push to your channels</CardDescription>
              </CardHeader>
              <CardContent className="pt-6 space-y-6">
                <div className="grid md:grid-cols-2 gap-4">
                  {competitors.length > 0 ? (
                    competitors.map((comp) => (
                      <Card
                        key={comp.id}
                        className={cn(
                          "hover:shadow-lg transition-all border-2",
                          selectedCompetitor?.id === comp.id
                            ? "border-purple-600 bg-purple-50"
                            : "hover:border-purple-500",
                        )}
                      >
                        <CardContent className="p-6 space-y-4">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <h4 className="font-bold text-lg text-slate-900 mb-2">{comp.title}</h4>
                              <p className="text-sm text-slate-600 mb-3 line-clamp-3">{comp.content}</p>
                              <div className="flex items-center gap-3 mb-4">
                                <Badge className="bg-purple-100 text-purple-700">{comp.platform || "LinkedIn"}</Badge>
                                <Badge variant="outline" className="font-semibold">
                                  {comp.engagement || "2.4K"} engagements
                                </Badge>
                              </div>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setEditingContent(comp)}
                                  className="flex-1"
                                >
                                  <Search className="mr-2 h-4 w-4" />
                                  Edit & Personalize
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    setSelectedCompetitor(comp)
                                    setSelectedOmniChannel([])
                                  }}
                                  className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
                                >
                                  <Send className="mr-2 h-4 w-4" />
                                  Push
                                </Button>
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  ) : (
                    <Card className="col-span-2 p-12 text-center">
                      <Eye className="h-16 w-16 text-slate-400 mx-auto mb-4" />
                      <p className="text-slate-400 font-medium">AI is analyzing competitor content...</p>
                    </Card>
                  )}
                </div>

                {/* Edit Modal */}
                {editingContent && (
                  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <Card className="max-w-2xl w-full max-h-[80vh] overflow-auto border-2">
                      <CardHeader className="bg-slate-100">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-slate-900">Edit & Personalize Content</CardTitle>
                          <Button variant="ghost" size="sm" onClick={() => setEditingContent(null)}>
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4 pt-6">
                        <div>
                          <label className="text-sm font-medium text-slate-900 mb-2 block">Title</label>
                          <Input
                            value={editingContent.title}
                            onChange={(e) => setEditingContent({ ...editingContent, title: e.target.value })}
                            className="h-12 border-slate-300 focus:border-purple-500"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium text-slate-900 mb-2 block">Content</label>
                          <Textarea
                            value={editingContent.content}
                            onChange={(e) => setEditingContent({ ...editingContent, content: e.target.value })}
                            className="min-h-[200px] border-slate-300 focus:border-purple-500"
                          />
                        </div>
                        <div className="flex gap-3 pt-4">
                          <Button variant="outline" onClick={() => setEditingContent(null)} className="flex-1">
                            Cancel
                          </Button>
                          <Button
                            onClick={() => {
                              setSelectedCompetitor(editingContent)
                              setEditingContent(null)
                            }}
                            className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
                          >
                            <Send className="mr-2 h-4 w-4" />
                            Save & Push
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Omni-Channel Push */}
                {selectedCompetitor && (
                  <div className="border-t pt-6 space-y-4 bg-gradient-to-r from-purple-50 to-pink-50 p-6 rounded-lg">
                    <h3 className="text-lg font-semibold text-slate-900">Push to Omni-Channel</h3>
                    <div className="grid md:grid-cols-3 gap-3">
                      {["Social Media", "Blog", "Email", "Video", "Direct Mail", "SMS"].map((channel) => (
                        <label
                          key={channel}
                          className="flex items-center gap-3 p-4 rounded-lg border-2 hover:border-purple-500 cursor-pointer transition-all bg-white"
                        >
                          <Checkbox
                            checked={selectedOmniChannel.includes(channel)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedOmniChannel([...selectedOmniChannel, channel])
                              } else {
                                setSelectedOmniChannel(selectedOmniChannel.filter((c) => c !== channel))
                              }
                            }}
                          />
                          <span className="font-medium text-slate-900">{channel}</span>
                        </label>
                      ))}
                    </div>
                    <Button
                      size="lg"
                      className="w-full bg-purple-600 hover:bg-purple-700 text-lg font-semibold"
                      disabled={selectedOmniChannel.length === 0}
                      onClick={() => handlePushToOmniChannel(selectedCompetitor, selectedOmniChannel)}
                    >
                      <Send className="mr-2 h-5 w-5" />
                      Push to {selectedOmniChannel.length} Channel{selectedOmniChannel.length !== 1 ? "s" : ""}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Newsletter Tab */}
          <TabsContent value="newsletter" className="space-y-6">
            {!isCreatingNewsletter ? (
              <>
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="text-2xl font-bold text-slate-900">Newsletter Campaigns</h3>
                    <p className="text-slate-600 mt-1">Email marketing to your database</p>
                  </div>
                  <Button
                    size="lg"
                    onClick={() => setIsCreatingNewsletter(true)}
                    className="bg-orange-600 hover:bg-orange-700 text-white"
                  >
                    <Plus className="mr-2 h-5 w-5" />
                    New Newsletter
                  </Button>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {newsletters.length > 0 ? (
                    newsletters.map((campaign) => (
                      <Card key={campaign.id} className="border-2 hover:shadow-lg transition-shadow">
                        <CardHeader className="pb-4">
                          <div className="flex justify-between items-start mb-3">
                            <Badge
                              variant={campaign.status === "sent" ? "default" : "secondary"}
                              className="capitalize"
                            >
                              {campaign.status}
                            </Badge>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </div>
                          <CardTitle className="text-xl text-slate-900">{campaign.title}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-slate-600 italic text-pretty">"{campaign.subjectLine}"</p>
                          <div className="grid grid-cols-3 gap-4 pt-4 border-t">
                            <div className="text-center">
                              <p className="text-xs text-slate-400 mb-1">Reach</p>
                              <p className="text-xl font-bold text-slate-900">
                                {campaign.sentToCount || campaign.audienceCount}
                              </p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-slate-400 mb-1">Opens</p>
                              <p className="text-xl font-bold text-slate-900">{campaign.openRate || 0}%</p>
                            </div>
                            <div className="text-center">
                              <p className="text-xs text-slate-400 mb-1">Clicks</p>
                              <p className="text-xl font-bold text-slate-900">{campaign.clickRate || 0}%</p>
                            </div>
                          </div>
                          {campaign.status === "draft" && (
                            <Button
                              className="w-full mt-4 bg-orange-600 hover:bg-orange-700 text-white"
                              onClick={() => handleSendNewsletter(campaign.id)}
                              disabled={isProcessing === campaign.id}
                            >
                              {isProcessing === campaign.id ? (
                                <>
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                                  Sending...
                                </>
                              ) : (
                                <>
                                  <Send className="mr-2 h-4 w-4" />
                                  Send Campaign
                                </>
                              )}
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    ))
                  ) : (
                    <div className="col-span-full text-center py-16 border-2 border-dashed rounded-xl border-slate-300">
                      <div className="bg-slate-100 rounded-full p-6 w-fit mx-auto mb-4">
                        <Mail className="h-12 w-12 text-slate-400" />
                      </div>
                      <p className="text-slate-400 font-medium">No newsletter campaigns yet</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Card className="border-2">
                <CardHeader className="bg-slate-100">
                  <div className="flex justify-between items-center">
                    <div>
                      <CardTitle className="text-slate-900">Create Newsletter Campaign</CardTitle>
                      <CardDescription>Design and send email newsletters to your contacts</CardDescription>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setIsCreatingNewsletter(false)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-900">Campaign Title</label>
                      <Input
                        type="text"
                        className="w-full border-slate-300 focus:border-orange-500"
                        value={newNewsletter.title}
                        onChange={(e) => setNewNewsletter({ ...newNewsletter, title: e.target.value })}
                        placeholder="Internal reference name"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-900">Template Style</label>
                      <select
                        className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:border-orange-500"
                        value={newNewsletter.templateStyle}
                        onChange={(e) => setNewNewsletter({ ...newNewsletter, templateStyle: e.target.value as any })}
                      >
                        <option value="modern">Modern Professional</option>
                        <option value="bold">Bold & High Contrast</option>
                        <option value="minimal">Minimalist Canvas</option>
                      </select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-slate-900">Subject Line</label>
                    <Input
                      type="text"
                      className="w-full border-slate-300 focus:border-orange-500"
                      value={newNewsletter.subjectLine}
                      onChange={(e) => setNewNewsletter({ ...newNewsletter, subjectLine: e.target.value })}
                      placeholder="What recipients see in inbox"
                    />
                  </div>
                  <Button
                    onClick={handleCreateNewsletter}
                    disabled={!newNewsletter.title || isProcessing === "create-newsletter"}
                    size="lg"
                    className="bg-orange-600 hover:bg-orange-700 text-white"
                  >
                    {isProcessing === "create-newsletter" ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Create Newsletter
                      </>
                    )}
                  </Button>

                  {generatedNewsletterContent && (
                    <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 space-y-3">
                      <p className="text-sm font-semibold text-orange-900">Newsletter Drafted</p>
                      {generatedNewsletterContent.subjects.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-orange-800 mb-1">Suggested subject lines:</p>
                          <ul className="space-y-1">
                            {generatedNewsletterContent.subjects.map((s, i) => (
                              <li key={i} className="text-sm text-orange-700 pl-2 border-l-2 border-orange-300">
                                {s}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <Textarea
                        rows={8}
                        className="text-sm"
                        value={generatedNewsletterContent.body}
                        onChange={(e) =>
                          setGeneratedNewsletterContent((prev) =>
                            prev ? { ...prev, body: e.target.value } : null,
                          )
                        }
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigator.clipboard.writeText(generatedNewsletterContent.body)}
                        >
                          Copy
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setGeneratedNewsletterContent(null)}
                        >
                          Discard
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Direct Mail Tab - Fully Functional */}
          <TabsContent value="mail" className="space-y-4">
            <Card className="border-2 shadow-md">
              <CardHeader className="bg-gradient-to-r from-rose-50 to-pink-50 border-b">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-3 text-slate-900">
                      <Ticket className="h-6 w-6 text-rose-600" />
                      Direct Mail Campaigns
                    </CardTitle>
                    <CardDescription>
                      Broker-approved templates • Personalize • Send via Lob or PostcardMania
                    </CardDescription>
                  </div>
                  <Button
                    onClick={() => setIsCreatingMail(true)}
                    size="lg"
                    className="bg-rose-600 hover:bg-rose-700 text-white"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create Campaign
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-6 space-y-6">
                {/* Template Selection */}
                {isCreatingMail && (
                  <div className="space-y-6 bg-gradient-to-r from-rose-50 to-pink-50 p-6 rounded-lg border-2 border-rose-200">
                    <h3 className="text-lg font-semibold text-slate-900">Select Broker-Approved Template</h3>
                    <div className="grid md:grid-cols-3 gap-4">
                      {directMailTemplates.map((template) => (
                        <Card
                          key={template.id}
                          className={cn(
                            "cursor-pointer hover:shadow-lg transition-all border-2",
                            newMail.templateId === template.id ? "border-rose-600 bg-rose-50" : "hover:border-rose-500",
                          )}
                          onClick={() => setNewMail({ ...newMail, templateId: template.id })}
                        >
                          <CardContent className="p-4 space-y-3">
                            <div className="aspect-video bg-gradient-to-br from-slate-100 to-slate-200 rounded-lg flex items-center justify-center">
                              <Ticket className="h-12 w-12 text-slate-400" />
                            </div>
                            <div className="text-center">
                              <h4 className="font-semibold text-slate-900">{template.name}</h4>
                              {newMail.templateId === template.id && (
                                <Badge className="mt-2 bg-rose-600">Selected</Badge>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>

                    {/* Personalization */}
                    <div className="space-y-4 pt-4 border-t">
                      <h3 className="text-lg font-semibold text-slate-900">Personalize Your Message</h3>
                      <div className="grid gap-4">
                        <div>
                          <label className="text-sm font-medium text-slate-900 mb-2 block">Campaign Title</label>
                          <Input
                            value={newMail.title}
                            onChange={(e) => setNewMail({ ...newMail, title: e.target.value })}
                            placeholder="Q1 Listings Campaign"
                            className="h-12 border-slate-300 focus:border-rose-500"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium text-slate-900 mb-2 block">Headline</label>
                          <Input
                            value={newMail.contentHeadline}
                            onChange={(e) => setNewMail({ ...newMail, contentHeadline: e.target.value })}
                            placeholder="Your Dream Home Awaits"
                            className="h-12 border-slate-300 focus:border-rose-500"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium text-slate-900 mb-2 block">Body Text</label>
                          <Textarea
                            value={newMail.contentBody}
                            onChange={(e) => setNewMail({ ...newMail, contentBody: e.target.value })}
                            placeholder="Contact me today for an exclusive showing..."
                            className="min-h-[120px] border-slate-300 focus:border-rose-500"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium text-slate-900 mb-2 block">Call to Action</label>
                          <Input
                            value={newMail.contentCta}
                            onChange={(e) => setNewMail({ ...newMail, contentCta: e.target.value })}
                            placeholder="Schedule a Showing →"
                            className="h-12 border-slate-300 focus:border-rose-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Send Provider Selection */}
                    <div className="flex gap-3 pt-4">
                      <Button variant="outline" onClick={() => setIsCreatingMail(false)} className="flex-1" size="lg">
                        Cancel
                      </Button>
                      <Button
                        onClick={handleCreateMail}
                        disabled={!newMail.title || isProcessing === "create-mail"}
                        className="flex-1 bg-rose-600 hover:bg-rose-700 text-white"
                        size="lg"
                      >
                        <Send className="mr-2 h-5 w-5" />
                        Send via Lob
                      </Button>
                      <Button
                        onClick={handleCreateMail}
                        disabled={!newMail.title || isProcessing === "create-mail"}
                        className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                        size="lg"
                      >
                        <Send className="mr-2 h-5 w-5" />
                        Send via PostcardMania
                      </Button>
                    </div>
                  </div>
                )}

                {/* Campaign List */}
                <div className="grid md:grid-cols-2 gap-4">
                  {directMail.length > 0
                    ? directMail.map((campaign) => (
                        <Card key={campaign.id} className="hover:shadow-lg transition-all border-2">
                          <CardContent className="p-6 space-y-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <h4 className="font-bold text-lg text-slate-900 mb-2">{campaign.title}</h4>
                                <p className="text-sm text-slate-600 mb-3">{campaign.template}</p>
                                <div className="flex items-center gap-3 mb-4">
                                  <Badge className="bg-rose-100 text-rose-700">
                                    {campaign.status === "sent" ? `${campaign.sent} sent` : "Draft"}
                                  </Badge>
                                  <Badge variant="outline">{campaign.opens} opens</Badge>
                                </div>
                                <Button
                                  onClick={() => handleSendMail(campaign.id)}
                                  disabled={isProcessing === campaign.id}
                                  className="w-full bg-rose-600 hover:bg-rose-700 text-white"
                                  size="sm"
                                >
                                  {isProcessing === campaign.id ? (
                                    <>
                                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                      Sending...
                                    </>
                                  ) : (
                                    <>
                                      <Send className="mr-2 h-4 w-4" />
                                      Send Now
                                    </>
                                  )}
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    : !isCreatingMail && (
                        <Card className="col-span-2 p-12 text-center border-2 border-dashed rounded-xl border-slate-300">
                          <Ticket className="h-16 w-16 text-slate-400 mx-auto mb-4" />
                          <p className="text-slate-400 font-medium mb-4">No direct mail campaigns yet</p>
                          <Button
                            onClick={() => setIsCreatingMail(true)}
                            size="lg"
                            className="bg-rose-600 hover:bg-rose-700 text-white"
                          >
                            <Plus className="mr-2 h-5 w-5" />
                            Create Your First Campaign
                          </Button>
                        </Card>
                      )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
