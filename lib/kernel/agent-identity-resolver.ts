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
 * For tests + cron resets — clears the in-process caches.
 *
 * KEPT, RECORDED AS A BUILD LINE (orphan burn-down, lane O). It has no caller
 * and no duplicate, and it is not speculative — both caches above memoize
 * NEGATIVE results (`cache.set(key, null)`) for the lifetime of the process, so
 * on a warm serverless instance a users.id that had no `agents` row when it was
 * first asked about stays unresolvable AFTER the agent is created. That is a
 * real staleness window and this function is its remedy.
 *
 * THE BLOCKER, precisely: the correct call site is agent creation — the moment
 * an `agents` row appears or its `user_id` changes — and that lives in
 * app/actions/agents.ts and app/actions/ai-agent-onboarding.ts, both of which
 * are owned by other lanes in this wave. Wiring it from here would collide.
 * Note for whoever wires it: this module is `server-only`, so a plain-tsx
 * simulator cannot import it and the "tests" half of the comment above has
 * never been reachable either.
 */
export function _resetAgentIdentityCaches(): void {
  agentToUserCache.clear()
  userToAgentCache.clear()
}
