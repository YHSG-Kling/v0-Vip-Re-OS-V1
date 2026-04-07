import { createClient } from "@/lib/supabase/server"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertTriangle, CheckCircle2, Mail, Users, DollarSign, UserCheck, BookOpen } from "lucide-react"
import Link from "next/link"

interface ProvisioningFlag {
  key: string
  label: string
  icon: React.ElementType
}

const FLAGS: ProvisioningFlag[] = [
  { key: "noInvite",      label: "No invite sent",        icon: Mail       },
  { key: "noAgent",       label: "No agent row",          icon: Users      },
  { key: "noCommission",  label: "No commission profile", icon: DollarSign },
  { key: "noTeam",        label: "No team assignment",    icon: UserCheck  },
  { key: "onboardingIncomplete", label: "Onboarding incomplete", icon: BookOpen },
]

interface UserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  user_type: string | null
  role: string | null
  created_at: string | null
}

interface ProvisioningResult {
  user: UserRow
  flags: string[]
}

interface Props {
  brokerageId: string
}

export async function ProvisioningHealthPanel({ brokerageId }: Props) {
  const supabase = await createClient()

  // Fetch all brokerage users (agents + admins) with no deleted_at
  const { data: users } = await supabase
    .from("users")
    .select("id, first_name, last_name, email, user_type, role, created_at")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .in("user_type", ["agent", "admin", "broker", "coordinator"])
    .order("created_at", { ascending: false })
    .limit(50)

  if (!users || users.length === 0) return null

  const userIds = users.map((u) => u.id)

  // Parallel fetch all provisioning signals
  const [
    agentsRes,
    onboardingRes,
    authUsersRes,
  ] = await Promise.all([
    // Fetch agent rows including their agents.id for downstream joins
    supabase
      .from("agents")
      .select("id, user_id")
      .eq("brokerage_id", brokerageId)
      .in("user_id", userIds),
    // Which user_ids have an onboarding record?
    supabase
      .from("agent_onboarding")
      .select("user_id, status, completion_percentage")
      .eq("brokerage_id", brokerageId)
      .in("user_id", userIds),
    // Check invite acceptance via password_hash or platform_role presence
    supabase
      .from("users")
      .select("id, platform_role, password_hash")
      .in("id", userIds),
  ])

  // Build user_id → agents.id map
  const agentRows = agentsRes.data ?? []
  const agentUserIds = new Set(agentRows.map((a) => a.user_id))
  const userIdToAgentId = new Map(agentRows.map((a) => [a.user_id, a.id]))
  const allAgentIds = agentRows.map((a) => a.id)

  // Fetch commission profiles and team memberships by agents.id (not users.id)
  const [commissionRes, teamRes] = await Promise.all([
    allAgentIds.length > 0
      ? supabase
          .from("agent_commission_profiles")
          .select("agent_id")
          .eq("brokerage_id", brokerageId)
          .eq("is_active", true)
          .in("agent_id", allAgentIds)
      : { data: [] },
    allAgentIds.length > 0
      ? supabase
          .from("team_members")
          .select("agent_id")
          .eq("brokerage_id", brokerageId)
          .eq("is_active", true)
          .in("agent_id", allAgentIds)
      : { data: [] },
  ])

  const commissionAgentIds = new Set((commissionRes.data ?? []).map((a) => a.agent_id))
  const teamAgentIds       = new Set((teamRes.data ?? []).map((a) => a.agent_id))
  const onboardingMap      = new Map((onboardingRes.data ?? []).map((o) => [o.user_id, o]))
  const authMap            = new Map((authUsersRes.data ?? []).map((u) => [u.id, u]))

  // Build per-user provisioning result
  const results: ProvisioningResult[] = users.map((user) => {
    const flags: string[] = []

    // No invite: no platform_role and no password_hash means they never accepted
    const auth = authMap.get(user.id)
    const inviteAccepted = !!(auth?.platform_role || auth?.password_hash)
    if (!inviteAccepted) flags.push("noInvite")

    // Agent-specific checks
    const resolvedType = user.user_type ?? user.role
    if (resolvedType === "agent" || resolvedType === "coordinator") {
      const hasAgentRow = agentUserIds.has(user.id)
      if (!hasAgentRow) flags.push("noAgent")

      // Commission and team lookups use agents.id, not users.id
      const agentId = userIdToAgentId.get(user.id)
      if (hasAgentRow && agentId && !commissionAgentIds.has(agentId)) {
        flags.push("noCommission")
      }
      if (hasAgentRow && agentId && !teamAgentIds.has(agentId)) {
        flags.push("noTeam")
      }
    }

    // Onboarding
    const onboarding = onboardingMap.get(user.id)
    if (!onboarding || (onboarding.status !== "completed" && (onboarding.completion_percentage ?? 0) < 100)) {
      flags.push("onboardingIncomplete")
    }

    return { user, flags }
  })

  const degraded = results.filter((r) => r.flags.length > 0)

  if (degraded.length === 0) {
    return (
      <Card className="border-green-200 bg-green-50/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            Provisioning Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-green-700">All {users.length} users are fully provisioned.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Provisioning Health
          <Badge variant="secondary" className="ml-auto text-xs bg-amber-100 text-amber-800 border-0">
            {degraded.length} of {users.length} incomplete
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {degraded.map(({ user, flags }) => (
          <div key={user.id} className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {user.first_name ?? ""} {user.last_name ?? ""}
                {!user.first_name && !user.last_name && (
                  <span className="text-muted-foreground">{user.email ?? user.id}</span>
                )}
              </p>
              <Badge variant="outline" className="text-xs capitalize">
                {user.user_type ?? user.role ?? "unknown"}
              </Badge>
            </div>
            {user.email && (
              <p className="text-xs text-muted-foreground">{user.email}</p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-1">
              {flags.map((flagKey) => {
                const flag = FLAGS.find((f) => f.key === flagKey)
                if (!flag) return null
                const Icon = flag.icon
                return (
                  <span
                    key={flagKey}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
                  >
                    <Icon className="h-3 w-3" />
                    {flag.label}
                  </span>
                )
              })}
            </div>
          </div>
        ))}
        <div className="pt-1">
          <Link
            href="/dashboard/admin/users"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Manage users
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
