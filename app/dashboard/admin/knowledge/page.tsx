import { Suspense } from 'react'
import { getKnowledgeArticles, getEmbeddingQueueStatus } from '@/app/actions/knowledge/search'
import { KnowledgeManagementClient } from './knowledge-client'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Knowledge Management | Admin',
  description: 'Manage knowledge base articles and help topics',
}

async function KnowledgeData() {
  const [articlesResult, queueStatus] = await Promise.all([
    getKnowledgeArticles({ limit: 50 }),
    getEmbeddingQueueStatus(),
  ])

  return (
    <KnowledgeManagementClient
      initialArticles={articlesResult.articles ?? []}
      queueStatus={queueStatus}
    />
  )
}

export default function KnowledgeManagementPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Knowledge Management</h1>
        <p className="text-muted-foreground">
          Manage knowledge base articles, help topics, and vector embeddings for RAG-powered AI assistance.
        </p>
      </div>

      <Suspense
        fallback={
          <div className="flex items-center justify-center h-96">
            <div className="animate-pulse text-muted-foreground">Loading knowledge base...</div>
          </div>
        }
      >
        <KnowledgeData />
      </Suspense>
    </div>
  )
}
