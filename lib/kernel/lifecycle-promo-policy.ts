/**
 * lib/kernel/lifecycle-promo-policy.ts
 *
 * Wave 27 — three-tier opt-in policy for the seven listing-lifecycle
 * promo moments. When a lifecycle event fires, the reactor calls
 * resolveLifecycleAutoSpawn() with the listing's agent + event_type;
 * resolution walks AGENT → TEAM → BROKERAGE → PLATFORM_DEFAULT and
 * returns the first match.
 *
 * Why three tiers, not just brokerage:
 *  · A solo agent on the brokerage tier wants per-agent control without
 *    nagging the broker every time.
 *  · A team lead may want their team to auto-spawn coming-soon promos
 *    (their listings are premium) while the rest of the brokerage stays
 *    on the price-sensitive default.
 *  · A broker controls the brokerage-wide default for legal/policy
 *    reasons (some markets restrict coming-soon advertising; the broker
 *    can disable the moment globally).
 *
 * Platform defaults match Wave 27's recommended split: high-value
 * moments default ON, sensitive moments default OFF. Subscribers
 * override via the UI (lifecycle_promo_policy upsert).
 *
 * Cooldowns: when the resolver returns auto_spawn=true, it ALSO returns
 * the effective cooldown_hours. The reactor uses this to debounce
 * rapid-fire events (e.g. a listing whose price gets edited three times
 * in a day only fires one price_reduction promo).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type LifecycleEventType =
  | "coming_soon"
  | "just_listed"
  | "open_house_announce"
  | "open_house_reminder"
  | "price_reduction"
  | "under_contract"
  | "just_sold"

interface PlatformDefault {
  autoSpawn:     boolean
  cooldownHours: number | null
}

/** Hard-coded platform defaults — the bottom of the resolution chain.
 *  Subscribers' overrides land in lifecycle_promo_policy. Changing
 *  these defaults requires a code change (intentional — they're
 *  brand-level decisions). */
const PLATFORM_DEFAULTS: Record<LifecycleEventType, PlatformDefault> = {
  coming_soon:         { autoSpawn: false, cooldownHours: null }, // agent opts in per listing
  just_listed:         { autoSpawn: true,  cooldownHours: null },
  open_house_announce: { autoSpawn: true,  cooldownHours: null },
  open_house_reminder: { autoSpawn: true,  cooldownHours: null }, // T-24h, single fire per event
  price_reduction:     { autoSpawn: false, cooldownHours: 24 },   // sensitive AND debounced
  under_contract:      { autoSpawn: true,  cooldownHours: null },
  just_sold:           { autoSpawn: true,  cooldownHours: null },
}

export interface ResolveScope {
  /** users.id of the listing agent (resolved upstream from listings.agent_id). */
  agentUserId: string
  brokerageId: string
}

export interface PolicyDecision {
  autoSpawn:      boolean
  cooldownHours:  number | null
  /** Where the resolution landed — useful for observability + the UI's
   *  "this setting is inherited from your team" indicator. */
  resolvedFrom:   "agent" | "team" | "brokerage" | "platform_default"
}

export async function resolveLifecycleAutoSpawn(
  scope: ResolveScope,
  eventType: LifecycleEventType,
): Promise<PolicyDecision> {
  const svc = createServiceClient()

  // Resolve the agent's agents.id + team_id from users.id. Agent override
  // checks need agents.id; team override needs agents.team_id.
  let agentRowId: string | null = null
  let teamId:     string | null = null
  try {
    const { data } = await svc
      .from("agents")
      .select("id, team_id")
      .eq("user_id", scope.agentUserId)
      .eq("brokerage_id", scope.brokerageId)
      .maybeSingle()
    const a = data as { id: string; team_id: string | null } | null
    if (a) {
      agentRowId = a.id
      teamId     = a.team_id
    }
  } catch {
    // Best-effort — without the agent row we skip agent + team overrides and
    // fall through to brokerage / platform.
  }

  // Walk in priority order — first match wins. Each query is a single
  // unique-index probe; no fan-out reads.
  const probes: Array<{ scope_type: "agent" | "team" | "brokerage"; scope_id: string | null }> = [
    { scope_type: "agent",     scope_id: agentRowId },
    { scope_type: "team",      scope_id: teamId },
    { scope_type: "brokerage", scope_id: scope.brokerageId },
  ]
  for (const probe of probes) {
    if (!probe.scope_id) continue
    try {
      const { data } = await svc
        .from("lifecycle_promo_policy")
        .select("auto_spawn, cooldown_hours")
        .eq("scope_type", probe.scope_type)
        .eq("scope_id", probe.scope_id)
        .eq("event_type", eventType)
        .maybeSingle()
      const row = data as { auto_spawn: boolean; cooldown_hours: number | null } | null
      if (row) {
        const platformCooldown = PLATFORM_DEFAULTS[eventType].cooldownHours
        return {
          autoSpawn:     row.auto_spawn,
          // Override cooldown applies even when the platform default has
          // none — and a NULL override falls back to platform.
          cooldownHours: row.cooldown_hours ?? platformCooldown,
          resolvedFrom:  probe.scope_type,
        }
      }
    } catch {
      // Per-probe failure doesn't fail the resolution — fall through to next tier.
    }
  }

  const def = PLATFORM_DEFAULTS[eventType]
  return {
    autoSpawn:     def.autoSpawn,
    cooldownHours: def.cooldownHours,
    resolvedFrom:  "platform_default",
  }
}

/** Check if a recent promo of the same (listing, event_type) was staged
 *  within the cooldown window. Returns true → suppress new spawn.
 *  Implemented as a single timestamp comparison on listing_promo_videos. */
export async function isWithinCooldown(args: {
  listingId:     string
  eventType:     LifecycleEventType
  cooldownHours: number
}): Promise<boolean> {
  if (args.cooldownHours <= 0) return false
  const svc = createServiceClient()
  const since = new Date(Date.now() - args.cooldownHours * 60 * 60 * 1000).toISOString()
  try {
    const { data } = await svc
      .from("listing_promo_videos")
      .select("id")
      .eq("listing_id", args.listingId)
      .eq("event_type", args.eventType)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    return !!data
  } catch {
    // Best-effort — if the cooldown probe fails, allow the spawn (better
    // to ship a redundant promo than silently suppress on infra hiccup).
    return false
  }
}
