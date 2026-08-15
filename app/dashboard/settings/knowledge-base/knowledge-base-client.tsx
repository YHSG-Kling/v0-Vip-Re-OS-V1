'use client'

import { useState, useCallback } from 'react'
import useSWR, { mutate } from 'swr'
import { createClient } from '@/lib/supabase/client'
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
} from 'lucide-react'
import { toast } from 'sonner'

interface KBArticle {
  id: string
  title: string
  content: string
  topic_category: string
  tags: string[]
  is_active: boolean
  brokerage_id: string | null
  content_embedding: number[] | null
  created_at: string
  updated_at: string
}

interface KnowledgeBaseClientProps {
  initialArticles: KBArticle[]
  categories: string[]
  brokerageId: string
  userType: string
}

const fetcher = async (url: string) => {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('help_topics_kb')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

export function KnowledgeBaseClient({
  initialArticles,
  categories,
  brokerageId,
  userType,
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

  // Form state
  const [formTitle, setFormTitle] = useState('')
  const [formContent, setFormContent] = useState('')
  const [formCategory, setFormCategory] = useState('general')
  const [formTags, setFormTags] = useState('')
  const [formBrokerageScope, setFormBrokerageScope] = useState<'platform' | 'brokerage'>('platform')

  const { data: articles, isLoading } = useSWR('kb-articles', fetcher, {
    fallbackData: initialArticles,
    refreshInterval: 30000,
  })

  const filteredArticles = (articles || []).filter((article: any) => {
    if (selectedCategory === 'all') return true
    return article.topic_category === selectedCategory
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
    setFormCategory(article.topic_category)
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
    const supabase = createClient()

    try {
      const articleData = {
        title: formTitle.trim(),
        content: formContent.trim(),
        topic_category: formCategory,
        tags: formTags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
        brokerage_id: formBrokerageScope === 'brokerage' ? brokerageId : null,
        is_active: true,
      }

      let savedArticleId: string

      if (editingArticle) {
        // Update existing
        const { error } = await supabase
          .from('help_topics_kb')
          .update(articleData)
          .eq('id', editingArticle.id)

        if (error) throw error
        savedArticleId = editingArticle.id
        toast.success('Article updated successfully')
      } else {
        // Insert new
        const { data, error } = await supabase
          .from('help_topics_kb')
          .insert(articleData)
          .select('id')
          .single()

        if (error) throw error
        savedArticleId = data.id
        toast.success('Article created successfully')
      }

      // Auto-trigger embedding if no embedding exists
      if (!editingArticle?.content_embedding) {
        setIsEmbedding(true)
        try {
          const response = await fetch('/api/intelligence/kb/embed', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET || ''}`,
            },
            body: JSON.stringify({ topicId: savedArticleId }),
          })

          if (response.ok) {
            toast.success('Article embedded for vector search')
          }
        } catch (embedError) {
          console.error('Embedding failed:', embedError)
          // Non-fatal - article is saved even if embedding fails
        }
        setIsEmbedding(false)
      }

      await mutate('kb-articles')
      setIsSheetOpen(false)
    } catch (error: any) {
      console.error('Save error:', error)
      toast.error(error.message || 'Failed to save article')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (articleId: string) => {
    if (!confirm('Are you sure you want to delete this article?')) return

    const supabase = createClient()

    try {
      const { error } = await supabase
        .from('help_topics_kb')
        .delete()
        .eq('id', articleId)

      if (error) throw error
      toast.success('Article deleted')
      await mutate('kb-articles')
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete article')
    }
  }

  const handleBulkEmbed = async () => {
    setIsBulkEmbedding(true)
    try {
      const response = await fetch('/api/intelligence/kb/embed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET || ''}`,
        },
        body: JSON.stringify({ embedAll: true }),
      })

      const result = await response.json()

      if (response.ok) {
        toast.success(`Embedded ${result.embedded} articles (${result.errors} errors)`)
        await mutate('kb-articles')
      } else {
        toast.error(result.error || 'Bulk embedding failed')
      }
    } catch (error) {
      toast.error('Failed to trigger bulk embedding')
    } finally {
      setIsBulkEmbedding(false)
    }
  }

  const handleSearchPreview = async () => {
    if (!searchQuery.trim()) return

    setIsSearching(true)
    try {
      const { searchKB } = await import('@/app/actions/kb-search')
      const results = await searchKB(searchQuery, brokerageId, 3)
      setSearchResults(results)
    } catch (error) {
      console.error('Search preview error:', error)
      toast.error('Search preview failed')
    } finally {
      setIsSearching(false)
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
        <h2 className="mb-4 text-sm font-semibold">Categories</h2>
        <div className="space-y-1">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                selectedCategory === category
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
            >
              {category === 'all' ? 'All Articles' : category.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        {/* Search Preview */}
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-semibold">Search Preview</h2>
          <div className="space-y-2">
            <Input
              placeholder="Test search query..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchPreview()}
            />
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
          </div>

          {searchResults.length > 0 && (
            <div className="mt-3 space-y-2">
              {searchResults.map((result) => (
                <div
                  key={result.id}
                  className="rounded-md border bg-background p-2 text-xs"
                >
                  <p className="font-medium">{result.title}</p>
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
            <Button onClick={openNewArticle}>
              <Plus className="mr-2 h-4 w-4" />
              New Article
            </Button>
          </div>
        </div>

        {/* Article List */}
        {isLoading ? (
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
                          {article.topic_category.replace(/_/g, ' ')}
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
                    <div className="flex items-center gap-2">
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
                        {category.replace(/_/g, ' ')}
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
    </div>
  )
}
