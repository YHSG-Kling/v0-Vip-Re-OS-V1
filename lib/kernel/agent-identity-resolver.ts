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
 *     ai_video_projects.agent_id, podcast_episodes.agent_id,
 *     agent_intro_videos.agent_id (m121),
 *     listing_promo_videos.agent_id (m124),
 *     newsletter_video_renders.agent_id (m127)
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

/** Brand a raw string as an AgentRecordId. Use only when the caller has
 *  verified the source (e.g., reading `contacts.agent_id`). */
export function asAgentRecordId(s: string): AgentRecordId { return s as AgentRecordId }
/** Brand a raw string as a UserAgentId. Use only when the caller has
 *  verified the source (e.g., reading `users.id`). */
export function asUserAgentId(s: string):  UserAgentId   { return s as UserAgentId }

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

/** For tests + cron resets — clears the in-process caches. */
export function _resetAgentIdentityCaches(): void {
  agentToUserCache.clear()
  userToAgentCache.clear()
}
