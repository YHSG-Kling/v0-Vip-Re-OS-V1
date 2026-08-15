/**
 * app/dashboard/settings/teams/page.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TEAM SETTINGS SURFACE — and, from this wave, the home of a team's own
 * logo and brand.
 *
 * This route was a six-line `redirect("/settings/users")`. Two things already
 * pointed at it and neither arrived anywhere useful:
 *
 *   lib/onboarding/setup-readiness.ts:210 — the REQUIRED team-lead task
 *     "Set your team logo & colors", href /dashboard/settings/teams
 *   app/config/navigation-config.ts:362  — the "Team Management" nav item
 *
 * So the checklist told a team lead to come here and set their logo, and this
 * page sent them to brokerage user management, where no such control exists.
 * `teams.logo_url` had no writer anywhere in the codebase. The panel below is
 * that writer's screen; the "Team Management" link is kept so the nav item's old
 * destination is still one click away rather than silently removed.
 *
 * NO ROLE GATE HERE, on purpose. The neighbouring /dashboard/settings control
 * centre redirects anyone who is not broker/admin — which on the live data
 * excludes the one real team lead, teamlead@vip.demo, whose user_type is 'agent'
 * while `teams.team_lead_id` says they run a team. Gating this page by user_type
 * would lock the very person the ruling is about out of their own brand. The
 * authority test lives in app/actions/team-branding.ts, where it is applied to
 * the FACT (teams.team_lead_id) on every read and every write, and the panel
 * renders an honest empty state for a caller who leads no team.
 */

import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { TeamBrandingPanel } from "../components/team-branding-panel"
import { Users, ExternalLink } from "lucide-react"

export const metadata = { title: "Team Settings | Brand" }

export default async function DashboardSettingsTeamsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Team Settings</h1>
        <p className="text-muted-foreground mt-1">
          Your team&apos;s own logo, colours and contact details — and what they inherit from the
          brokerage when you leave them blank.
        </p>
      </div>

      <TeamBrandingPanel />

      <Link
        href="/settings/users"
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        <Users className="h-4 w-4" />
        Team members, roles and seats
        <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  )
}
