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
import { embedAndStore } from '@/lib/intelligence/kb-search'
import { isPlatformStaffIdentity } from '@/lib/auth/resolve-user-role'
import { isStorableHelpTopicCategory, HELP_TOPIC_CATEGORIES } from '@/lib/knowledge/help-topic-categories'
import { revalidatePath } from 'next/cache'

// ============================================================================
// Shared helpers for the admin CRUD below
// ============================================================================

/**
 * Platform staff may write topics with brokerage_id NULL — rows EVERY tenant
 * reads. Resolved from the users row rather than trusted from the client.
 */
async function callerIsPlatformStaff(): Promise<boolean> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return false
  const { data } = await supabase
    .from('users')
    .select('user_type, platform_role')
    .eq('id', user.id)
    .maybeSingle()
  return isPlatformStaffIdentity(data?.user_type ?? null, data?.platform_role ?? null)
}

/** help_topics_kb.topic_key is a stable handle; derive one when none is typed. */
function deriveTopicKey(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return slug || 'untitled_topic'
}

/**
 * Embed through embedAndStore — NOT updateHelpTopicEmbedding directly.
 *
 * Both ultimately call the same canonical embedder, but embedAndStore also
 * emits KB_ARTICLE_EMBEDDED. Calling the inner function meant a topic created
 * from the admin screen was embedded WITHOUT the kernel event, while one
 * embedded through /api/intelligence/kb/embed got it — the same write with two
 * different observable outcomes. One path now.
 *
 * Returns whether the embedding landed, so the caller can tell the admin the
 * truth: an article that saved but did not embed is invisible to the AI, and
 * reporting that as plain success is how it stays invisible.
 */
async function embedNow(id: string, content: string): Promise<boolean> {
  try {
    await embedAndStore(id)
    return true
  } catch (err) {
    console.error('[KnowledgeSearch] Embedding failed, queuing as fallback:', err)
    await queueForEmbedding('help_topics_kb', id, content)
    return false
  }
}

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

  // A NULL brokerage produced the literal filter `brokerage_id.eq.null`, which
  // PostgREST rejects (22P02) — the admin screen would have shown "Failed to
  // fetch articles" for anyone not attached to a brokerage instead of the
  // platform-wide rows they are entitled to see.
  const scopeFilter = brokerageId
    ? `brokerage_id.is.null,brokerage_id.eq.${brokerageId}`
    : 'brokerage_id.is.null'

  let query = supabase
    .from('knowledge_articles')
    .select('*, author:users(first_name, last_name, email)', { count: 'exact' })
    .or(scopeFilter)
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

  // Same NULL-brokerage guard as getKnowledgeArticles — `brokerage_id.eq.null`
  // is not a filter PostgREST accepts.
  const scopeFilter = brokerageId
    ? `brokerage_id.is.null,brokerage_id.eq.${brokerageId}`
    : 'brokerage_id.is.null'

  // Try by ID first
  let { data, error } = await supabase
    .from('knowledge_articles')
    .select('*, author:users(first_name, last_name, email)')
    .eq('id', idOrSlug)
    .or(scopeFilter)
    .single()

  // If not found, try by slug
  if (error && error.code === 'PGRST116') {
    const result = await supabase
      .from('knowledge_articles')
      .select('*, author:users(first_name, last_name, email)')
      .eq('slug', idOrSlug)
      .or(scopeFilter)
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

  // OWNERSHIP IS DECIDED ON THE ROW THAT IS ACTUALLY THERE.
  // The filter used to be `.eq('brokerage_id', brokerageId)`, which can never
  // match a PLATFORM article (brokerage_id IS NULL) — editing one affected zero
  // rows and `.single()` then failed with a generic "Failed to update article".
  // Same defect deleteHelpTopic already documents, one table over.
  const { data: article, error: readError } = await supabase
    .from('knowledge_articles')
    .select('id, brokerage_id')
    .eq('id', id)
    .maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!article) throw new Error('That article was not found')
  if (article.brokerage_id === null) {
    if (!(await callerIsPlatformStaff())) {
      throw new Error('Only platform staff can edit a platform-wide article')
    }
  } else if (article.brokerage_id !== brokerageId) {
    throw new Error('That article belongs to another brokerage')
  }

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

  // Decide on the row that exists — see updateKnowledgeArticle. A delete keyed
  // on brokerage_id reported success while removing nothing for platform rows.
  const { data: article, error: readError } = await supabase
    .from('knowledge_articles')
    .select('id, brokerage_id')
    .eq('id', id)
    .maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!article) throw new Error('That article was not found')
  if (article.brokerage_id === null) {
    if (!(await callerIsPlatformStaff())) {
      throw new Error('Only platform staff can delete a platform-wide article')
    }
  } else if (article.brokerage_id !== brokerageId) {
    throw new Error('That article belongs to another brokerage')
  }

  const { error } = await supabase
    .from('knowledge_articles')
    .delete()
    .eq('id', id)

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
// rateArticle was a DUPLICATE of voteArticleHelpful (app/actions/support.ts),
// which is the one the Help centre actually calls. Both incremented
// knowledge_articles.helpful_count / not_helpful_count. Deleted here, and the
// surviving one took this version's better half: the atomic public.increment
// RPC, instead of the read-modify-write that lost a vote whenever two people
// rated the same article at once.

// trackArticleView was a DUPLICATE of the view bump inside
// app/actions/support.ts:getHelpArticle, which is what the Help centre actually
// calls — exactly the same relationship rateArticle had with voteArticleHelpful
// above, in the same file, resolved the same way.
//
// The survivor is strictly better on every axis, so there was nothing to merge:
//   · it is AUTHENTICATED (getAgentContext + isAuthenticated). This one had no
//     gate at all, and as a "use server" export that made it a public,
//     anonymous, unbounded view-count inflation primitive for any article uuid.
//   · it is TENANT-CHECKED (`data.brokerage_id !== ctx.brokerageId → null`) and
//     published-only. This one bumped any id, in any brokerage, in any status.
//   · its bump is COUPLED to an article actually being read and returned, which
//     is what a view count is supposed to mean. This one counted a view that
//     nobody had.
//
// The one thing this version had that the survivor does not is the
// read-modify-write fallback below the RPC — and that is a defect, not a
// capability: it is the same lost-update race that got rateArticle's version
// replaced, and it ran on the session client, where knowledge_articles UPDATE is
// admin-gated, so it would have silently done nothing anyway. Per the rule, the
// implementation was not ported.
//
// public.increment is allowlisted server-side (verified live: it raises unless
// the (table, column) pair is one of four counters), so the generic RPC this used
// was not itself an "increment any column anywhere" hole. That question, raised in
// docs/orphan-burndown-slice3.md, is now answered and closed.
//
// ⚠️ CENSUS: this is a deliberate capability collapse with the survivor named
// (app/actions/support.ts:getHelpArticle). scripts/orphan-export-baseline.json
// must be re-baselined for it, the same way resumeCampaignSequence was.

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
  topic_key?: string
  title: string
  content: string
  category: string
  tags?: string[]
  /**
   * 'platform' writes brokerage_id NULL — a topic every tenant can read.
   * Only platform staff may do that; a brokerage admin asking for it is
   * REFUSED rather than silently downgraded to their own tenant, because a
   * silent downgrade would look identical to success while publishing the
   * article to nobody but themselves.
   */
  scope?: 'platform' | 'brokerage'
}) {
  const supabase = await createClient()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false as const, error: 'Not signed in' }

  const scope = input.scope ?? 'brokerage'
  const staff = await callerIsPlatformStaff()
  if (scope === 'platform' && !staff) {
    return {
      success: false as const,
      error: 'Only platform staff can publish a platform-wide article',
    }
  }
  if (scope === 'brokerage' && !ctx.brokerageId) {
    return { success: false as const, error: 'No brokerage is attached to this account' }
  }

  // `help_topics_kb.category` carries a live CHECK constraint. A value outside it
  // comes back as a bare Postgres 23514 whose message names a constraint, not a
  // field the admin can act on — so the refusal is made here, in the vocabulary's
  // own terms, and it names the values that ARE storable.
  if (!isStorableHelpTopicCategory(input.category)) {
    return {
      success: false as const,
      error: `"${input.category}" is not a storable help-topic category. Choose one of: ${HELP_TOPIC_CATEGORIES.join(', ')}`,
    }
  }

  const { data, error } = await supabase
    .from('help_topics_kb')
    .insert({
      brokerage_id: scope === 'platform' ? null : ctx.brokerageId,
      topic_key: input.topic_key?.trim() || deriveTopicKey(input.title),
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
    return { success: false as const, error: error.message }
  }

  const embedded = await embedNow(data.id, data.content)

  revalidatePath('/dashboard/settings/knowledge-base')
  return { success: true as const, topic: data, embedded }
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
    scope?: 'platform' | 'brokerage'
  }
) {
  const supabase = await createClient()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false as const, error: 'Not signed in' }

  // Same CHECK, same refusal. `category` is optional on update, so only a
  // supplied one is tested — omitting it leaves the stored value alone.
  if (input.category !== undefined && !isStorableHelpTopicCategory(input.category)) {
    return {
      success: false as const,
      error: `"${input.category}" is not a storable help-topic category. Choose one of: ${HELP_TOPIC_CATEGORIES.join(', ')}`,
    }
  }

  const staff = await callerIsPlatformStaff()

  // Read the row FIRST. A platform row (brokerage_id NULL) is visible to every
  // tenant, so letting a brokerage admin edit one would let any tenant rewrite
  // what every other tenant reads.
  const { data: article, error: readError } = await supabase
    .from('help_topics_kb')
    .select('id, brokerage_id, published_at:updated_at')
    .eq('id', id)
    .maybeSingle()
  if (readError) return { success: false as const, error: readError.message }
  if (!article) return { success: false as const, error: 'That article was not found' }
  if (article.brokerage_id === null && !staff) {
    return { success: false as const, error: 'Only platform staff can edit a platform-wide article' }
  }
  if (article.brokerage_id !== null && article.brokerage_id !== ctx.brokerageId) {
    return { success: false as const, error: 'That article belongs to another brokerage' }
  }

  const { scope, ...fields } = input
  if (scope === 'platform' && !staff) {
    return { success: false as const, error: 'Only platform staff can publish a platform-wide article' }
  }

  const patch: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() }
  if (scope) patch.brokerage_id = scope === 'platform' ? null : ctx.brokerageId

  const { data, error } = await supabase
    .from('help_topics_kb')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('[KnowledgeSearch] Failed to update help topic:', error.message)
    return { success: false as const, error: error.message }
  }

  // Re-embed when anything the embedding is built from changed.
  const embedded =
    input.content || input.title || input.tags ? await embedNow(data.id, data.content) : true

  revalidatePath('/dashboard/settings/knowledge-base')
  return { success: true as const, topic: data, embedded }
}

/**
 * Delete a help topic
 */
export async function deleteHelpTopic(id: string) {
  const supabase = await createClient()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false as const, error: 'Not signed in' }

  // The old version filtered on `.eq('brokerage_id', brokerageId)`, which can
  // never match a platform row (brokerage_id IS NULL) — so deleting a
  // platform-wide article silently affected zero rows and still reported
  // success. Decide on the row that is actually there.
  const { data: article, error: readError } = await supabase
    .from('help_topics_kb')
    .select('id, brokerage_id')
    .eq('id', id)
    .maybeSingle()
  if (readError) return { success: false as const, error: readError.message }
  if (!article) return { success: false as const, error: 'That article was not found' }

  if (article.brokerage_id === null) {
    if (!(await callerIsPlatformStaff())) {
      return { success: false as const, error: 'Only platform staff can delete a platform-wide article' }
    }
  } else if (article.brokerage_id !== ctx.brokerageId) {
    return { success: false as const, error: 'That article belongs to another brokerage' }
  }

  const { error } = await supabase.from('help_topics_kb').delete().eq('id', id)

  if (error) {
    console.error('[KnowledgeSearch] Failed to delete help topic:', error.message)
    return { success: false as const, error: error.message }
  }

  revalidatePath('/dashboard/settings/knowledge-base')
  return { success: true as const }
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
