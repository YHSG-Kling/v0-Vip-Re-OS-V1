"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Sparkles, Video, Mail, Share2, TrendingUp, Radio, Megaphone, Loader2, Copy, Check } from "lucide-react"
import { generateVideoScript } from "@/app/actions/video-generation"
import { generateAIDirectMail } from "@/app/actions/ai-marketing-automation"
import { generateSocialContent } from "@/app/actions/social-publishing"
import { generateMarketReport } from "@/app/actions/ai-market-intelligence"
import { createPodcastEpisode } from "@/app/actions/podcast-generation"

interface AgentSuperpowersPanelProps {
  agentId: string
  brokerageId: string
  hotLeadName?: string
}

export function AgentSuperpowersPanel({ agentId, brokerageId, hotLeadName }: AgentSuperpowersPanelProps) {
  const [generating, setGenerating] = useState(false)
  const [output, setOutput] = useState("")
  const [copied, setCopied] = useState(false)

  // Form states
  const [videoPurpose, setVideoPurpose] = useState("market_update")
  const [videoPersona, setVideoPersona] = useState("professional")
  const [videoContactName, setVideoContactName] = useState(hotLeadName || "")

  const [mailCampaignType, setMailCampaignType] = useState("just_listed")
  const [mailTargetArea, setMailTargetArea] = useState("")
  const [mailHeadline, setMailHeadline] = useState("")

  const [socialContentType, setSocialContentType] = useState("market_update")

  const [marketArea, setMarketArea] = useState("")
  const [reportType, setReportType] = useState("monthly")

  const [podcastTitle, setPodcastTitle] = useState("")
  const [podcastTopic, setPodcastTopic] = useState("")

  const handleCopy = async () => {
    await navigator.clipboard.writeText(output)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleVideoGenerate = async () => {
    setGenerating(true)
    setOutput("")
    try {
      const result = await generateVideoScript({
        purpose: videoPurpose,
        persona: videoPersona,
        contactName: videoContactName,
        userId: agentId
      })
      setOutput(result.script || "No script generated")
    } catch (e) {
      setOutput("Error generating script")
    }
    setGenerating(false)
  }

  const handleMailGenerate = async () => {
    setGenerating(true)
    setOutput("")
    try {
      const result = await generateAIDirectMail({
        agentId,
        campaignType: mailCampaignType,
        targetArea: mailTargetArea,
        headline: mailHeadline
      })
      setOutput(result.content || "No content generated")
    } catch (e) {
      setOutput("Error generating mail content")
    }
    setGenerating(false)
  }

  const handleSocialGenerate = async () => {
    setGenerating(true)
    setOutput("")
    try {
      console.log("[v0] Generating social content:", { contentType: socialContentType, userId: agentId })
      const result = await generateSocialContent({
        contentType: socialContentType,
        userId: agentId
      })
      console.log("[v0] Social content result:", result)
      if (result && result.content) {
        setOutput(result.content)
      } else {
        setOutput("Generated content is empty. Please try again or adjust your settings.")
      }
    } catch (e: any) {
      console.error("[v0] Error generating social content:", e)
      setOutput(`Error: ${e?.message || "Failed to generate content. Please check your AI model configuration and try again."}`)
    }
    setGenerating(false)
  }

  const handleMarketGenerate = async () => {
    setGenerating(true)
    setOutput("")
    try {
      const result = await generateMarketReport({
        marketArea,
        reportType,
        agentId
      })
      setOutput(result.report || "No report generated")
    } catch (e) {
      setOutput("Error generating report")
    }
    setGenerating(false)
  }

  const handlePodcastGenerate = async () => {
    setGenerating(true)
    setOutput("")
    try {
      const result = await createPodcastEpisode({
        title: podcastTitle,
        description: podcastTopic,
        script: podcastTopic,
        category: 'market_update'
      })
      setOutput(result.success ? "Podcast episode created successfully!" : "Error creating podcast")
    } catch (e) {
      setOutput("Error creating podcast episode")
    }
    setGenerating(false)
  }

  const superpowers = [
    {
      icon: Video,
      iconColor: "text-blue-600",
      title: "AI Video",
      description: "Create a homeowner update your customer will actually watch",
      href: "/dashboard/videos/create",
      linkText: "Open Video Studio →",
      onGenerate: handleVideoGenerate,
      form: (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Purpose</Label>
            <Select value={videoPurpose} onValueChange={setVideoPurpose}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="market_update">Market Update</SelectItem>
                <SelectItem value="listing_promo">Listing Promo</SelectItem>
                <SelectItem value="buyer_tips">Buyer Tips</SelectItem>
                <SelectItem value="seller_tips">Seller Tips</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Persona</Label>
            <Select value={videoPersona} onValueChange={setVideoPersona}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="professional">Professional</SelectItem>
                <SelectItem value="friendly">Friendly</SelectItem>
                <SelectItem value="expert">Expert</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Contact Name</Label>
            <Input value={videoContactName} onChange={(e) => setVideoContactName(e.target.value)} placeholder="Optional" />
          </div>
        </div>
      )
    },
    {
      icon: Mail,
      iconColor: "text-orange-600",
      title: "Direct Mail",
      description: "Generate neighborhood direct mail in 30 seconds",
      href: "/dashboard/campaigns/mail",
      linkText: "Open Direct Mail →",
      onGenerate: handleMailGenerate,
      form: (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Campaign Type</Label>
            <Select value={mailCampaignType} onValueChange={setMailCampaignType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="just_listed">Just Listed</SelectItem>
                <SelectItem value="just_sold">Just Sold</SelectItem>
                <SelectItem value="market_update">Market Update</SelectItem>
                <SelectItem value="farming">Farming</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Target Area</Label>
            <Input value={mailTargetArea} onChange={(e) => setMailTargetArea(e.target.value)} placeholder="e.g., Downtown Miami" />
          </div>
          <div>
            <Label className="text-xs">Headline</Label>
            <Input value={mailHeadline} onChange={(e) => setMailHeadline(e.target.value)} placeholder="Optional custom headline" />
          </div>
        </div>
      )
    },
    {
      icon: Share2,
      iconColor: "text-purple-600",
      title: "Social Content",
      description: "Turn one idea into posts for every platform",
      href: "/dashboard/social",
      linkText: "Open Social →",
      onGenerate: handleSocialGenerate,
      form: (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Content Type</Label>
            <Select value={socialContentType} onValueChange={setSocialContentType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="market_update">Market Update</SelectItem>
                <SelectItem value="new_listing">New Listing</SelectItem>
                <SelectItem value="just_sold">Just Sold</SelectItem>
                <SelectItem value="buyer_tips">Buyer Tips</SelectItem>
                <SelectItem value="seller_tips">Seller Tips</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )
    },
    {
      icon: TrendingUp,
      iconColor: "text-green-600",
      title: "Market Report",
      description: "Send a market update your homeowner will actually read",
      href: "/dashboard/market-insights",
      linkText: "Open Market Insights →",
      onGenerate: handleMarketGenerate,
      form: (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Market Area</Label>
            <Input value={marketArea} onChange={(e) => setMarketArea(e.target.value)} placeholder="e.g., Coral Gables, FL" />
          </div>
          <div>
            <Label className="text-xs">Report Type</Label>
            <Select value={reportType} onValueChange={setReportType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )
    },
    {
      icon: Radio,
      iconColor: "text-teal-600",
      title: "Podcast Engine",
      description: "Turn this market insight into content your sphere will share",
      href: "/dashboard/marketing/podcast",
      linkText: "Open Podcast Studio →",
      onGenerate: handlePodcastGenerate,
      form: (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Episode Title</Label>
            <Input value={podcastTitle} onChange={(e) => setPodcastTitle(e.target.value)} placeholder="e.g., Q4 Market Trends" />
          </div>
          <div>
            <Label className="text-xs">Topic / Script</Label>
            <Textarea value={podcastTopic} onChange={(e) => setPodcastTopic(e.target.value)} placeholder="Describe your topic or paste a script..." rows={3} />
          </div>
        </div>
      )
    }
  ]

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Agent Superpowers
        </CardTitle>
        <CardDescription>One action. Maximum impact.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {superpowers.map((power, idx) => (
            <Dialog key={idx} onOpenChange={() => { setOutput(""); setGenerating(false) }}>
              <DialogTrigger asChild>
                <Card className="cursor-pointer hover:shadow-md transition-shadow">
                  <CardContent className="p-3">
                    <power.icon className={`h-5 w-5 ${power.iconColor} mb-2`} />
                    <p className="text-sm font-medium">{power.title}</p>
                    <p className="text-xs text-muted-foreground">{power.description}</p>
                  </CardContent>
                </Card>
              </DialogTrigger>
              <DialogContent className="max-w-lg bg-background border shadow-lg">
                <DialogHeader className="border-b pb-4">
                  <DialogTitle className="flex items-center gap-2 text-lg">
                    <power.icon className={`h-5 w-5 ${power.iconColor}`} />
                    {power.title}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  {power.form}
                  <Button onClick={power.onGenerate} disabled={generating} className="w-full">
                    {generating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Generate
                  </Button>
                  {output && (
                    <div className="space-y-2 p-4 bg-muted/50 rounded-lg border">
                      <Textarea 
                        value={output} 
                        onChange={(e) => setOutput(e.target.value)} 
                        rows={7}
                        className="bg-background" 
                      />
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={handleCopy} className="bg-background">
                          {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                          {copied ? "Copied" : "Copy"}
                        </Button>
                        <Link href={power.href}>
                          <Button variant="outline" size="sm" className="bg-background">{power.linkText}</Button>
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
                <DialogFooter className="border-t pt-4">
                  <DialogClose asChild>
                    <Button variant="ghost">Close</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ))}
        </div>

        {/* Campaign Launcher */}
        <div className="p-4 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-2 mb-3">
            <Megaphone className="h-5 w-5 text-primary" />
            <p className="text-sm font-medium">Launch a Full Campaign — one action, all channels</p>
          </div>
          <div className="flex gap-2">
            <Link href="/dashboard/campaigns/sequences">
              <Button variant="outline" size="sm">Launch Listing Campaign</Button>
            </Link>
            <Link href="/dashboard/marketing/studio">
              <Button variant="outline" size="sm">Marketing Studio</Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
