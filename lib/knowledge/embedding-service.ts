/**
 * L12 Knowledge Management - Embedding Service
 * Handles text embedding generation using OpenAI/Vercel AI Gateway
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { embed, embedMany } from 'ai'
import { createServiceClient } from '@/lib/supabase/service'
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
// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
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
  const supabase = createServiceClient()

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
  const supabase = createServiceClient()

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
  const supabase = createServiceClient()
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
  const supabase = createServiceClient()

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
      await sentinelWrite(supabase, supabase
        .from('embedding_queue')
        .update({ status: 'processing', attempts: item.attempts + 1 })
        .eq('id', item.id), { table: "embedding_queue", flow: "embedding_queue_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

      // Process based on source table
      if (item.source_table === 'help_topics_kb') {
        await updateHelpTopicEmbedding(item.source_id)
      } else if (item.source_table === 'knowledge_articles') {
        await updateArticleEmbedding(item.source_id)
      }

      // Mark as completed
      await sentinelWrite(supabase, supabase
        .from('embedding_queue')
        .update({
          status: 'completed',
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id), { table: "embedding_queue", flow: "embedding_queue_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

      processed++
    } catch (error) {
      // Mark as failed
      await sentinelWrite(supabase, supabase
        .from('embedding_queue')
        .update({
          status: item.attempts + 1 >= 3 ? 'failed' : 'pending',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('id', item.id), { table: "embedding_queue", flow: "embedding_queue_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

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
  const supabase = createServiceClient()

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

  // BATCHED (orphan burn-down, lane E). This loop used to call generateEmbedding
  // once PER TOPIC — one HTTP round-trip to the gateway for every row, on a
  // function whose whole job is "embed everything that has no embedding yet".
  // generateEmbeddings (:33) existed for exactly this and had never been called.
  //
  // Why it matters beyond speed: a backfill over a few hundred topics is the one
  // path here that runs long enough to hit a rate limit or a request cap
  // mid-way, and each failure in the old loop cost a whole topic. embedMany
  // sends the batch in one request, so the provider sees one call instead of N,
  // and the batch either comes back aligned to its input or throws as a unit —
  // no partial silent misalignment between text and vector.
  //
  // The batch is chunked because the input is unbounded: a single request
  // carrying every topic in the table would eventually exceed the provider's
  // payload limit, and a whole-table failure is exactly what a backfill must not
  // do. A chunk that fails is counted and the rest still land.
  const BATCH = 50
  for (let i = 0; i < topics.length; i += BATCH) {
    const chunk = topics.slice(i, i + BATCH)
    const texts = chunk.map((topic) =>
      [topic.title, topic.content, ...(topic.tags || [])].join('\n\n')
    )

    let embeddings: number[][]
    try {
      embeddings = await generateEmbeddings(texts)
    } catch (error) {
      console.error(
        `[EmbeddingService] Batch embed failed for topics ${i}-${i + chunk.length - 1}:`,
        error
      )
      failed += chunk.length
      continue
    }

    // embedMany returns one vector per input, in input order. If that invariant
    // ever breaks, writing anyway would attach the WRONG vector to a topic —
    // a search result that is confidently about something else — so refuse the
    // chunk instead.
    if (embeddings.length !== chunk.length) {
      console.error(
        `[EmbeddingService] Batch returned ${embeddings.length} embeddings for ${chunk.length} topics — refusing to write a possibly misaligned batch`
      )
      failed += chunk.length
      continue
    }

    for (let j = 0; j < chunk.length; j++) {
      const topic = chunk[j]
      // supabase-js RESOLVES a refused write — check the error, or a topic that
      // was never actually updated is counted as backfilled and never retried.
      const { error: updateError } = await supabase
        .from('help_topics_kb')
        .update({
          content_embedding: `[${embeddings[j].join(',')}]`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', topic.id)

      if (updateError) {
        console.error(
          `[EmbeddingService] Failed to store embedding for topic ${topic.id}:`,
          updateError.message
        )
        failed++
      } else {
        processed++
      }
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
  const supabase = createServiceClient()
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
  const supabase = createServiceClient()
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

// ============================================================================
// RULING 13 — "ALL COPY ON THE OS CAN BE FOUND BY AN AI SEARCH" (wave 149, lane 149E; contract C31, second sentence).
// ============================================================================
//
// This file is the OS's own AI-search survivor (ragSearch over help_topics_kb + knowledge_articles, read into prompts by
// app/actions/knowledge/search.ts buildRAGContext — the office assistant's retrieval). It saw ONLY the two KB tables: the
// tenant's blog posts, social posts, lead-magnet landing pages and published video pages were invisible to the assistant
// that is meant to know the business. The federated reader below EXTENDS it (kept in this module rather than a new one so
// the CRM entry's proxy graph does not grow — app/crm/page.tsx reaches this file through ai-chat → knowledge/search).
//
// TWO HALVES, ONE SOURCE LIST:
//   1. External AI search finds the PUBLIC copy through app/robots.ts (AI crawlers welcomed), app/sitemap.ts and
//      app/llms.txt/route.ts. `OS_COPY_SOURCES` names, for every copy-bearing table, the public route it is served at (or
//      null when the copy is never public); scripts/search-visibility-guard.ts holds sitemap + llms.txt to
//      PUBLIC_COPY_ROUTES, so a public surface added to one and forgotten in the other is a red guard.
//   2. The OS's own AI search: `searchOsCopy` is READ-TIME and stores nothing — no second index, no copy that can go stale.
//      Lexical (ilike + a term-hit score) for the non-KB sources; embedding them would need a vector column per table or a
//      projection table (see the lane notes' blind spots). Tenant-pinned on every read; platform-authored help
//      (brokerage_id NULL) is read in a SEPARATE query, never through an OR that could widen past the tenant.

type OsCopyDb = { from: (table: string) => any }

export type OsCopySourceTable = "blog_posts" | "social_posts" | "lead_capture_forms" | "ai_video_projects" | "help_topics_kb" | "knowledge_articles"

export interface OsCopySource {
  table: OsCopySourceTable
  kind: "page" | "post" | "magnet" | "help"
  /** Columns searched (text only). */
  textColumns: string[]
  titleColumn: string
  /** The public route prefix this copy is served at, or null when the copy is never public. */
  publicRoute: string | null
  /** How a row becomes public (the predicate sitemap / llms.txt use). */
  publicWhen: string | null
  /** Include platform-authored rows (brokerage_id IS NULL) beside the tenant's own. */
  includePlatformRows: boolean
}

export const OS_COPY_SOURCES: readonly OsCopySource[] = Object.freeze([
  { table: "blog_posts", kind: "post", textColumns: ["title", "excerpt", "content"], titleColumn: "title", publicRoute: "/blog/", publicWhen: "publish_status = 'published' and slug is not null", includePlatformRows: false },
  { table: "social_posts", kind: "post", textColumns: ["content", "post_brief"], titleColumn: "post_brief", publicRoute: null, publicWhen: null, includePlatformRows: false },
  { table: "lead_capture_forms", kind: "magnet", textColumns: ["name", "thank_you_message"], titleColumn: "name", publicRoute: "/lm/", publicWhen: "is_active = true and slug is not null", includePlatformRows: false },
  { table: "ai_video_projects", kind: "page", textColumns: ["title", "script_content"], titleColumn: "title", publicRoute: "/v/", publicWhen: "is_published = true and public_slug is not null", includePlatformRows: false },
  { table: "help_topics_kb", kind: "help", textColumns: ["title", "content"], titleColumn: "title", publicRoute: null, publicWhen: null, includePlatformRows: true },
  { table: "knowledge_articles", kind: "help", textColumns: ["title", "excerpt", "content"], titleColumn: "title", publicRoute: null, publicWhen: null, includePlatformRows: false },
])

/** The public routes the sitemap and llms.txt must BOTH list (guard-held). Tenant websites and team sites compose this copy. */
export const PUBLIC_COPY_ROUTES: readonly string[] = Object.freeze([
  ...OS_COPY_SOURCES.map((s) => s.publicRoute).filter((r): r is string => !!r),
  "/site/", "/team/", "/listing/", "/p/",
])

export interface OsCopyHit {
  table: OsCopySourceTable
  kind: OsCopySource["kind"]
  id: string
  title: string
  excerpt: string
  /** Public path when the row is public by its source's predicate; null otherwise (internal copy). */
  url: string | null
  score: number
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "what", "how", "are", "you", "your", "our", "from", "about", "into", "can", "does", "have", "has", "was", "were", "will", "who", "why", "when", "where", "which"])

/** PURE. Query → up to five search terms, stripped of PostgREST filter metacharacters. */
export function searchTerms(query: string): string[] {
  const terms = String(query ?? "").toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, "")).filter((t) => t.length >= 3 && !STOP.has(t))
  return [...new Set(terms)].slice(0, 5)
}

/** PURE. Term-hit score: a title hit counts three times a body hit. Zero means not a match. */
function scoreCopy(terms: readonly string[], title: string, body: string): number {
  const t = title.toLowerCase(), b = body.toLowerCase()
  let s = 0
  for (const term of terms) { if (t.includes(term)) s += 3; if (b.includes(term)) s += 1 }
  return s
}

function excerptAround(body: string, terms: readonly string[], len = 220): string {
  const lower = body.toLowerCase()
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - 60)
  return (start > 0 ? "…" : "") + body.slice(start, start + len).replace(/\s+/g, " ").trim() + (start + len < body.length ? "…" : "")
}

function publicUrl(src: OsCopySource, row: Record<string, any>): string | null {
  if (!src.publicRoute) return null
  if (src.table === "blog_posts") return row.publish_status === "published" && row.slug ? `/blog/${row.slug}` : null
  if (src.table === "lead_capture_forms") return row.is_active === true && row.slug ? `/lm/${row.slug}` : null
  if (src.table === "ai_video_projects") return row.is_published === true && row.public_slug ? `/v/${row.public_slug}` : null
  return null
}

const EXTRA_COLS: Partial<Record<OsCopySourceTable, string[]>> = {
  blog_posts: ["slug", "publish_status"], lead_capture_forms: ["slug", "is_active"], ai_video_projects: ["public_slug", "is_published"],
}

/**
 * Federated search over every OS copy source for ONE tenant. Returns hits ranked by score and the per-source refusals
 * (a refused source is named, never read as "no copy").
 */
export async function searchOsCopy(db: OsCopyDb, input: { brokerageId: string; query: string; limit?: number; sources?: readonly OsCopySourceTable[] }): Promise<{ hits: OsCopyHit[]; refused: string[]; terms: string[] }> {
  const terms = searchTerms(input.query)
  const refused: string[] = []
  if (!input.brokerageId) return { hits: [], refused: ["no tenant"], terms }
  if (terms.length === 0) return { hits: [], refused, terms }
  const limit = Math.max(1, Math.min(input.limit ?? 8, 25))
  const wanted = OS_COPY_SOURCES.filter((s) => !input.sources || input.sources.includes(s.table))

  const perSource = await Promise.all(wanted.map(async (src) => {
    const cols = ["id", ...src.textColumns, ...(EXTRA_COLS[src.table] ?? [])]
    const or = src.textColumns.flatMap((c) => terms.map((t) => `${c}.ilike.%${t}%`)).join(",")
    // Tenant rows, and (for platform-authored help only) the brokerage_id IS NULL rows — two plain reads, never one OR that
    // a malformed filter could widen past the tenant.
    const reads = [db.from(src.table).select(cols.join(", ")).eq("brokerage_id", input.brokerageId).or(or).limit(limit * 3)]
    if (src.includePlatformRows) reads.push(db.from(src.table).select(cols.join(", ")).is("brokerage_id", null).or(or).limit(limit * 3))
    const rows: Array<Record<string, any>> = []
    for (const r of await Promise.all(reads)) {
      if (r.error) { refused.push(`${src.table}: ${r.error.message ?? "refused"}`); continue }
      rows.push(...((r.data ?? []) as Array<Record<string, any>>))
    }
    return rows.map((row) => {
      const title = String(row[src.titleColumn] ?? "").trim() || `(untitled ${src.kind})`
      const body = src.textColumns.filter((c) => c !== src.titleColumn).map((c) => String(row[c] ?? "")).join("\n")
      return { table: src.table, kind: src.kind, id: String(row.id), title: title.slice(0, 160), excerpt: excerptAround(body || title, terms), url: publicUrl(src, row), score: scoreCopy(terms, title, body) }
    }).filter((h) => h.score > 0)
  }))
  const hits = perSource.flat().sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit)
  return { hits, refused, terms }
}

/** PURE. The prompt block buildRAGContext appends — facts the assistant may cite, each with where it lives. */
export function renderOsCopyContext(hits: readonly OsCopyHit[], maxChars = 2400): string {
  if (hits.length === 0) return ""
  let out = "Your own published and drafted copy on the OS (cite the title and where it lives; never invent copy that is not here):\n\n"
  for (const h of hits) {
    const section = `### ${h.title} — ${h.kind} (${h.table}${h.url ? `, public at ${h.url}` : ", internal"})\n${h.excerpt}\n\n`
    if (out.length + section.length > maxChars) break
    out += section
  }
  return out
}
