import OpenAI from 'openai'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'

export interface KBResult {
  id: string
  title: string
  content: string
  topic_category: string
  similarity?: number
  tags?: string[]
}

// Lazy initialization to avoid build-time errors when OPENAI_API_KEY is not set
let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  }
  return _openai
}

/**
 * Search the knowledge base using vector similarity with ILIKE fallback
 */
export async function searchKB(
  query: string,
  brokerageId: string,
  limit = 5
): Promise<KBResult[]> {
  const supabase = createServiceClient()

  try {
    // Step 1: Generate embedding for query
    const embeddingResponse = await getOpenAI().embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    })

    const queryEmbedding = embeddingResponse.data[0].embedding

    // Step 2: Vector similarity search
    // Using raw SQL for pgvector cosine distance operator
    const { data: vectorResults, error: vectorError } = await supabase.rpc(
      'match_help_topics',
      {
        query_embedding: queryEmbedding,
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
    .select('id, title, content, topic_category, tags')
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

  // Fetch the article content
  const { data: topic, error: fetchError } = await supabase
    .from('help_topics_kb')
    .select('id, content, title, brokerage_id')
    .eq('id', topicId)
    .single()

  if (fetchError || !topic) {
    throw new Error(`Topic not found: ${topicId}`)
  }

  // Generate embedding
  const embeddingResponse = await getOpenAI().embeddings.create({
    model: 'text-embedding-3-small',
    input: `${topic.title}\n\n${topic.content}`,
  })

  const embedding = embeddingResponse.data[0].embedding

  // Store embedding
  const { error: updateError } = await supabase
    .from('help_topics_kb')
    .update({ content_embedding: embedding })
    .eq('id', topicId)

  if (updateError) {
    throw new Error(`Failed to store embedding: ${updateError.message}`)
  }

  // Log kernel event
  await supabase.from('lifecycle_events').insert({
    brokerage_id: topic.brokerage_id,
    entity_type: 'kb_article',
    entity_id: topicId,
    event_type: KernelEvent.KB_ARTICLE_EMBEDDED,
    metadata: {
      title: topic.title,
      embedding_model: 'text-embedding-3-small',
      timestamp: new Date().toISOString(),
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
