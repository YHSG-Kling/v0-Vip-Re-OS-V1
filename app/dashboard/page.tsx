import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export const dynamic = "force-dynamic"

// Role-based dashboard routing — server-resolved, no client spinner
const ROLE_DASHBOARD_ROUTES: Record<string, string> = {
  admin: "/dashboard/admin",
  superadmin: "/dashboard/admin",
  broker: "/dashboard/brokerage",
  tc: "/dashboard/coordinator",
  compliance_officer: "/dashboard/compliance",
  isa: "/dashboard/isa",
  team_lead: "/dashboard/agent",
  agent: "/dashboard/agent",
  contact: "/portal",
  vendor: "/vendor/dashboard",
  lender: "/lender/dashboard",
  title: "/title/dashboard",
  title_agent: "/title/dashboard",
}

export default async function DashboardPage() {
  const context = await getAgentContext()

  if (!context.isAuthenticated) {
    redirect("/login")
  }

  const role = context.role || "agent"
  const target = ROLE_DASHBOARD_ROUTES[role] ?? "/dashboard/agent"
  redirect(target)
}
