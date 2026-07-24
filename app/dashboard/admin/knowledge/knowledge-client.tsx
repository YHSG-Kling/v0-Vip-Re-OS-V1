'use client'

import { useState, useTransition } from 'react'
import {
  searchKnowledge,
  buildRAGContext,
  createKnowledgeArticle,
  deleteKnowledgeArticle,
  regenerateEmbedding,
  backfillAllEmbeddings,
} from '@/app/actions/knowledge/search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Search, Plus, Trash2, RefreshCw, FileText } from 'lucide-react'

type Article = {
  id: string
  title: string
  slug: string
  category: string | null
  status: string | null
  content: string
  tags: string[] | null
  content_embedding: unknown | null
  updated_at: string | null
  brokerage_id: string | null
}

type QueueStatus = { pending: number; processing: number; completed: number; failed: number }

interface Props {
  initialArticles: Article[]
  queueStatus: QueueStatus
}

const emptyForm = () => ({ title: '', slug: '', category: 'general', content: '', tags: '', status: 'published' as 'draft' | 'published' })

export function KnowledgeManagementClient({ initialArticles, queueStatus }: Props) {
  const [activeTab, setActiveTab] = useState<'articles' | 'search' | 'playground'>('articles')

  // ── Articles state ──
  const [articles, setArticles] = useState<Article[]>(initialArticles)
  const [queue, setQueue] = useState<QueueStatus>(queueStatus)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm())
  const [formError, setFormError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  // ── Search / playground state ──
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    const slug = (form.slug || form.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (!form.title.trim() || !form.content.trim() || !slug) {
      setFormError('Title and content are required.')
      return
    }
    startTransition(async () => {
      try {
        const created = await createKnowledgeArticle({
          title: form.title.trim(),
          slug,
          content: form.content.trim(),
          category: form.category.trim() || 'general',
          tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
          status: form.status,
        })
        setArticles(prev => [created as Article, ...prev])
        // The create queued an embedding (queueForEmbedding) — reflect it live.
        setQueue(q => ({ ...q, pending: q.pending + 1 }))
        setForm(emptyForm())
        setShowForm(false)
      } catch (err: any) {
        setFormError(err?.message ?? 'Failed to create article')
      }
    })
  }

  function handleDelete(id: string) {
    setBusyId(id)
    startTransition(async () => {
      try {
        await deleteKnowledgeArticle(id)
        setArticles(prev => prev.filter(a => a.id !== id))
      } catch (err: any) {
        setFormError(err?.message ?? 'Failed to delete (platform articles are read-only for tenants).')
      } finally {
        setBusyId(null)
      }
    })
  }

  function handleReembed(id: string) {
    setBusyId(id)
    startTransition(async () => {
      try {
        await regenerateEmbedding('knowledge_articles', id)
      } catch { /* surfaced via queue on refresh */ } finally {
        setBusyId(null)
      }
    })
  }

  function handleBackfill() {
    startTransition(async () => {
      try {
        await backfillAllEmbeddings()
        setQueue(q => ({ ...q, pending: q.pending }))
      } catch { /* best-effort */ }
    })
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setLoading(true)
    try {
      const results = await searchKnowledge(searchQuery, { limit: 10 })
      setSearchResults(results || [])
    } catch (error) {
      console.error('Search failed:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleRAGContext = async () => {
    if (!searchQuery.trim()) return
    setLoading(true)
    try {
      const context = await buildRAGContext(searchQuery, { maxResults: 5 })
      setSearchResults([{ id: 'rag-context', title: 'RAG Context', content: context || '(no matching knowledge — the AI would answer from brand voice alone)', type: 'rag' }])
    } catch (error) {
      console.error('RAG context failed:', error)
    } finally {
      setLoading(false)
    }
  }

  const embedded = articles.filter(a => a.content_embedding != null).length

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
        <TabsList>
          <TabsTrigger value="articles">Articles</TabsTrigger>
          <TabsTrigger value="search">Semantic Search</TabsTrigger>
          <TabsTrigger value="playground">RAG Playground</TabsTrigger>
        </TabsList>

        {/* ── ARTICLES: upload + manage the AI's knowledge corpus ── */}
        <TabsContent value="articles" className="space-y-4">
          {/* Embedding status */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Articles" value={articles.length} />
            <StatCard label="Embedded" value={embedded} />
            <StatCard label="Queued" value={queue.pending + queue.processing} />
            <StatCard label="Failed" value={queue.failed} tone={queue.failed > 0 ? 'warn' : undefined} />
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Knowledge Articles</CardTitle>
                <CardDescription>
                  Upload the knowledge that trains your AI. Each article is embedded and retrieved by the assistant
                  (RAG) so answers reflect YOUR brokerage&apos;s facts, policies, and brand — not generic real-estate boilerplate.
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleBackfill} disabled={isPending}>
                  <RefreshCw className="h-4 w-4 mr-1" /> Re-embed all
                </Button>
                <Button size="sm" onClick={() => { setShowForm(s => !s); setFormError(null) }}>
                  <Plus className="h-4 w-4 mr-1" /> New Article
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {showForm && (
                <form onSubmit={handleCreate} className="rounded-lg border border-border p-4 space-y-3 bg-muted/30">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Title</label>
                      <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Our commission structure" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Category</label>
                      <Input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="general" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Content</label>
                    <textarea
                      value={form.content}
                      onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                      rows={6}
                      placeholder="The facts/policies/answers the AI should know. Plain language works best — this is embedded for retrieval."
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Tags (comma-separated)</label>
                      <Input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="commission, listings" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Status</label>
                      <select
                        value={form.status}
                        onChange={e => setForm(f => ({ ...f, status: e.target.value as 'draft' | 'published' }))}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="published">Published (used by the AI)</option>
                        <option value="draft">Draft</option>
                      </select>
                    </div>
                  </div>
                  {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => { setShowForm(false); setFormError(null) }}>Cancel</Button>
                    <Button type="submit" size="sm" disabled={isPending}>
                      {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add to knowledge base'}
                    </Button>
                  </div>
                </form>
              )}

              {articles.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <FileText className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No articles yet. Add your first — it becomes part of the AI&apos;s brain.
                </div>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {articles.map(a => (
                    <div key={a.id} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground truncate">{a.title}</span>
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${a.content_embedding != null ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                            {a.content_embedding != null ? 'Embedded' : 'Pending embed'}
                          </span>
                          {a.status && a.status !== 'published' && (
                            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">{a.status}</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{a.category ?? 'general'} · {a.content.slice(0, 90)}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => handleReembed(a.id)} disabled={busyId === a.id} className="text-xs text-primary hover:underline disabled:opacity-50" title="Regenerate embedding">
                          {busyId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => handleDelete(a.id)} disabled={busyId === a.id} className="text-xs text-destructive hover:underline disabled:opacity-50" title="Delete">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── SEMANTIC SEARCH: search the KNOWLEDGE BASE (not contacts) ── */}
        <TabsContent value="search" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Semantic Search</CardTitle>
              <CardDescription>
                Search your knowledge base by meaning (vector similarity), not keywords — the same retrieval the AI uses.
                This searches ARTICLES &amp; HELP TOPICS, not buyer/seller records.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="What do you want to know?"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
                />
                <Button onClick={handleSearch} disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>
              {searchResults.length > 0 && searchResults[0].type !== 'rag' && (
                <div className="space-y-2">
                  <h3 className="font-semibold">Results ({searchResults.length})</h3>
                  {searchResults.map((result, idx) => (
                    <div key={idx} className="p-3 border rounded-lg space-y-2">
                      <div className="font-medium">{result.title}</div>
                      <div className="text-sm text-muted-foreground">{result.content}</div>
                      {result.similarity !== undefined && (
                        <div className="text-xs text-muted-foreground">Similarity: {(result.similarity * 100).toFixed(1)}%</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── RAG PLAYGROUND: preview what the AI retrieves for a question ── */}
        <TabsContent value="playground" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>RAG Playground</CardTitle>
              <CardDescription>
                Ask a question and see the EXACT knowledge the AI would pull in to answer it. Use this to check whether
                your knowledge base covers a topic — if the context is empty, add an Article so the AI stops guessing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Enter a question for the assistant..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRAGContext() }}
                />
                <Button onClick={handleRAGContext} disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>
              {searchResults.length > 0 && searchResults[0].type === 'rag' && (
                <div className="p-3 border rounded-lg space-y-2 bg-muted/50">
                  <h3 className="font-semibold">Retrieved context</h3>
                  <div className="text-sm whitespace-pre-wrap font-mono">{searchResults[0].content}</div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className={`text-2xl font-semibold ${tone === 'warn' ? 'text-amber-600' : 'text-foreground'}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}
