"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Textarea } from "@/app/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/app/components/ui/sheet"
import {
  Scissors,
  FileText,
  Mail,
  ExternalLink,
  Loader2,
  Sparkles,
  Copy,
  CheckCircle2,
} from "lucide-react"
import { toast } from "sonner"
import {
  generatePodcastSnippetSuggestions,
  generatePodcastBlogPost,
  generatePodcastNewsletterTeaser,
} from "@/app/actions/podcast-generation"

interface Episode {
  id: string
  title: string
  status: string
  category?: string
  duration_seconds?: number | null
}

interface Props {
  episodes: Episode[]
}

interface Snippet {
  hook?: string
  body?: string
  suggested_caption?: string
  estimated_duration_seconds?: number
}

type SheetMode = "snippets" | "blog" | "teaser" | null

export function RepurposeTab({ episodes }: Props) {
  const publishedEpisodes = episodes.filter((e) => e.status === "published" || e.status === "completed")
  const [activeEpisode, setActiveEpisode] = useState<Episode | null>(null)
  const [sheetMode, setSheetMode] = useState<SheetMode>(null)
  const [loading, setLoading] = useState(false)
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [blogContent, setBlogContent] = useState("")
  const [blogTitle, setBlogTitle] = useState("")
  const [blogSavedId, setBlogSavedId] = useState<string | null>(null)
  const [teaserContent, setTeaserContent] = useState("")
  const [teaserSavedId, setTeaserSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function close() {
    setActiveEpisode(null)
    setSheetMode(null)
    setSnippets([])
    setBlogContent("")
    setBlogTitle("")
    setBlogSavedId(null)
    setTeaserContent("")
    setTeaserSavedId(null)
    setError(null)
  }

  async function startSnippets(ep: Episode) {
    setActiveEpisode(ep)
    setSheetMode("snippets")
    setLoading(true)
    setError(null)
    setSnippets([])
    try {
      const res = await generatePodcastSnippetSuggestions({ episodeId: ep.id })
      if (res.success) setSnippets(res.snippets ?? [])
      else setError(res.error ?? "Failed to generate snippets")
    } finally {
      setLoading(false)
    }
  }

  async function startBlog(ep: Episode) {
    setActiveEpisode(ep)
    setSheetMode("blog")
    setLoading(true)
    setError(null)
    setBlogContent("")
    setBlogTitle("")
    setBlogSavedId(null)
    try {
      const res = await generatePodcastBlogPost({ episodeId: ep.id })
      if (res.success) {
        setBlogContent(res.content ?? "")
        setBlogTitle(res.title ?? ep.title)
        setBlogSavedId(res.blogPostId ?? null)
      } else {
        setError(res.error ?? "Failed to generate blog post")
      }
    } finally {
      setLoading(false)
    }
  }

  async function startTeaser(ep: Episode) {
    setActiveEpisode(ep)
    setSheetMode("teaser")
    setLoading(true)
    setError(null)
    setTeaserContent("")
    setTeaserSavedId(null)
    try {
      const res = await generatePodcastNewsletterTeaser({ episodeId: ep.id })
      if (res.success) {
        setTeaserContent(res.content ?? "")
        setTeaserSavedId(res.teaserId ?? null)
      } else {
        setError(res.error ?? "Failed to generate teaser")
      }
    } finally {
      setLoading(false)
    }
  }

  async function copyText(text: string, label = "Copied") {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(label)
    } catch {
      toast.error("Could not copy")
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Turn this episode into more content</CardTitle>
          <CardDescription>
            Each published episode becomes social clips, a blog post, and a newsletter teaser — without re-recording.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-gray-600">
          <ul className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
            <li className="flex items-start gap-2 p-3 rounded-lg border bg-white">
              <Scissors className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-gray-900">Social clips</p>
                <p className="text-xs text-gray-500">Short, captioned highlights for Reels / Shorts / TikTok.</p>
              </div>
            </li>
            <li className="flex items-start gap-2 p-3 rounded-lg border bg-white">
              <FileText className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-gray-900">Blog post</p>
                <p className="text-xs text-gray-500">Long-form post built from the episode transcript.</p>
              </div>
            </li>
            <li className="flex items-start gap-2 p-3 rounded-lg border bg-white">
              <Mail className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-gray-900">Newsletter teaser</p>
                <p className="text-xs text-gray-500">One-paragraph promo to drop into your next send.</p>
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Published episodes</CardTitle>
        </CardHeader>
        <CardContent>
          {publishedEpisodes.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No published episodes yet. Publish an episode and it will appear here, ready to repurpose.
            </p>
          ) : (
            <ul className="divide-y">
              {publishedEpisodes.map((ep) => (
                <li key={ep.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{ep.title}</p>
                    {ep.category && (
                      <Badge variant="secondary" className="mt-1 text-xs">
                        {ep.category}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => startSnippets(ep)} className="gap-1.5">
                      <Scissors className="h-3.5 w-3.5" />
                      Generate Clips
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => startBlog(ep)} className="gap-1.5">
                      <FileText className="h-3.5 w-3.5" />
                      Generate Blog
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => startTeaser(ep)} className="gap-1.5">
                      <Mail className="h-3.5 w-3.5" />
                      Generate Teaser
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Repurpose result sheet */}
      <Sheet open={!!sheetMode} onOpenChange={(v) => !v && close()}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {sheetMode === "snippets" && "Snippet Suggestions"}
              {sheetMode === "blog" && "Blog Post Draft"}
              {sheetMode === "teaser" && "Newsletter Teaser"}
            </SheetTitle>
            <SheetDescription>
              {activeEpisode ? `From "${activeEpisode.title}"` : ""}
            </SheetDescription>
          </SheetHeader>

          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400 mr-2" />
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Sparkles className="h-3.5 w-3.5" />
                Generating with AI…
              </span>
            </div>
          )}

          {!loading && error && (
            <p className="text-sm text-red-600 py-4">{error}</p>
          )}

          {!loading && !error && sheetMode === "snippets" && (
            <div className="space-y-3 py-4">
              {snippets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No snippet suggestions returned.</p>
              ) : (
                snippets.map((s, i) => (
                  <div key={i} className="rounded-md border p-3">
                    {s.hook && <p className="font-medium text-sm">{s.hook}</p>}
                    {s.body && <p className="text-sm text-gray-700 mt-1.5">{s.body}</p>}
                    {s.suggested_caption && (
                      <p className="text-xs text-muted-foreground mt-2 italic">"{s.suggested_caption}"</p>
                    )}
                    <div className="flex items-center justify-between mt-2.5">
                      <span className="text-[11px] text-muted-foreground">
                        ~{s.estimated_duration_seconds ?? 30}s
                      </span>
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs gap-1"
                          onClick={() => copyText(`${s.hook ?? ""}\n\n${s.body ?? ""}\n\n${s.suggested_caption ?? ""}`)}
                        >
                          <Copy className="h-3 w-3" />
                          Copy
                        </Button>
                        <Button asChild size="sm" variant="outline" className="h-7 text-xs gap-1">
                          <Link
                            href={`/dashboard/campaigns/repurpose?source=podcast&episodeId=${activeEpisode?.id}`}
                          >
                            Send to Omnipresence
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {!loading && !error && sheetMode === "blog" && (
            <div className="space-y-3 py-4">
              {blogSavedId && (
                <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Saved to Blog as draft.
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground mb-1">Title</p>
                <p className="font-medium">{blogTitle}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Content (markdown)</p>
                <Textarea readOnly value={blogContent} rows={18} className="font-mono text-xs" />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => copyText(blogContent, "Blog post copied")}>
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                  Copy Markdown
                </Button>
                <Button asChild size="sm">
                  <Link href={blogSavedId ? `/dashboard/marketing/blog/${blogSavedId}` : "/dashboard/marketing/blog"}>
                    Open in Blog Editor
                    <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                  </Link>
                </Button>
              </div>
            </div>
          )}

          {!loading && !error && sheetMode === "teaser" && (
            <div className="space-y-3 py-4">
              {teaserSavedId && (
                <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Saved to Newsletter draft queue.
                </div>
              )}
              <Textarea readOnly value={teaserContent} rows={8} />
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => copyText(teaserContent, "Teaser copied")}>
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                  Copy
                </Button>
                <Button asChild size="sm">
                  <Link href="/newsletters">
                    Open Newsletter
                    <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
