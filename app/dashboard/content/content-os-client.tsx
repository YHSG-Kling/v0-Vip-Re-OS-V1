"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, FileText, Sparkles, Wand2, BookTemplate, GraduationCap } from "lucide-react"
import { toast } from "sonner"
import {
  getGeneratedContent,
  createGeneratedContent,
  updateContentStatus,
  getContentTemplates,
  saveContentTemplate,
  learnFromEdits,
  trackContentUsage,
  enhancedGenerateListingDescription,
  generateAllListingDescriptions,
} from "@/app/actions/ai-content-generation"
import {
  GENERATED_CONTENT_STATUSES,
  DESCRIPTION_TYPES,
} from "@/app/actions/ai-content-generation.utils"
import { SeoHashtagsPanel } from "./panels/seo-hashtags-panel"
import { PerformanceCostsPanel } from "./panels/performance-costs-panel"
import { AbTestingPanel } from "./panels/ab-testing-panel"
import { ContentPlanPanel } from "./panels/content-plan-panel"

const CONTENT_TYPES = ["listing_description", "social_post", "email", "blog_post", "market_report"]

/** Tabs the command palette can deep-link into via ?tab=. */
const TABS = ["drafts", "templates", "listings", "seo", "experiments", "performance", "plan", "voice"] as const

export function ContentOsClient() {
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get("tab")
  const defaultTab = (TABS as readonly string[]).includes(requestedTab ?? "") ? requestedTab! : "drafts"

  const [drafts, setDrafts] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  // ── draft composer ──────────────────────────────────────────────────────
  const [draftType, setDraftType] = useState(CONTENT_TYPES[0])
  const [draftTitle, setDraftTitle] = useState("")
  const [draftBody, setDraftBody] = useState("")

  // ── template composer ───────────────────────────────────────────────────
  const [tplName, setTplName] = useState("")
  const [tplType, setTplType] = useState(CONTENT_TYPES[0])
  const [tplCategory, setTplCategory] = useState("general")
  const [tplBody, setTplBody] = useState("")

  // ── learn-from-edits ────────────────────────────────────────────────────
  const [learnContentId, setLearnContentId] = useState("")
  const [learnOriginal, setLearnOriginal] = useState("")
  const [learnEdited, setLearnEdited] = useState("")
  const [learnResult, setLearnResult] = useState<any>(null)

  // ── enhanced listing description ────────────────────────────────────────
  const [propertyId, setPropertyId] = useState("")
  const [descType, setDescType] = useState<(typeof DESCRIPTION_TYPES)[number]>("standard")
  const [enhanced, setEnhanced] = useState<any>(null)

  const reload = useCallback(async () => {
    const [draftsRes, tplRes] = await Promise.all([getGeneratedContent({ limit: 50 }), getContentTemplates()])

    // A refused read is reported, never rendered as "you have nothing".
    if (draftsRes.success) {
      setDrafts(draftsRes.content)
      setLoadError(null)
    } else {
      setDrafts([])
      setLoadError(draftsRes.error)
    }
    if (tplRes.success) setTemplates(tplRes.templates)
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const handleCreateDraft = () => {
    startTransition(async () => {
      const res = await createGeneratedContent({
        contentType: draftType,
        title: draftTitle || undefined,
        content: draftBody,
      })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Draft saved")
      setDraftTitle("")
      setDraftBody("")
      reload()
    })
  }

  const handleStatus = (contentId: string, status: string) => {
    startTransition(async () => {
      const res = await updateContentStatus(contentId, status)
      // The dialog/row only moves after the server has agreed.
      if (!res.success) { toast.error(res.error); return }
      toast.success(`Marked ${status}`)
      reload()
    })
  }

  const handleTrackUsage = (contentType: string, aiEdited: boolean) => {
    startTransition(async () => {
      const res = await trackContentUsage({ contentType, aiEdited })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Usage recorded")
    })
  }

  const handleSaveTemplate = () => {
    startTransition(async () => {
      const res = await saveContentTemplate({
        templateName: tplName,
        contentType: tplType,
        category: tplCategory,
        structure: { body: tplBody },
        exampleOutput: tplBody,
      })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Template saved")
      setTplName("")
      setTplBody("")
      reload()
    })
  }

  const handleLearn = () => {
    startTransition(async () => {
      const res = await learnFromEdits({
        contentId: learnContentId,
        originalContent: learnOriginal,
        editedContent: learnEdited,
      })
      if (!res.success) {
        setLearnResult(null)
        toast.error(res.error)
        return
      }
      setLearnResult(res.learnings)
      toast.success("Brand voice updated from your edits")
    })
  }

  const handleEnhanced = () => {
    startTransition(async () => {
      const res = await enhancedGenerateListingDescription({
        propertyId,
        descriptionType: descType,
      })
      if (!res.success) {
        setEnhanced(null)
        toast.error(res.error)
        return
      }
      setEnhanced(res)
      toast.success("Description written")
      reload()
    })
  }

  const handleBulk = () => {
    startTransition(async () => {
      const res = await generateAllListingDescriptions()
      if (!res.success) { toast.error(res.error); return }
      const { queued, completed, failed } = res.data
      // Report the server's real verdict, including the failures.
      if (failed > 0) {
        toast.warning(`${completed} of ${queued} written — ${failed} failed`)
      } else {
        toast.success(`${completed} of ${queued} descriptions written`)
      }
      reload()
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content OS</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Drafts, templates, keywords, hashtags, experiments, performance and AI spend
        </p>
      </div>

      {loadError && (
        <Card>
          <CardContent className="py-3 text-xs text-destructive">
            Could not load your content: {loadError}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue={defaultTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="drafts">Drafts</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="listings">Listing writer</TabsTrigger>
          <TabsTrigger value="seo">SEO &amp; hashtags</TabsTrigger>
          <TabsTrigger value="experiments">Experiments</TabsTrigger>
          <TabsTrigger value="performance">Performance &amp; spend</TabsTrigger>
          <TabsTrigger value="plan">30-day plan</TabsTrigger>
          <TabsTrigger value="voice">Brand voice</TabsTrigger>
        </TabsList>

        {/* ── DRAFTS ─────────────────────────────────────────────────────── */}
        <TabsContent value="drafts" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="h-4 w-4" /> New draft
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Content type</Label>
                  <Select value={draftType} onValueChange={setDraftType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTENT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Title</Label>
                  <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="Optional" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Body</Label>
                <Textarea
                  rows={5}
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  placeholder="Write or paste the content…"
                />
              </div>
              <Button onClick={handleCreateDraft} disabled={isPending || !draftBody.trim()}>
                {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Save draft
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Your content ({drafts.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {drafts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No content yet.</p>
              ) : (
                <div className="divide-y">
                  {drafts.map((d) => (
                    <div key={d.id} className="py-3 flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{d.title || d.content_type}</p>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {d.content || JSON.stringify(d.generated_content ?? "")}
                        </p>
                        <div className="flex gap-1.5 mt-1.5">
                          <Badge variant="outline" className="text-[10px]">
                            {d.content_type}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px]">
                            {d.status ?? "draft"}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 shrink-0">
                        {GENERATED_CONTENT_STATUSES.filter((s) => s !== d.status).map((s) => (
                          <Button
                            key={s}
                            size="sm"
                            variant="outline"
                            disabled={isPending}
                            onClick={() => handleStatus(d.id, s)}
                          >
                            {s}
                          </Button>
                        ))}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isPending}
                          onClick={() => handleTrackUsage(d.content_type, Boolean(d.edited_at))}
                        >
                          Record use
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TEMPLATES ──────────────────────────────────────────────────── */}
        <TabsContent value="templates" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <BookTemplate className="h-4 w-4" /> New template
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input value={tplName} onChange={(e) => setTplName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Content type</Label>
                  <Select value={tplType} onValueChange={setTplType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTENT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Input value={tplCategory} onChange={(e) => setTplCategory(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Structure / example</Label>
                <Textarea rows={4} value={tplBody} onChange={(e) => setTplBody(e.target.value)} />
              </div>
              <Button onClick={handleSaveTemplate} disabled={isPending || !tplName.trim()}>
                {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Save template
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Template library ({templates.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {templates.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No templates yet.</p>
              ) : (
                <div className="divide-y">
                  {templates.map((t) => (
                    <div key={t.id} className="py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{t.template_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.content_type} · {t.category ?? "uncategorised"}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        used {t.usage_count ?? 0}×
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── LISTING WRITER ─────────────────────────────────────────────── */}
        <TabsContent value="listings" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Wand2 className="h-4 w-4" /> Enhanced listing description
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Adds neighborhood context, comparables, buyer-persona detection, SEO keywords and a
                &quot;Them First&quot; check on top of the base description writer.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Listing ID</Label>
                  <Input
                    value={propertyId}
                    onChange={(e) => setPropertyId(e.target.value)}
                    placeholder="UUID of the listing"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Length</Label>
                  <Select value={descType} onValueChange={(v) => setDescType(v as typeof descType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DESCRIPTION_TYPES.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleEnhanced} disabled={isPending || !propertyId.trim()}>
                  {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                  Write description
                </Button>
                <Button variant="outline" onClick={handleBulk} disabled={isPending}>
                  Write for all active listings
                </Button>
              </div>

              {enhanced && (
                <div className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={enhanced.validation?.passed ? "default" : "destructive"} className="text-[10px]">
                      Them-First {Math.round((enhanced.validation?.overall_score ?? 0) * 100)}%
                    </Badge>
                    {enhanced.targetPersona && (
                      <Badge variant="outline" className="text-[10px]">
                        {String(enhanced.targetPersona)}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{enhanced.description}</p>
                  {enhanced.validation?.recommendations?.length > 0 && (
                    <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                      {enhanced.validation.recommendations.map((r: string, i: number) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="seo" className="mt-4">
          <SeoHashtagsPanel />
        </TabsContent>

        <TabsContent value="experiments" className="mt-4">
          <AbTestingPanel drafts={drafts} onChanged={reload} />
        </TabsContent>

        <TabsContent value="performance" className="mt-4">
          <PerformanceCostsPanel drafts={drafts} />
        </TabsContent>

        <TabsContent value="plan" className="mt-4">
          <ContentPlanPanel />
        </TabsContent>

        {/* ── BRAND VOICE LEARNING ───────────────────────────────────────── */}
        <TabsContent value="voice" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <GraduationCap className="h-4 w-4" /> Learn from an edit
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Paste what the AI wrote and what you changed it to. The differences are folded into your
                brand voice profile, so future drafts start closer to your voice.
              </p>
              <div className="space-y-1.5">
                <Label>Content ID</Label>
                <Select value={learnContentId} onValueChange={setLearnContentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a piece of content" />
                  </SelectTrigger>
                  <SelectContent>
                    {drafts.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.title || d.content_type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>AI wrote</Label>
                  <Textarea rows={5} value={learnOriginal} onChange={(e) => setLearnOriginal(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>You changed it to</Label>
                  <Textarea rows={5} value={learnEdited} onChange={(e) => setLearnEdited(e.target.value)} />
                </div>
              </div>
              <Button
                onClick={handleLearn}
                disabled={isPending || !learnContentId || !learnOriginal.trim() || !learnEdited.trim()}
              >
                {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                <Sparkles className="h-4 w-4 mr-1.5" />
                Teach my brand voice
              </Button>

              {learnResult && (
                <div className="rounded-md border p-3 text-xs space-y-1">
                  {learnResult.style_notes && <p>{learnResult.style_notes}</p>}
                  {Array.isArray(learnResult.words_to_avoid) && learnResult.words_to_avoid.length > 0 && (
                    <p className="text-muted-foreground">
                      Now avoiding: {learnResult.words_to_avoid.join(", ")}
                    </p>
                  )}
                  {Array.isArray(learnResult.preferred_phrases) && learnResult.preferred_phrases.length > 0 && (
                    <p className="text-muted-foreground">
                      Now preferring: {learnResult.preferred_phrases.join(", ")}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
