/**
 * lib/kernel/agent-identity-resolver.ts
 *
 * Canonical resolver between the two `agent_id` flavors that drift across
 * the schema:
 *
 *   AGENTS-ID columns (FK → agents.id):
 *     contacts.agent_id, listings.agent_id, social_posts.agent_id,
 *     agent_voice_profiles.agent_id,
 *     podcast_show_settings.agent_id (semantic, no FK)
 *
 *   USERS-ID columns (FK → users.id):
 *     the `*_user_id` family — listing_agreements.agent_user_id,
 *     listing_presentations.agent_user_id, workflow_runs.agent_user_id, … —
 *     plus two that do NOT read that way: contacts.source_agent_id and
 *     closing_disclosure.title_agent_id
 *
 * m366 RE-POINTED 20 columns from users(id) to agents(id), including the five
 * this header used to list as users-class: ai_video_projects, podcast_episodes,
 * agent_intro_videos, listing_promo_videos and newsletter_video_renders. After
 * that migration NO column spelled plainly `agent_id` is a users.id — the plain
 * spelling means agents(id) everywhere. scripts/agent-fk-columns.ts holds the
 * authoritative snapshot; this comment is a summary of it, not a second source.
 *
 * Wave 6, 9, 11, 14, 15 each caught FK violations from this confusion.
 * Wave 38 caught the agent_voice_profiles one — its agent_id FKs to
 * agents(id), verified via Supabase MCP against the live constraint.
 * Use these helpers instead of inline lookups so the next producer
 * doesn't re-discover the gotcha.
 *
 * Branded types (AgentRecordId / UserAgentId) make it a type error to
 * pass the wrong one — call sites that resolve through these helpers
 * carry the brand forward into downstream inserts.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

declare const AgentRecordIdBrand: unique symbol
declare const UserAgentIdBrand: unique symbol

/** A row id in the `agents` table (what contacts.agent_id stores). */
export type AgentRecordId = string & { readonly [AgentRecordIdBrand]: true }
/** A row id in the `users` table (what ai_video_projects.agent_id stores). */
export type UserAgentId   = string & { readonly [UserAgentIdBrand]: true }

// ─── REMOVED in the orphan burn-down (lane O) ────────────────────────────────
//
// `asAgentRecordId(s)` and `asUserAgentId(s)` — the two brand constructors —
// DELETED.
// SURVIVORS: `resolveAgentRecordToUserId` and `resolveUserIdToAgentRecord`
// below, which are what actually prevents the id-space slip this file exists
// for. They TRANSLATE at runtime; the constructors only re-labelled a string
// the caller had already decided about, and a wrong decision branded as right
// is worse than an unbranded string.
//
// The discipline they served was never adopted, and could not be: both resolver
// signatures accept `AgentRecordId | string`, so every raw string is already
// admitted and the brand is unenforceable at the boundary that matters. Sixteen
// live call sites across app/actions pass plain `string` — e.g.
// app/actions/listing-lifecycle-core.ts:481 declares
// `const listingAgentRecordId: string` and hands it straight to the resolver —
// and NOT ONE file in the repo imports the `AgentRecordId` / `UserAgentId`
// types. Nothing was lost: the types stay (the resolvers still return them, so
// a resolved id carries the brand forward exactly as the header describes), and
// the only thing gone is the ability to assert a brand without checking it.

/**
 * Resolve an agents.id to the canonical users.id via agents.user_id.
 * Returns null when the agents row doesn't exist or has no user_id.
 *
 * Cached at the module scope for a single process lifetime — the
 * mapping is stable and read-heavy.
 */
const agentToUserCache = new Map<string, string | null>()

export async function resolveAgentRecordToUserId(agentRecordId: AgentRecordId | string): Promise<UserAgentId | null> {
  if (!agentRecordId) return null
  const cached = agentToUserCache.get(agentRecordId)
  if (cached !== undefined) return cached === null ? null : (cached as UserAgentId)
  const svc = createServiceClient()
  try {
    const { data } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", agentRecordId)
      .maybeSingle()
    const userId = (data?.user_id as string | null) ?? null
    agentToUserCache.set(agentRecordId, userId)
    return userId === null ? null : (userId as UserAgentId)
  } catch (e) {
    console.error(`[agent-identity-resolver] lookup failed for agents.id=${agentRecordId}:`, (e as Error).message)
    return null
  }
}

/**
 * Resolve a users.id to the matching agents.id. Less commonly needed —
 * most newer tables already store users.id — but useful when writing into
 * a legacy column like `social_posts.agent_id`.
 */
const userToAgentCache = new Map<string, string | null>()

export async function resolveUserIdToAgentRecord(userAgentId: UserAgentId | string, brokerageId: string): Promise<AgentRecordId | null> {
  if (!userAgentId) return null
  const cacheKey = `${userAgentId}::${brokerageId}`
  const cached = userToAgentCache.get(cacheKey)
  if (cached !== undefined) return cached === null ? null : (cached as AgentRecordId)
  const svc = createServiceClient()
  try {
    const { data } = await svc
      .from("agents")
      .select("id")
      .eq("user_id", userAgentId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    const agentId = (data?.id as string | null) ?? null
    userToAgentCache.set(cacheKey, agentId)
    return agentId === null ? null : (agentId as AgentRecordId)
  } catch (e) {
    console.error(`[agent-identity-resolver] reverse lookup failed for users.id=${userAgentId}, brokerage=${brokerageId}:`, (e as Error).message)
    return null
  }
}

/**
 * ★ THE NEGATIVE-CACHE INVALIDATOR ★ — call this the moment an `agents` row is
 * created, or its `user_id` / `brokerage_id` changes.
 *
 * THE DEFECT IT FIXES, precisely. Both caches above memoize NEGATIVE results
 * (`cache.set(key, null)`) for the lifetime of the process, and a serverless
 * instance stays warm across requests. So the sequence
 *
 *     request 1: resolveUserIdToAgentRecord(u, b) → no row yet → caches null
 *     request 2: createAgent(u, b)                → the row now EXISTS
 *     request 3: resolveUserIdToAgentRecord(u, b) → returns the CACHED null
 *
 * leaves a brand-new agent unresolvable on that instance until it recycles —
 * minutes to hours, and only on some instances, which is the shape of bug that
 * gets reported as "it works for me".
 *
 * PRECISE, NOT A FLUSH. Only the two keys that the new row can have poisoned are
 * dropped: the agents.id key in `agentToUserCache`, and the composite
 * `users.id::brokerage_id` key in `userToAgentCache`. Every other tenant's warm
 * mapping survives, which matters because these caches exist to keep a read-heavy
 * lookup off the database.
 *
 * ─── REMOVED in the orphan burn-down (lane L) ────────────────────────────────
 * `_resetAgentIdentityCaches()` — MERGED-THEN-DELETED. SURVIVOR: this function.
 * It cleared BOTH maps entirely and was described as being "for tests + cron
 * resets". Neither half was reachable: it had no caller anywhere in the tree, and
 * this module imports `server-only`, so the plain-tsx simulators that would have
 * been the "tests" cannot import it at all. Nothing needed merging — a full flush
 * is what this does, minus the collateral damage — and keeping a blunt flush
 * beside a precise invalidator only invites the flush to be called instead.
 */
export function invalidateAgentIdentity(params: {
  /** agents.id of the row that was created or changed, when known. */
  agentRecordId?: string | null
  /** users.id the row points at. */
  userId?: string | null
  /** The tenant the row belongs to — part of the reverse cache's composite key. */
  brokerageId?: string | null
}): void {
  if (params.agentRecordId) agentToUserCache.delete(params.agentRecordId)
  if (params.userId && params.brokerageId) {
    userToAgentCache.delete(`${params.userId}::${params.brokerageId}`)
  }
}
