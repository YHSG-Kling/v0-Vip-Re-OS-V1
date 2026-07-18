import Link from "next/link"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Building2, CreditCard, LifeBuoy, Megaphone, Cog, ShieldCheck, ArrowRight, Bell,
} from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePlatformRole } from "@/lib/platform/require-capability"
import { platformStaffCan, isPlatformStaffRole, type PlatformCapability } from "@/lib/platform/platform-staff-roster"
import { PLATFORM_ANNOUNCEMENT_TYPE } from "@/lib/notifications/platform-staff"
import { AnnouncementComposer } from "./announcement-composer"
import { AgreementAckBanner } from "./agreement-ack-banner"

export const dynamic = "force-dynamic"

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM STAFF COMMAND HOME — ONE role-aware landing for every platform role
// (superadmin / admin / marketing / support). A HUB, not a new tool: each card
// links an EXISTING superadmin surface, and a card renders only when the
// caller's role holds that surface's capability (platformStaffCan — the same
// map the page gates consult, so home and gates can never disagree).
// ─────────────────────────────────────────────────────────────────────────────

interface Tool {
  label: string
  href: string
  desc: string
  /** The capability the target page's own gate requires. */
  cap: PlatformCapability
  /** Key into the live-counts map (only cheap head-counts on familiar tables). */
  countKey?: "activeTenants" | "openTickets" | "pendingHealing"
}

interface ToolGroup { title: string; icon: typeof Building2; tools: Tool[] }

const GROUPS: ToolGroup[] = [
  {
    title: "Tenants", icon: Building2, tools: [
      { label: "All brokerages", href: "/dashboard/superadmin/brokerages", cap: "tenants", countKey: "activeTenants",
        desc: "Every subscriber across the 4 tiers — lifecycle, tier changes, margin, per-tenant detail." },
      { label: "Add subscriber manually", href: "/dashboard/superadmin/brokerages/new", cap: "tenants",
        desc: "Provision a new tenant + owner account without self-serve signup." },
      { label: "Usage reports — all tiers", href: "/dashboard/superadmin/usage-reports", cap: "tenants",
        desc: "Seats, book size, and metered usage per subscriber" },
      { label: "Engagement radar", href: "/dashboard/superadmin/engagement", cap: "tenants",
        desc: "Churn risk from behavior: real sign-ins, active users 7/30d, and creation velocity — riskiest tenants first." },
      { label: "Create user in a subscription", href: "/dashboard/superadmin/brokerages", cap: "tenants",
        desc: "Open the tenant → Team panel → Add user. Invites any role into any tenant, with full role records, audited." },
    ],
  },
  {
    title: "Billing", icon: CreditCard, tools: [
      { label: "Subscriptions", href: "/dashboard/superadmin/subscriptions", cap: "billing",
        desc: "The operational queue: trials lapsing, payments past due, renewals coming up — plus MRR." },
      { label: "Plans & pricing", href: "/dashboard/superadmin/plans", cap: "plans",
        desc: "The 4 subscription tiers — pricing, features, and what each tier unlocks." },
      { label: "Rollout cohorts", href: "/dashboard/superadmin/rollout", cap: "plans",
        desc: "Stage feature rollouts across tenant cohorts." },
      { label: "Subscriber referral fees", href: "/dashboard/superadmin/growth#subscriber-referrals", cap: "billing",
        desc: "Who referred each paying tenant, the fee owed from its MRR, and the mark-paid ledger." },
    ],
  },
  {
    title: "Support", icon: LifeBuoy, tools: [
      { label: "Communications — platform lines", href: "/dashboard/superadmin/communications", cap: "support",
        desc: "The AI phone reception + outbound rails" },
      { label: "Support console", href: "/dashboard/superadmin/support", cap: "support", countKey: "openTickets",
        desc: "Every tenant's tickets — queue with SLA flags, threads, replies, assignment." },
      { label: "Tenant call logs", href: "/dashboard/superadmin/tenant-calls", cap: "support",
        desc: "Cross-tenant AI call oversight — transcripts + summaries for debugging a tenant's calls. Access is audited." },
    ],
  },
  {
    title: "Marketing & Growth", icon: Megaphone, tools: [
      { label: "Growth — market the platform", href: "/dashboard/superadmin/growth", cap: "marketing",
        desc: "The platform's own funnel: prospects, pitch drafts, brand kit, and the product content calendar." },
    ],
  },
  {
    title: "Systems", icon: Cog, tools: [
      { label: "AI Ops", href: "/dashboard/superadmin/ai-ops", cap: "ai_ops",
        desc: "Cross-tenant AI operations — usage, cost, and the autonomous managers." },
      { label: "OS Sentinel", href: "/dashboard/superadmin/sentinel", cap: "sentinel",
        desc: "One view of the whole agentic OS — subsystems, open incidents, self-healing." },
      { label: "Observability", href: "/dashboard/superadmin/observability", cap: "sentinel",
        desc: "System health, cron runs, and error surfaces across the platform." },
      { label: "Continuity board", href: "/dashboard/superadmin/continuity", cap: "sentinel",
        desc: "Business-continuity posture — what keeps running when a dependency fails." },
      { label: "Connectors", href: "/dashboard/superadmin/connectors", cap: "providers",
        desc: "Vendor connector status — connected, expiring, broken." },
      { label: "Connection health — every tenant", href: "/dashboard/superadmin/connection-health", cap: "sentinel",
        desc: "Per tenant × their connected integrations — OAuth expiry and inactive credentials across the fleet." },
      { label: "Connector healing", href: "/dashboard/superadmin/connector-healing", cap: "providers", countKey: "pendingHealing",
        desc: "AI-proposed connector fixes awaiting a human approve/reject." },
      { label: "Env providers", href: "/dashboard/superadmin/env-providers", cap: "providers",
        desc: "Environment-level provider keys and configuration." },
      { label: "API tokens", href: "/dashboard/superadmin/api-tokens", cap: "providers",
        desc: "Platform API tokens — issue, scope, revoke." },
      { label: "A2P 10DLC", href: "/dashboard/superadmin/a2p", cap: "providers",
        desc: "Every tenant's SMS campaign registration status." },
      { label: "Suppression list", href: "/dashboard/superadmin/suppression", cap: "sentinel",
        desc: "Platform-wide outbound suppression — addresses that must never be contacted." },
      { label: "Vendors — every tenant", href: "/dashboard/superadmin/vendors", cap: "sentinel",
        desc: "Cross-tenant vendor network — status, portal linkage, premium placements, and the invoice ledger." },
    ],
  },
  {
    title: "Governance", icon: ShieldCheck, tools: [
      { label: "Platform console", href: "/dashboard/superadmin/platform", cap: "staff",
        desc: "The god switch — emergency mode, AI engine, providers, cross-tenant margin and safety feeds." },
      { label: "Platform staff", href: "/dashboard/superadmin/staff", cap: "staff",
        desc: "The people who run the platform — roles from the capability map." },
      { label: "Action ledger", href: "/dashboard/superadmin/audit", cap: "staff",
        desc: "superadmin_audit_log — who changed what, when, from where." },
      { label: "Audit trail", href: "/dashboard/superadmin/audit-trail", cap: "staff",
        desc: "Platform audit trail across tenant-affecting events." },
    ],
  },
]

const ROLE_BLURB: Record<string, string> = {
  superadmin: "Full platform control — every surface below is yours.",
  admin: "Operate the platform — everything except managing staff roles.",
  marketing: "Market the platform and see the tenants it serves.",
  support: "Support every tenant and step inside one when a ticket needs it.",
}

export default async function PlatformStaffHomePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: profile } = await supabase.from("users").select("user_type, platform_role, first_name").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRole(profile as any)
  if (!isPlatformStaffRole(role)) {
    return <div className="p-6 text-red-600">Forbidden: platform staff access only</div>
  }

  const can = (cap: PlatformCapability) => platformStaffCan(role, cap)
  const svc = createServiceClient()

  // Live counts — cheap HEAD counts only, and only for surfaces this role can reach.
  const [tenantsRes, ticketsRes, healingRes, announcementsRes] = await Promise.all([
    can("tenants")
      ? svc.from("brokerages").select("id", { count: "exact", head: true }).eq("status", "active")
      : Promise.resolve({ count: null, error: null }),
    can("support")
      ? svc.from("support_tickets").select("id", { count: "exact", head: true }).in("status", ["open", "in_progress"])
      : Promise.resolve({ count: null, error: null }),
    can("providers")
      ? svc.from("connector_healing_proposals").select("id", { count: "exact", head: true }).eq("status", "pending")
      : Promise.resolve({ count: null, error: null }),
    svc.from("notifications")
      .select("id, title, body, priority, is_read, created_at")
      .eq("user_id", user.id).eq("type", PLATFORM_ANNOUNCEMENT_TYPE)
      .order("created_at", { ascending: false }).limit(5),
  ])

  // HR: does MY staff profile carry an employment agreement I haven't acknowledged?
  const { data: hrProfile, error: hrErr } = await svc
    .from("platform_staff_profiles")
    .select("employment_agreement_text, agreement_acknowledged_at")
    .eq("user_id", user.id)
    .maybeSingle()
  const pendingAgreement =
    hrErr == null && (hrProfile as any)?.employment_agreement_text && !(hrProfile as any)?.agreement_acknowledged_at
      ? ((hrProfile as any).employment_agreement_text as string)
      : null

  const counts: Record<NonNullable<Tool["countKey"]>, string | null> = {
    activeTenants: tenantsRes.error == null && tenantsRes.count != null ? `${tenantsRes.count} active` : null,
    openTickets: ticketsRes.error == null && ticketsRes.count != null ? `${ticketsRes.count} open` : null,
    pendingHealing: healingRes.error == null && healingRes.count != null ? `${healingRes.count} pending` : null,
  }
  const announcements = announcementsRes.error == null ? (announcementsRes.data ?? []) : []

  const visibleGroups = GROUPS
    .map((g) => ({ ...g, tools: g.tools.filter((t) => can(t.cap)) }))
    .filter((g) => g.tools.length > 0)

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            Platform home{(profile as any)?.first_name ? ` — ${(profile as any).first_name}` : ""}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{ROLE_BLURB[role] ?? "Your platform tools."}</p>
        </div>
        <Badge variant="outline" className="text-xs capitalize">{role}</Badge>
      </div>

      {/* HR: my employment agreement awaits MY acknowledgment (self-row action, audited) */}
      {pendingAgreement && <AgreementAckBanner agreementText={pendingAgreement} />}

      {/* Internal staff announcements — the lightweight comms lane (admin+ post, all staff read) */}
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2"><Bell className="h-4 w-4 text-primary" />Platform announcements</CardTitle>
          {can("announcements") && <AnnouncementComposer />}
        </CardHeader>
        <CardContent>
          {announcements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No announcements yet.</p>
          ) : (
            <ul className="space-y-3">
              {(announcements as any[]).map((a) => (
                <li key={a.id} className="border-b last:border-0 pb-3 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{a.title}</span>
                    {a.priority === "high" && <Badge className="text-[10px] bg-red-100 text-red-800">high</Badge>}
                    {!a.is_read && <span className="h-1.5 w-1.5 rounded-full bg-primary" title="Unread" />}
                    <span className="ml-auto text-[11px] text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap mt-0.5">{a.body}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Capability-grouped tool cards — only what THIS role can reach */}
      {visibleGroups.map((g) => (
        <section key={g.title}>
          <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5 mb-2">
            <g.icon className="h-4 w-4" />{g.title}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.tools.map((t) => {
              const count = t.countKey ? counts[t.countKey] : null
              return (
                <Card key={t.href + t.label} className="hover:border-primary/50 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{t.label}</span>
                      {count && <Badge variant="secondary" className="text-[10px] tabular-nums">{count}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 min-h-[2rem]">{t.desc}</p>
                    <Button asChild size="sm" variant="ghost" className="mt-2 -ml-2 h-7 px-2 text-xs">
                      <Link href={t.href}>Open <ArrowRight className="h-3 w-3 ml-1" /></Link>
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
