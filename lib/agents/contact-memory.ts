/**
 * lib/agents/contact-memory.ts
 *
 * Vector recall layer for per-entity Managed Agents AND the existing Portal AI Chat.
 * Two operations:
 *
 *   1. embedContactMemory(...) — write a memory row with its embedding. Called from
 *      the kernel event fanout on every meaningful contact-touching event so the
 *      agents have a growing recall corpus per (entity_type, entity_id).
 *
 *   2. recallContactMemory(...) — vector similarity search scoped to a single
 *      entity. Called as a custom tool by Managed Agents AND as a server action by
 *      the portal chat backend so both surfaces share the same recall.
 *
 * Embedding model: OpenAI text-embedding-3-small (1536 dims) — matches the existing
 * `help_topics_kb` + `knowledge_articles` convention.
 *
 * Single-egress note: this helper uses the OpenAI SDK directly to match the existing
 * kb-search.ts pattern. A follow-up will migrate ALL embedding calls (kb + here) to
 * the Vercel AI Gateway's /v1/embeddings endpoint via callConnector.
 */
import "server-only"
import OpenAI from "openai"
import { createServiceClient } from "@/lib/supabase/service"

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

const EMBEDDING_MODEL = "text-embedding-3-small"
const EMBEDDING_DIMS  = 1536

export type MemoryKind =
  | "transparency_update"
  | "portal_message"
  | "agent_note"
  | "showing_feedback"
  | "persona_signal"
  | "preference"
  | "bba_event"
  | "agent_message"

export type MemoryEntityType = "contact" | "transaction" | "listing"

export interface EmbedMemoryInput {
  brokerageId:  string
  entityType:   MemoryEntityType
  entityId:     string
  memoryKind:   MemoryKind
  /** Short text — keep ≤ 1000 chars for retrieval quality. Caller should split longer source content. */
  content:      string
  sourceTable?: string
  sourceId?:    string
  metadata?:    Record<string, unknown>
}

export interface EmbedMemoryResult {
  ok:        boolean
  memoryId?: string
  error?:    string
}

/**
 * Embed + persist a single memory row. Never-throws; returns {ok:false,error} on
 * any failure so kernel fanout callers don't break primary writes.
 */
export async function embedContactMemory(input: EmbedMemoryInput): Promise<EmbedMemoryResult> {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, error: "OPENAI_API_KEY not configured" }
  }
  const trimmed = (input.content ?? "").trim()
  if (!trimmed) return { ok: false, error: "empty content" }
  // Cap embedded input — long text degrades retrieval quality and costs more.
  const truncated = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed

  let embedding: number[]
  try {
    const res = await getOpenAI().embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
    })
    embedding = res.data[0]?.embedding ?? []
  } catch (e) {
    return { ok: false, error: `embedding failed: ${(e as Error).message}` }
  }
  if (embedding.length !== EMBEDDING_DIMS) {
    return { ok: false, error: `embedding dimension mismatch: got ${embedding.length}, expected ${EMBEDDING_DIMS}` }
  }

  const svc = createServiceClient()
  const { data, error } = await svc.from("contact_memory").insert({
    brokerage_id: input.brokerageId,
    entity_type:  input.entityType,
    entity_id:    input.entityId,
    memory_kind:  input.memoryKind,
    content:      truncated,
    // pgvector accepts an array of numbers via the Postgres extension; supabase-js
    // serializes this correctly when the column type is `vector`.
    embedding:    embedding as unknown as string,
    source_table: input.sourceTable ?? null,
    source_id:    input.sourceId    ?? null,
    metadata:     input.metadata    ?? {},
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  return { ok: true, memoryId: data.id as string }
}

export interface RecallInput {
  brokerageId:  string
  entityType:   MemoryEntityType
  entityId:     string
  query:        string
  /** Max rows returned. Default 5; cap at 20 to keep agent context manageable. */
  k?:           number
  /** Optional kind filter (e.g. only "showing_feedback" + "preference"). */
  memoryKinds?: MemoryKind[]
}

export interface RecallMemoryRow {
  id:         string
  memoryKind: MemoryKind
  content:    string
  createdAt:  string
  similarity: number
  metadata:   Record<string, unknown>
}

export interface RecallResult {
  ok:      boolean
  memories: RecallMemoryRow[]
  error?:  string
}

/**
 * Vector similarity search scoped to one entity. Returns ranked memories with
 * cosine similarity scores (higher = more similar). The brokerage_id filter is
 * NON-NEGOTIABLE — never search across brokerages.
 */
export async function recallContactMemory(input: RecallInput): Promise<RecallResult> {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, memories: [], error: "OPENAI_API_KEY not configured" }
  }
  const k     = Math.min(20, Math.max(1, input.k ?? 5))
  const query = (input.query ?? "").trim()
  if (!query) return { ok: true, memories: [] }

  let qEmbedding: number[]
  try {
    const res = await getOpenAI().embeddings.create({
      model: EMBEDDING_MODEL,
      input: query,
    })
    qEmbedding = res.data[0]?.embedding ?? []
  } catch (e) {
    return { ok: false, memories: [], error: `query embedding failed: ${(e as Error).message}` }
  }

  const svc = createServiceClient()
  // Use the <=> cosine distance operator from pgvector; smaller is more similar, so
  // similarity = 1 - distance. Filter by brokerage + entity in SQL so the planner
  // restricts the IVFFlat probe to the entity-scoped subset (idx_contact_memory_entity).
  const { data, error } = await svc.rpc("contact_memory_recall", {
    p_brokerage_id: input.brokerageId,
    p_entity_type:  input.entityType,
    p_entity_id:    input.entityId,
    p_query_embedding: qEmbedding as unknown as string,
    p_k: k,
    p_memory_kinds: input.memoryKinds ?? null,
  })
  if (error) return { ok: false, memories: [], error: error.message }

  const memories: RecallMemoryRow[] = (data ?? []).map((r: any) => ({
    id:         r.id as string,
    memoryKind: r.memory_kind as MemoryKind,
    content:    r.content as string,
    createdAt:  r.created_at as string,
    similarity: typeof r.similarity === "number" ? r.similarity : 0,
    metadata:   (r.metadata ?? {}) as Record<string, unknown>,
  }))

  return { ok: true, memories }
}
