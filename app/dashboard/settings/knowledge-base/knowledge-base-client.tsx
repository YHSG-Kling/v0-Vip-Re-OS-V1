'use client'

import { useState, useCallback } from 'react'
// The help-topic vocabulary owns its own display labels. `.replace(/_/g,' ')`
// renders "tech_stack" as "tech stack"; the module renders it as "Tech Stack",
// which is what the admin picked from and what the CHECK constraint stores.
// Client-safe by design (no `server-only`), so the picker imports it rather
// than keeping a private copy — a hand-maintained vocabulary beside a CHECK is
// how the drift this module documents got in.
import { helpTopicCategoryLabel } from '@/lib/knowledge/help-topic-categories'
import useSWR, { mutate } from 'swr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Plus,
  Search,
  RefreshCw,
  Loader2,
  CheckCircle,
  Circle,
  AlertCircle,
  FileText,
  Trash2,
  Edit,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createHelpTopic,
  updateHelpTopic,
  deleteHelpTopic,
  getHelpTopicsAdmin,
  backfillAllEmbeddings,
  regenerateEmbedding,
  searchKnowledge,
  searchHelpTopicsRAG,
  searchArticlesRAG,
  getKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
} from '@/app/actions/knowledge/search'

/**
 * knowledge_articles.category has its OWN CHECK constraint, and it is NOT the
 * help_topics_kb one (license / brand / tech_stack / training / certification /
 * general). Mixing them up is the exact 23514 the help-topic category module was
 * written to stop, so the article picker gets the article vocabulary.
 * MIRRORS knowledge_articles_category_check — adding a member here without the
 * migration produces a value the database refuses.
 */
const ARTICLE_CATEGORIES = [
  'onboarding',
  'compliance',
  'marketing',
  'transactions',
  'leads',
  'integrations',
  'general',
] as const

type ArticleStatus = 'draft' | 'published' | 'archived'

interface KnowledgeArticleRow {
  id: string
  title: string
  slug: string
  content: string
  excerpt: string | null
  category: string
  tags: string[] | null
  status: ArticleStatus
  brokerage_id: string | null
  content_embedding: number[] | null
  view_count: number | null
  helpful_count: number | null
  updated_at: string
}

/** knowledge_articles.slug is NOT NULL — derive one when the admin types none. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled-article'
  )
}

interface KBArticle {
  id: string
  title: string
  content: string
  category: string
  tags: string[]
  is_active: boolean
  brokerage_id: string | null
  content_embedding: number[] | null
  created_at: string
  updated_at: string
}

interface EmbeddingQueueStatus {
  pending: number
  processing: number
  completed: number
  failed: number
}

interface KnowledgeBaseClientProps {
  initialArticles: KBArticle[]
  categories: string[]
  brokerageId: string
  userType: string
  /** Embedding-queue counts — ported from the removed admin Knowledge page. */
  queueStatus?: EmbeddingQueueStatus
}

// The browser used to read help_topics_kb directly, which relied entirely on
// RLS for the platform-vs-brokerage split. getHelpTopicsAdmin applies the same
// rule on the server (this brokerage's rows OR the platform's), so the scope is
// stated once instead of assumed in two places.
const fetcher = async () => {
  const { topics } = await getHelpTopicsAdmin({ limit: 200 })
  return topics
}

/**
 * The AI BRAIN'S OWN CORPUS, which this screen never showed.
 *
 * Knowledge Ops (admin command centre) counts knowledge_articles — published,
 * drafts, stale — and its only button says "Manage Knowledge Base" and lands
 * here. Until now this page managed help_topics_kb ONLY, so every one of those
 * counted articles was unreachable: complete CRUD server-side, a control that
 * pointed at it, and nothing in between.
 */
const articlesFetcher = async (): Promise<KnowledgeArticleRow[]> => {
  const { articles } = await getKnowledgeArticles({ limit: 200 })
  return (articles ?? []) as unknown as KnowledgeArticleRow[]
}

export function KnowledgeBaseClient({
  initialArticles,
  categories,
  brokerageId,
  userType,
  queueStatus,
}: KnowledgeBaseClientProps) {
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [isSheetOpen, setIsSheetOpen] = useState(false)
  const [editingArticle, setEditingArticle] = useState<KBArticle | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isEmbedding, setIsEmbedding] = useState(false)
  const [isBulkEmbedding, setIsBulkEmbedding] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchSource, setSearchSource] = useState<'all' | 'help_topics' | 'articles'>('all')
  const [reEmbeddingId, setReEmbeddingId] = useState<string | null>(null)

  // Which corpus this screen is managing. help_topics_kb is the in-product help
  // KB; knowledge_articles is the AI brain's retrieval corpus. Both are embedded
  // and both are searched by the assistant, so both belong on this screen.
  const [source, setSource] = useState<'topics' | 'articles'>('topics')

  // Form state
  const [formTitle, setFormTitle] = useState('')
  const [formContent, setFormContent] = useState('')
  const [formCategory, setFormCategory] = useState('general')
  const [formTags, setFormTags] = useState('')
  const [formBrokerageScope, setFormBrokerageScope] = useState<'platform' | 'brokerage'>('platform')

  // knowledge_articles editor state
  const [isArticleSheetOpen, setIsArticleSheetOpen] = useState(false)
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null)
  const [isLoadingArticle, setIsLoadingArticle] = useState(false)
  const [isSavingArticle, setIsSavingArticle] = useState(false)
  const [artTitle, setArtTitle] = useState('')
  const [artSlug, setArtSlug] = useState('')
  const [artExcerpt, setArtExcerpt] = useState('')
  const [artContent, setArtContent] = useState('')
  const [artCategory, setArtCategory] = useState<string>('general')
  const [artTags, setArtTags] = useState('')
  const [artStatus, setArtStatus] = useState<ArticleStatus>('draft')

  const { data: articles, isLoading } = useSWR('kb-articles', fetcher, {
    fallbackData: initialArticles,
    refreshInterval: 30000,
  })

  const { data: knowledgeArticles, isLoading: articlesLoading } = useSWR(
    'kb-knowledge-articles',
    articlesFetcher,
    { refreshInterval: 60000 },
  )

  const filteredArticles = (articles || []).filter((article: any) => {
    if (selectedCategory === 'all') return true
    return article.category === selectedCategory
  })

  const filteredKnowledgeArticles = (knowledgeArticles || []).filter((a) => {
    if (selectedCategory === 'all') return true
    return a.category === selectedCategory
  })

  const openNewArticle = () => {
    setEditingArticle(null)
    setFormTitle('')
    setFormContent('')
    setFormCategory('general')
    setFormTags('')
    setFormBrokerageScope('platform')
    setIsSheetOpen(true)
  }

  const openEditArticle = (article: KBArticle) => {
    setEditingArticle(article)
    setFormTitle(article.title)
    setFormContent(article.content)
    setFormCategory(article.category)
    setFormTags(article.tags?.join(', ') || '')
    setFormBrokerageScope(article.brokerage_id ? 'brokerage' : 'platform')
    setIsSheetOpen(true)
  }

  const handleSave = async () => {
    if (!formTitle.trim() || !formContent.trim()) {
      toast.error('Title and content are required')
      return
    }

    setIsSaving(true)
    setIsEmbedding(true)

    try {
      // These used to be raw browser writes to help_topics_kb followed by a
      // POST to /api/intelligence/kb/embed carrying
      // `Bearer ${NEXT_PUBLIC_INTERNAL_API_SECRET}`. Two things were wrong:
      // the route validates INTERNAL_API_SECRET (a different, server-only
      // variable), so the header could not match and every embed returned 401;
      // and the response was only checked for `ok`, never for failure — so the
      // admin was told "Article created successfully" while the article stayed
      // unembedded and therefore invisible to the AI that is the whole point of
      // uploading it. The server actions embed inline, need no secret in the
      // browser, and report whether the embedding actually landed.
      const tags = formTags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
      const scope = formBrokerageScope

      const res = editingArticle
        ? await updateHelpTopic(editingArticle.id, {
            title: formTitle.trim(),
            content: formContent.trim(),
            category: formCategory,
            tags,
            scope,
          })
        : await createHelpTopic({
            title: formTitle.trim(),
            content: formContent.trim(),
            category: formCategory,
            tags,
            scope,
          })

      if (!res.success) {
        toast.error(res.error)
        return
      }

      toast.success(editingArticle ? 'Article updated' : 'Article created')
      if (res.embedded) {
        toast.success('Article embedded for vector search')
      } else {
        toast.error('Saved, but the embedding failed — the AI cannot retrieve this article yet. It is queued for retry.')
      }

      await mutate('kb-articles')
      setIsSheetOpen(false)
    } catch (error: any) {
      console.error('Save error:', error)
      toast.error(error.message || 'Failed to save article')
    } finally {
      setIsEmbedding(false)
      setIsSaving(false)
    }
  }

  const handleDelete = async (articleId: string) => {
    if (!confirm('Are you sure you want to delete this article?')) return

    const res = await deleteHelpTopic(articleId)
    if (!res.success) {
      toast.error(res.error)
      return
    }
    toast.success('Article deleted')
    await mutate('kb-articles')
  }

  const handleBulkEmbed = async () => {
    setIsBulkEmbedding(true)
    try {
      const result = await backfillAllEmbeddings()
      if (result.failed > 0) {
        toast.error(`Embedded ${result.processed} of ${result.total}; ${result.failed} failed`)
      } else {
        toast.success(`Embedded ${result.processed} of ${result.total} articles`)
      }
      await mutate('kb-articles')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to run bulk embedding')
    } finally {
      setIsBulkEmbedding(false)
    }
  }

  /**
   * THE PREVIEW NOW TESTS WHAT THE AI ACTUALLY RETRIEVES.
   *
   * It used to call searchKB (app/actions/kb-search), which searches
   * help_topics_kb ONLY and falls back to an ILIKE text scan when the vector
   * search returns nothing. For an admin asking "did my upload become
   * retrievable?" that fallback is a trap: an article with NO embedding still
   * matches on a title substring, so the screen says yes when the assistant will
   * say no. The RAG actions are the assistant's own retrieval path — both
   * corpora, vector-only — so a miss here is a real miss.
   */
  const handleSearchPreview = async () => {
    if (!searchQuery.trim()) return

    setIsSearching(true)
    try {
      const results =
        searchSource === 'help_topics'
          ? await searchHelpTopicsRAG(searchQuery, { limit: 5 })
          : searchSource === 'articles'
            ? await searchArticlesRAG(searchQuery, { limit: 5 })
            : await searchKnowledge(searchQuery, { limit: 5 })
      setSearchResults(results as any[])
      if ((results as any[]).length === 0) {
        toast.message('No embedded match — the assistant would not find this either.')
      }
    } catch (error) {
      console.error('Search preview error:', error)
      toast.error('Search preview failed')
    } finally {
      setIsSearching(false)
    }
  }

  /**
   * THE SECOND OPINION, kept deliberately separate.
   *
   * searchKB (app/actions/kb-search) is help_topics_kb only and falls back to an
   * ILIKE scan when the vector search returns nothing. That fallback is wrong as
   * a retrieval preview — it matches text the AI cannot reach — but it is
   * exactly the right DIAGNOSTIC once the preview above comes back empty: it
   * answers "does the wording even exist in a topic?", which separates "never
   * written" from "written but not embedded". Two questions, two buttons.
   */
  const handleTextFallbackSearch = async () => {
    if (!searchQuery.trim()) return
    setIsSearching(true)
    try {
      const { searchKB } = await import('@/app/actions/kb-search')
      const results = await searchKB(searchQuery, brokerageId, 5)
      setSearchResults(results)
      toast.message(
        results.length === 0
          ? 'No help topic contains that wording at all.'
          : 'Text match only — these may not be embedded, so the AI may still miss them.',
      )
    } catch (error) {
      console.error('Text search error:', error)
      toast.error('Text search failed')
    } finally {
      setIsSearching(false)
    }
  }

  /**
   * Re-embed ONE row. "Re-embed All" existed; a single stuck article did not
   * have a fix short of running the whole backfill, and the list has shown a
   * per-row "Not Embedded" state the whole time with nothing to do about it.
   */
  const handleRegenerate = async (
    sourceTable: 'help_topics_kb' | 'knowledge_articles',
    id: string,
  ) => {
    setReEmbeddingId(id)
    try {
      await regenerateEmbedding(sourceTable, id)
      toast.success('Embedding regenerated')
      await mutate(sourceTable === 'help_topics_kb' ? 'kb-articles' : 'kb-knowledge-articles')
    } catch (error: any) {
      toast.error(error?.message || 'Re-embedding failed')
    } finally {
      setReEmbeddingId(null)
    }
  }

  const openNewKnowledgeArticle = () => {
    setEditingKnowledgeId(null)
    setArtTitle('')
    setArtSlug('')
    setArtExcerpt('')
    setArtContent('')
    setArtCategory('general')
    setArtTags('')
    setArtStatus('draft')
    setIsArticleSheetOpen(true)
  }

  /**
   * Re-read the row before editing rather than trusting the list snapshot —
   * the list refreshes on a timer, and saving a stale body silently reverts
   * whatever a co-admin published in between.
   */
  const openEditKnowledgeArticle = async (row: KnowledgeArticleRow) => {
    setEditingKnowledgeId(row.id)
    setIsArticleSheetOpen(true)
    setIsLoadingArticle(true)
    try {
      const fresh: any = await getKnowledgeArticle(row.id)
      setArtTitle(fresh?.title ?? row.title)
      setArtSlug(fresh?.slug ?? row.slug)
      setArtExcerpt(fresh?.excerpt ?? '')
      setArtContent(fresh?.content ?? row.content)
      setArtCategory(fresh?.category ?? row.category)
      setArtTags((fresh?.tags ?? row.tags ?? []).join(', '))
      setArtStatus((fresh?.status ?? row.status) as ArticleStatus)
    } catch (error: any) {
      toast.error(error?.message || 'Could not load that article')
      setIsArticleSheetOpen(false)
    } finally {
      setIsLoadingArticle(false)
    }
  }

  const handleSaveKnowledgeArticle = async () => {
    if (!artTitle.trim() || !artContent.trim()) {
      toast.error('Title and content are required')
      return
    }
    setIsSavingArticle(true)
    try {
      const tags = artTags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
      const slug = artSlug.trim() || slugify(artTitle)

      if (editingKnowledgeId) {
        await updateKnowledgeArticle(editingKnowledgeId, {
          title: artTitle.trim(),
          slug,
          content: artContent.trim(),
          excerpt: artExcerpt.trim() || undefined,
          category: artCategory,
          tags,
          status: artStatus,
        })
        toast.success('Article updated and re-embedded')
      } else {
        await createKnowledgeArticle({
          title: artTitle.trim(),
          slug,
          content: artContent.trim(),
          excerpt: artExcerpt.trim() || undefined,
          category: artCategory,
          tags,
          status: artStatus === 'archived' ? 'draft' : artStatus,
        })
        toast.success('Article created and embedded')
      }
      await mutate('kb-knowledge-articles')
      setIsArticleSheetOpen(false)
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save article')
    } finally {
      setIsSavingArticle(false)
    }
  }

  const handleDeleteKnowledgeArticle = async (id: string) => {
    if (!confirm('Delete this article? The AI will stop retrieving it.')) return
    try {
      await deleteKnowledgeArticle(id)
      toast.success('Article deleted')
      await mutate('kb-knowledge-articles')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to delete article')
    }
  }

  const getEmbeddingStatus = (article: KBArticle) => {
    if (article.content_embedding) {
      return { icon: CheckCircle, color: 'text-green-600', label: 'Embedded' }
    }
    return { icon: Circle, color: 'text-muted-foreground', label: 'Not Embedded' }
  }

  return (
    <div className="flex h-full">
      {/* Left Sidebar - Category Filter */}
      <div className="w-64 shrink-0 border-r bg-muted/30 p-4">
        {/* EMBEDDING QUEUE — ported from the removed /dashboard/admin/knowledge, the
            second "Knowledge Base" screen. An article is only searchable by the AI
            once its embedding lands, so a stuck queue explains "I uploaded it and
            the assistant still doesn't know it". Failures are called out in red;
            an idle, healthy queue stays quiet. */}
        {queueStatus && (queueStatus.pending + queueStatus.processing + queueStatus.failed) > 0 && (
          <div className="mb-4 rounded-md border bg-background p-3 text-xs">
            <div className="mb-2 font-semibold">Embedding queue</div>
            <div className="space-y-1">
              {queueStatus.processing > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Processing</span><span className="font-medium">{queueStatus.processing}</span></div>
              )}
              {queueStatus.pending > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Pending</span><span className="font-medium">{queueStatus.pending}</span></div>
              )}
              {queueStatus.failed > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Failed</span><span className="font-semibold text-red-600">{queueStatus.failed}</span></div>
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Articles become AI-searchable once embedded.
            </p>
          </div>
        )}
        <h2 className="mb-4 text-sm font-semibold">Categories</h2>
        <div className="space-y-1">
          {(source === 'articles' ? ['all', ...ARTICLE_CATEGORIES] : categories).map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                selectedCategory === category
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
            >
              {category === 'all'
                ? 'All Articles'
                : source === 'articles'
                  ? category.replace(/_/g, ' ')
                  : helpTopicCategoryLabel(category)}
            </button>
          ))}
        </div>

        {/* Search Preview */}
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-semibold">Search Preview</h2>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Runs the assistant&apos;s own vector retrieval. No text-match fallback —
            a miss here is a miss for the AI.
          </p>
          <div className="space-y-2">
            <Input
              placeholder="Test search query..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchPreview()}
            />
            <Select
              value={searchSource}
              onValueChange={(v) => setSearchSource(v as 'all' | 'help_topics' | 'articles')}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Both sources</SelectItem>
                <SelectItem value="help_topics">Help topics only</SelectItem>
                <SelectItem value="articles">Knowledge articles only</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleSearchPreview}
              disabled={isSearching}
            >
              {isSearching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-2 h-4 w-4" />
              )}
              Test Search
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              onClick={handleTextFallbackSearch}
              disabled={isSearching}
              title="Diagnostic: plain text match across help topics, embedded or not"
            >
              No match? Check text search
            </Button>
          </div>

          {searchResults.length > 0 && (
            <div className="mt-3 space-y-2">
              {searchResults.map((result) => (
                <div
                  key={result.id}
                  className="rounded-md border bg-background p-2 text-xs"
                >
                  <p className="font-medium">{result.title}</p>
                  {result.source && (
                    <p className="text-muted-foreground">
                      {result.source === 'articles' ? 'Knowledge article' : 'Help topic'}
                    </p>
                  )}
                  {result.similarity && (
                    <p className="text-muted-foreground">
                      Similarity: {(result.similarity * 100).toFixed(1)}%
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Knowledge Base</h1>
            <p className="text-muted-foreground">
              Manage help articles for AI assistant and search
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleBulkEmbed}
              disabled={isBulkEmbedding}
            >
              {isBulkEmbedding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Re-embed All
            </Button>
            <Button
              onClick={source === 'articles' ? openNewKnowledgeArticle : openNewArticle}
            >
              <Plus className="mr-2 h-4 w-4" />
              {source === 'articles' ? 'New Knowledge Article' : 'New Article'}
            </Button>
          </div>
        </div>

        {/* Corpus switch — help_topics_kb vs knowledge_articles */}
        <div className="mb-4 inline-flex rounded-md border p-0.5">
          {(['topics', 'articles'] as const).map((s) => (
            <button
              key={s}
              onClick={() => {
                setSource(s)
                setSelectedCategory('all')
              }}
              className={`rounded px-3 py-1.5 text-sm transition-colors ${
                source === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              }`}
            >
              {s === 'topics' ? 'Help Topics' : 'Knowledge Articles'}
              {s === 'articles' && knowledgeArticles ? ` (${knowledgeArticles.length})` : ''}
            </button>
          ))}
        </div>

        {/* KNOWLEDGE ARTICLES — the AI brain's corpus */}
        {source === 'articles' ? (
          articlesLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : filteredKnowledgeArticles.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <FileText className="mb-4 h-12 w-12 text-muted-foreground" />
                <p className="text-muted-foreground">No knowledge articles in this category</p>
                <Button variant="link" onClick={openNewKnowledgeArticle}>
                  Write your first article
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredKnowledgeArticles.map((article) => {
                const embedded = Boolean(article.content_embedding)
                return (
                  <Card key={article.id} className="hover:border-primary/50 transition-colors">
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-medium">{article.title}</h3>
                          <Badge variant="outline" className="text-xs">
                            {article.category.replace(/_/g, ' ')}
                          </Badge>
                          <Badge
                            variant={article.status === 'published' ? 'default' : 'secondary'}
                            className="text-xs"
                          >
                            {article.status}
                          </Badge>
                          {article.brokerage_id === null && (
                            <Badge variant="outline" className="text-xs">Platform-wide</Badge>
                          )}
                          <div
                            className={`flex items-center gap-1 text-xs ${
                              embedded ? 'text-green-600' : 'text-muted-foreground'
                            }`}
                          >
                            {embedded ? (
                              <CheckCircle className="h-3 w-3" />
                            ) : (
                              <AlertCircle className="h-3 w-3" />
                            )}
                            {embedded ? 'Embedded' : 'Not Embedded'}
                          </div>
                        </div>
                        <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                          {article.excerpt || article.content.substring(0, 150)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Updated {new Date(article.updated_at).toLocaleDateString()} ·{' '}
                          {article.view_count ?? 0} views
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Re-embed this article"
                          disabled={reEmbeddingId === article.id}
                          onClick={() => handleRegenerate('knowledge_articles', article.id)}
                        >
                          {reEmbeddingId === article.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Zap className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEditKnowledgeArticle(article)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteKnowledgeArticle(article.id)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )
        ) : /* Article List */
        isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : filteredArticles.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="mb-4 h-12 w-12 text-muted-foreground" />
              <p className="text-muted-foreground">No articles in this category</p>
              <Button variant="link" onClick={openNewArticle}>
                Create your first article
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filteredArticles.map((article: any) => {
              const status = getEmbeddingStatus(article)
              const StatusIcon = status.icon

              return (
                <Card key={article.id} className="hover:border-primary/50 transition-colors">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{article.title}</h3>
                        <Badge variant="outline" className="text-xs">
                          {article.category.replace(/_/g, ' ')}
                        </Badge>
                        <div className={`flex items-center gap-1 text-xs ${status.color}`}>
                          <StatusIcon className="h-3 w-3" />
                          {status.label}
                        </div>
                      </div>
                      <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                        {article.content.substring(0, 150)}...
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Updated {new Date(article.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Re-embed this topic"
                        disabled={reEmbeddingId === article.id}
                        onClick={() => handleRegenerate('help_topics_kb', article.id)}
                      >
                        {reEmbeddingId === article.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Zap className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditArticle(article)}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(article.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit/Create Sheet */}
      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
        <SheetContent className="w-[500px] sm:max-w-[500px]">
          <SheetHeader>
            <SheetTitle>
              {editingArticle ? 'Edit Article' : 'New Article'}
            </SheetTitle>
            <SheetDescription>
              {editingArticle
                ? 'Update the knowledge base article'
                : 'Create a new knowledge base article'}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Article title..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select value={formCategory} onValueChange={setFormCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categories
                    .filter((c) => c !== 'all')
                    .map((category) => (
                      <SelectItem key={category} value={category}>
                        {helpTopicCategoryLabel(category)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="content">Content</Label>
              <Textarea
                id="content"
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder="Article content..."
                rows={10}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input
                id="tags"
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                placeholder="setup, getting-started, account..."
              />
            </div>

            <div className="space-y-2">
              <Label>Scope</Label>
              <Select
                value={formBrokerageScope}
                onValueChange={(v) => setFormBrokerageScope(v as 'platform' | 'brokerage')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="platform">Platform Default (All Brokerages)</SelectItem>
                  <SelectItem value="brokerage">This Brokerage Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                className="flex-1"
                onClick={handleSave}
                disabled={isSaving || isEmbedding}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : isEmbedding ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Embedding...
                  </>
                ) : (
                  'Save Article'
                )}
              </Button>
              <Button variant="outline" onClick={() => setIsSheetOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Knowledge Article editor (knowledge_articles) */}
      <Sheet open={isArticleSheetOpen} onOpenChange={setIsArticleSheetOpen}>
        <SheetContent className="w-[560px] sm:max-w-[560px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {editingKnowledgeId ? 'Edit Knowledge Article' : 'New Knowledge Article'}
            </SheetTitle>
            <SheetDescription>
              Articles are embedded on save — the assistant retrieves published
              ones when answering.
            </SheetDescription>
          </SheetHeader>

          {isLoadingArticle ? (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="art-title">Title</Label>
                <Input
                  id="art-title"
                  value={artTitle}
                  onChange={(e) => setArtTitle(e.target.value)}
                  placeholder="Article title..."
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="art-slug">Slug</Label>
                <Input
                  id="art-slug"
                  value={artSlug}
                  onChange={(e) => setArtSlug(e.target.value)}
                  placeholder={artTitle ? slugify(artTitle) : 'auto-generated-from-title'}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={artCategory} onValueChange={setArtCategory}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ARTICLE_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c.replace(/_/g, ' ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={artStatus}
                    onValueChange={(v) => setArtStatus(v as ArticleStatus)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="published">Published</SelectItem>
                      {editingKnowledgeId && (
                        <SelectItem value="archived">Archived</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="art-excerpt">Excerpt</Label>
                <Input
                  id="art-excerpt"
                  value={artExcerpt}
                  onChange={(e) => setArtExcerpt(e.target.value)}
                  placeholder="One-line summary shown in the help centre..."
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="art-content">Content</Label>
                <Textarea
                  id="art-content"
                  value={artContent}
                  onChange={(e) => setArtContent(e.target.value)}
                  placeholder="Article content the AI will learn from..."
                  rows={12}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="art-tags">Tags (comma-separated)</Label>
                <Input
                  id="art-tags"
                  value={artTags}
                  onChange={(e) => setArtTags(e.target.value)}
                  placeholder="listing, compliance, disclosure..."
                />
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  className="flex-1"
                  onClick={handleSaveKnowledgeArticle}
                  disabled={isSavingArticle}
                >
                  {isSavingArticle ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving &amp; embedding...
                    </>
                  ) : (
                    'Save Article'
                  )}
                </Button>
                <Button variant="outline" onClick={() => setIsArticleSheetOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
