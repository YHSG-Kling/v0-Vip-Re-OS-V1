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
      console.log("[v0] Generating video script:", { purpose: videoPurpose, persona: videoPersona, contactName: videoContactName, userId: agentId })
      const result = await generateVideoScript({
        purpose: videoPurpose,
        persona: videoPersona,
        contactName: videoContactName,
        userId: agentId
      })
      console.log("[v0] Video script result:", result)
      if (result && result.script) {
        setOutput(result.script)
      } else {
        setOutput("Generated script is empty. Please try again or adjust your settings.")
      }
    } catch (e: any) {
      console.error("[v0] Error generating video script:", e)
      setOutput(`Error: ${e?.message || "Failed to generate script. Please check your AI model configuration and try again."}`)
    }
    setGenerating(false)
  }

  const handleMailGenerate = async () => {
    setGenerating(true)
    setOutput("")
    try {
      console.log("[v0] Generating direct mail:", { agentId, campaignType: mailCampaignType, targetArea: mailTargetArea, headline: mailHeadline })
      const result = await generateAIDirectMail({
        agentId,
        campaignType: mailCampaignType,
        targetArea: mailTargetArea,
        headline: mailHeadline
      })
      console.log("[v0] Direct mail result:", result)
      if (result && result.content) {
        setOutput(result.content)
      } else {
        setOutput("Generated content is empty. Please try again or provide more details.")
      }
    } catch (e: any) {
      console.error("[v0] Error generating direct mail:", e)
      setOutput(`Error: ${e?.message || "Failed to generate mail content. Please check your configuration and try again."}`)
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
      console.log("[v0] Generating market report:", { marketArea, reportType, agentId })
      const result = await generateMarketReport({
        marketArea,
        reportType,
        agentId
      })
      console.log("[v0] Market report result:", result)
      if (result && result.report) {
        setOutput(result.report)
      } else {
        setOutput("Generated report is empty. Please provide a valid market area and try again.")
      }
    } catch (e: any) {
      console.error("[v0] Error generating market report:", e)
      setOutput(`Error: ${e?.message || "Failed to generate report. Please check your market area and try again."}`)
    }
    setGenerating(false)
  }

  const handlePodcastGenerate = async () => {
    setGenerating(true)
    setOutput("")
    try {
      console.log("[v0] Creating podcast episode:", { title: podcastTitle, topic: podcastTopic })
      const result = await createPodcastEpisode({
        title: podcastTitle,
        description: podcastTopic,
        script: podcastTopic,
        category: 'market_update'
      })
      console.log("[v0] Podcast result:", result)
      if (result && result.success) {
        setOutput("Podcast episode created successfully! You can find it in the Podcast Studio.")
      } else {
        setOutput("Failed to create podcast episode. Please provide a title and topic and try again.")
      }
    } catch (e: any) {
      console.error("[v0] Error creating podcast:", e)
      setOutput(`Error: ${e?.message || "Failed to create podcast episode. Please check your inputs and try again."}`)
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
              <DialogContent className="max-w-2xl bg-background border shadow-lg">
                <DialogHeader className="border-b pb-4 bg-gradient-to-r from-primary/5 to-transparent -m-6 mb-0 p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg bg-background border ${power.iconColor}`}>
                        <power.icon className="h-6 w-6" />
                      </div>
                      <div>
                        <DialogTitle className="text-xl font-semibold">{power.title}</DialogTitle>
                        <p className="text-sm text-muted-foreground mt-1">{power.description}</p>
                      </div>
                    </div>
                  </div>
                </DialogHeader>
                
                <div className="space-y-6 py-6">
                  {/* AI Capabilities Info */}
                  <div className="flex items-start gap-3 p-3 bg-primary/5 rounded-lg border border-primary/20">
                    <Sparkles className="h-5 w-5 text-primary mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">AI-Powered Generation</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Leverages your brand voice, market data, and proven templates to create personalized content in seconds.
                      </p>
                    </div>
                  </div>

                  {/* Form Inputs */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold">Customize Your Content</h4>
                    {power.form}
                  </div>

                  {/* Generate Button */}
                  <Button 
                    onClick={power.onGenerate} 
                    disabled={generating} 
                    className="w-full h-11 text-base font-semibold"
                    size="lg"
                  >
                    {generating ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin mr-2" />
                        Generating with AI...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-5 w-5 mr-2" />
                        Generate {power.title}
                      </>
                    )}
                  </Button>

                  {/* Output Section */}
                  {output && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-semibold">Generated Content</h4>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={handleCopy}>
                            {copied ? (
                              <>
                                <Check className="h-4 w-4 mr-1.5" />
                                Copied!
                              </>
                            ) : (
                              <>
                                <Copy className="h-4 w-4 mr-1.5" />
                                Copy
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                      
                      <div className="relative">
                        <Textarea 
                          value={output} 
                          onChange={(e) => setOutput(e.target.value)} 
                          rows={10}
                          className="bg-muted/30 border-2 font-mono text-sm resize-none" 
                        />
                        {output.toLowerCase().includes('error') && (
                          <div className="absolute top-2 right-2 bg-destructive/10 text-destructive text-xs px-2 py-1 rounded">
                            Generation Error
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg border">
                        <div className="flex-1">
                          <p className="text-xs text-muted-foreground">
                            Ready to use this content? Open the full studio to refine, schedule, and publish.
                          </p>
                        </div>
                        <Link href={power.href}>
                          <Button size="sm" variant="default">
                            {power.linkText}
                          </Button>
                        </Link>
                      </div>
                    </div>
                  )}
                </div>

                <DialogFooter className="border-t pt-4 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Powered by AI • Brand voice applied • Compliance checked
                  </p>
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
