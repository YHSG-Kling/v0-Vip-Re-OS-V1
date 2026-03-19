import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { PlatformOwnerOSClient } from "./platform-owner-os-client"
import { getAdminStats } from "@/app/actions/admin/platform-stats"
import { getServiceStatuses, getAutomationErrors } from "@/app/actions/system-health"
import { getAllBrokeragesBilling } from "@/app/actions/billing"
import { getAuditTrail } from "@/app/actions/audit-trail"

export const metadata = {
  title: "Platform Owner OS | Control Center",
  description: "Platform-level administration and governance",
}

export default async function PlatformOwnerOSPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) redirect("/login")
  
  const service = createServiceClient()
  
  // Check platform admin role
  const { data: adminRole } = await service
    .from("user_role_assignments")
    .select("role")
    .eq("user_id", user.id)
    .single()
  
  if (adminRole?.role !== "platform_admin") redirect("/dashboard")
  
  // Fetch all admin data in parallel
  const [
    adminStats,
    systemHealth,
    billingMetrics,
    auditTrail,
    automationErrorsData,
    { data: brokerages },
    { data: integrations },
  ] = await Promise.all([
    getAdminStats(),
    getServiceStatuses(),
    getAllBrokeragesBilling(),
    getAuditTrail({ limit: 50 }),
    getAutomationErrors(7),
    service.from("brokerages").select("*").order("created_at", { ascending: false }).limit(100),
    service.from("brokerage_integrations").select("*"),
  ])
  
  const { data: aiAuditLog } = await service
    .from("ai_feedback_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100)
  
  return (
    <PlatformOwnerOSClient
      adminStats={adminStats}
      systemHealth={systemHealth}
      billingMetrics={billingMetrics}
      auditTrail={auditTrail}
      brokerages={brokerages || []}
      integrations={integrations || []}
      automationErrors={automationErrorsData?.errors || []}
      aiAuditLog={aiAuditLog || []}
      currentUserId={user.id}
    />
  )
}
