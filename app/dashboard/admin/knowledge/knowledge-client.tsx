'use client'

import { useState, useEffect } from 'react'
import {
  createArticle,
  updateArticle,
  deleteArticle,
  triggerEmbeddingQueue,
  testSemanticSearch,
} from '@/app/actions/knowledge/search'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Plus, Edit2, Trash2, Search, RefreshCw, Zap } from 'lucide-react'

interface Article {
  id: string
  topic_key: string
  title: string
  content: string
  category: string
  tags: string[]
  is_active: boolean
  has_embedding?: boolean
  created_at: string
  updated_at: string
}

interface Topic {
  id: string
  topic_key: string
  title: string
  content: string
  category: string
  tags: string[]
  is_active: boolean
  created_at: string
  updated_at: string
}

interface QueueStatus {
  pending: number
  processing: number
  completed: number
  failed: number
}

interface Props {
  initialArticles: Article[]
  initialTopics: Topic[]
  totalArticles: number
  totalTopics: number
  queueStatus: QueueStatus
}

export function KnowledgeManagementClient({
  initialArticles,
  initialTopics,
  totalArticles,
  totalTopics,
  queueStatus,
}: Props) {
  const [articles, setArticles] = useState<Article[]>(initialArticles)
  const [topics, setTopics] = useState<Topic[]>(initialTopics)
  const [loading, setLoading] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'articles' | 'topics' | 'search'>('articles')
  const [formData, setFormData] = useState({
    topic_key: '',
    title: '',
    content: '',
    category: 'general',
    tags: '',
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [embeddingInProgress, setEmbeddingInProgress] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const tagsArray = formData.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      if (editingId) {
        await updateArticle(editingId, {
          ...formData,
          tags: tagsArray,
        })
      } else {
        await createArticle({
          ...formData,
          tags: tagsArray,
        })
      }

      resetForm()
      setIsOpen(false)
    } catch (error) {
      console.error('Failed to save article:', error)
    }
  }

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this article?')) {
      try {
        await deleteArticle(id)
        setArticles(articles.filter((a) => a.id !== id))
      } catch (error) {
        console.error('Failed to delete article:', error)
      }
    }
  }

  const handleEdit = (article: Article) => {
    setFormData({
      topic_key: article.topic_key,
      title: article.title,
      content: article.content,
      category: article.category,
      tags: article.tags.join(', '),
    })
    setEditingId(article.id)
    setIsOpen(true)
  }

  const resetForm = () => {
    setFormData({
      topic_key: '',
      title: '',
      content: '',
      category: 'general',
      tags: '',
    })
    setEditingId(null)
  }

  const handleTriggerEmbedding = async () => {
    setEmbeddingInProgress(true)
    try {
      const result = await triggerEmbeddingQueue()
      alert(`Embedding queue triggered. Processed: ${result.processed}`)
    } catch (error) {
      console.error('Failed to trigger embedding queue:', error)
      alert('Failed to trigger embedding queue')
    } finally {
      setEmbeddingInProgress(false)
    }
  }

  const handleSemanticSearch = async () => {
    if (!searchQuery.trim()) return

    try {
      const results = await testSemanticSearch(
        searchQuery,
        categoryFilter === 'all' ? undefined : categoryFilter
      )
      setSearchResults(results || [])
    } catch (error) {
      console.error('Search failed:', error)
    }
  }

  const filteredArticles =
    categoryFilter === 'all'
      ? articles
      : articles.filter((a) => a.category === categoryFilter)

  return (
    <div className="space-y-6">
      {/* Queue Status Cards */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{queueStatus.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Processing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {queueStatus.processing}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {queueStatus.completed}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Failed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {queueStatus.failed}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle>Knowledge Base</CardTitle>
            <CardDescription>
              Manage help articles and vector embeddings
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleTriggerEmbedding}
              disabled={embeddingInProgress}
              size="sm"
              variant="outline"
            >
              {embeddingInProgress ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Zap className="mr-2 h-4 w-4" />
                  Reindex
                </>
              )}
            </Button>
            <Dialog open={isOpen} onOpenChange={setIsOpen}>
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  onClick={() => resetForm()}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Article
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {editingId ? 'Edit Article' : 'Create Article'}
                  </DialogTitle>
                  <DialogDescription>
                    Add or update a knowledge base article for the AI assistant
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="text-sm font-medium">Topic Key</label>
                    <Input
                      value={formData.topic_key}
                      onChange={(e) =>
                        setFormData({ ...formData, topic_key: e.target.value })
                      }
                      placeholder="e.g., license_upload_process"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Title</label>
                    <Input
                      value={formData.title}
                      onChange={(e) =>
                        setFormData({ ...formData, title: e.target.value })
                      }
                      placeholder="Article title"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Content</label>
                    <Textarea
                      value={formData.content}
                      onChange={(e) =>
                        setFormData({ ...formData, content: e.target.value })
                      }
                      placeholder="Detailed article content"
                      rows={8}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Category</label>
                    <Select
                      value={formData.category}
                      onValueChange={(value) =>
                        setFormData({ ...formData, category: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="license">License</SelectItem>
                        <SelectItem value="brand">Brand</SelectItem>
                        <SelectItem value="tech_stack">Tech Stack</SelectItem>
                        <SelectItem value="training">Training</SelectItem>
                        <SelectItem value="certification">
                          Certification
                        </SelectItem>
                        <SelectItem value="general">General</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">
                      Tags (comma-separated)
                    </label>
                    <Input
                      value={formData.tags}
                      onChange={(e) =>
                        setFormData({ ...formData, tags: e.target.value })
                      }
                      placeholder="e.g., onboarding, workflow, faq"
                    />
                  </div>
                  <div className="flex gap-2 pt-4">
                    <Button type="submit">
                      {editingId ? 'Update' : 'Create'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsOpen(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>

        <CardContent>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <TabsList>
              <TabsTrigger value="articles">
                Articles ({totalArticles})
              </TabsTrigger>
              <TabsTrigger value="topics">Topics ({totalTopics})</TabsTrigger>
              <TabsTrigger value="search">Test Search</TabsTrigger>
            </TabsList>

            {/* Articles Tab */}
            <TabsContent value="articles" className="space-y-4">
              <div className="flex gap-2">
                <Select
                  value={categoryFilter}
                  onValueChange={setCategoryFilter}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    <SelectItem value="license">License</SelectItem>
                    <SelectItem value="brand">Brand</SelectItem>
                    <SelectItem value="tech_stack">Tech Stack</SelectItem>
                    <SelectItem value="training">Training</SelectItem>
                    <SelectItem value="certification">Certification</SelectItem>
                    <SelectItem value="general">General</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Tags</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredArticles.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center py-8 text-muted-foreground"
                        >
                          No articles found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredArticles.map((article) => (
                        <TableRow key={article.id}>
                          <TableCell className="font-medium">
                            {article.title}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {article.category}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {article.tags.slice(0, 2).map((tag, idx) => (
                                <Badge
                                  key={idx}
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  {tag}
                                </Badge>
                              ))}
                              {article.tags.length > 2 && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  +{article.tags.length - 2}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                article.is_active
                                  ? 'default'
                                  : 'secondary'
                              }
                            >
                              {article.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(
                              article.updated_at
                            ).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleEdit(article)}
                              >
                                <Edit2 className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDelete(article.id)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            {/* Topics Tab */}
            <TabsContent value="topics" className="space-y-4">
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topics.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center py-8 text-muted-foreground"
                        >
                          No topics found
                        </TableCell>
                      </TableRow>
                    ) : (
                      topics.map((topic) => (
                        <TableRow key={topic.id}>
                          <TableCell className="font-medium">
                            {topic.title}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {topic.category}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                topic.is_active ? 'default' : 'secondary'
                              }
                            >
                              {topic.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(topic.updated_at).toLocaleDateString()}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            {/* Search Tab */}
            <TabsContent value="search" className="space-y-4">
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Test the semantic search functionality with vector embeddings
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter a search query..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSemanticSearch()
                    }}
                  />
                  <Select
                    value={categoryFilter}
                    onValueChange={setCategoryFilter}
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      <SelectItem value="license">License</SelectItem>
                      <SelectItem value="brand">Brand</SelectItem>
                      <SelectItem value="tech_stack">Tech Stack</SelectItem>
                      <SelectItem value="training">Training</SelectItem>
                      <SelectItem value="certification">
                        Certification
                      </SelectItem>
                      <SelectItem value="general">General</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button onClick={handleSemanticSearch} variant="outline">
                    <Search className="mr-2 h-4 w-4" />
                    Search
                  </Button>
                </div>

                {searchResults.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Search Results:</h3>
                    <div className="space-y-2">
                      {searchResults.map((result, idx) => (
                        <div
                          key={idx}
                          className="p-3 border rounded-lg space-y-1"
                        >
                          <div className="flex items-center justify-between">
                            <div className="font-medium">{result.title}</div>
                            <Badge variant="outline">
                              {Math.round(result.similarity * 100)}% match
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {result.content}
                          </p>
                          <div className="text-xs text-muted-foreground">
                            {result.category}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
