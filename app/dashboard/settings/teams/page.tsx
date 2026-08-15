/**
 * app/dashboard/settings/teams/page.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TEAM SETTINGS SURFACE — the home of a team's own logo and brand, and from
 * W47 also of its SPLIT and its EMAIL SIGNATURE.
 *
 * This route was a six-line `redirect("/settings/users")`. FOUR things already
 * pointed at it and none of them arrived anywhere useful:
 *
 *   lib/onboarding/setup-readiness.ts:210 — the REQUIRED team-lead task
 *     "Set your team logo & colors", href /dashboard/settings/teams
 *   lib/onboarding/critical-setup.ts:277  — the REQUIRED item
 *     `lead_team_structure` ("Set up your team")
 *   lib/onboarding/critical-setup.ts:283  — the REQUIRED item
 *     `lead_team_splits` ("Set your team splits"), whose stated reason is that
 *     "Team P&L and per-agent payouts compute wrong (or not at all) until
 *     team_split_type/value are set" — checked by `f.teamLead?.splitsSet`
 *   app/config/navigation-config.ts:362   — the "Team Management" nav item
 *
 * So the checklist told a team lead to come here and set their logo AND their
 * splits, and this page sent them to brokerage user management, where neither
 * control exists. `teams.logo_url` and `teams.team_split_*` had no writer
 * anywhere in the codebase; `teams.branding_override.email_signature_html` had a
 * reader in the email assembler and no writer either. The panel below is that
 * writer's screen for all three; the "Team Management" link is kept so the nav
 * item's old destination is still one click away rather than silently removed.
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

export const metadata = { title: "Team Settings | Brand, Split & Signature" }

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
          brokerage when you leave them blank. Also the team&apos;s commission split, which the
          payout calculation applies to every closing by an agent on this team, and the team&apos;s
          fallback email signature.
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
