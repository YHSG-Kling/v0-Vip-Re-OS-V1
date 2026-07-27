import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Users, AlertTriangle, CheckCircle2, Building2, ArrowRight } from "lucide-react"
import { InviteUserButton } from "./invite-user-button"
import { EditUserButton } from "./edit-user-button"
import { SEAT_ROLES, effectiveSeatLimit, parseSeatOverride, tierLabel } from "@/lib/kernel/tier-role-matrix"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

const ROLE_COLOR: Record<string, string> = {
  agent:               "bg-blue-100 text-blue-700",
  broker:              "bg-purple-100 text-purple-700",
  admin:               "bg-red-100 text-red-700",
  superadmin:          "bg-red-100 text-red-800",
  tc:                  "bg-orange-100 text-orange-700",
  isa:                 "bg-green-100 text-green-700",
  team_lead:           "bg-indigo-100 text-indigo-700",
  compliance_officer:  "bg-yellow-100 text-yellow-800",
  lender:              "bg-cyan-100 text-cyan-700",
  vendor:              "bg-gray-100 text-gray-600",
  contact:             "bg-slate-100 text-slate-600",
}

// Roles that require an agents domain record
const REQUIRES_AGENTS_ROW = new Set(["agent", "isa", "team_lead"])
// Roles that require a transaction_coordinators record
const REQUIRES_TC_ROW = new Set(["tc"])

export default async function AdminUsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Auth gate — use user_type (canonical), check maybeSingle to avoid throwing
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const callerType = profile?.user_type ?? "agent"
  if (!["admin", "broker", "superadmin"].includes(callerType)) {
    redirect("/dashboard")
  }

  // SPLIT (console consolidation): the cross-tenant user listing belongs to the
  // god console. Platform staff get a link-out to the per-tenant user panels
  // instead of a cross-tenant directory here.
  if (callerType === "superadmin") {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <Building2 className="w-10 h-10 mx-auto text-muted-foreground" />
            <div>
              <h1 className="text-xl font-bold">Cross-tenant user management lives in the platform console</h1>
              <p className="text-sm text-muted-foreground mt-2">
                This page is the brokerage-scoped user directory for tenant admins.
                As platform staff, manage users per brokerage from the god console.
              </p>
            </div>
            <Link
              href="/dashboard/superadmin/brokerages"
              className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:underline"
            >
              Open Brokerages console
              <ArrowRight className="w-4 h-4" />
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Kernel guard: tenant admins must be anchored to a brokerage.
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Load users — always scoped to the caller's brokerage (tenant anchor)
  const service = createServiceClient()

  // Tenant plan tier — drives the tier-aware invitable-role list (matrix in
  // lib/kernel/tier-role-matrix.ts; the invite server action enforces the same).
  const { data: tenant } = await service
    .from("brokerages")
    .select("plan_tier, billing_metadata")
    .eq("id", profile.brokerage_id)
    .maybeSingle()
  const planTier: string | null = tenant?.plan_tier ?? null

  const { data: users } = await service
    .from("users")
    .select("id, first_name, last_name, email, user_type, status, brokerage_id, created_at")
    .is("deleted_at", null)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(200)
  const userList = users ?? []

  // Load domain record status for quick health check
  // agents rows and TC rows in a single query each
  const userIds = userList.map(u => u.id)

  // tenant anchor (scope burn-down): userIds come from the brokerage-scoped users
  // query above; additionally pin the agents lookup to the caller's brokerage
  // (superadmin never reaches this listing — it links out to the god console).
  const agentsQuery = service
    .from("agents")
    .select("user_id")
    .in("user_id", userIds)
    .eq("brokerage_id", profile.brokerage_id)

  const [{ data: agentRows }, { data: tcRows }] = await Promise.all([
    userIds.length
      ? agentsQuery
      : Promise.resolve({ data: [] }),
    userIds.length
      ? service.from("transaction_coordinators").select("user_id").in("user_id", userIds)
      : Promise.resolve({ data: [] }),
  ])

  const agentUserIds = new Set((agentRows ?? []).map((r: { user_id: string }) => r.user_id))
  const tcUserIds    = new Set((tcRows ?? []).map((r: { user_id: string }) => r.user_id))

  function isDomainRecordMissing(u: { id: string; user_type: string | null }) {
    const role = u.user_type ?? ""
    if (REQUIRES_AGENTS_ROW.has(role) && !agentUserIds.has(u.id)) return true
    if (REQUIRES_TC_ROW.has(role)     && !tcUserIds.has(u.id))    return true
    return false
  }

  const incompleteCount = userList.filter(u => isDomainRecordMissing(u)).length

  // SEAT METER — the same math the invite gate enforces (Solo 2 · Team 5 ·
  // Brokerage/Multi unlimited; a seat = active SEAT_ROLES user, partners and
  // suspended users never count).
  const seatCount = userList.filter(
    (u) => (SEAT_ROLES as readonly string[]).includes(u.user_type ?? "") && u.status !== "suspended"
  ).length
  // ONE resolution with the invite gate: staff-set per-tenant override wins over the tier default.
  const { limit: seatLimit, overridden: seatOverridden } = effectiveSeatLimit(planTier, parseSeatOverride(tenant?.billing_metadata))

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-600" />
            User Management
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {userList.length} user{userList.length !== 1 ? "s" : ""}
            <span className={`ml-2 font-medium ${seatLimit !== null && seatCount >= seatLimit ? "text-red-600" : "text-slate-700"}`}>
              — {seatLimit === null
                ? `${seatCount} seats in use (unlimited on ${tierLabel(planTier)})`
                : `${seatCount} of ${seatLimit} seats used${seatOverridden ? " (custom limit)" : ""}`}
            </span>
            {incompleteCount > 0 && (
              <span className="ml-2 text-amber-600 font-medium">
                — {incompleteCount} incomplete account{incompleteCount !== 1 ? "s" : ""}
              </span>
            )}
          </p>
        </div>
        <InviteUserButton
          callerRole={callerType}
          brokerageId={profile?.brokerage_id}
          tier={planTier}
        />
      </div>

      {/* Incomplete accounts banner */}
      {incompleteCount > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800">
              {incompleteCount} account{incompleteCount !== 1 ? "s are" : " is"} missing required domain records.
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              Edit each flagged user and save to trigger automatic repair, or they will be repaired on first login.
            </p>
          </div>
        </div>
      )}

      {/* User list */}
      {userList.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            No users found
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {userList.map((u) => {
            const missing = isDomainRecordMissing(u)
            return (
              <Card key={u.id} className={missing ? "border-amber-200" : undefined}>
                <CardContent className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium truncate">
                        {[u.first_name, u.last_name].filter(Boolean).join(" ") || "Unnamed User"}
                      </p>
                      {missing && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                          <AlertTriangle className="w-3 h-3" />
                          Domain record missing
                        </span>
                      )}
                      {u.status === "suspended" && (
                        <span className="inline-flex items-center text-xs text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
                          Deactivated
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground truncate">{u.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Joined {new Date(u.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        ROLE_COLOR[u.user_type ?? "agent"] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {u.user_type || "agent"}
                    </span>
                    {!missing ? (
                      <CheckCircle2 className="w-4 h-4 text-green-500" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                    )}
                    <EditUserButton userId={u.id} />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
