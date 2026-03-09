/**
 * L12 Knowledge Management - Embedding Service
 * Handles text embedding generation using OpenAI/Vercel AI Gateway
 */

import { embed, embedMany } from 'ai'
import { createClient } from '@/lib/supabase/server'
import { createHash } from 'crypto'

// Configuration
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536
const MAX_TOKENS = 8191

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // Truncate if too long (rough estimate: 1 token ≈ 4 chars)
  const truncatedText = text.slice(0, MAX_TOKENS * 4)

  const { embedding } = await embed({
    model: EMBEDDING_MODEL,
    value: truncatedText,
  })

  return embedding
}

/**
 * Generate embeddings for multiple texts (batch)
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  // Truncate each text
  const truncatedTexts = texts.map(t => t.slice(0, MAX_TOKENS * 4))

  const { embeddings } = await embedMany({
    model: EMBEDDING_MODEL,
    values: truncatedTexts,
  })

  return embeddings
}

/**
 * Hash content for change detection
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Update embedding for a help topic
 */
export async function updateHelpTopicEmbedding(topicId: string): Promise<void> {
  const supabase = await createClient()

  // Fetch the topic
  const { data: topic, error: fetchError } = await supabase
    .from('help_topics_kb')
    .select('title, content, tags')
    .eq('id', topicId)
    .single()

  if (fetchError || !topic) {
    throw new Error(`Failed to fetch topic ${topicId}: ${fetchError?.message}`)
  }

  // Create searchable text combining title, content, and tags
  const searchableText = [
    topic.title,
    topic.content,
    ...(topic.tags || []),
  ].join('\n\n')

  // Generate embedding
  const embedding = await generateEmbedding(searchableText)

  // Update the topic with embedding
  const { error: updateError } = await supabase
    .from('help_topics_kb')
    .update({
      content_embedding: `[${embedding.join(',')}]`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', topicId)

  if (updateError) {
    throw new Error(`Failed to update embedding for topic ${topicId}: ${updateError.message}`)
  }
}

/**
 * Update embedding for a knowledge article
 */
export async function updateArticleEmbedding(articleId: string): Promise<void> {
  const supabase = await createClient()

  // Fetch the article
  const { data: article, error: fetchError } = await supabase
    .from('knowledge_articles')
    .select('title, content, excerpt, tags, category')
    .eq('id', articleId)
    .single()

  if (fetchError || !article) {
    throw new Error(`Failed to fetch article ${articleId}: ${fetchError?.message}`)
  }

  // Create searchable text
  const searchableText = [
    article.title,
    article.excerpt || '',
    article.content,
    article.category,
    ...(article.tags || []),
  ].join('\n\n')

  // Generate embedding
  const embedding = await generateEmbedding(searchableText)

  // Update the article with embedding
  const { error: updateError } = await supabase
    .from('knowledge_articles')
    .update({
      content_embedding: `[${embedding.join(',')}]`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', articleId)

  if (updateError) {
    throw new Error(`Failed to update embedding for article ${articleId}: ${updateError.message}`)
  }
}

/**
 * Queue an item for embedding generation
 */
export async function queueForEmbedding(
  sourceTable: 'help_topics_kb' | 'knowledge_articles',
  sourceId: string,
  content: string
): Promise<void> {
  const supabase = await createClient()
  const contentHash = hashContent(content)

  const { error } = await supabase
    .from('embedding_queue')
    .upsert(
      {
        source_table: sourceTable,
        source_id: sourceId,
        content_hash: contentHash,
        status: 'pending',
        attempts: 0,
      },
      { onConflict: 'source_table,source_id' }
    )

  if (error) {
    console.error('[EmbeddingService] Failed to queue item:', error.message)
  }
}

/**
 * Process pending embeddings from the queue
 */
export async function processPendingEmbeddings(limit: number = 10): Promise<{
  processed: number
  failed: number
}> {
  const supabase = await createClient()

  // Fetch pending items
  const { data: pending, error: fetchError } = await supabase
    .from('embedding_queue')
    .select('*')
    .eq('status', 'pending')
    .lt('attempts', 3)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (fetchError || !pending) {
    console.error('[EmbeddingService] Failed to fetch queue:', fetchError?.message)
    return { processed: 0, failed: 0 }
  }

  let processed = 0
  let failed = 0

  for (const item of pending) {
    try {
      // Mark as processing
      await supabase
        .from('embedding_queue')
        .update({ status: 'processing', attempts: item.attempts + 1 })
        .eq('id', item.id)

      // Process based on source table
      if (item.source_table === 'help_topics_kb') {
        await updateHelpTopicEmbedding(item.source_id)
      } else if (item.source_table === 'knowledge_articles') {
        await updateArticleEmbedding(item.source_id)
      }

      // Mark as completed
      await supabase
        .from('embedding_queue')
        .update({
          status: 'completed',
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      processed++
    } catch (error) {
      // Mark as failed
      await supabase
        .from('embedding_queue')
        .update({
          status: item.attempts + 1 >= 3 ? 'failed' : 'pending',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('id', item.id)

      failed++
    }
  }

  return { processed, failed }
}

/**
 * Backfill embeddings for all existing help topics
 */
export async function backfillHelpTopicEmbeddings(): Promise<{
  total: number
  processed: number
  failed: number
}> {
  const supabase = await createClient()

  // Fetch all topics without embeddings
  const { data: topics, error } = await supabase
    .from('help_topics_kb')
    .select('id, title, content, tags')
    .is('content_embedding', null)
    .eq('is_active', true)

  if (error || !topics) {
    throw new Error(`Failed to fetch topics: ${error?.message}`)
  }

  let processed = 0
  let failed = 0

  for (const topic of topics) {
    try {
      const searchableText = [
        topic.title,
        topic.content,
        ...(topic.tags || []),
      ].join('\n\n')

      const embedding = await generateEmbedding(searchableText)

      await supabase
        .from('help_topics_kb')
        .update({
          content_embedding: `[${embedding.join(',')}]`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', topic.id)

      processed++
    } catch (error) {
      console.error(`[EmbeddingService] Failed to embed topic ${topic.id}:`, error)
      failed++
    }
  }

  return { total: topics.length, processed, failed }
}

/**
 * Semantic search on help topics using vector similarity
 */
export async function semanticSearchHelpTopics(
  query: string,
  options: {
    brokerageId?: string
    category?: string
    limit?: number
    threshold?: number
  } = {}
): Promise<Array<{
  id: string
  topic_key: string
  title: string
  content: string
  category: string
  tags: string[]
  similarity: number
}>> {
  const supabase = await createClient()
  const { brokerageId, limit = 5, threshold = 0.7 } = options

  // Generate embedding for the query
  const queryEmbedding = await generateEmbedding(query)

  // Call the match function
  const { data, error } = await supabase.rpc('match_help_topics', {
    query_embedding: `[${queryEmbedding.join(',')}]`,
    match_threshold: threshold,
    match_count: limit,
    p_brokerage_id: brokerageId || null,
  })

  if (error) {
    console.error('[EmbeddingService] Semantic search failed:', error.message)
    return []
  }

  return data || []
}

/**
 * Semantic search on knowledge articles
 */
export async function semanticSearchArticles(
  query: string,
  options: {
    brokerageId?: string
    category?: string
    limit?: number
    threshold?: number
  } = {}
): Promise<Array<{
  id: string
  title: string
  slug: string
  content: string
  excerpt: string
  category: string
  tags: string[]
  similarity: number
}>> {
  const supabase = await createClient()
  const { brokerageId, category, limit = 5, threshold = 0.7 } = options

  // Generate embedding for the query
  const queryEmbedding = await generateEmbedding(query)

  // Call the match function
  const { data, error } = await supabase.rpc('match_knowledge_articles', {
    query_embedding: `[${queryEmbedding.join(',')}]`,
    match_threshold: threshold,
    match_count: limit,
    p_brokerage_id: brokerageId || null,
    p_category: category || null,
  })

  if (error) {
    console.error('[EmbeddingService] Article search failed:', error.message)
    return []
  }

  return data || []
}

/**
 * Combined RAG search across all knowledge sources
 */
export async function ragSearch(
  query: string,
  options: {
    brokerageId?: string
    category?: string
    limit?: number
    threshold?: number
    sources?: ('help_topics' | 'articles')[]
  } = {}
): Promise<Array<{
  source: 'help_topics' | 'articles'
  id: string
  title: string
  content: string
  category: string
  tags: string[]
  similarity: number
}>> {
  const { sources = ['help_topics', 'articles'], limit = 5, ...rest } = options
  const results: Array<{
    source: 'help_topics' | 'articles'
    id: string
    title: string
    content: string
    category: string
    tags: string[]
    similarity: number
  }> = []

  // Search help topics
  if (sources.includes('help_topics')) {
    const helpResults = await semanticSearchHelpTopics(query, { ...rest, limit })
    results.push(
      ...helpResults.map(r => ({
        source: 'help_topics' as const,
        id: r.id,
        title: r.title,
        content: r.content,
        category: r.category,
        tags: r.tags,
        similarity: r.similarity,
      }))
    )
  }

  // Search articles
  if (sources.includes('articles')) {
    const articleResults = await semanticSearchArticles(query, { ...rest, limit })
    results.push(
      ...articleResults.map(r => ({
        source: 'articles' as const,
        id: r.id,
        title: r.title,
        content: r.content,
        category: r.category,
        tags: r.tags,
        similarity: r.similarity,
      }))
    )
  }

  // Sort by similarity and take top results
  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
}
