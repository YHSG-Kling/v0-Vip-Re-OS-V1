"use server"

/**
 * app/actions/marketing-cadence-policy.ts
 *
 * Writer for the newsletter + social cadence policies (writer-less burn-down
 * round 3). Both tables were created as mirrors of blog_cadence_policy (m247 /
 * m248) and their ticker crons (newsletter-cadence-tick / social-cadence-tick)
 * consume them every run — but no settings action ever wrote a row, so neither
 * auto-cadence could EVER fire. This mirrors upsertBlogCadencePolicy exactly:
 * same scope model (agent/team/brokerage via resolvePolicyScopeAccess), same
 * cadence vocabulary (live CHECK: weekly/biweekly/monthly/off), same
 * (scope_type, scope_id) unique upsert (live-verified unique indexes exist).
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import type { CadenceValue } from "@/app/actions/blog-cadence-policy"

const VALID_CADENCES: CadenceValue[] = ["weekly", "biweekly", "monthly", "off"]

export type CadenceChannel = "newsletter" | "social"

const CHANNEL_TABLE: Record<CadenceChannel, string> = {
  newsletter: "newsletter_cadence_policy",
  social: "social_cadence_policy",
}

export interface MarketingCadencePolicyRow {
  cadence: CadenceValue
  fire_day: number | null
  preferred_categories: string[] | null
  preferred_persona: string | null
  /** social only */
  preferred_post_types?: string[] | null
}

export async function getMyMarketingCadencePolicies(): Promise<{
  success: boolean
  error?: string
  scopeId?: string
  newsletter?: MarketingCadencePolicyRow | null
  social?: MarketingCadencePolicyRow | null
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { success: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: agentRow } = await svc
    .from("agents").select("id").eq("user_id", ctx.userId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  const agentRecordId = (agentRow?.id as string | undefined) ?? null
  if (!agentRecordId) return { success: false, error: "Agent record not found" }

  const [nlR, soR] = await Promise.all([
    svc.from("newsletter_cadence_policy")
      .select("cadence, fire_day, preferred_categories, preferred_persona")
      .eq("scope_type", "agent").eq("scope_id", agentRecordId).maybeSingle(),
    svc.from("social_cadence_policy")
      .select("cadence, fire_day, preferred_categories, preferred_persona, preferred_post_types")
      .eq("scope_type", "agent").eq("scope_id", agentRecordId).maybeSingle(),
  ])
  return {
    success: true,
    scopeId: agentRecordId,
    newsletter: (nlR.data as MarketingCadencePolicyRow | null) ?? null,
    social: (soR.data as MarketingCadencePolicyRow | null) ?? null,
  }
}

export async function upsertMarketingCadencePolicy(input: {
  channel: CadenceChannel
  cadence: CadenceValue
  fireDay: number | null
  preferredCategories?: string[] | null
  preferredPersona?: string | null
  /** social only */
  preferredPostTypes?: string[] | null
  scopeType?: "agent" | "team" | "brokerage"
  scopeId?: string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { success: false, error: "Unauthorized" }
  const table = CHANNEL_TABLE[input.channel]
  if (!table) return { success: false, error: "unknown_channel" }
  if (!VALID_CADENCES.includes(input.cadence)) return { success: false, error: "Invalid cadence" }
  if (input.cadence === "weekly" || input.cadence === "biweekly") {
    if (input.fireDay === null || input.fireDay < 0 || input.fireDay > 6) {
      return { success: false, error: "fire_day must be 0-6 for weekly/biweekly cadence" }
    }
  } else if (input.cadence === "monthly") {
    if (input.fireDay === null || input.fireDay < 1 || input.fireDay > 28) {
      return { success: false, error: "fire_day must be 1-28 for monthly cadence" }
    }
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
    if (!scopeId || !access.teamScopeIds.includes(scopeId)) return { success: false, error: "Forbidden — team not in your scope" }
  } else if (scopeType === "brokerage") {
    if (!access.canEditBrokerage) return { success: false, error: "Forbidden" }
    scopeId = access.brokerageScopeId
  }
  if (!scopeId) return { success: false, error: "Could not resolve scope id" }

  const svc = createServiceClient()
  const row: Record<string, unknown> = {
    scope_type: scopeType,
    scope_id: scopeId,
    brokerage_id: ctx.brokerageId, // both tables carry the tenant anchor (unlike blog's)
    cadence: input.cadence,
    fire_day: input.fireDay,
    preferred_categories: input.preferredCategories ?? null,
    preferred_persona: input.preferredPersona ?? null,
    updated_at: new Date().toISOString(),
    updated_by: ctx.userId,
  }
  if (input.channel === "social") row.preferred_post_types = input.preferredPostTypes ?? null

  // (scope_type, scope_id) unique indexes live-verified on BOTH tables — pass-10 safe.
  const { error } = await svc.from(table).upsert(row, { onConflict: "scope_type,scope_id" })
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/blog-cadence")
  return { success: true }
}
