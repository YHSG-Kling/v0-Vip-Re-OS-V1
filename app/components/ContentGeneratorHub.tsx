"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertTriangle, CheckCircle, Mail, MessageSquare, Share2, Newspaper } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { VideoGenerationButtons } from "@/components/video/VideoGenerationButtons"

interface QualityResult {
  score: number
  themPercentage: number
  agentPercentage: number
  warnings: string[]
  suggestions: string[]
}

export function ContentGeneratorHub() {
  const [prospectId, setProspectId] = useState("")
  const [emailType, setEmailType] = useState("introduction")
  const [messageType, setMessageType] = useState("follow-up")
  const [audienceSegment, setAudienceSegment] = useState("first-time-buyers")
  const [audienceType, setAudienceType] = useState("buyers")
  const [painPoint, setPainPoint] = useState("")
  const [topic, setTopic] = useState("")
  const [platform, setPlatform] = useState("instagram")

  const [generatedContent, setGeneratedContent] = useState<string | null>(null)
  const [quality, setQuality] = useState<QualityResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generateContent = async (endpoint: string, payload: any) => {
    setLoading(true)
    setError(null)
    setGeneratedContent(null)
    setQuality(null)

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!res.ok) throw new Error("Failed to generate content")

      const data = await res.json()
      setGeneratedContent(data.content)
      setQuality(data.quality)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  const getQualityColor = (score: number) => {
    if (score >= 80) return "bg-green-500"
    if (score >= 60) return "bg-yellow-500"
    return "bg-red-500"
  }

  return (
    <div className="w-full max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">THEM-FIRST Content Generator</CardTitle>
          <CardDescription>Generate content that's 80-90% about your prospect and 10-20% about you</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="email" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="email" className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Email
              </TabsTrigger>
              <TabsTrigger value="text" className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Text
              </TabsTrigger>
              <TabsTrigger value="social" className="flex items-center gap-2">
                <Share2 className="h-4 w-4" />
                Social
              </TabsTrigger>
              <TabsTrigger value="newsletter" className="flex items-center gap-2">
                <Newspaper className="h-4 w-4" />
                Newsletter
              </TabsTrigger>
            </TabsList>

            <TabsContent value="email" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="prospectId">Prospect ID</Label>
                <Input
                  id="prospectId"
                  placeholder="Enter prospect UUID"
                  value={prospectId}
                  onChange={(e) => setProspectId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="emailType">Email Type</Label>
                <Select value={emailType} onValueChange={setEmailType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="introduction">Introduction</SelectItem>
                    <SelectItem value="follow-up">Follow-up</SelectItem>
                    <SelectItem value="check-in">Check-in</SelectItem>
                    <SelectItem value="property-alert">Property Alert</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => generateContent("/api/generate/email", { prospectId, emailType })}
                disabled={loading || !prospectId}
                className="w-full"
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate Email
              </Button>
            </TabsContent>

            <TabsContent value="text" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="prospectIdText">Prospect ID</Label>
                <Input
                  id="prospectIdText"
                  placeholder="Enter prospect UUID"
                  value={prospectId}
                  onChange={(e) => setProspectId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="messageType">Message Type</Label>
                <Select value={messageType} onValueChange={setMessageType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="follow-up">Follow-up</SelectItem>
                    <SelectItem value="quick-check">Quick Check-in</SelectItem>
                    <SelectItem value="update">Update</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => generateContent("/api/generate/text", { prospectId, messageType })}
                disabled={loading || !prospectId}
                className="w-full"
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate Text Message
              </Button>
            </TabsContent>

            <TabsContent value="social" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="audienceSegment">Audience Segment</Label>
                <Select value={audienceSegment} onValueChange={setAudienceSegment}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first-time-buyers">First-Time Buyers</SelectItem>
                    <SelectItem value="growing-families">Growing Families</SelectItem>
                    <SelectItem value="downsizers">Downsizers</SelectItem>
                    <SelectItem value="investors">Investors</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="platform">Platform</Label>
                <Select value={platform} onValueChange={setPlatform}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="instagram">Instagram</SelectItem>
                    <SelectItem value="facebook">Facebook</SelectItem>
                    <SelectItem value="linkedin">LinkedIn</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => generateContent("/api/generate/social", { audienceSegment, platform })}
                disabled={loading}
                className="w-full"
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate Social Post
              </Button>
            </TabsContent>

            <TabsContent value="newsletter" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="audienceType">Audience Type</Label>
                <Select value={audienceType} onValueChange={setAudienceType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buyers">Buyers</SelectItem>
                    <SelectItem value="sellers">Sellers</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="painPoint">Pain Point</Label>
                <Input
                  id="painPoint"
                  placeholder="e.g., Worried about market timing"
                  value={painPoint}
                  onChange={(e) => setPainPoint(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="topic">Topic (Optional)</Label>
                <Input
                  id="topic"
                  placeholder="e.g., Spring market insights"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
              </div>
              <Button
                onClick={() => generateContent("/api/generate/newsletter", { audienceType, painPoint, topic })}
                disabled={loading}
                className="w-full"
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate Newsletter
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {generatedContent && quality && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Generated Content
              <Badge className={getQualityColor(quality.score)}>Quality Score: {quality.score}/100</Badge>
            </CardTitle>
            <CardDescription>
              <div className="flex gap-4 mt-2">
                <span>Them-focused: {quality.themPercentage.toFixed(1)}%</span>
                <span>Agent-focused: {quality.agentPercentage.toFixed(1)}%</span>
              </div>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea value={generatedContent} readOnly rows={12} className="font-mono text-sm" />

            {quality.warnings.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Quality Warnings</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1">
                    {quality.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {quality.suggestions.length > 0 && (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertTitle>Suggestions for Improvement</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1">
                    {quality.suggestions.map((suggestion, i) => (
                      <li key={i}>{suggestion}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="mt-6 p-4 bg-muted/30 rounded-lg border">
              <h4 className="text-sm font-semibold mb-3 text-muted-foreground">Convert to Video</h4>
              <VideoGenerationButtons script={generatedContent} title="Generated Content Video" size="sm" />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
