// Two of these four buttons used to be 404s: /dashboard/admin/onboarding/reports
// and /dashboard/admin/onboarding/assignments have no page.tsx and never have.
// A third, "View All Agents", pointed at /dashboard/onboarding/progress — the
// AGENT's own progress page, not a broker roster.
//
// Every destination below is a route that exists. The broker roster is
// /dashboard/onboarding/admin/agents (admin/broker/superadmin gated, and now
// reading the same roster loader this console does).

import { Button } from '@/components/ui/button'
import { Users, GraduationCap, BarChart3 } from 'lucide-react'
import Link from 'next/link'

export function OnboardingCommandStrip() {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href="/dashboard/onboarding/admin/agents">
        <Button className="gap-2">
          <Users className="h-4 w-4" />
          View All Agents
        </Button>
      </Link>
      <Link href="/dashboard/onboarding">
        <Button variant="outline" className="gap-2">
          <BarChart3 className="h-4 w-4" />
          My Onboarding
        </Button>
      </Link>
      <Link href="/academy">
        <Button variant="outline" className="gap-2">
          <GraduationCap className="h-4 w-4" />
          Academy
        </Button>
      </Link>
    </div>
  )
}
