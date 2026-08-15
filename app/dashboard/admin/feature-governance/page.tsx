import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { FeatureGovernanceClient } from "./feature-governance-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Feature Governance",
  description: "Manage feature flags, trial access grants, and usage analytics",
}

export default async function FeatureGovernancePage() {
  const context = await getAgentContext()

  if (!context?.brokerageId) redirect("/login")
  if (!["admin", "superadmin", "broker"].includes(context.userType ?? "")) {
    redirect("/dashboard")
  }

  const supabase = await createClient()
  const brokerageId = context.brokerageId

  // "Is superadmin" needs BOTH identity columns and AgentContext carries only
  // user_type, so platform_role is read here. `context.userType === "superadmin"`
  // was FALSE for the platform's only superadmin (user_type='admin',
  // platform_role='superadmin'), which made this page's entire write half dead
  // for the one account that owns it: every flag toggle and tier checkbox
  // rendered `disabled`, and the client showed the read-only "flags are managed
  // by the platform team" notice TO the platform team. Same shape as
  // public.is_platform_admin() in RLS; see app/actions/vendor-budget.ts:136-147.
  const { data: identity } = await supabase
    .from("users")
    .select("platform_role")
    .eq("id", context.userId)
    .maybeSingle()
  const isSuperadmin =
    context.userType === "superadmin" ||
    (identity as { platform_role?: string | null } | null)?.platform_role === "superadmin"

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10)

  const [flags, overrides, usage] = await Promise.all([
    supabase
      .from("feature_flags")
      .select(
        "id, feature_key, display_name, description, category, enabled, beta, deprecated, superadmin_only, solo_agent_access, team_access, brokerage_access, multi_location_access, updated_at"
      )
      .order("category")
      .order("display_name"),

    supabase
      .from("feature_access_overrides")
      .select(
        "id, user_id, brokerage_id, team_id, feature_key, override_type, trial_ends_at, notes, created_at, users(email)"
      )
      .eq("brokerage_id", brokerageId),

    supabase
      .from("feature_usage_tracking")
      .select("feature_key, user_id")
      .eq("brokerage_id", brokerageId)
      .gte("period_start", startOfMonth),
  ])

  // Build usageMap: feature_key -> count of distinct users this month
  const usageMap = (usage.data ?? []).reduce<Record<string, number>>((acc, u) => {
    acc[u.feature_key] = (acc[u.feature_key] ?? 0) + 1
    return acc
  }, {})

  return (
    <FeatureGovernanceClient
      flags={flags.data ?? []}
      overrides={(overrides.data ?? []) as any}
      usageMap={usageMap}
      brokerageId={brokerageId}
      isSuperadmin={isSuperadmin}
    />
  )
}
