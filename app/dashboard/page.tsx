"use client"

import { useEffect, useState, Suspense } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { ApprovalsBanner } from "@/components/ApprovalsBanner"
import { Clock, Loader2 } from "lucide-react"
import { useAuth } from "@/lib/auth/client"
import {
  RootRoleResolver,
  RootCommandPreview,
  RootRoleShortcuts,
  RootSystemStatusStrip,
  getRoleRoute,
  getRoleLabel,
} from "./components/root-os"

// Role-based dashboard routing - matches actual existing pages
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

const Loading = () => (
  <div className="flex items-center justify-center h-96">
    <div className="text-center">
      <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-primary" />
      <p className="text-sm text-muted-foreground">Loading your workspace...</p>
    </div>
  </div>
)

function DashboardContent() {
  const router = useRouter()
  const { user, userContext, loading: authLoading } = useAuth()
  const [redirected, setRedirected] = useState(false)
  const [resolvedRole, setResolvedRole] = useState<string | null>(null)

  // Redirect based on user role
  useEffect(() => {
    if (authLoading || redirected) return

    if (userContext) {
      const primaryRole = userContext.roles?.[0] || "agent"
      setResolvedRole(primaryRole)

      const targetRoute = ROLE_DASHBOARD_ROUTES[primaryRole]
      if (targetRoute && targetRoute !== "/dashboard") {
        setRedirected(true)
        router.replace(targetRoute)
      }
    } else if (!user) {
      // No session at all — send to login
      setRedirected(true)
      router.replace("/login")
    } else {
      // Authenticated but userContext not yet resolved — default to agent dashboard.
      // Onboarding is only triggered via explicit invitation flow, not as a catch-all.
      setRedirected(true)
      router.replace("/dashboard/agent")
    }
  }, [userContext, authLoading, redirected, router, user])

  // Show loading while auth is loading or redirecting
  if (authLoading || redirected) {
    return <Loading />
  }

  // If we reach here, user either has no specific role route or is on fallback
  // Show the Kernel OS gateway interface
  const displayRole = resolvedRole || "agent"
  const userName = user?.user_metadata?.first_name || user?.email?.split("@")[0] || "User"

  return (
    <div className="min-h-screen bg-background p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
              Welcome back, {userName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {getRoleLabel(displayRole)} Dashboard
            </p>
          </div>
          <div className="flex items-center gap-3">
            <RootSystemStatusStrip />
            <Badge variant="outline" className="px-3 py-1 hidden sm:flex">
              <Clock className="h-3 w-3 mr-1" />
              {new Date().toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </Badge>
          </div>
        </div>

        {/* Approvals Banner - Real data from approval_items table */}
        <ApprovalsBanner />

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Column - Priority Actions */}
          <div className="lg:col-span-2 space-y-6">
            {/* Priority Command Preview - Real data from ai_daily_briefings */}
            <RootCommandPreview />
          </div>

          {/* Sidebar Column */}
          <div className="space-y-6">
            {/* Role Shortcuts - Links to real existing routes */}
            <RootRoleShortcuts role={displayRole} />

            {/* Role-specific navigation hint */}
            <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
              <p className="text-sm font-medium text-foreground mb-2">
                Go to your command center
              </p>
              <p className="text-xs text-muted-foreground mb-3">
                Access your full {getRoleLabel(displayRole)} workspace with all tools and intelligence panels.
              </p>
              <a
                href={getRoleRoute(displayRole)}
                className="inline-flex items-center text-sm font-medium text-primary hover:underline"
              >
                Open {getRoleLabel(displayRole)}
                <span className="ml-1">→</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DashboardContent />
    </Suspense>
  )
}
