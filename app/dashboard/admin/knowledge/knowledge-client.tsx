'use client'

import { useState } from 'react'
import { searchKnowledge, buildRAGContext } from '@/app/actions/knowledge/search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Search } from 'lucide-react'

export function KnowledgeManagementClient() {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'search' | 'playground'>('search')

  const handleSearch = async () => {
    if (!searchQuery.trim()) return

    setLoading(true)
    try {
      const results = await searchKnowledge(searchQuery, {
        limit: 10,
      })
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
      const context = await buildRAGContext(searchQuery, {
        maxResults: 5,
      })
      setSearchResults([
        {
          id: 'rag-context',
          title: 'RAG Context',
          content: context,
          type: 'rag',
        },
      ])
    } catch (error) {
      console.error('RAG context failed:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Knowledge Management</CardTitle>
          <CardDescription>
            Test semantic search and RAG-powered context retrieval
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <TabsList>
              <TabsTrigger value="search">Semantic Search</TabsTrigger>
              <TabsTrigger value="playground">RAG Playground</TabsTrigger>
            </TabsList>

            <TabsContent value="search" className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Search the knowledge base with semantic vector similarity
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="What do you want to know?"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch()
                  }}
                />
                <Button onClick={handleSearch} disabled={loading}>
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {searchResults.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-semibold">Results ({searchResults.length})</h3>
                  {searchResults.map((result, idx) => (
                    <div key={idx} className="p-3 border rounded-lg space-y-2">
                      <div className="font-medium">{result.title}</div>
                      <div className="text-sm text-muted-foreground">
                        {result.content}
                      </div>
                      {result.similarity !== undefined && (
                        <div className="text-xs text-muted-foreground">
                          Similarity: {(result.similarity * 100).toFixed(1)}%
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="playground" className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Test RAG context building for AI assistant responses
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter a question for the assistant..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRAGContext()
                  }}
                />
                <Button onClick={handleRAGContext} disabled={loading}>
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {searchResults.length > 0 && searchResults[0].type === 'rag' && (
                <div className="p-3 border rounded-lg space-y-2 bg-muted/50">
                  <h3 className="font-semibold">RAG Context</h3>
                  <div className="text-sm whitespace-pre-wrap font-mono">
                    {searchResults[0].content}
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
