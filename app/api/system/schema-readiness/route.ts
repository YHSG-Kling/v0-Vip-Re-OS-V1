import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

const TABLE_CHECKS = [
  {
    name: "workflow_executions",
    migrationScript: "scripts/220-create-workflow-orchestration.sql",
    description: "Tracks workflow run state for orchestration and retries",
  },
  {
    name: "workflow_step_executions",
    migrationScript: "scripts/220-create-workflow-orchestration.sql",
    description: "Tracks individual step outcomes within a workflow run",
  },
  {
    name: "workflow_retries",
    migrationScript: "scripts/220-create-workflow-orchestration.sql",
    description: "Queues scheduled retries for failed workflow executions",
  },
  {
    name: "team_activity_snapshots",
    migrationScript: "scripts/220-create-workflow-orchestration.sql",
    description: "Pre-aggregated team activity heat-map data for dashboards",
  },
  {
    name: "agent_monthly_earnings",
    migrationScript: "scripts/220-create-workflow-orchestration.sql",
    description: "Rolled-up monthly earnings per agent for financial reporting",
  },
]

export async function GET() {
  // Role gate — broker/admin/superadmin only
  const context = await getAgentContext()
  if (!context?.brokerageId || !isAdminOrBroker({ user_type: context.userType })) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  const results = await Promise.all(
    TABLE_CHECKS.map(async (check) => {
      const { error } = await supabase.from(check.name as any).select("id").limit(1)
      const present =
        !error ||
        (error.code !== "42P01" && !error.message?.includes("does not exist"))
      return { ...check, present }
    })
  )

  return NextResponse.json(results)
}
