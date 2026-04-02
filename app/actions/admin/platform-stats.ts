import { createServiceClient } from "@/lib/supabase/service"

export async function getAdminStats() {
  const service = createServiceClient()
  
  const [
    { count: brokerageCount },
    { count: userCount },
    { count: integrationCount },
    { data: recentErrors },
  ] = await Promise.all([
    service.from("brokerages").select("id", { count: "exact", head: true }),
    service.from("users").select("id", { count: "exact", head: true }),
    service.from("brokerage_integrations").select("id", { count: "exact", head: true }),
    service
      .from("automation_errors")
      .select("*")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(5),
  ])

  return {
    brokerageCount: brokerageCount || 0,
    userCount: userCount || 0,
    integrationCount: integrationCount || 0,
    unresolvledErrorCount: recentErrors?.length || 0,
    recentErrors: recentErrors || [],
  }
}

export async function getPlatformAdminStats() {
  return getAdminStats()
}
