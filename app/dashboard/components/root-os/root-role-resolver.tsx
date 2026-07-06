'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, User, Building2, Shield, Phone, ClipboardCheck, UserCircle, LifeBuoy } from 'lucide-react'
import Link from 'next/link'
import { ROLE_DASHBOARD_ROUTES as CANON_ROUTES, ROLE_LABELS } from '@/lib/kernel/role-routes'

// Routes + labels are the canonical, consolidated map (lib/kernel/role-routes.ts);
// only the per-role ICON is UI-local. Composed here so this view can't drift.
const ROLE_ICON: Record<string, typeof User> = {
  admin: Shield, superadmin: Shield, support: LifeBuoy, broker: Building2, tc: ClipboardCheck,
  compliance_officer: Shield, isa: Phone, team_lead: User, agent: User, contact: UserCircle,
  vendor: Building2, lender: Building2, title: Building2, title_agent: Building2, system: Shield,
}
const ROLE_DASHBOARD_ROUTES: Record<string, { route: string; label: string; icon: typeof User }> =
  Object.fromEntries(Object.keys(CANON_ROUTES).map((r) => [r, {
    route: CANON_ROUTES[r], label: ROLE_LABELS[r] ?? r, icon: ROLE_ICON[r] ?? User,
  }]))

interface RootRoleResolverProps {
  autoRedirect?: boolean
  onRoleResolved?: (role: string, route: string) => void
}

export function RootRoleResolver({ autoRedirect = true, onRoleResolved }: RootRoleResolverProps) {
  const router = useRouter()
  const { user, userContext, loading } = useAuth()
  const [resolvedRole, setResolvedRole] = useState<string | null>(null)
  const [redirected, setRedirected] = useState(false)

  useEffect(() => {
    if (loading || redirected) return

    if (userContext) {
      const primaryRole = userContext.roles?.[0] || 'agent'
      setResolvedRole(primaryRole)

      const roleConfig = ROLE_DASHBOARD_ROUTES[primaryRole]
      if (roleConfig) {
        onRoleResolved?.(primaryRole, roleConfig.route)

        if (autoRedirect && roleConfig.route !== '/dashboard') {
          setRedirected(true)
          router.replace(roleConfig.route)
        }
      }
    }
  }, [userContext, loading, autoRedirect, redirected, router, onRoleResolved])

  if (loading || (autoRedirect && redirected)) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-primary" />
          <p className="text-sm text-muted-foreground">Resolving your workspace...</p>
        </div>
      </div>
    )
  }

  // If not auto-redirecting, show role selection
  if (!autoRedirect && resolvedRole) {
    const roleConfig = ROLE_DASHBOARD_ROUTES[resolvedRole]
    const Icon = roleConfig?.icon || User

    return (
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Icon className="h-5 w-5 text-primary" />
            Welcome Back
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Your role:</span>
            <Badge variant="outline" className="capitalize">
              {resolvedRole.replace('_', ' ')}
            </Badge>
          </div>
          {roleConfig && (
            <Link href={roleConfig.route}>
              <Button className="w-full">
                Go to {roleConfig.label}
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>
    )
  }

  return null
}

export function getRoleRoute(role: string): string {
  return ROLE_DASHBOARD_ROUTES[role]?.route || '/dashboard/agent'
}

export function getRoleLabel(role: string): string {
  return ROLE_DASHBOARD_ROUTES[role]?.label || 'Dashboard'
}
