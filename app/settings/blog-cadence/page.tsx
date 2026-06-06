import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { BlogCadenceSettingsClient } from "./client"
import type { BlogCadencePolicyRow } from "@/app/actions/blog-cadence-policy"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ tab?: string; team?: string }>
}

export default async function BlogCadenceSettingsPage({ searchParams }: PageProps) {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditAgent && !access.canEditTeam && !access.canEditBrokerage) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Blog Cadence Settings</h1>
        <p className="text-red-600">You don't have permission to manage these settings.</p>
      </div>
    )
  }
  const sp = await searchParams
  const tabRaw = sp.tab ?? "agent"
  const scopeType: "agent" | "team" | "brokerage" =
    (tabRaw === "team" && access.canEditTeam) ? "team"
    : (tabRaw === "brokerage" && access.canEditBrokerage) ? "brokerage"
    : "agent"
  const activeTeamId = sp.team ?? (access.teamScopeIds[0] ?? null)
  const scopeId =
    scopeType === "agent"     ? access.agentScopeId
    : scopeType === "team"    ? activeTeamId
    : scopeType === "brokerage" ? access.brokerageScopeId
    : null

  let policy: BlogCadencePolicyRow | null = null
  if (scopeId) {
    const svc = createServiceClient()
    const { data } = await svc
      .from("blog_cadence_policy")
      .select("cadence, fire_day, preferred_categories, preferred_persona")
      .eq("scope_type", scopeType)
      .eq("scope_id", scopeId)
      .maybeSingle()
    policy = (data as BlogCadencePolicyRow | null) ?? null
  }

  return (
    <BlogCadenceSettingsClient
      initialPolicy={policy}
      access={access}
      activeTab={scopeType}
      activeTeamId={activeTeamId}
    />
  )
}
