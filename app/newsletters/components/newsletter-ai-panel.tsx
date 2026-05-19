"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, BarChart2, Copy, Check } from "lucide-react"
import {
  aiGenerateSubjectLines,
  aiWriteNewsletterContent,
  aiAnalyzeNewsletterPerformance,
} from "@/app/actions/ai-newsletter"

function sanitizeNewsletterHtml(html: string): string {
  if (typeof window === "undefined") return ""
  const doc = new DOMParser().parseFromString(html, "text/html")
  doc.querySelectorAll("script, iframe, object, embed, form").forEach(el => el.remove())
  doc.querySelectorAll("*").forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith("on") || attr.value.toLowerCase().includes("javascript:")) {
        el.removeAttribute(attr.name)
      }
    })
  })
  return doc.body.innerHTML
}

interface NewsletterAIPanelProps {
  agentId: string
  brokerageId: string
}

export function NewsletterAIPanel({ agentId, brokerageId }: NewsletterAIPanelProps) {
  // Subject lines
  const [slTopic, setSlTopic] = useState("")
  const [slAudience, setSlAudience] = useState<"all" | "buyers" | "sellers" | "investors" | "lifetime_customers">("all")
  const [slTone, setSlTone] = useState<"professional" | "friendly" | "urgent" | "curious">("friendly")
  const [slLoading, setSlLoading] = useState(false)
  const [subjectLines, setSubjectLines] = useState<string[]>([])
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  // Content writer
  const [cwTopic, setCwTopic] = useState("")
  const [cwTemplate, setCwTemplate] = useState("market-update")
  const [cwLoading, setCwLoading] = useState(false)
  const [cwResult, setCwResult] = useState<any>(null)
  const [cwCopied, setCwCopied] = useState(false)

  // Performance
  const [perfLoading, setPerfLoading] = useState(false)
  const [perfResult, setPerfResult] = useState<any>(null)

  async function handleGenerateSubjectLines() {
    if (!slTopic.trim()) return
    setSlLoading(true)
    setSubjectLines([])
    try {
      const res = await aiGenerateSubjectLines({
        agentId,
        brokerageId,
        newsletterTopic: slTopic,
        audience: slAudience,
        tone: slTone,
        includeEmoji: false,
      })
      if (res.success && res.subjectLines) {
        const sl = res.subjectLines as any
        const lines: string[] = [
          sl.primary?.subject,
          ...(sl.variants?.map((v: any) => v.subject) ?? []),
        ].filter(Boolean)
        setSubjectLines(lines)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setSlLoading(false)
    }
  }

  async function handleWriteContent() {
    if (!cwTopic.trim()) return
    setCwLoading(true)
    setCwResult(null)
    try {
      const res = await aiWriteNewsletterContent({
        agentId,
        brokerageId,
        template: cwTemplate,
        topic: cwTopic,
      })
      if (res.success) {
        setCwResult(res)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setCwLoading(false)
    }
  }

  async function handleAnalyzePerformance() {
    setPerfLoading(true)
    setPerfResult(null)
    try {
      const res = await aiAnalyzeNewsletterPerformance({ agentId })
      if (res.success) {
        setPerfResult(res)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setPerfLoading(false)
    }
  }

  function copyText(text: string, idx: number) {
    navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1500)
  }

  function copyCwContent() {
    const text = cwResult?.content ?? cwResult?.body ?? ""
    if (text) {
      navigator.clipboard.writeText(text)
      setCwCopied(true)
      setTimeout(() => setCwCopied(false), 1500)
    }
  }

  return (
    <div className="space-y-6">
      {/* Subject Line Generator */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            AI Subject Line Generator
          </CardTitle>
          <CardDescription>Generate high-open-rate subject lines for any newsletter topic</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs">Newsletter topic</Label>
            <Input
              placeholder="e.g. Spring market update, interest rate changes"
              value={slTopic}
              onChange={(e) => setSlTopic(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Audience</Label>
              <Select value={slAudience} onValueChange={(v: any) => setSlAudience(v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All contacts</SelectItem>
                  <SelectItem value="buyers">Buyers</SelectItem>
                  <SelectItem value="sellers">Sellers</SelectItem>
                  <SelectItem value="investors">Investors</SelectItem>
                  <SelectItem value="lifetime_customers">Lifetime Customers</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tone</Label>
              <Select value={slTone} onValueChange={(v: any) => setSlTone(v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="friendly">Friendly</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="curious">Curious</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleGenerateSubjectLines}
            disabled={slLoading || !slTopic.trim()}
            className="w-full gap-1.5"
          >
            {slLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate Subject Lines
          </Button>
          {subjectLines.length > 0 && (
            <div className="space-y-2 pt-1">
              {subjectLines.map((line, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
                  <p className="text-sm flex-1">{line}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => copyText(line, i)}
                  >
                    {copiedIdx === i ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content Writer */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-500" />
            AI Newsletter Content Writer
          </CardTitle>
          <CardDescription>Generate full newsletter content from a topic and template</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Template</Label>
              <Select value={cwTemplate} onValueChange={setCwTemplate}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="market-update">Market Update</SelectItem>
                  <SelectItem value="buyer-tips">Buyer Tips</SelectItem>
                  <SelectItem value="seller-tips">Seller Tips</SelectItem>
                  <SelectItem value="community-spotlight">Community Spotlight</SelectItem>
                  <SelectItem value="investment-insights">Investment Insights</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Topic</Label>
              <Input
                className="h-8 text-xs"
                placeholder="e.g. Rising inventory in Q2"
                value={cwTopic}
                onChange={(e) => setCwTopic(e.target.value)}
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleWriteContent}
            disabled={cwLoading || !cwTopic.trim()}
            className="w-full gap-1.5"
          >
            {cwLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Write Newsletter Content
          </Button>
          {cwResult ? (
            <div className="space-y-2 pt-1">
              {cwResult.subject && (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">Subject</Badge>
                  <p className="text-sm font-medium">{cwResult.subject}</p>
                </div>
              )}
              <div className="relative rounded-md border bg-muted/30 p-3 max-h-64 overflow-y-auto">
                {cwResult.content || cwResult.body ? (
                  <div
                    className="text-xs text-foreground prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeNewsletterHtml(cwResult.content ?? cwResult.body ?? "") }}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground italic">No content generated.</p>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 h-6 w-6"
                  onClick={copyCwContent}
                >
                  {cwCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2">
              Click &ldquo;Write Newsletter Content&rdquo; to generate your newsletter
            </p>
          )}
        </CardContent>
      </Card>

      {/* Performance Analyzer */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-emerald-500" />
            AI Performance Analyzer
          </CardTitle>
          <CardDescription>Analyze past send data to surface what subject lines and content types drive the most opens</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            size="sm"
            onClick={handleAnalyzePerformance}
            disabled={perfLoading}
            className="w-full gap-1.5"
            variant="outline"
          >
            {perfLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart2 className="h-3.5 w-3.5" />}
            Analyze Newsletter Performance
          </Button>
          {perfResult && (
            <div className="space-y-3 pt-1">
              {perfResult.summary && (
                <p className="text-sm text-muted-foreground">{perfResult.summary}</p>
              )}
              {perfResult.topPerforming?.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold">Top Performing</p>
                  {perfResult.topPerforming.slice(0, 3).map((item: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-xs rounded border bg-muted/30 px-2 py-1.5">
                      <span className="truncate">{item.subject ?? item.label ?? `Campaign ${i + 1}`}</span>
                      {item.open_rate != null && (
                        <Badge variant="secondary" className="text-xs shrink-0 ml-2">
                          {Math.round(item.open_rate * 100)}% open
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {perfResult.recommendations?.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold">Recommendations</p>
                  <ul className="space-y-1">
                    {perfResult.recommendations.slice(0, 3).map((r: string, i: number) => (
                      <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                        <span className="text-emerald-500 mt-0.5">•</span>{r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
