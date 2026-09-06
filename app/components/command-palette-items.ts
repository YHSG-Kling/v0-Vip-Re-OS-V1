// app/components/command-palette-items.ts
//
// The command palette's entry roster + its ROLE ADMISSION logic, extracted to a
// pure module (no "use client", no JSX) so the guard chain can drive it
// (scripts/command-palette-role-simulator.ts) exactly as the role-union-nav
// guard drives navigation-config.
//
// ONE VOCABULARY (CLAUDE.md §6): this module holds NO role roster of its own.
// Which roles may see an entry is decided ENTIRELY by the navigation config —
// getNavigationForRole(heldRoles) from app/config/navigation-config.ts, the
// same call app-shell uses to build the sidebar — so the palette can never
// drift from the nav. Two mechanisms, both sourced there:
//
//   1. NAVIGATION_BY_ROLE[role].commandPaletteItems — the per-role quick-action
//      lane the nav config has ALWAYS carried and merged (proved by
//      role-union-nav probe U4), which until now had no reader in the product
//      (a writer with no reader, §1) — the palette is that reader.
//   2. The rich entries below are admitted per user by whether their
//      destination path is REACHABLE from that user's merged navigation
//      (exact path, or a sub-path of a nav-linked page — the same prefix
//      semantics lib/kernel/helpers.ts ROUTE_ROLE_REQUIREMENTS uses).
//
// FAIL CLOSED (§4): no roles loaded → NO entries. An entry whose destination
// no role's navigation reaches is shown to NOBODY, not everybody.
//
// Icons are lucide icon NAMES (strings), the same vocabulary the nav config
// uses, mapped to components inside command-palette.tsx.

import { getNavigationForRole } from "@/app/config/navigation-config"
import type { NavigationConfig, NavItem } from "@/app/types/navigation"

export interface PaletteItem {
  label: string
  href: string
  /** lucide-react icon name — same string vocabulary as navigation-config. */
  icon: string
  group: string
}

// ─── Entry roster ────────────────────────────────────────────────────────────
// Formerly NAV_ITEMS + ACTION_ITEMS inside command-palette.tsx, shown to every
// user unconditionally. Content preserved; hrefs corrected where the palette
// carried a second spelling of a destination the navigation already names
// (each correction commented at the entry).

export const PALETTE_ITEMS: readonly PaletteItem[] = [
  // ── Navigation ─────────────────────────────────────────────────────────────
  { label: "Dashboard", href: "/dashboard/agent", icon: "LayoutGrid", group: "Navigation" },
  { label: "AI Briefing", href: "/dashboard/briefing", icon: "Sparkles", group: "Navigation" },
  { label: "My Contacts (CRM)", href: "/crm", icon: "Users", group: "Navigation" },
  { label: "My Listings", href: "/dashboard/listings", icon: "Home", group: "Navigation" },
  { label: "Transactions", href: "/dashboard/transactions", icon: "FileText", group: "Navigation" },
  { label: "Open Houses", href: "/dashboard/open-houses", icon: "CalendarDays", group: "Navigation" },
  // Was /dashboard/inbox — a spelling no role's navigation carries. The nav's
  // inbox (agent + broker Communications group) is /dashboard/communications/inbox.
  { label: "Communications Inbox", href: "/dashboard/communications/inbox", icon: "MessageCircle", group: "Navigation" },
  { label: "Video Library", href: "/dashboard/videos/library", icon: "Video", group: "Navigation" },
  { label: "Social Dashboard", href: "/dashboard/social", icon: "Share2", group: "Navigation" },
  // Was /dashboard/analytics — the nav's analytics entry (broker + admin) is /analytics.
  { label: "Analytics", href: "/analytics", icon: "BarChart3", group: "Navigation" },
  { label: "Market Insights", href: "/dashboard/market-insights", icon: "TrendingUp", group: "Navigation" },
  { label: "My Financials", href: "/dashboard/financials/agent", icon: "DollarSign", group: "Navigation" },
  { label: "Goals Dashboard", href: "/dashboard/goals", icon: "Activity", group: "Navigation" },
  { label: "Education Library", href: "/dashboard/education", icon: "GraduationCap", group: "Navigation" },
  { label: "Referrals & Reviews", href: "/lifetime-customers?tab=referrals", icon: "Users", group: "Navigation" },
  // /dashboard/content (Content OS) is carried by the content groups of agent,
  // broker, admin, team_lead and the shared MARKETING_GROUP (tc + compliance
  // officer) since wave 19 — it had been a nav orphan, and the role filter
  // correctly hid it from everyone until test:ai-content-wiring made the
  // collision visible. Its sub-pages (approvals) ride the prefix rule.
  { label: "Content OS", href: "/dashboard/content", icon: "Sparkles", group: "Navigation" },
  { label: "Content Approvals", href: "/dashboard/content/approvals", icon: "Shield", group: "Admin" },
  { label: "Data Health", href: "/dashboard/admin/data-health", icon: "Activity", group: "Admin" },
  { label: "AI Usage & Cost", href: "/dashboard/admin/ai-usage", icon: "Sparkles", group: "Admin" },
  { label: "Automation Events", href: "/dashboard/admin/events", icon: "Activity", group: "Admin" },
  { label: "Agent Onboarding", href: "/dashboard/admin/onboarding", icon: "UserPlus", group: "Admin" },
  { label: "Knowledge Base", href: "/dashboard/settings/knowledge-base", icon: "BookOpen", group: "Admin" },
  { label: "Settings", href: "/settings", icon: "Settings", group: "Settings" },
  { label: "Brand Voice", href: "/settings/brand-voice", icon: "Mic", group: "Settings" },
  { label: "Integrations", href: "/settings/integrations", icon: "Settings", group: "Settings" },

  // ── Create ─────────────────────────────────────────────────────────────────
  { label: "Draft offer", href: "/crm?action=draft_offer", icon: "FileEdit", group: "Create" },
  // Was /dashboard/listings/new — no page.tsx exists there (404). The real
  // create surface is /dashboard/listings?action=new (app/listings/new/page.tsx
  // itself redirects there), same repoint style as the 2026-08-29 sweep.
  { label: "Draft listing agreement", href: "/dashboard/listings?action=new", icon: "FileEdit", group: "Create" },
  { label: "Create new listing", href: "/dashboard/listings?action=new", icon: "Plus", group: "Create" },
  { label: "Schedule open house", href: "/dashboard/open-houses?action=new", icon: "CalendarDays", group: "Create" },
  { label: "Schedule showing", href: "/crm?action=schedule_showing", icon: "Calendar", group: "Create" },
  { label: "Schedule buyer tour", href: "/crm?action=schedule_tour", icon: "MapPin", group: "Create" },
  // ── FIVE DEAD CONTROLS, REPOINTED (dangling-link sweep, 2026-08-29) ────────
  // Each of these hrefs had NO page.tsx, so typing the command landed the user
  // on a 404. Each now names the surface that actually performs the action:
  //   /dashboard/cma/new                 → /dashboard/listings (MassCMAButton +
  //       CmaHistorySheet live there; per-listing CMA is /dashboard/listings/[id]/cma,
  //       and ROUTE_ALIASES already records /dashboard/cma → /dashboard/listings)
  //   /dashboard/marketing/newsletter    → /newsletters ("Create Newsletter",
  //       newsletter_campaigns)
  //   /dashboard/marketing/email         → /dashboard/marketing/studio?tab=newsletters,
  //       whose "Email Campaigns" card is the writer of email_campaigns
  //   /dashboard/marketing/image         → /dashboard/social?action=create, the only
  //       surface that mounts <GenerateImageButton> (the post composer)
  // ?action=new on the social composer was ALSO dead: page.tsx reads
  // `action === "create"`, so the composer never opened. One spelling now (§6).
  { label: "Generate CMA", href: "/dashboard/listings", icon: "BarChart3", group: "Create" },
  { label: "Compose newsletter", href: "/newsletters", icon: "Newspaper", group: "Create" },
  { label: "Compose email campaign", href: "/dashboard/marketing/studio?tab=newsletters", icon: "Mail", group: "Create" },
  { label: "Compose social post", href: "/dashboard/social?action=create", icon: "Share2", group: "Create" },
  { label: "Generate AI image", href: "/dashboard/social?action=create", icon: "ImageIcon", group: "Create" },
  { label: "Generate AI video", href: "/dashboard/videos/create", icon: "Video", group: "Create" },
  { label: "Record podcast episode", href: "/dashboard/marketing/podcast?action=new", icon: "Headphones", group: "Create" },
  // Was /dashboard/marketing/blog/new — no page.tsx exists there (404; the
  // sixth dead control the 2026-08-29 sweep missed). The nav's blog surface
  // (every marketing-holding role) is /dashboard/marketing/studio?tab=blog.
  { label: "Write blog post", href: "/dashboard/marketing/studio?tab=blog", icon: "PenLine", group: "Create" },
  { label: "Send direct mail", href: "/dashboard/campaigns/mail?action=new", icon: "Send", group: "Create" },
  { label: "Launch ad campaign", href: "/dashboard/campaigns/ads?action=new", icon: "Megaphone", group: "Create" },
  { label: "Send gift", href: "/lifetime-customers?action=send_gift", icon: "Gift", group: "Create" },
  { label: "Add new contact", href: "/crm?action=new_contact", icon: "UserPlus", group: "Create" },

  // ── Find — navigates to /crm with a search; the page reads ?q= ─────────────
  { label: "Find a contact", href: "/crm?focus=search", icon: "Search", group: "Find" },
  { label: "Find a listing", href: "/dashboard/listings?focus=search", icon: "Search", group: "Find" },
  { label: "Find a transaction", href: "/dashboard/transactions?focus=search", icon: "Search", group: "Find" },

  // ── Today — segmented dashboards / queues ──────────────────────────────────
  { label: "Today's gameplan", href: "/dashboard/briefing", icon: "Sparkles", group: "Today" },
  // /dashboard/calendar got its nav home 2026-08-31 (agent / broker /
  // team_lead sidebars in navigation-config.ts — the working-day roles), so
  // these three entries are now visible to exactly those roles via the same
  // nav-inheritance that fixed Content OS. Zero palette-local role logic.
  { label: "Today's showings", href: "/dashboard/calendar?filter=showings&day=today", icon: "Calendar", group: "Today" },
  { label: "Today's appointments", href: "/dashboard/calendar?day=today", icon: "CalendarDays", group: "Today" },
  { label: "Today's tours", href: "/dashboard/calendar?filter=tours&day=today", icon: "MapPin", group: "Today" },
  // Was /dashboard/inbox — see "Communications Inbox" above; one spelling (§6).
  { label: "Open inbox", href: "/dashboard/communications/inbox", icon: "Inbox", group: "Today" },

  // ── Pipeline / segmented queues ────────────────────────────────────────────
  { label: "Hot leads", href: "/crm?segment=hot", icon: "Flame", group: "Pipeline" },
  { label: "At-risk contacts", href: "/crm?segment=at_risk", icon: "AlertTriangle", group: "Pipeline" },
  { label: "New contacts (last 7d)", href: "/crm?segment=new", icon: "Plus", group: "Pipeline" },
  { label: "Likely sellers", href: "/crm?segment=likely_seller", icon: "Target", group: "Pipeline" },
  { label: "Wealth opportunities", href: "/dashboard/agent?focus=wealth", icon: "TrendingUp", group: "Pipeline" },
  { label: "Lifetime customers", href: "/lifetime-customers", icon: "Star", group: "Pipeline" },
  { label: "Pending offers", href: "/dashboard/transactions?status=pending_offer", icon: "FileText", group: "Pipeline" },
  { label: "Countered offers", href: "/dashboard/transactions?status=countered", icon: "FileText", group: "Pipeline" },
  { label: "Active listings", href: "/dashboard/listings?status=active", icon: "Home", group: "Pipeline" },
  { label: "Coming soon listings", href: "/dashboard/listings?status=coming_soon", icon: "Home", group: "Pipeline" },
  { label: "Closing this week", href: "/dashboard/transactions?filter=closing_this_week", icon: "ClipboardCheck", group: "Pipeline" },
  { label: "Recently closed", href: "/dashboard/transactions?status=closed", icon: "ClipboardCheck", group: "Pipeline" },

  // ── CDA / Compliance ───────────────────────────────────────────────────────
  { label: "View pending CDAs", href: "/dashboard/compliance#cda-queue", icon: "Shield", group: "CDA" },
  { label: "Compliance violations", href: "/dashboard/compliance?tab=violations", icon: "AlertTriangle", group: "CDA" },
  { label: "Approval queue", href: "/dashboard/content/approvals", icon: "Shield", group: "CDA" },
  { label: "Approval routing preview", href: "/dashboard/content/approvals", icon: "Shield", group: "CDA" },

  // ── Content OS ─────────────────────────────────────────────────────────────
  { label: "Content drafts", href: "/dashboard/content?tab=drafts", icon: "FileText", group: "Content" },
  { label: "Content templates", href: "/dashboard/content?tab=templates", icon: "FileText", group: "Content" },
  { label: "Write listing descriptions", href: "/dashboard/content?tab=listings", icon: "Wand2", group: "Content" },
  { label: "SEO keywords & hashtags", href: "/dashboard/content?tab=seo", icon: "Search", group: "Content" },
  { label: "Content A/B tests", href: "/dashboard/content?tab=experiments", icon: "Activity", group: "Content" },
  { label: "Content performance & AI spend", href: "/dashboard/content?tab=performance", icon: "BarChart3", group: "Content" },
  { label: "Build 30-day content plan", href: "/dashboard/content?tab=plan", icon: "Calendar", group: "Content" },
  { label: "Teach my brand voice", href: "/dashboard/content?tab=voice", icon: "Mic", group: "Content" },

  // ── Send / Outreach (route navigates to a template-aware composer) ─────────
  { label: "Compose with AI (voice)", href: "/dashboard/agent?action=ai_voice", icon: "Mic", group: "Send" },
  { label: "Send touchpoint", href: "/crm?action=send_touchpoint", icon: "Wand2", group: "Send" },
  { label: "Send review request", href: "/lifetime-customers?action=send_review_request", icon: "Star", group: "Send" },
  { label: "Send referral request", href: "/lifetime-customers?action=send_referral_request", icon: "Users", group: "Send" },
  { label: "Send buyer intake link", href: "/crm?action=send_buyer_intake", icon: "Send", group: "Send" },
  { label: "Make AI call", href: "/dashboard/isa/calling", icon: "Phone", group: "Send" },

  // ── Operations ─────────────────────────────────────────────────────────────
  { label: "Open vendor marketplace", href: "/dashboard/vendors", icon: "Users", group: "Operations" },
  // /dashboard/lender never had a page.tsx. The loan pipeline is the lender
  // portal's own board, app/lender/pipeline/page.tsx.
  { label: "Open lender pipeline", href: "/lender/pipeline", icon: "DollarSign", group: "Operations" },
  { label: "Open TC dashboard", href: "/dashboard/coordinator", icon: "ClipboardCheck", group: "Operations" },
  { label: "Open broker dashboard", href: "/dashboard/admin", icon: "BarChart3", group: "Operations" },
  { label: "View commissions", href: "/dashboard/financials/agent", icon: "DollarSign", group: "Operations" },
  { label: "View workflow analytics", href: "/dashboard/admin?widget=workflow_reports", icon: "Activity", group: "Operations" },
  { label: "View transaction-form library", href: "/dashboard/admin/transaction-forms", icon: "FileText", group: "Operations" },
]

// ─── Role admission ──────────────────────────────────────────────────────────

/** Strip query string and hash — admission is decided on the pathname. */
export function pathnameOf(href: string): string {
  return href.split(/[?#]/)[0]
}

/**
 * Ancestors that admit NOTHING by prefix. "/dashboard" appears in several
 * roles' navigation as the mobile "More" target; letting it seed prefix
 * admission would open the entire /dashboard tree — including /dashboard/admin
 * and /dashboard/superadmin — to every staff role, which is exactly the
 * unfiltered palette this module replaces.
 */
const GENERIC_ANCESTORS: ReadonlySet<string> = new Set(["/", "/dashboard"])

/**
 * A destination is admitted when the user's navigation links its exact path,
 * or links an ancestor page of it (a nav-linked /crm admits /crm/contacts/new —
 * the same prefix semantics as ROUTE_ROLE_REQUIREMENTS in lib/kernel/helpers.ts),
 * generic roots excepted. Anything else is refused — fail closed.
 */
export function isPathAdmitted(href: string, reachable: ReadonlySet<string>): boolean {
  let path = pathnameOf(href)
  if (GENERIC_ANCESTORS.has(path)) return false
  if (reachable.has(path)) return true
  for (;;) {
    const cut = path.lastIndexOf("/")
    if (cut <= 0) return false
    path = path.slice(0, cut)
    if (GENERIC_ANCESTORS.has(path)) return false
    if (reachable.has(path)) return true
  }
}

/** Every pathname the given navigation links, across all four lanes, children included. */
export function collectReachablePaths(nav: NavigationConfig): Set<string> {
  const out = new Set<string>()
  const walk = (items?: readonly NavItem[]) => {
    for (const item of items ?? []) {
      if (item.href) out.add(pathnameOf(item.href))
      if (item.children) walk(item.children as readonly NavItem[])
    }
  }
  walk(nav.sidebarItems as readonly NavItem[])
  walk(nav.topNavItems as readonly NavItem[])
  walk(nav.mobileBottomNav as readonly NavItem[])
  walk(nav.commandPaletteItems as readonly NavItem[])
  return out
}

/**
 * The palette a user with these roles may see.
 *
 * FAIL CLOSED: roles not loaded / empty → NO entries — never a default roster.
 *
 * Composition, both halves sourced from getNavigationForRole (multi-role users
 * get the same merged union the sidebar shows — proved by test:role-union-nav):
 *   1. "Quick Actions" — the merged commandPaletteItems lane of the nav config.
 *   2. The rich roster above, filtered to nav-reachable destinations.
 */
export function visiblePaletteItems(
  roles: readonly string[] | null | undefined
): PaletteItem[] {
  if (!roles || roles.length === 0) return []

  const nav = getNavigationForRole([...roles])
  const reachable = collectReachablePaths(nav)

  const out: PaletteItem[] = []

  // Quick Actions dedupe on label+href only: two nav entries may deliberately
  // name the same destination differently (the palette's original composite-key
  // rule — identical hrefs across groups do not collide), so href alone must
  // not collapse them, and the rich roster below is NOT deduped against these.
  const seenQuick = new Set<string>()
  for (const item of (nav.commandPaletteItems ?? []) as readonly NavItem[]) {
    if (!item.href || !item.label) continue
    const key = `${item.label}|${item.href}`
    if (seenQuick.has(key)) continue
    seenQuick.add(key)
    out.push({ label: item.label, href: item.href, icon: "Sparkles", group: "Quick Actions" })
  }

  for (const item of PALETTE_ITEMS) {
    if (isPathAdmitted(item.href, reachable)) out.push(item)
  }

  return out
}
