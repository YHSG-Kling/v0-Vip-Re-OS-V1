"use server"

/**
 * app/actions/lifecycle-promo-policy.ts
 *
 * Wave 28 — server actions for the Settings UI that writes
 * lifecycle_promo_policy rows. Three operations:
 *
 *   1. getMyLifecyclePromoPolicy() — returns the current row for each of
 *      the 7 event types at the caller's appropriate scope (agent for
 *      solo-tier users, team for team leads, brokerage for admins). When
 *      no row exists, returns the platform default so the UI can render
 *      a "currently using platform default" indicator.
 *
 *   2. upsertLifecyclePromoPolicy(eventType, autoSpawn, cooldownHours?) —
 *      writes one row at the caller's scope. The scope is resolved
 *      server-side from the auth session; the client never names it.
 *
 *   3. deleteLifecyclePromoPolicy(eventType) — removes the override so
 *      the resolution chain falls back to the next tier.
 *
 * Permission model:
 *   · Any authenticated user can set their AGENT-scope override
 *   · Team leads can set TEAM-scope overrides for their team
 *   · Brokerage admins can set BROKERAGE-scope overrides
 *
 * For Wave 28 the UI only exposes the AGENT scope (the simplest tier and
 * the one every subscriber has). Team + brokerage scope writes come in a
 * follow-up commit alongside the role-checked Settings UI shell.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

export type LifecycleEventType =
  | "coming_soon"
  | "just_listed"
  | "open_house_announce"
  | "open_house_reminder"
  | "price_reduction"
  | "under_contract"
  | "just_sold"

const ALL_EVENT_TYPES: LifecycleEventType[] = [
  "coming_soon", "just_listed", "open_house_announce", "open_house_reminder",
  "price_reduction", "under_contract", "just_sold",
]

const PLATFORM_DEFAULTS: Record<LifecycleEventType, { autoSpawn: boolean; cooldownHours: number | null }> = {
  coming_soon:         { autoSpawn: false, cooldownHours: null },
  just_listed:         { autoSpawn: true,  cooldownHours: null },
  open_house_announce: { autoSpawn: true,  cooldownHours: null },
  open_house_reminder: { autoSpawn: true,  cooldownHours: null },
  price_reduction:     { autoSpawn: false, cooldownHours: 24 },
  under_contract:      { autoSpawn: true,  cooldownHours: null },
  just_sold:           { autoSpawn: true,  cooldownHours: null },
}

export interface LifecycleEventDisplay {
  eventType:           LifecycleEventType
  label:               string
  description:         string
  effectiveAutoSpawn:  boolean
  effectiveCooldownHr: number | null
  hasAgentOverride:    boolean
  agentOverride:       { autoSpawn: boolean; cooldownHours: number | null } | null
  platformDefault:     { autoSpawn: boolean; cooldownHours: number | null }
}

const EVENT_METADATA: Record<LifecycleEventType, { label: string; description: string }> = {
  coming_soon:         { label: "Coming Soon",         description: "Pre-market teaser when a listing is staged 'coming soon'. Default off — agent opts in per listing." },
  just_listed:         { label: "Just Listed",         description: "Auto-fires when a listing publishes (status='active')." },
  open_house_announce: { label: "Open House Announce", description: "Auto-fires when an open house is scheduled." },
  open_house_reminder: { label: "Open House Reminder", description: "Auto-fires 24h before the open house event." },
  price_reduction:     { label: "Price Reduction",     description: "Fires when list_price drops. Default off — sensitive moment. 24h cooldown so repeated edits don't fan out." },
  under_contract:      { label: "Under Contract",      description: "Auto-fires when the listing goes under contract. 'Off market' announcement." },
  just_sold:           { label: "Just Sold",           description: "Auto-fires when the listing closes. Social-proof moment; sale price never disclosed unless explicitly approved." },
}

export interface GetMyPolicyResult {
  success: boolean
  error?: string
  scope?: "agent" | "team" | "brokerage"
  /** agents.id when scope='agent'; teams.id for team; brokerages.id for brokerage. */
  scopeId?: string
  events?: LifecycleEventDisplay[]
}

export async function getMyLifecyclePromoPolicy(): Promise<GetMyPolicyResult> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  // Resolve the caller's agents.id (the AGENT-scope override key).
  const { data: agentRow } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  const agentRecordId = (agentRow?.id as string | undefined) ?? null
  if (!agentRecordId) {
    return { success: false, error: "Agent record not found for this user" }
  }

  // Pull all 7 event rows for this agent in ONE query.
  const { data: overrideRows } = await svc
    .from("lifecycle_promo_policy")
    .select("event_type, auto_spawn, cooldown_hours")
    .eq("scope_type", "agent")
    .eq("scope_id", agentRecordId)
  const overrideMap = new Map<LifecycleEventType, { autoSpawn: boolean; cooldownHours: number | null }>()
  for (const r of (overrideRows ?? []) as Array<{ event_type: LifecycleEventType; auto_spawn: boolean; cooldown_hours: number | null }>) {
    overrideMap.set(r.event_type, { autoSpawn: r.auto_spawn, cooldownHours: r.cooldown_hours })
  }

  const events: LifecycleEventDisplay[] = ALL_EVENT_TYPES.map((et) => {
    const override = overrideMap.get(et) ?? null
    const platform = PLATFORM_DEFAULTS[et]
    const effective = override ?? platform
    return {
      eventType:           et,
      label:               EVENT_METADATA[et].label,
      description:         EVENT_METADATA[et].description,
      effectiveAutoSpawn:  effective.autoSpawn,
      effectiveCooldownHr: effective.cooldownHours,
      hasAgentOverride:    !!override,
      agentOverride:       override,
      platformDefault:     platform,
    }
  })

  return { success: true, scope: "agent", scopeId: agentRecordId, events }
}

/**
 * Wave 32 — scoped upsert. Caller specifies the tier they want to write
 * (agent / team / brokerage) and supplies the scopeId; the server
 * verifies the auth user is allowed to write at that tier before the
 * insert. Without a scopeType the action defaults to AGENT (backward
 * compat with Wave 28 callers).
 */
export async function upsertLifecyclePromoPolicy(input: {
  eventType:     LifecycleEventType
  autoSpawn:     boolean
  cooldownHours?: number | null
  scopeType?:    "agent" | "team" | "brokerage"
  scopeId?:      string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }
  if (!ALL_EVENT_TYPES.includes(input.eventType)) {
    return { success: false, error: "Invalid event_type" }
  }

  const scopeType = input.scopeType ?? "agent"
  const { resolvePolicyScopeAccess } = await import("@/lib/identity/policy-scope")
  const access = await resolvePolicyScopeAccess()
  let scopeId = input.scopeId ?? null
  if (scopeType === "agent") {
    if (!access.canEditAgent) return { success: false, error: "Forbidden" }
    scopeId = access.agentScopeId
  } else if (scopeType === "team") {
    if (!access.canEditTeam) return { success: false, error: "Forbidden" }
    if (!scopeId || !access.teamScopeIds.includes(scopeId)) {
      return { success: false, error: "Forbidden — team not in your scope" }
    }
  } else if (scopeType === "brokerage") {
    if (!access.canEditBrokerage) return { success: false, error: "Forbidden" }
    scopeId = access.brokerageScopeId
  }
  if (!scopeId) return { success: false, error: "Could not resolve scope id" }

  const svc = createServiceClient()
  const { error } = await svc.from("lifecycle_promo_policy").upsert({
    scope_type:     scopeType,
    scope_id:       scopeId,
    event_type:     input.eventType,
    auto_spawn:     input.autoSpawn,
    cooldown_hours: input.cooldownHours ?? null,
    updated_at:     new Date().toISOString(),
    updated_by:     ctx.userId,
  }, { onConflict: "scope_type,scope_id,event_type" })
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/lifecycle-promos")
  return { success: true }
}

export async function deleteLifecyclePromoPolicy(input: {
  eventType: LifecycleEventType
  scopeType?: "agent" | "team" | "brokerage"
  scopeId?:   string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }
  const scopeType = input.scopeType ?? "agent"
  const { resolvePolicyScopeAccess } = await import("@/lib/identity/policy-scope")
  const access = await resolvePolicyScopeAccess()
  let scopeId = input.scopeId ?? null
  if (scopeType === "agent") {
    if (!access.canEditAgent) return { success: false, error: "Forbidden" }
    scopeId = access.agentScopeId
  } else if (scopeType === "team") {
    if (!access.canEditTeam) return { success: false, error: "Forbidden" }
    if (!scopeId || !access.teamScopeIds.includes(scopeId)) {
      return { success: false, error: "Forbidden — team not in your scope" }
    }
  } else if (scopeType === "brokerage") {
    if (!access.canEditBrokerage) return { success: false, error: "Forbidden" }
    scopeId = access.brokerageScopeId
  }
  if (!scopeId) return { success: false, error: "Could not resolve scope id" }

  const svc = createServiceClient()
  const { error } = await svc.from("lifecycle_promo_policy")
    .delete()
    .eq("scope_type", scopeType)
    .eq("scope_id", scopeId)
    .eq("event_type", input.eventType)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/lifecycle-promos")
  return { success: true }
}

/** Wave 32 — fetch policy state for a SPECIFIC tier (used by tab switches). */
export async function getLifecyclePromoPolicyForScope(args: {
  scopeType: "agent" | "team" | "brokerage"
  scopeId?:  string
}): Promise<{ success: boolean; error?: string; events?: LifecycleEventDisplay[] }> {
  const { resolvePolicyScopeAccess } = await import("@/lib/identity/policy-scope")
  const access = await resolvePolicyScopeAccess()
  let resolvedScopeId: string | null = null
  if (args.scopeType === "agent") {
    if (!access.canEditAgent) return { success: false, error: "Forbidden" }
    resolvedScopeId = access.agentScopeId
  } else if (args.scopeType === "team") {
    if (!access.canEditTeam) return { success: false, error: "Forbidden" }
    if (!args.scopeId || !access.teamScopeIds.includes(args.scopeId)) {
      return { success: false, error: "Forbidden — team not in your scope" }
    }
    resolvedScopeId = args.scopeId
  } else if (args.scopeType === "brokerage") {
    if (!access.canEditBrokerage) return { success: false, error: "Forbidden" }
    resolvedScopeId = access.brokerageScopeId
  }
  if (!resolvedScopeId) return { success: false, error: "Could not resolve scope id" }

  const svc = createServiceClient()
  const { data: overrideRows } = await svc
    .from("lifecycle_promo_policy")
    .select("event_type, auto_spawn, cooldown_hours")
    .eq("scope_type", args.scopeType)
    .eq("scope_id", resolvedScopeId)
  const overrideMap = new Map<LifecycleEventType, { autoSpawn: boolean; cooldownHours: number | null }>()
  for (const r of (overrideRows ?? []) as Array<{ event_type: LifecycleEventType; auto_spawn: boolean; cooldown_hours: number | null }>) {
    overrideMap.set(r.event_type, { autoSpawn: r.auto_spawn, cooldownHours: r.cooldown_hours })
  }
  const events: LifecycleEventDisplay[] = ALL_EVENT_TYPES.map((et) => {
    const override = overrideMap.get(et) ?? null
    const platform = PLATFORM_DEFAULTS[et]
    const effective = override ?? platform
    return {
      eventType:           et,
      label:               EVENT_METADATA[et].label,
      description:         EVENT_METADATA[et].description,
      effectiveAutoSpawn:  effective.autoSpawn,
      effectiveCooldownHr: effective.cooldownHours,
      hasAgentOverride:    !!override,
      agentOverride:       override,
      platformDefault:     platform,
    }
  })
  return { success: true, events }
}
