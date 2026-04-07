"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Link2,
  Sparkles,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Play,
  Download,
  Trash2,
  ChevronDown,
  Video,
} from "lucide-react"
import { toast } from "sonner"
import {
  generateVideoScript,
  updateVideoScript,
  startVideoGeneration,
  getVideoQueue,
  deleteVideo,
  getUserOrganizations,
} from "@/app/actions/link-to-video"
import { cn } from "@/lib/utils"

export default function LinkToVideoGenerator() {
  const [url, setUrl] = useState("")
  const [contentCategory, setContentCategory] = useState("property_listing")
  const [selectedOrg, setSelectedOrg] = useState<any>(null)
  const [organizations, setOrganizations] = useState<any[]>([])
  const [script, setScript] = useState("")
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null)
  const [compliance, setCompliance] = useState<any>(null)
  const [videoQueue, setVideoQueue] = useState<any[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedVideo, setSelectedVideo] = useState<any>(null)
  const [publishSettings, setPublishSettings] = useState({
    publishToSocials: false,
    platforms: [] as string[],
    scheduleType: "immediate",
  })

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    try {
      const [orgs, queue] = await Promise.all([getUserOrganizations(), getVideoQueue()])
      setOrganizations(orgs)
      if (orgs.length > 0) setSelectedOrg(orgs[0])
      setVideoQueue(queue)
    } catch (error) {
      console.error("[v0] Load data error:", error)
      setOrganizations([{ id: "default-org", name: "Default Organization", type: "brokerage" }])
      setSelectedOrg({ id: "default-org", name: "Default Organization", type: "brokerage" })
      setVideoQueue([])
    }
  }

  async function handleGenerateScript() {
    if (!url || !selectedOrg) {
      toast.error("Please enter a URL and select an organization")
      return
    }

    setIsGenerating(true)
    try {
      const result = await generateVideoScript({
        url,
        contentCategory,
        organizationId: selectedOrg.id,
        organizationType: selectedOrg.type,
      })

      if (result.success && result.videoQueue) {
        setScript(result.videoQueue.ai_generated_script)
        setCurrentVideoId(result.videoQueue.id)
        toast.success("Script generated successfully!")
        loadData()
      } else {
        toast.error(result.error || "Failed to generate script")
      }
    } catch (error) {
      toast.error("Error generating script")
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleUpdateScript() {
    if (!currentVideoId) return

    try {
      await updateVideoScript(currentVideoId, script)
      toast.success("Script updated and re-checked for compliance")
      loadData()
    } catch (error) {
      toast.error("Failed to update script")
    }
  }

  async function handleGenerateVideo() {
    if (!currentVideoId) return

    try {
      await startVideoGeneration(currentVideoId)
      toast.success("Video generation started! Check the queue below.")
      setScript("")
      setUrl("")
      setCurrentVideoId(null)
      loadData()
    } catch (error) {
      toast.error("Failed to start video generation")
    }
  }

  async function handleDeleteVideo(videoId: string) {
    try {
      await deleteVideo(videoId)
      toast.success("Video deleted")
      loadData()
    } catch (error) {
      toast.error("Failed to delete video")
    }
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; text: string }> = {
      draft: { variant: "outline", text: "Draft" },
      generating_audio: { variant: "secondary", text: "Generating Audio" },
      creating_video: { variant: "secondary", text: "Creating Video" },
      adding_subtitles: { variant: "secondary", text: "Adding Subtitles" },
      completed: { variant: "default", text: "Completed" },
      failed: { variant: "destructive", text: "Failed" },
    }
    const config = variants[status] || variants.draft
    return <Badge variant={config.variant}>{config.text}</Badge>
  }

  const getComplianceBadge = (passed: boolean, flags: any[]) => {
    if (!flags || flags.length === 0)
      return (
        <Badge variant="default" className="bg-green-500">
          <CheckCircle className="h-3 w-3 mr-1" />
          Compliant
        </Badge>
      )
    const hasViolations = flags.some((f) => f.severity === "violation")
    return (
      <Badge variant={hasViolations ? "destructive" : "secondary"}>
        <AlertTriangle className="h-3 w-3 mr-1" />
        {hasViolations ? "Violation" : "Warning"}
      </Badge>
    )
  }

  return (
    <div className="space-y-6">
      {/* Input Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Transform Any Link into a Social Video
          </CardTitle>
          <CardDescription>
            Paste any URL and let AI create an engaging video with voiceover and subtitles
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* URL Input */}
          <div className="space-y-2">
            <Label htmlFor="url">Website URL</Label>
            <div className="flex gap-2">
              <Input
                id="url"
                placeholder="https://example.com/property-listing"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="flex-1"
              />
              <Button onClick={handleGenerateScript} disabled={isGenerating || !url}>
                {isGenerating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Generate Script
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Content Category & Organization */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Content Category</Label>
              <Select value={contentCategory} onValueChange={setContentCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="property_listing">Property Listing</SelectItem>
                  <SelectItem value="market_update">Market Update</SelectItem>
                  <SelectItem value="general_social">General Social</SelectItem>
                  <SelectItem value="team_announcement">Team Announcement</SelectItem>
                  <SelectItem value="educational">Educational</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Organization Branding</Label>
              <Select
                value={selectedOrg?.id}
                onValueChange={(id) => setSelectedOrg(organizations.find((o) => o.id === id))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select organization" />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name} ({org.type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* AI Generated Script */}
          {script && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>AI Generated Script</Label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{script.split(" ").length} words</span>
                  {compliance && getComplianceBadge(compliance.passed, compliance.flags)}
                </div>
              </div>
              <Textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={6}
                placeholder="AI will generate your script here..."
              />
              <Button variant="outline" size="sm" onClick={handleUpdateScript}>
                Re-check Compliance
              </Button>

              {/* Compliance Details */}
              {compliance && compliance.flags && compliance.flags.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-between">
                      <span>View Compliance Details</span>
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 mt-2">
                    {compliance.flags.map((flag: any, idx: number) => (
                      <div key={idx} className="border rounded-lg p-3 space-y-1">
                        <div className="flex items-center gap-2">
                          <AlertTriangle
                            className={cn(
                              "h-4 w-4",
                              flag.severity === "violation" ? "text-red-500" : "text-yellow-500",
                            )}
                          />
                          <span className="font-medium text-sm">{flag.issue}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{flag.suggestion}</p>
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              )}

              {/* Publishing Options */}
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-between">
                    <span>Publishing Options</span>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 mt-4 border rounded-lg p-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="publish"
                      checked={publishSettings.publishToSocials}
                      onCheckedChange={(checked) =>
                        setPublishSettings({ ...publishSettings, publishToSocials: checked as boolean })
                      }
                    />
                    <Label htmlFor="publish" className="cursor-pointer">
                      Publish to social media after generation
                    </Label>
                  </div>

                  {publishSettings.publishToSocials && (
                    <>
                      <div className="space-y-2">
                        <Label>Select Platforms</Label>
                        <div className="grid grid-cols-2 gap-2">
                          {["Facebook", "Instagram", "LinkedIn", "TikTok", "YouTube Shorts", "X/Twitter"].map(
                            (platform) => (
                              <div key={platform} className="flex items-center space-x-2">
                                <Checkbox
                                  id={platform}
                                  checked={publishSettings.platforms.includes(platform)}
                                  onCheckedChange={(checked) => {
                                    if (checked) {
                                      setPublishSettings({
                                        ...publishSettings,
                                        platforms: [...publishSettings.platforms, platform],
                                      })
                                    } else {
                                      setPublishSettings({
                                        ...publishSettings,
                                        platforms: publishSettings.platforms.filter((p) => p !== platform),
                                      })
                                    }
                                  }}
                                />
                                <Label htmlFor={platform} className="cursor-pointer text-sm">
                                  {platform}
                                </Label>
                              </div>
                            ),
                          )}
                        </div>
                      </div>

                      <RadioGroup
                        value={publishSettings.scheduleType}
                        onValueChange={(value) => setPublishSettings({ ...publishSettings, scheduleType: value })}
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="immediate" id="immediate" />
                          <Label htmlFor="immediate" className="cursor-pointer">
                            Publish immediately
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="schedule" id="schedule" />
                          <Label htmlFor="schedule" className="cursor-pointer">
                            Schedule for later
                          </Label>
                        </div>
                      </RadioGroup>
                    </>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {/* Action Buttons */}
              <div className="flex gap-2 pt-2">
                <Button onClick={handleGenerateVideo} className="flex-1">
                  <Play className="h-4 w-4 mr-2" />
                  Generate Video
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setScript("")
                    setUrl("")
                    setCurrentVideoId(null)
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Video Queue Table */}
      <Card>
        <CardHeader>
          <CardTitle>Video Queue</CardTitle>
          <CardDescription>Track your video generation progress</CardDescription>
        </CardHeader>
        <CardContent>
          {videoQueue.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Compliance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {videoQueue.map((video) => (
                  <TableRow key={video.id}>
                    <TableCell className="max-w-[200px] truncate" title={video.source_url}>
                      {video.source_url}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{video.content_category}</Badge>
                    </TableCell>
                    <TableCell>
                      {getComplianceBadge(video.compliance_check_passed, video.compliance_flags || [])}
                    </TableCell>
                    <TableCell>{getStatusBadge(video.status)}</TableCell>
                    <TableCell>{new Date(video.created_at).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {video.status === "completed" && (
                          <Button size="sm" variant="ghost">
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => handleDeleteVideo(video.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-12">
              <Video className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground mb-2">No videos in queue yet.</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                The Link-to-Video feature requires the{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">video_content_queue</code> database table.
                Migration script{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">260-fix-content-studio-tables.sql</code> will
                create it automatically.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
