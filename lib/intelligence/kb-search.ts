import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { emitKernelEvent } from '@/lib/kernel/emit'
import { generateEmbedding, updateHelpTopicEmbedding } from '@/lib/knowledge/embedding-service'

export interface KBResult {
  id: string
  title: string
  content: string
  topic_category: string
  similarity?: number
  tags?: string[]
}

/**
 * Search the knowledge base using vector similarity with ILIKE fallback.
 * The query embedding + the stored embeddings both go through the ONE canonical
 * embedder (lib/knowledge/embedding-service, the AI gateway) — the raw-OpenAI
 * second pipeline was retired; this module keeps only its distinct value (the
 * 0.55 threshold, the ILIKE fallback, and the KBResult shape its callers read).
 */
export async function searchKB(
  query: string,
  brokerageId: string,
  limit = 5
): Promise<KBResult[]> {
  const supabase = createServiceClient()

  try {
    // Step 1: Generate embedding for query (canonical gateway embedder)
    const queryEmbedding = await generateEmbedding(query)

    // Step 2: Vector similarity search — pass the pgvector string literal, the
    // format the canonical pipeline uses.
    const { data: vectorResults, error: vectorError } = await supabase.rpc(
      'match_help_topics',
      {
        query_embedding: `[${queryEmbedding.join(',')}]`,
        p_brokerage_id: brokerageId,
        match_threshold: 0.55,
        match_count: limit,
      }
    )

    if (vectorError) {
      console.error('[kb-search] Vector search error:', vectorError.message)
      // Fall through to ILIKE fallback
    }

    if (vectorResults && vectorResults.length > 0) {
      return vectorResults.map((r: any) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        topic_category: r.category,
        similarity: r.similarity,
        tags: r.tags,
      }))
    }

    // Step 3: Fallback to ILIKE text search
    return await searchKBFallback(query, brokerageId, limit)
  } catch (error) {
    console.error('[kb-search] Embedding generation failed, using fallback:', error)
    // Fallback to ILIKE if embedding fails
    return await searchKBFallback(query, brokerageId, limit)
  }
}

/**
 * ILIKE text search fallback
 */
async function searchKBFallback(
  query: string,
  brokerageId: string,
  limit: number
): Promise<KBResult[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('help_topics_kb')
    .select('id, title, content, topic_category:category, tags')
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .eq('is_active', true)
    .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
    .limit(limit)

  if (error) {
    console.error('[kb-search] ILIKE fallback error:', error.message)
    return []
  }

  return (data || []).map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    topic_category: r.topic_category,
    tags: r.tags,
  }))
}

/**
 * Generate embedding and store for a KB article
 */
export async function embedAndStore(topicId: string): Promise<void> {
  const supabase = createServiceClient()

  // Fetch metadata for the kernel event (title + brokerage scope).
  const { data: topic, error: fetchError } = await supabase
    .from('help_topics_kb')
    .select('id, title, brokerage_id')
    .eq('id', topicId)
    .single()

  if (fetchError || !topic) {
    throw new Error(`Topic not found: ${topicId}`)
  }

  // Embed + store through the ONE canonical pipeline (AI gateway, pgvector
  // literal storage) — no second raw-OpenAI path.
  await updateHelpTopicEmbedding(topicId)

  // Emit through the canonical emitter — INSERT + reactor fan-out in one call.
  await emitKernelEvent({
    event:       KernelEvent.KB_ARTICLE_EMBEDDED,
    brokerageId: topic.brokerage_id,
    entityType:  'kb_article',
    entityId:    topicId,
    metadata: {
      title:           topic.title,
      embedding_model: 'openai/text-embedding-3-small',
      timestamp:       new Date().toISOString(),
    },
  })
}

/**
 * Get articles that need embedding
 */
export async function getArticlesNeedingEmbedding(): Promise<string[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('help_topics_kb')
    .select('id')
    .is('content_embedding', null)
    .eq('is_active', true)

  if (error) {
    console.error('[kb-search] Error fetching articles needing embedding:', error.message)
    return []
  }

  return (data || []).map((r) => r.id)
}
