'use server'

import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import {
  ragSearch,
  semanticSearchHelpTopics,
  semanticSearchArticles,
  updateHelpTopicEmbedding,
  updateArticleEmbedding,
  backfillHelpTopicEmbeddings,
  queueForEmbedding,
} from '@/lib/knowledge/embedding-service'
import { revalidatePath } from 'next/cache'

// ============================================================================
// RAG Search Actions
// ============================================================================

/**
 * Semantic search across all knowledge sources
 */
export async function searchKnowledge(
  query: string,
  options: {
    category?: string
    limit?: number
    threshold?: number
    sources?: ('help_topics' | 'articles')[]
  } = {}
) {
  const { brokerageId } = await getAgentContext()

  const results = await ragSearch(query, {
    brokerageId: brokerageId ?? undefined,
    ...options,
  })

  return results
}

/**
 * Search help topics only
 */
export async function searchHelpTopicsRAG(
  query: string,
  options: {
    category?: string
    limit?: number
    threshold?: number
  } = {}
) {
  const { brokerageId } = await getAgentContext()

  const results = await semanticSearchHelpTopics(query, {
    brokerageId: brokerageId ?? undefined,
    ...options,
  })

  return results
}

/**
 * Search knowledge articles only
 */
export async function searchArticlesRAG(
  query: string,
  options: {
    category?: string
    limit?: number
    threshold?: number
  } = {}
) {
  const { brokerageId } = await getAgentContext()

  const results = await semanticSearchArticles(query, {
    brokerageId: brokerageId ?? undefined,
    ...options,
  })

  return results
}

/**
 * Build RAG context for AI prompts
 */
export async function buildRAGContext(
  query: string,
  options: {
    maxTokens?: number
    maxResults?: number
    category?: string
    sources?: ('help_topics' | 'articles')[]
  } = {}
): Promise<string> {
  const { maxTokens = 3000, maxResults = 5, ...rest } = options

  const results = await searchKnowledge(query, {
    limit: maxResults,
    threshold: 0.6,
    ...rest,
  })

  if (results.length === 0) {
    return ''
  }

  // Build context string
  let context = 'Relevant Knowledge Base Content:\n\n'
  let tokenEstimate = 0

  for (const result of results) {
    const section = `### ${result.title} (${Math.round(result.similarity * 100)}% match)\n${result.content}\n\n`
    const sectionTokens = Math.ceil(section.length / 4)

    if (tokenEstimate + sectionTokens > maxTokens) {
      break
    }

    context += section
    tokenEstimate += sectionTokens
  }

  return context
}

// ============================================================================
// Knowledge Article CRUD Actions
// ============================================================================

/**
 * Get all knowledge articles
 */
export async function getKnowledgeArticles(options: {
  category?: string
  status?: 'draft' | 'published' | 'archived'
  limit?: number
  offset?: number
} = {}) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()
  const { category, status, limit = 50, offset = 0 } = options

  let query = supabase
    .from('knowledge_articles')
    .select('*, author:users(first_name, last_name, email)', { count: 'exact' })
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (category) {
    query = query.eq('category', category)
  }

  if (status) {
    query = query.eq('status', status)
  }

  const { data, count, error } = await query

  if (error) {
    console.error('[KnowledgeSearch] Failed to fetch articles:', error.message)
    throw new Error('Failed to fetch articles')
  }

  return { articles: data || [], total: count || 0 }
}

/**
 * Get a single knowledge article by ID or slug
 */
export async function getKnowledgeArticle(idOrSlug: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Try by ID first
  let { data, error } = await supabase
    .from('knowledge_articles')
    .select('*, author:users(first_name, last_name, email)')
    .eq('id', idOrSlug)
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .single()

  // If not found, try by slug
  if (error && error.code === 'PGRST116') {
    const result = await supabase
      .from('knowledge_articles')
      .select('*, author:users(first_name, last_name, email)')
      .eq('slug', idOrSlug)
      .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      .single()

    data = result.data
    error = result.error
  }

  if (error) {
    console.error('[KnowledgeSearch] Failed to fetch article:', error.message)
    throw new Error('Article not found')
  }

  return data
}

/**
 * Create a new knowledge article
 */
export async function createKnowledgeArticle(input: {
  title: string
  slug: string
  content: string
  excerpt?: string
  category: string
  tags?: string[]
  status?: 'draft' | 'published'
}) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  const { data, error } = await supabase
    .from('knowledge_articles')
    .insert({
      brokerage_id: brokerageId,
      author_id: userId,
      title: input.title,
      slug: input.slug,
      content: input.content,
      excerpt: input.excerpt,
      category: input.category,
      tags: input.tags || [],
      status: input.status || 'draft',
      published_at: input.status === 'published' ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error) {
    console.error('[KnowledgeSearch] Failed to create article:', error.message)
    throw new Error('Failed to create article')
  }

  // Embed SYNCHRONOUSLY so the article is immediately retrievable by the AI
  // (the embedding_queue has no cron drain); queue as a durable fallback.
  try {
    await updateArticleEmbedding(data.id)
  } catch {
    await queueForEmbedding('knowledge_articles', data.id, data.content)
  }

  revalidatePath('/dashboard/settings/knowledge-base')
  return data
}

/**
 * Update a knowledge article
 */
export async function updateKnowledgeArticle(
  id: string,
  input: {
    title?: string
    slug?: string
    content?: string
    excerpt?: string
    category?: string
    tags?: string[]
    status?: 'draft' | 'published' | 'archived'
  }
) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const updateData: Record<string, unknown> = {
    ...input,
    updated_at: new Date().toISOString(),
  }

  // Set published_at when publishing
  if (input.status === 'published') {
    const { data: existing } = await supabase
      .from('knowledge_articles')
      .select('published_at')
      .eq('id', id)
      .single()

    if (!existing?.published_at) {
      updateData.published_at = new Date().toISOString()
    }
  }

  const { data, error } = await supabase
    .from('knowledge_articles')
    .update(updateData)
    .eq('id', id)
    .eq('brokerage_id', brokerageId)
    .select()
    .single()

  if (error) {
    console.error('[KnowledgeSearch] Failed to update article:', error.message)
    throw new Error('Failed to update article')
  }

  // Re-embed synchronously if content changed (queue as durable fallback).
  if (input.content || input.title || input.excerpt || input.tags) {
    try {
      await updateArticleEmbedding(data.id)
    } catch {
      await queueForEmbedding('knowledge_articles', data.id, data.content)
    }
  }

  revalidatePath('/dashboard/settings/knowledge-base')
  return data
}

/**
 * Delete a knowledge article
 */
export async function deleteKnowledgeArticle(id: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { error } = await supabase
    .from('knowledge_articles')
    .delete()
    .eq('id', id)
    .eq('brokerage_id', brokerageId)

  if (error) {
    console.error('[KnowledgeSearch] Failed to delete article:', error.message)
    throw new Error('Failed to delete article')
  }

  revalidatePath('/dashboard/settings/knowledge-base')
  return { success: true }
}

/**
 * Mark article as helpful or not helpful
 */
export async function rateArticle(id: string, helpful: boolean) {
  const supabase = await createClient()

  const column = helpful ? 'helpful_count' : 'not_helpful_count'

  const { error } = await supabase.rpc('increment', {
    row_id: id,
    table_name: 'knowledge_articles',
    column_name: column,
  })

  if (error) {
    // Fallback to manual increment
    const { data: article } = await supabase
      .from('knowledge_articles')
      .select(column)
      .eq('id', id)
      .single()

    if (article) {
      await supabase
        .from('knowledge_articles')
        .update({ [column]: ((article as any)[column] || 0) + 1 })
        .eq('id', id)
    }
  }

  return { success: true }
}

/**
 * Increment view count for an article
 */
export async function trackArticleView(id: string) {
  const supabase = await createClient()

  const { error } = await supabase.rpc('increment', {
    row_id: id,
    table_name: 'knowledge_articles',
    column_name: 'view_count',
  })

  if (error) {
    // Fallback to manual increment
    const { data: article } = await supabase
      .from('knowledge_articles')
      .select('view_count')
      .eq('id', id)
      .single()

    if (article) {
      await supabase
        .from('knowledge_articles')
        .update({ view_count: (article.view_count || 0) + 1 })
        .eq('id', id)
    }
  }
}

// ============================================================================
// Help Topic Actions (Admin)
// ============================================================================

/**
 * Get all help topics
 */
export async function getHelpTopicsAdmin(options: {
  category?: string
  limit?: number
  offset?: number
} = {}) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()
  const { category, limit = 50, offset = 0 } = options

  let query = supabase
    .from('help_topics_kb')
    .select('*', { count: 'exact' })
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .order('category')
    .order('title')
    .range(offset, offset + limit - 1)

  if (category) {
    query = query.eq('category', category)
  }

  const { data, count, error } = await query

  if (error) {
    console.error('[KnowledgeSearch] Failed to fetch help topics:', error.message)
    throw new Error('Failed to fetch help topics')
  }

  return { topics: data || [], total: count || 0 }
}

/**
 * Create a help topic
 */
export async function createHelpTopic(input: {
  topic_key: string
  title: string
  content: string
  category: string
  tags?: string[]
}) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from('help_topics_kb')
    .insert({
      brokerage_id: brokerageId,
      topic_key: input.topic_key,
      title: input.title,
      content: input.content,
      category: input.category,
      tags: input.tags || [],
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error('[KnowledgeSearch] Failed to create help topic:', error.message)
    throw new Error('Failed to create help topic')
  }

  // Embed synchronously so the topic is immediately retrievable (queue fallback).
  try {
    await updateHelpTopicEmbedding(data.id)
  } catch {
    await queueForEmbedding('help_topics_kb', data.id, data.content)
  }

  revalidatePath('/dashboard/settings/knowledge-base')
  return data
}

/**
 * Update a help topic
 */
export async function updateHelpTopic(
  id: string,
  input: {
    topic_key?: string
    title?: string
    content?: string
    category?: string
    tags?: string[]
    is_active?: boolean
  }
) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from('help_topics_kb')
    .update({
      ...input,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .select()
    .single()

  if (error) {
    console.error('[KnowledgeSearch] Failed to update help topic:', error.message)
    throw new Error('Failed to update help topic')
  }

  // Re-embed synchronously if content changed (queue as durable fallback).
  if (input.content || input.title || input.tags) {
    try {
      await updateHelpTopicEmbedding(data.id)
    } catch {
      await queueForEmbedding('help_topics_kb', data.id, data.content)
    }
  }

  revalidatePath('/dashboard/settings/knowledge-base')
  return data
}

/**
 * Delete a help topic
 */
export async function deleteHelpTopic(id: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { error } = await supabase
    .from('help_topics_kb')
    .delete()
    .eq('id', id)
    .eq('brokerage_id', brokerageId)

  if (error) {
    console.error('[KnowledgeSearch] Failed to delete help topic:', error.message)
    throw new Error('Failed to delete help topic')
  }

  revalidatePath('/dashboard/settings/knowledge-base')
  return { success: true }
}

// ============================================================================
// Embedding Management Actions (Admin)
// ============================================================================

/**
 * Regenerate embedding for a specific item
 */
export async function regenerateEmbedding(
  sourceTable: 'help_topics_kb' | 'knowledge_articles',
  sourceId: string
) {
  if (sourceTable === 'help_topics_kb') {
    await updateHelpTopicEmbedding(sourceId)
  } else {
    await updateArticleEmbedding(sourceId)
  }

  return { success: true }
}

/**
 * Backfill all missing embeddings
 */
export async function backfillAllEmbeddings() {
  const result = await backfillHelpTopicEmbeddings()
  return result
}

/**
 * Get embedding queue status
 */
export async function getEmbeddingQueueStatus() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('embedding_queue')
    .select('status')

  if (error) {
    console.error('[KnowledgeSearch] Failed to get queue status:', error.message)
    return { pending: 0, processing: 0, completed: 0, failed: 0 }
  }

  const counts = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  }

  for (const item of data || []) {
    counts[item.status as keyof typeof counts]++
  }

  return counts
}
