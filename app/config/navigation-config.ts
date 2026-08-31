'use strict'

import { UserRole } from '@/app/types/roles'
import { NavigationConfig, NavItem } from '@/app/types/navigation'

// ─── CROSS-ROLE SURFACE GROUPS ───────────────────────────────────────────────
//
// OWNER RULING, verbatim: "a tc needs to see compliance and marketing;
// compliance officer needs to see transactions and marketing… the compliance
// manager is the one that deals with marketing."
//
// Neither of those was true. MEASURED before this change:
//   tc                 7 sidebar items — transactions only. NO compliance, NO marketing.
//   compliance_officer 14 sidebar items — compliance only. NO transactions, NO marketing.
//
// These three consts exist so the shared surfaces have ONE definition. The
// alternative — pasting the items into each role's array — is how the same link
// ends up with two hrefs and one of them rots; this file already carries scars
// from that (several `Nav-parity:` and `Orphan-route sweep:` comments below mark
// links that had gone missing from one role and not another).
//
// Every href here is COPIED VERBATIM from the role that already owned it, not
// invented: the transaction items from `tc`, the compliance items from
// `compliance_officer`, the marketing group from the broker/admin `content`
// group. A new href would be a route nobody has built.
//
// getNavigationForRole() dedupes by `id || href` when it merges several roles, so
// a user holding BOTH tc and compliance_officer sees each of these once, not twice.

/** Deal-coordination surfaces. Source of truth: the `tc` role's own sidebar. */
const TRANSACTION_ITEMS: readonly NavItem[] = [
  { id: 'deals', label: 'Active Deals', href: '/transaction/deals', icon: 'Handshake', badgeKey: 'active_deals' },
  { id: 'checklists', label: 'Checklists', href: '/transaction/checklists', icon: 'CheckSquare' },
  { id: 'documents', label: 'Documents', href: '/transaction/documents', icon: 'Folder' },
  { id: 'vendors', label: 'Vendor Coordination', href: '/transaction/vendors', icon: 'Users' },
] as const

/**
 * Compliance surfaces a NON-compliance-officer role needs in order to do its own
 * job — deliberately NARROWER than the compliance officer's own sidebar.
 *
 * A TC needs to know what is BLOCKING a file: the queue, and the violations
 * raised against it. A TC does not need Policies, Audit Logs, AI Quality or Comm
 * Intelligence — those are the officer's instruments, not a coordinator's, and
 * handing them over would make the two roles identical.
 *
 * "Required Documents" is deliberately ABSENT. The only route of that name is
 * /dashboard/settings/required-documents, which is where a BROKERAGE CONFIGURES
 * which documents it demands — an admin surface, not a per-deal one. The
 * coordinator's per-deal equivalent is Checklists, which they already have. (I
 * first wrote this const with a /compliance/required-documents entry; that route
 * does not exist. Checking every href against app/ before shipping is why it is
 * not in here.)
 */
const COMPLIANCE_ITEMS_FOR_COORDINATION: readonly NavItem[] = [
  { id: 'compliance-queue', label: 'Compliance Queue', href: '/dashboard/compliance/queue', icon: 'ListChecks' },
  { id: 'violations', label: 'Violations', href: '/compliance/violations', icon: 'AlertTriangle', badgeKey: 'compliance_violations' },
] as const

/**
 * The marketing group, verbatim from the broker/admin `content` group.
 *
 * Given to BOTH tc and compliance_officer by the ruling. For the compliance
 * officer it is not a courtesy: they are "the one that deals with marketing", so
 * Review Queue is their approval surface — the place brand/fair-housing review
 * actually happens — and it was unreachable for them before this.
 */
const MARKETING_GROUP: NavItem = {
  id: 'content',
  label: 'Marketing & Content',
  icon: 'Palette',
  children: [
    { id: 'marketing-studio', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
    // Content OS: the AI content workspace (drafts, SEO, experiments, plan). Was a nav orphan — the page existed, the palette deep-linked it (guarded by test:ai-content-wiring), and NO role's navigation carried it, so the role-filtered palette correctly hid it from everyone. The nav entry is the fix; the palette inherits it.
    { id: 'content-os', label: 'Content OS', href: '/dashboard/content' },
    { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
    { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
    { id: 'newsletter-templates', label: 'Newsletter Templates', href: '/newsletters' },
    { id: 'lead-magnets', label: 'Lead Magnets', href: '/dashboard/marketing/lead-magnets' },
    { id: 'blog', label: 'Blog Posts', href: '/dashboard/marketing/studio?tab=blog' },
    { id: 'podcast', label: 'Podcast Studio', href: '/dashboard/marketing/podcast' },
    { id: 'seo', label: 'SEO / GEO', href: '/dashboard/marketing/seo' },
    { id: 'video-pages', label: 'Video Pages', href: '/dashboard/marketing/video-pages' },
  ],
}

export const NAVIGATION_BY_ROLE: Record<UserRole, NavigationConfig> = {
  agent: {
    sidebarItems: [
      { id: 'briefing', label: 'AI Briefing', href: '/dashboard/briefing', icon: 'Sparkles' },
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'first-deal', label: 'First Deal', href: '/dashboard/agent/first-deal', icon: 'Target' },
      { id: 'ai-roi', label: 'AI ROI', href: '/dashboard/agent/roi', icon: 'TrendingUp' },
      { id: 'refer-agent', label: 'Refer an Agent', href: '/dashboard/agent/refer', icon: 'Share2' },
      // Orphan-route sweep: built client-referral surface no nav linked — now discoverable.
      { id: 'referral-network', label: 'Referral Network', href: '/dashboard/agent/referral-network', icon: 'Share2' },
      { id: 'operations', label: 'Operations', href: '/dashboard/operations', icon: 'Activity' },
      // NOTE: agents work contacts — "My Leads", "Lead Acquisition", and "Lead Intelligence"
      // are intentionally excluded. Lead intake is admin/system; ISA qualification is system.
      { id: 'contacts', label: 'My Contacts', href: '/crm', icon: 'Users' },
      // Tenant mirror of the round-31 staff portal-clients view: which of my
      // contacts have client-portal access + pending invites.
      { id: 'portal-clients', label: 'Portal Clients', href: '/crm/portal-clients', icon: 'DoorOpen' },
      { id: 'listings', label: 'My Listings', href: '/dashboard/listings', icon: 'Home' },
      { id: 'listing-health', label: 'Listing Health', href: '/dashboard/listings/health', icon: 'ShieldCheck' },
      { id: 'open-houses', label: 'Open Houses', href: '/dashboard/open-houses', icon: 'CalendarDays' },
      { id: 'showing-prep', label: 'Showing Prep', href: '/dashboard/showings/prep', icon: 'Sparkles' },
      { id: 'transactions', label: 'Transactions', href: '/dashboard/transactions', icon: 'FileText' },
      // Orphan-route sweep (lane G): the STAGE BOARD (TransactionPipelineView —
      // under contract / inspection / appraisal / financing / closing prep /
      // closed, with overdue milestones surfaced per card) was reachable from
      // nothing. It is NOT a duplicate of Transactions above it: that page is a
      // status-grouped LIST, this is the per-stage board, and each answers a
      // different question.
      //
      // NOTE FOR THE INTEGRATOR — the href is `/transactions/pipeline`, not
      // `/dashboard/…`, because the page lives in the route GROUP
      // app/(dashboard)/transactions/pipeline and route groups vanish from the
      // URL. That group holds this one page and has no layout.tsx, so the board
      // renders OUTSIDE the dashboard shell. Reported, not silently "fixed":
      // relocating the page is a move another lane owns.
      { id: 'transaction-pipeline', label: 'Transaction Pipeline', href: '/transactions/pipeline', icon: 'Columns' },
      { id: 'closing-concierge', label: 'Closing Concierge', href: '/dashboard/transactions/closing-concierge', icon: 'ShieldCheck' },
      { id: 'documents', label: 'Document Center', href: '/dashboard/documents', icon: 'FolderOpen' },
      // Orphan-route sweep: AI contract review existed with zero inbound links.
      { id: 'contract-review', label: 'Contract Review', href: '/dashboard/documents/contract-review', icon: 'FileSearch' },
      { id: 'overdue', label: 'Overdue', href: '/dashboard/overdue', icon: 'AlertCircle', badgeKey: 'overdue_count' },
      { id: 'weekly-insights', label: 'Weekly Insights', href: '/dashboard/insights/weekly', icon: 'Sparkles' },
      { id: 'forms-library', label: 'Forms Library', href: '/dashboard/forms', icon: 'ClipboardList' },
      { id: 'divider1', divider: true },
      { id: 'offers', label: 'Offers Pipeline', href: '/offers', icon: 'FileText' },
      {
        id: 'video-tools',
        label: 'Video Tools',
        icon: 'Video',
        children: [
          { id: 'create-video', label: 'Create Video', href: '/dashboard/videos/create' },
          { id: 'twin-studio', label: 'Twin Studio', href: '/dashboard/settings/twin-studio' },
          { id: 'my-videos', label: 'My Videos', href: '/dashboard/videos/library' },
          { id: 'education', label: 'Education', href: '/dashboard/videos/education' },
        ],
      },
      {
        id: 'content',
        label: 'Marketing & Content',
        icon: 'Palette',
        children: [
          { id: 'marketing-studio', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
          { id: 'content-os', label: 'Content OS', href: '/dashboard/content' },
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'brand-voice', label: 'BrandVoice Profile', href: '/dashboard/marketing/studio/brand-voice' },
          { id: 'newsletter-templates', label: 'Newsletter Templates', href: '/newsletters' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
          { id: 'lead-magnets', label: 'Lead Magnets', href: '/dashboard/marketing/lead-magnets' },
          { id: 'blog', label: 'Blog Posts', href: '/dashboard/marketing/studio?tab=blog' },
          { id: 'podcast', label: 'Podcast Studio', href: '/dashboard/marketing/podcast' },
          { id: 'seo', label: 'SEO / GEO', href: '/dashboard/marketing/seo' },
          { id: 'video-pages', label: 'Video Pages', href: '/dashboard/marketing/video-pages' },
        ],
      },
      {
        id: 'campaigns',
        label: 'Campaigns',
        icon: 'Megaphone',
        children: [
          { id: 'sequences', label: 'Automation Sequences', href: '/dashboard/campaigns/sequences' },
          { id: 'workflow-reports', label: 'Workflow Reports', href: '/dashboard/campaigns/workflow-reports' },
          { id: 'ads', label: 'Ad Campaigns', href: '/dashboard/campaigns/ads' },
          { id: 'direct-mail', label: 'Direct Mail', href: '/dashboard/campaigns/mail' },
          { id: 'repurpose', label: 'Repurpose Content', href: '/dashboard/campaigns/repurpose' },
          { id: 'competitive', label: 'Competitive Intel', href: '/dashboard/campaigns/competitive' },
          { id: 'roi', label: 'Campaign ROI', href: '/dashboard/campaigns/roi' },
        ],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: 'MessageCircle',
        children: [
          // Orphan-route sweep (lane G): every CHILD of /dashboard/communications
          // was in this menu and the HUB ITSELF was not — the unified inbox +
          // AI-prioritised queue across email, SMS and the eight social DM
          // channels (getConversations + prioritizeInbox) was reachable from
          // nothing. Listed first because it is the parent of the four below it.
          { id: 'communications-os', label: 'Communications OS', href: '/dashboard/communications' },
          { id: 'inbox', label: 'Inbox', href: '/dashboard/communications/inbox', badgeKey: 'unread_notifications' },
          { id: 'outreach', label: 'AI Outreach', href: '/dashboard/communications/outreach' },
          { id: 'intelligence', label: 'Comm Intelligence', href: '/dashboard/communications/intelligence' },
          { id: 'handoff-cockpit', label: 'Handoff Cockpit', href: '/dashboard/communications/handoffs' },
        ],
      },
      { id: 'market-insights', label: 'Market Insights', href: '/dashboard/market-insights', icon: 'TrendingUp' },
      { id: 'patterns', label: 'Behavioral Patterns', href: '/dashboard/patterns', icon: 'Activity' },
      { id: 'stale', label: 'Stale Queue', href: '/dashboard/stale', icon: 'AlertCircle' },
      // One "Financials" umbrella — earnings/commissions and the fees you owe the
      // brokerage were two separate top-level items; grouped so money lives in one place.
      {
        id: 'financials',
        label: 'Financials',
        icon: 'DollarSign',
        href: '/dashboard/financials/agent',
        children: [
          { id: 'my-financials', label: 'Earnings & Commissions', href: '/dashboard/financials/agent' },
          // Orphan-route sweep: open brokerage-fee charges page must stay reachable.
          { id: 'financials-fees', label: 'My Fees', href: '/dashboard/financials/agent/fees' },
        ],
      },
      { id: 'credit-pipeline', label: 'Credit Pipeline', href: '/credit-pipeline', icon: 'CreditCard' },
      {
        id: 'sphere',
        label: 'Sphere of Influence',
        icon: 'Users',
        href: '/lifetime-customers',
        children: [
          { id: 'sphere-all', label: 'All Sphere Contacts', href: '/lifetime-customers' },
          { id: 'sphere-resonance', label: 'Resonance — Life Events', href: '/dashboard/sphere' },
          { id: 'sphere-wealth', label: 'Wealth Opportunities', href: '/dashboard/wealth' },
          // The Referral & Advocacy Engine (/referrals) was the target here all along.
          // This pointed at the lifetime-customers `radar` tab, which carries none of
          // the ROI rollup, referrer leaderboard, review-request, gifting or anniversary
          // flows — so the whole engine was unreachable from every nav in the product.
          { id: 'sphere-referrals', label: 'Referrals', href: '/referrals' },
          { id: 'sphere-reviews', label: 'Reviews & Reputation', href: '/lifetime-customers?tab=reviews' },
          { id: 'sphere-gifting', label: 'Gifting & Milestones', href: '/lifetime-customers?tab=gifting' },
          // Orphan-route sweep: the Gift Studio command center had no inbound nav link.
          { id: 'sphere-gift-studio', label: 'Gift Studio', href: '/dashboard/gifts' },
        ],
      },
      { id: 'academy', label: 'Academy', href: '/academy', icon: 'BookOpen' },
      { id: 'help-support', label: 'Help & Support', href: '/dashboard/help', icon: 'LifeBuoy' },
      { id: 'approvals', label: 'Approvals', href: '/approvals', icon: 'CheckSquare' },
      // Tier-parity: a solo-tier principal signs in as an agent — the Command Center
      // (AI-teammate roster, earned autonomy, trust meter, QBR) is their room too.
      // The page itself gates: non-principal staff agents are redirected to /dashboard.
      { id: 'command-center', label: 'AI Command Center', href: '/dashboard/admin/command-center', icon: 'Bot' },
      { id: 'intelligence-report', label: 'Monthly Intelligence Report', href: '/dashboard/intelligence-report', icon: 'Sparkles' },
      { id: 'divider2', divider: true },
      {
        id: 'ai-tools',
        label: 'AI Tools',
        icon: 'Sparkles',
        children: [
          { id: 'ai-tools-hub', label: 'AI Toolkit', href: '/dashboard/ai-tools' },
          { id: 'ai-chat', label: 'AI Chat', href: '/dashboard/chat' },
          { id: 'voice-command', label: 'Voice Assistant', href: '/dashboard/voice' },
          { id: 'ai-briefing', label: 'Daily Briefing', href: '/dashboard/briefing' },
        ],
      },
      { id: 'reporting-center', label: 'Pipeline Analytics', href: '/dashboard/reporting', icon: 'BarChart3' },
      { id: 'coaching', label: 'Training & Coaching', href: '/dashboard/coaching', icon: 'Award' },
      { id: 'practice', label: 'Objection Practice', href: '/dashboard/coaching/practice', icon: 'Sparkles' },
      // Orphan-route sweep (lane G): /dashboard/coaching/sessions is the surface
      // the two coaching handlers in app/actions/copilot.ts were written for —
      // `handleCoachingSessionBooked` (the ONLY writer of a coaching booking) and
      // `handleSuggestionAccepted` (the ONLY writer of the `accepted` status on
      // smart_assistant_suggestions). The page exists and was reachable from
      // nothing, so neither verb had ever been exercisable by a human. Its own
      // docblock said the missing piece was one nav line; this is that line.
      { id: 'coaching-sessions', label: 'Coaching Sessions', href: '/dashboard/coaching/sessions', icon: 'CalendarCheck' },
      { id: 'goals', label: 'My Goals', href: '/dashboard/goals', icon: 'Target' },
      // Orphan-route sweep (lane G): the Income Truth surface — the income-engine
      // gap projection plus its per-action disposition verbs
      // (computeAndPersistGapAction / getLatestGapAction) — had no nav entry.
      // Filed beside My Goals: it is the same question ("am I going to make it?")
      // answered from the ledger rather than from a target.
      { id: 'income-truth', label: 'Income Truth', href: '/dashboard/income-truth', icon: 'DollarSign' },
      { id: 'voice-intelligence', label: 'Voice Intelligence', href: '/dashboard/voice-intelligence', icon: 'Mic' },
      { id: 'motivation', label: 'Motivation', href: '/dashboard/motivation', icon: 'Trophy' },
      // Orphan-route sweep: challenges gamification surface was unreachable.
      { id: 'challenges', label: 'Challenges', href: '/dashboard/challenges', icon: 'Trophy' },
      { id: 'diagnosis', label: 'Business Diagnosis', href: '/dashboard/diagnosis', icon: 'Stethoscope' },
      { id: 'reports', label: 'Reports', href: '/dashboard/reports', icon: 'BarChart3' },
      {
        id: 'agent-tools',
        label: 'Agent Tools',
        icon: 'Wrench',
        children: [
          { id: 'business-cards', label: 'Business Cards', href: '/dashboard/agent/business-cards' },
          { id: 'qr-codes', label: 'QR Codes', href: '/dashboard/agent/qr-codes' },
          { id: 'home-value', label: 'Home Value Tool', href: '/dashboard/tools/home-value' },
          // Orphan-route sweep: calculators dashboard existed with zero inbound links.
          { id: 'calculators', label: 'Calculators', href: '/dashboard/calculators' },
        ],
      },
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell' },
      { id: 'divider3', divider: true },
      // Walkthrough [44/45] "Profile goes settings / Settings goes to settings" — My
      // Profile was filed INSIDE the Settings group, so both nav paths landed in
      // settings and the agent had no distinct place that was about them. Their
      // identity (name, license, bio, photo, voice) is not app configuration, so it
      // sits at the top level beside Settings rather than inside it.
      { id: 'my-profile', label: 'My Profile', href: '/dashboard/profile', icon: 'User' },
      {
        id: 'settings',
        label: 'Settings',
        icon: 'Settings',
        children: [
          { id: 'settings-general', label: 'General', href: '/dashboard/settings/general' },
          { id: 'settings-calendar', label: 'Calendar Sync', href: '/dashboard/settings/calendar' },
          { id: 'settings-branding', label: 'Branding', href: '/dashboard/settings/branding' },
          // Owner: "settings sets territories covered." subscriber_service_areas — the
          // per-zip roster lib/platform/distribution-engine.ts routes platform leads
          // through — had no settings surface at all; its only writer was a side effect
          // of creating a lead-SCRAPING market. It is listed HERE as well as under
          // Brokerage Settings because the table's grain is brokerage / team / agent and
          // an agent may set their own coverage: one destination, and the page itself
          // decides from the SESSION which grains that particular viewer may write.
          { id: 'settings-territories', label: 'Territories', href: '/dashboard/settings/territories' },
          // Walkthrough [28]: this AGENT entry pointed at the brokerage's provider
          // CREDENTIAL surface (platform_credentials API keys, provider overrides) — a
          // broker/admin responsibility, not an individual agent's. Agents connect their
          // own accounts in the Connection Center; the credential surface stays in the
          // admin navigation, where it is reached by roles that may actually manage it.
          { id: 'settings-connections', label: 'Connections', href: '/settings/connections' },
          { id: 'settings-isa-calling', label: 'ISA Calling', href: '/dashboard/settings/isa-calling' },
          { id: 'settings-notification-rules', label: 'Notification Rules', href: '/dashboard/settings/notification-rules' },
          { id: 'settings-assistant', label: 'Assistant Voice', href: '/dashboard/settings/assistant' },
          { id: 'settings-embeds', label: 'Embeds', href: '/dashboard/settings/embeds' },
          { id: 'settings-usage', label: 'Usage', href: '/dashboard/settings/usage' },
          { id: 'settings-license-ce', label: 'License & CE', href: '/dashboard/settings/license-ce' },
          { id: 'widget-settings', label: 'Widget & AI Setup', href: '/dashboard/settings/widget' },
          { id: 'podcast-channels', label: 'Podcast Channels', href: '/dashboard/settings/podcast-channels' },
          { id: 'knowledge-base', label: 'Knowledge Base', href: '/dashboard/settings/knowledge-base' },
          { id: 'listing-templates', label: 'Listing Templates', href: '/dashboard/settings/listing-task-templates' },
        ],
      },
    ],
    topNavItems: [
      { id: 'search', label: 'Search', icon: 'Search' },
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'contacts', label: 'Contacts', href: '/crm', icon: 'Users' },
      { id: 'listings', label: 'Listings', href: '/dashboard/listings', icon: 'Home' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'quick-contact', label: 'Create Contact', href: '/crm/contacts/new' },
      { id: 'video-studio', label: 'Create AI Video', href: '/dashboard/videos/create' },
      { id: 'marketing-studio', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
      // ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY — the '/leads'
      // command-palette entry was removed; agents work contacts (post-promotion).
      { id: 'briefing', label: 'AI Daily Briefing', href: '/dashboard/briefing' },
      { id: 'voice', label: 'Voice Command', href: '/dashboard/voice' },
      { id: 'outreach', label: 'AI Outreach', href: '/dashboard/communications/outreach' },
      { id: 'market', label: 'Market Insights', href: '/dashboard/market-insights' },
    ],
  },

  broker: {
    sidebarItems: [
      { id: 'briefing', label: 'AI Briefing', href: '/dashboard/briefing', icon: 'Sparkles' },
      { id: 'dashboard', label: 'Broker Dashboard', href: '/dashboard/brokerage', icon: 'LayoutGrid' },
      { id: 'operations', label: 'Operations', href: '/dashboard/operations', icon: 'Activity' },
      { id: 'team', label: 'My Team', href: '/dashboard/team', icon: 'Users' },
      { id: 'portal-clients', label: 'Portal Clients', href: '/crm/portal-clients', icon: 'DoorOpen' },
      { id: 'help-support', label: 'Help & Support', href: '/dashboard/help', icon: 'LifeBuoy' },
      { id: 'lead-intel', label: 'Lead Intelligence', href: '/leads', icon: 'Brain' },
      // The funnel cockpit (raw→gate→promoted aggregates + hot seller-intent). The
      // page shows funnel + promoted leads to broker/broker_admin but withholds the
      // RAW review bench (platform-staff only via its isPlatform gate), so this is
      // a "view the leads, not the raw" surface for the brokerage-admin family.
      { id: 'lead-funnel', label: 'Lead Funnel', href: '/dashboard/admin/lead-intake', icon: 'Filter' },
      { id: 'acquisition', label: 'Lead Acquisition', href: '/dashboard/acquisition', icon: 'Zap' },
      { id: 'analytics', label: 'Analytics', href: '/analytics', icon: 'BarChart3' },
      { id: 'transactions', label: 'All Transactions', href: '/dashboard/transactions', icon: 'FileText' },
      { id: 'documents', label: 'Document Center', href: '/dashboard/documents', icon: 'FolderOpen' },
      { id: 'overdue', label: 'Overdue', href: '/dashboard/overdue', icon: 'AlertCircle' },
      { id: 'forms-library', label: 'Forms Library', href: '/dashboard/forms', icon: 'ClipboardList' },
      { id: 'approvals', label: 'Approvals', href: '/approvals', icon: 'CheckSquare', badgeKey: 'pending_approvals' },
      // Tenant-parity: the Command Center (AI-teammate roster, earned autonomy, trust
      // meter, QBR, autonomy-halt banner) had no nav entry for ANY role — reachable
      // only from QBR email deep-links. It is the principal's room; link it.
      { id: 'command-center', label: 'AI Command Center', href: '/dashboard/admin/command-center', icon: 'Bot' },
      { id: 'voice-command', label: 'Voice Assistant', href: '/dashboard/voice', icon: 'Mic' },
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'divider1', divider: true },
      {
        id: 'intel',
        label: 'Intelligence',
        icon: 'Brain',
        children: [
          { id: 'intelligence-center', label: 'Intelligence Center', href: '/dashboard/brokerage/intelligence' },
          // Orphan-route sweep: the monthly intelligence report page (principal-gated) had no nav entry.
          { id: 'intelligence-report', label: 'Monthly Intelligence Report', href: '/dashboard/intelligence-report' },
          { id: 'deal-health', label: 'Deal Health', href: '/dashboard/brokerage/deal-health' },
          { id: 'fatigue', label: 'Agent Fatigue', href: '/dashboard/brokerage/fatigue' },
          { id: 'team-heatmap', label: 'Team Heatmap', href: '/dashboard/team-heatmap' },
          { id: 'patterns', label: 'Behavioral Patterns', href: '/dashboard/patterns' },
          { id: 'stale', label: 'Stale Queue', href: '/dashboard/stale' },
          { id: 'market-insights', label: 'Market Insights', href: '/dashboard/market-insights' },
          { id: 'coordination', label: 'AI Coordination', href: '/dashboard/coordination' },
          { id: 'ai-quality', label: 'AI Quality', href: '/dashboard/ai-quality' },
          { id: 'recruiting-roi', label: 'Recruiting ROI', href: '/dashboard/recruiting-roi' },
        ],
      },
      {
        id: 'video-tools',
        label: 'Video Tools',
        icon: 'Video',
        children: [
          { id: 'create-video', label: 'Create Video', href: '/dashboard/videos/create' },
          { id: 'twin-studio', label: 'Twin Studio', href: '/dashboard/settings/twin-studio' },
          { id: 'my-videos', label: 'My Videos', href: '/dashboard/videos/library' },
          { id: 'education', label: 'Education', href: '/dashboard/videos/education' },
        ],
      },
      {
        id: 'content',
        label: 'Marketing & Content',
        icon: 'Palette',
        children: [
          { id: 'marketing-studio', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
          { id: 'content-os', label: 'Content OS', href: '/dashboard/content' },
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
          // Nav-parity: the QR manager was in the AGENT sidebar only, so a broker
          // had no way to see the codes their brokerage prints. Same page, same
          // href — it scopes its own data to the caller (see
          // app/actions/qr-management.ts), so a broker lands on the whole
          // brokerage's board rather than an empty personal one.
          { id: 'qr-codes', label: 'QR Codes', href: '/dashboard/agent/qr-codes' },
          // Nav-parity: agents and team leads could reach Newsletters; the broker could not.
          { id: 'newsletter-templates', label: 'Newsletter Templates', href: '/newsletters' },
          { id: 'lead-magnets', label: 'Lead Magnets', href: '/dashboard/marketing/lead-magnets' },
          { id: 'blog', label: 'Blog Posts', href: '/dashboard/marketing/studio?tab=blog' },
          { id: 'podcast', label: 'Podcast Studio', href: '/dashboard/marketing/podcast' },
          { id: 'seo', label: 'SEO / GEO', href: '/dashboard/marketing/seo' },
          { id: 'video-pages', label: 'Video Pages', href: '/dashboard/marketing/video-pages' },
        ],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: 'MessageCircle',
        children: [
          // Nav-parity with the agent block (orphan-route sweep, lane G): the
          // Communications OS hub itself, not just its four children.
          { id: 'communications-os', label: 'Communications OS', href: '/dashboard/communications' },
          { id: 'broker-inbox', label: 'Inbox', href: '/dashboard/communications/inbox' },
          { id: 'intelligence', label: 'Comm Intelligence', href: '/dashboard/communications/intelligence' },
          { id: 'outreach', label: 'AI Outreach', href: '/dashboard/communications/outreach' },
          { id: 'sequences', label: 'Automation Sequences', href: '/dashboard/campaigns/sequences' },
          { id: 'handoff-cockpit', label: 'Handoff Cockpit', href: '/dashboard/communications/handoffs' },
        ],
      },
      {
        id: 'financials',
        label: 'Financials',
        icon: 'DollarSign',
        children: [
          { id: 'brokerage-pl', label: 'Brokerage P&L', href: '/dashboard/financials/brokerage' },
          { id: 'revenue-pipeline', label: 'Revenue Pipeline', href: '/dashboard/financials/pipeline' },
          { id: 'team-financials', label: 'Team Financials', href: '/dashboard/financials/team' },
          { id: 'commissions', label: 'Commissions', href: '/dashboard/financials/commissions' },
          { id: 'expenses', label: 'Expenses', href: '/dashboard/financials/expenses' },
          { id: 'payouts', label: 'Agent Payouts', href: '/dashboard/financials/payouts' },
          { id: 'credit-pipeline', label: 'Credit Pipeline', href: '/credit-pipeline' },
        ],
      },
      { id: 'education', label: 'Education Library', href: '/dashboard/education', icon: 'GraduationCap' },
      { id: 'compliance', label: 'Compliance', href: '/dashboard/compliance', icon: 'Shield' },
      { id: 'vendors', label: 'Partner Portal', href: '/dashboard/vendors', icon: 'Users' },
      { id: 'system-intel', label: 'System Intelligence', href: '/dashboard/system', icon: 'Radar' },
      {
        id: 'sphere',
        label: 'Sphere of Influence',
        icon: 'Users',
        href: '/lifetime-customers',
        children: [
          { id: 'sphere-all', label: 'All Sphere Contacts', href: '/lifetime-customers' },
          { id: 'sphere-resonance', label: 'Resonance — Life Events', href: '/dashboard/sphere' },
          { id: 'sphere-wealth', label: 'Wealth Opportunities', href: '/dashboard/wealth' },
          { id: 'sphere-referrals', label: 'Referrals', href: '/referrals' },
          { id: 'sphere-reviews', label: 'Reviews & Reputation', href: '/lifetime-customers?tab=reviews' },
          { id: 'sphere-gifting', label: 'Gifting & Milestones', href: '/lifetime-customers?tab=gifting' },
          // Orphan-route sweep: the Gift Studio command center had no inbound nav link.
          { id: 'sphere-gift-studio', label: 'Gift Studio', href: '/dashboard/gifts' },
        ],
      },
      { id: 'leaderboard', label: 'Leaderboard', href: '/dashboard/motivation', icon: 'Award' },
      { id: 'workflows', label: 'Workflow Monitor', href: '/workflows', icon: 'Workflow' },
      { id: 'usage-metrics', label: 'Usage Metrics', href: '/dashboard/admin/usage', icon: 'Activity' },
      { id: 'assignment-rules', label: 'Assignment Rules', href: '/dashboard/admin/assignment-rules', icon: 'GitBranch' },
      { id: 'reports', label: 'Reports', href: '/dashboard/reports', icon: 'BarChart3' },
      { id: 'divider2', divider: true },
      {
        id: 'settings',
        label: 'Brokerage Settings',
        icon: 'Settings',
        children: [
          { id: 'general', label: 'General', href: '/dashboard/settings/general' },
          { id: 'branding', label: 'Branding', href: '/dashboard/settings/branding' },
          // Owner's ruling: "command strip is fine but you should still be able to find
          // it on navigation." The Prohibited Words panel shipped reachable only from the
          // settings command strip (settings-command-strip.tsx → /compliance/settings).
          // It is a SETTINGS surface, so it is filed with the other per-area settings
          // pages rather than under the Compliance dashboard entry above (which points at
          // the violations/monitoring surface, /dashboard/compliance — a different page).
          // The destination is /compliance/settings and NOT /dashboard/settings: that page
          // redirects any user_type outside broker/admin, and it is the whole-settings
          // Control Center, not a compliance surface. One destination, one entry — the
          // compliance_officer block's own Settings item already points here and is not
          // duplicated.
          { id: 'compliance-settings', label: 'Compliance & Prohibited Words', href: '/compliance/settings' },
          { id: 'team-mgmt', label: 'Team Management', href: '/dashboard/settings/teams' },
          // The brokerage-wide grain — the ONLY grain the platform lead rotation reads
          // (distribution-engine filters .is(agent_user_id,null).is(team_id,null)) — is
          // settable only by a brokerage admin, so this entry is the primary one.
          { id: 'territories', label: 'Territories', href: '/dashboard/settings/territories' },
          { id: 'integrations', label: 'Integrations', href: '/dashboard/settings/integrations' },
          { id: 'isa-calling', label: 'ISA Calling', href: '/dashboard/settings/isa-calling' },
          { id: 'widget-settings', label: 'Widget & AI Setup', href: '/dashboard/settings/widget' },
          { id: 'knowledge-base', label: 'Knowledge Base', href: '/dashboard/settings/knowledge-base' },
        ],
      },
    ],
    topNavItems: [
      { id: 'search', label: 'Search', icon: 'Search' },
      { id: 'alerts', label: 'Alerts', icon: 'AlertCircle', badgeKey: 'pending_approvals' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/brokerage', icon: 'LayoutGrid' },
      { id: 'team', label: 'Team', href: '/dashboard/team', icon: 'Users' },
      { id: 'analytics', label: 'Analytics', href: '/analytics', icon: 'BarChart3' },
      { id: 'financials', label: 'Financials', href: '/dashboard/financials/brokerage', icon: 'DollarSign' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'briefing', label: 'AI Briefing', href: '/dashboard/briefing' },
      { id: 'deal-health', label: 'Deal Health Dashboard', href: '/dashboard/brokerage/deal-health' },
      { id: 'team-heatmap', label: 'Team Heatmap', href: '/dashboard/team-heatmap' },
      { id: 'ai-quality', label: 'AI Quality', href: '/dashboard/ai-quality' },
      { id: 'compliance', label: 'Compliance Dashboard', href: '/dashboard/compliance' },
      { id: 'marketing', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
    ],
  },

  isa: {
    sidebarItems: [
      { id: 'dashboard', label: 'AI-ISA Console', href: '/dashboard/isa', icon: 'LayoutGrid' },
      { id: 'calling', label: 'Calling Queue', href: '/dashboard/isa/calling', icon: 'Phone', badgeKey: 'isa_queue_count' },
      // ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY — the '/leads'
      // entry was removed from the ISA block; the ISA works its own console.
      { id: 'outreach', label: 'AI Outreach', href: '/dashboard/communications/outreach', icon: 'Send' },
      { id: 'sequences', label: 'Automation Sequences', href: '/dashboard/campaigns/sequences', icon: 'Repeat' },
      { id: 'campaigns', label: 'Campaigns', href: '/dashboard/isa/campaigns', icon: 'Megaphone' },
      { id: 'scripts', label: 'Scripts', href: '/dashboard/isa/scripts', icon: 'FileText' },
      { id: 'analytics', label: 'My Stats', href: '/dashboard/isa/analytics', icon: 'BarChart3' },
      { id: 'isa-settings', label: 'ISA Settings', href: '/dashboard/ai-isa/settings', icon: 'Settings' },
      { id: 'intelligence', label: 'Comm Intelligence', href: '/dashboard/communications/intelligence', icon: 'Brain' },
      // Notification-rail parity: every tenant user type gets the /notifications home.
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'divider1', divider: true },
      {
        id: 'video-tools',
        label: 'Video Tools',
        icon: 'Video',
        children: [
          { id: 'create-video', label: 'Create Video', href: '/dashboard/videos/create' },
          { id: 'twin-studio', label: 'Twin Studio', href: '/dashboard/settings/twin-studio' },
          { id: 'my-videos', label: 'My Videos', href: '/dashboard/videos/library' },
        ],
      },
      { id: 'settings', label: 'Settings', href: '/dashboard/settings/general', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'calling', label: 'Calling', href: '/dashboard/isa/calling', icon: 'Phone' },
      // LEADS = BROKERAGE + PLATFORM ONLY — '/leads' removed (see sidebar note).
      { id: 'outreach', label: 'Outreach', href: '/dashboard/communications/outreach', icon: 'Send' },
      { id: 'analytics', label: 'Stats', href: '/dashboard/isa/analytics', icon: 'BarChart3' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'dial-number', label: 'Open Calling Queue', href: '/dashboard/isa/calling' },
      { id: 'outreach', label: 'AI Outreach Center', href: '/dashboard/communications/outreach' },
      { id: 'new-campaign', label: 'ISA Campaigns', href: '/dashboard/isa/campaigns' },
      { id: 'voice-isa', label: 'Voice ISA Dashboard', href: '/dashboard/voice/isa' },
    ],
  },

  admin: {
    sidebarItems: [
      { id: 'briefing', label: 'AI Briefing', href: '/dashboard/briefing', icon: 'Sparkles' },
      { id: 'dashboard', label: 'Admin Dashboard', href: '/dashboard/admin', icon: 'LayoutGrid' },
      { id: 'leads', label: 'Lead Intelligence', href: '/leads', icon: 'Brain' },
      { id: 'portal-clients', label: 'Portal Clients', href: '/crm/portal-clients', icon: 'DoorOpen' },
      { id: 'onboarding', label: 'Agent Onboarding', href: '/dashboard/admin/onboarding', icon: 'UserPlus' },
      // Orphan-route sweep: the agent roster's ONLY link lived in RootRoleShortcuts,
      // a component that was never rendered — so the page was already unreachable
      // and the dead file was merely hiding it from the orphan-route guard. The
      // per-agent detail route IS linked (revenue-protection-rollup-widget), so
      // the index was the one surface with no way in.
      { id: 'agent-roster', label: 'Agent Roster', href: '/dashboard/admin/agents', icon: 'Users' },
      // Orphan-route sweep: onboarding-step editor was unreachable from any nav.
      { id: 'onboarding-steps', label: 'Onboarding Steps', href: '/dashboard/admin/onboarding-steps', icon: 'ListChecks' },
      { id: 'education', label: 'Education Content', href: '/dashboard/admin/education', icon: 'GraduationCap' },
      // Orphan-route sweep (lane G): the multi-channel learning-module AUTHOR
      // (listLearningModulesForBrokerageAction) and its AI-draft APPROVAL queue
      // (listPendingApprovalModulesAction) were both built, both admin-gated and
      // both unreachable from any nav. Filed beside Education Content — the same
      // subject, one seat.
      { id: 'learning-modules', label: 'Learning Modules', href: '/dashboard/admin/learning-modules', icon: 'BookOpen' },
      { id: 'learning-module-approvals', label: 'Learning Module Approvals', href: '/dashboard/admin/learning-modules/approvals', icon: 'CheckSquare' },
      { id: 'brokerage-fees', label: 'Brokerage Fees', href: '/dashboard/admin/fees', icon: 'DollarSign' },
      { id: 'phone-settings', label: 'Phone & ISA Voice', href: '/dashboard/admin/phone-settings', icon: 'Phone' },
      { id: 'ai-call-setup', label: 'AI Call Handling', href: '/dashboard/onboarding/ai-call-setup', icon: 'PhoneCall' },
      { id: 'assignment-rules', label: 'Assignment Rules', href: '/dashboard/admin/assignment-rules', icon: 'GitBranch' },
      { id: 'forms', label: 'Forms Manager', href: '/dashboard/admin/forms', icon: 'FileText' },
      { id: 'knowledge', label: 'Knowledge Base', href: '/dashboard/settings/knowledge-base', icon: 'BookOpen' },
      { id: 'lead-lineage', label: 'Lead Lineage', href: '/dashboard/admin/lead-lineage', icon: 'GitBranch' },
      { id: 'locations', label: 'Office Locations', href: '/dashboard/admin/locations', icon: 'Building2' },
      { id: 'manager-trust', label: 'Manager Trust', href: '/dashboard/admin/manager-trust', icon: 'ShieldCheck' },
      { id: 'support-tickets', label: 'Support Tickets', href: '/dashboard/admin/support-tickets', icon: 'LifeBuoy' },
      { id: 'approvals', label: 'Approvals', href: '/approvals', icon: 'CheckSquare', badgeKey: 'pending_approvals' },
      // Tenant-parity: the Command Center had no nav entry for any role (see broker block).
      { id: 'command-center', label: 'AI Command Center', href: '/dashboard/admin/command-center', icon: 'Bot' },
      { id: 'voice-command', label: 'Voice Assistant', href: '/dashboard/voice', icon: 'Mic' },
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'divider1', divider: true },
      {
        id: 'intelligence',
        label: 'Intelligence Suite',
        icon: 'Brain',
        children: [
          { id: 'intelligence-center', label: 'Intelligence Center', href: '/dashboard/brokerage/intelligence' },
          // Orphan-route sweep: the monthly intelligence report page (principal-gated) had no nav entry.
          { id: 'intelligence-report', label: 'Monthly Intelligence Report', href: '/dashboard/intelligence-report' },
          { id: 'deal-health', label: 'Deal Health', href: '/dashboard/brokerage/deal-health' },
          { id: 'team-heatmap', label: 'Team Heatmap', href: '/dashboard/team-heatmap' },
          { id: 'patterns', label: 'Behavioral Patterns', href: '/dashboard/patterns' },
          { id: 'stale', label: 'Stale Queue', href: '/dashboard/stale' },
          { id: 'ai-quality', label: 'AI Quality', href: '/dashboard/ai-quality' },
          // Orphan-route sweep: the FINRA-2026 manager eval harness UI was unreachable from any nav.
          { id: 'compliance-eval', label: 'Compliance Eval', href: '/dashboard/admin/compliance-eval' },
          { id: 'coordination', label: 'AI Coordination', href: '/dashboard/coordination' },
          { id: 'comm-intel', label: 'Comm Intelligence', href: '/dashboard/communications/intelligence' },
          { id: 'farm-intel', label: 'Farm Intelligence', href: '/dashboard/admin/farm-intelligence' },
          { id: 'provider-intel', label: 'Provider Intelligence', href: '/dashboard/admin/provider-intelligence' },
        ],
      },
      {
        // Built admin surfaces that were unreachable from any nav (UI-wiring audit) — now discoverable.
        id: 'ops-insights',
        label: 'Brokerage Ops & Insights',
        icon: 'Gauge',
        children: [
          { id: 'brokerage-pnl', label: 'Brokerage P&L', href: '/dashboard/financials/brokerage', icon: 'TrendingUp' },
          { id: 'agent-scorecard', label: 'Agent Scorecard', href: '/dashboard/admin/agent-scorecard', icon: 'Award' },
          { id: 'transaction-propensity', label: 'Transaction Propensity', href: '/dashboard/admin/transaction-propensity', icon: 'Target' },
          { id: 'strategy-insights', label: 'Strategy Insights', href: '/dashboard/admin/strategy-insights', icon: 'Lightbulb' },
          { id: 'direct-mail-performance', label: 'Direct Mail Performance', href: '/dashboard/admin/direct-mail-performance', icon: 'Mail' },
          // Lead Intake, Scrape Diagnostics, Cron Health are PLATFORM-only (the
          // scraping/cron machinery is platform-owned infrastructure, not a
          // tenant concern) — they live in the superadmin tree, not here.
          { id: 'ai-identity', label: 'AI Identity', href: '/dashboard/admin/ai-identity', icon: 'Bot' },
          { id: 'ai-disclosures', label: 'AI Disclosures', href: '/dashboard/admin/compliance/ai-disclosures', icon: 'FileCheck' },
          // Orphan-route sweep: vendor approval queue was unreachable from any nav.
          { id: 'vendor-approvals', label: 'Vendor Approvals', href: '/dashboard/admin/vendor-approvals', icon: 'ShieldCheck' },
        ],
      },
      {
        // Tenant-parity: the admin persona is the OWNER seat for solo and brokerage
        // tenants, yet had zero advertising nav — every marketing page exists and every
        // tier's flag grants access, they were simply unreachable from this sidebar.
        id: 'content',
        label: 'Marketing & Content',
        icon: 'Palette',
        children: [
          { id: 'marketing-studio', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
          { id: 'content-os', label: 'Content OS', href: '/dashboard/content' },
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
          { id: 'newsletter-templates', label: 'Newsletter Templates', href: '/newsletters' },
          // Nav-parity: the QR manager was agent-only. Same page, scoped by the
          // caller's role — the admin seat sees the whole brokerage's codes.
          { id: 'qr-codes', label: 'QR Codes', href: '/dashboard/agent/qr-codes' },
          { id: 'lead-magnets', label: 'Lead Magnets', href: '/dashboard/marketing/lead-magnets' },
          { id: 'blog', label: 'Blog Posts', href: '/dashboard/marketing/studio?tab=blog' },
          { id: 'podcast', label: 'Podcast Studio', href: '/dashboard/marketing/podcast' },
          { id: 'seo', label: 'SEO / GEO', href: '/dashboard/marketing/seo' },
          { id: 'video-pages', label: 'Video Pages', href: '/dashboard/marketing/video-pages' },
          // ── Orphan-route sweep (lane G) ────────────────────────────────────
          // Four BUILT admin marketing surfaces with no nav entry anywhere. Each
          // page gates on `isAdminOrBroker` (or getAgentContext) and each has a
          // live server action behind it, so this is a wire, not a new feature:
          //   · content-studio        → loadContentStudio + ApproveReelButton
          //   · marketing-approvals   → listPendingMarketingAssetsAction
          //   · marketing-agent-actions → getPendingMarketingActions
          //   · content-intel         → listContentSources (brokerage-scoped)
          // Filed under Marketing & Content because all four are the APPROVAL /
          // SOURCE half of the studio above them; the two CAMPAIGN surfaces went
          // to the Campaigns group instead.
          { id: 'content-studio', label: 'Content Studio', href: '/dashboard/admin/content-studio' },
          { id: 'marketing-approvals', label: 'Asset Approvals', href: '/dashboard/admin/marketing-approvals' },
          { id: 'marketing-agent-actions', label: 'Marketing Agent Actions', href: '/dashboard/admin/marketing-agent-actions' },
          { id: 'content-intel', label: 'Content Intelligence', href: '/dashboard/marketing/content-intel' },
        ],
      },
      {
        id: 'campaigns',
        label: 'Campaigns',
        icon: 'Megaphone',
        children: [
          { id: 'sequences', label: 'Automation Sequences', href: '/dashboard/campaigns/sequences' },
          { id: 'workflow-reports', label: 'Workflow Reports', href: '/dashboard/campaigns/workflow-reports' },
          { id: 'ads', label: 'Ad Campaigns', href: '/dashboard/campaigns/ads' },
          { id: 'direct-mail', label: 'Direct Mail', href: '/dashboard/campaigns/mail' },
          { id: 'repurpose', label: 'Repurpose Content', href: '/dashboard/campaigns/repurpose' },
          { id: 'competitive', label: 'Competitive Intel', href: '/dashboard/campaigns/competitive' },
          { id: 'roi', label: 'Campaign ROI', href: '/dashboard/campaigns/roi' },
          // Orphan-route sweep (lane G): the campaign AUTHORING page
          // (listMarketingCampaignsAction) and the cross-channel APPROVAL feed
          // (loadCampaignCenter) were both unreachable from any nav.
          { id: 'marketing-campaigns', label: 'Marketing Campaigns', href: '/dashboard/admin/marketing-campaigns' },
          { id: 'campaign-center', label: 'Campaign Command Center', href: '/dashboard/admin/campaign-center' },
        ],
      },
      { id: 'analytics', label: 'Analytics', href: '/analytics', icon: 'BarChart3' },
      { id: 'reports', label: 'Reports', href: '/dashboard/reports', icon: 'FileText' },
      { id: 'team-financials', label: 'Team Financials', href: '/dashboard/financials/team', icon: 'DollarSign' },
      { id: 'compliance', label: 'Compliance', href: '/dashboard/compliance', icon: 'Shield' },
      { id: 'education', label: 'Education Library', href: '/dashboard/education', icon: 'GraduationCap' },
      { id: 'brand-compliance', label: 'Brand & Compliance', href: '/dashboard/admin/brand', icon: 'Shield' },
      // Markets are part of the BRAND: a brokerage's target markets decide where
      // the platform-owned scrapers hunt leads FOR that brand — so the tenant's
      // market/territory setup lives here, beside Brand, not in the platform ops group.
      { id: 'brand-markets', label: 'Markets', href: '/dashboard/admin/markets', icon: 'Map' },
      { id: 'tcpa-compliance', label: 'TCPA Compliance', href: '/dashboard/admin/compliance/tcpa', icon: 'Shield' },
      // Orphan-route sweep (lane G): the DSAR queue — the surface a brokerage
      // works its statutory data-subject requests on (listDSARQueueAction, with
      // per-row accept/fulfil/deny verbs and an OVERDUE badge) — had no nav entry
      // at all, which for a privacy obligation with a legal clock on it is the
      // worst place for a page to be invisible. Filed with the compliance items.
      { id: 'privacy-requests', label: 'Privacy Requests (DSAR)', href: '/dashboard/admin/privacy/requests', icon: 'ShieldCheck' },
      // Owner's ruling: "command strip is fine but you should still be able to find it on
      // navigation." Same entry as the broker's (see the Brokerage Settings group there);
      // this sidebar has no settings group — its settings-shaped pages sit at the top
      // level beside the compliance items (cf. 'required-documents' below) — so it is
      // filed with the other compliance entries. Destination /compliance/settings, the one
      // surface every role that may write a phrase can reach.
      { id: 'compliance-settings', label: 'Compliance & Prohibited Words', href: '/compliance/settings', icon: 'ShieldAlert' },
      // Orphan-route sweep: per-state required-document settings were unreachable from any nav.
      { id: 'required-documents', label: 'Required Documents', href: '/dashboard/settings/required-documents', icon: 'FileCheck' },
      // Feature Governance is PLATFORM-owned (enrollment flags aren't tenant-editable) —
      // it lives in the superadmin tree, not the brokerage admin's sidebar. (2026-07 walkthrough)
      { id: 'workflows', label: 'Workflow Monitor', href: '/workflows', icon: 'Workflow' },
      { id: 'video-analytics', label: 'Video Analytics', href: '/dashboard/videos/analytics', icon: 'Video' },
      // Orphan-route sweep (lane G): the brokerage's video TEMPLATE library
      // (getVideoTemplates, admin/broker-gated) sat beside Video Analytics in the
      // tree and beside nothing in the nav.
      { id: 'video-templates', label: 'Video Templates', href: '/dashboard/videos/templates', icon: 'Video' },
      { id: 'sla-monitor', label: 'SLA Monitor', href: '/dashboard/admin/sla-monitor', icon: 'Clock' },
      { id: 'visitor-tracking', label: 'Visitor Tracking', href: '/dashboard/admin/visitor-tracking', icon: 'Eye' },
      { id: 'divider2', divider: true },
      // Tenant-parity fix: Billing pointed at the platform-gated superadmin console
      // ("Forbidden" for every tenant principal). The tenant billing home is /dashboard/admin/billing.
      { id: 'billing', label: 'Billing', href: '/dashboard/admin/billing', icon: 'CreditCard' },
      { id: 'usage-metrics', label: 'Usage Metrics', href: '/dashboard/admin/usage', icon: 'Activity' },
      { id: 'system-intel', label: 'System Intelligence', href: '/dashboard/system', icon: 'Radar' },
      // Tenant-parity fix: System Health + Audit Trail pointed at platform-gated superadmin
      // consoles (dead "Forbidden" links for tenant admins). System Intelligence
      // (/dashboard/system, admin/broker-gated) already covers system health above;
      // the tenant audit surface is /compliance/audits.
      { id: 'logs', label: 'Audit Trail', href: '/compliance/audits', icon: 'Eye' },
      { id: 'ai-audit', label: 'AI Audit', href: '/dashboard/admin/ai-audit', icon: 'Sparkles' },
      { id: 'error-handler', label: 'Error Handler', href: '/dashboard/admin/error-handler', icon: 'AlertTriangle' },
      // "What's New & Status" is a PLATFORM release/status surface — held out of the tenant
      // admin nav until the OS launches; it lives in the superadmin tree. (2026-07 walkthrough)
      { id: 'settings', label: 'Settings', href: '/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'AlertTriangle', badgeKey: 'pending_approvals' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/admin', icon: 'LayoutGrid' },
      { id: 'onboarding', label: 'Onboarding', href: '/dashboard/admin/onboarding', icon: 'UserPlus' },
      { id: 'system', label: 'System', href: '/dashboard/system', icon: 'Activity' },
      { id: 'settings', label: 'Settings', href: '/settings', icon: 'Settings' },
    ],
    commandPaletteItems: [
      { id: 'briefing', label: 'AI Briefing', href: '/dashboard/briefing' },
      { id: 'view-logs', label: 'View Audit Trail', href: '/compliance/audits' },
      { id: 'system-status', label: 'System Health', href: '/dashboard/system' },
      { id: 'deal-health', label: 'Deal Health', href: '/dashboard/brokerage/deal-health' },
      { id: 'ai-quality', label: 'AI Quality', href: '/dashboard/ai-quality' },
      { id: 'workflows', label: 'Workflow Monitor', href: '/workflows' },
      { id: 'onboarding', label: 'Agent Onboarding', href: '/dashboard/admin/onboarding' },
    ],
  },

  vendor: {
    sidebarItems: [
      { id: 'dashboard', label: 'Dashboard', href: '/vendor/dashboard', icon: 'LayoutGrid' },
      { id: 'jobs', label: 'Jobs', href: '/vendor/jobs', icon: 'Briefcase', badgeKey: 'vendor_pending_jobs' },
      { id: 'portfolio', label: 'Portfolio', href: '/vendor/portfolio', icon: 'Image' },
      { id: 'earnings', label: 'Earnings', href: '/vendor/earnings', icon: 'DollarSign' },
      { id: 'documents', label: 'Documents', href: '/vendor/documents', icon: 'FolderOpen' },
      // Round 35 missed-loop sweep: vendor invoicing (round 34) was reachable only
      // from a dashboard link — first-class nav entry for the money surface.
      { id: 'invoices', label: 'Invoices', href: '/vendor/invoices', icon: 'Receipt' },
      // Orphan-route sweep: the vendor connection center was unreachable from any nav.
      { id: 'connections', label: 'Connections', href: '/vendor/connections', icon: 'Plug' },
      // DIRECTION CORRECTED (m497). This comment used to read "the vendor's OWN plan catalogue
      // (vendor_plans) — what brokerages subscribe to", which had the money running backwards.
      // A vendor package is a BROKERAGE charging a VENDOR for marketplace access and placement:
      // money flows VENDOR → BROKERAGE. So this page is the PAYER's read-only view of the
      // packages a brokerage offers and what this vendor is enrolled in — the catalogue is
      // authored on the brokerage side (/dashboard/vendors). Still distinct from /vendor/billing,
      // which is the platform tier the vendor pays US; the difference between the two is the
      // PAYEE, not the direction. Label says Packages so the surface does not re-teach the
      // inverted model. See lib/vendors/vendor-money-directions.ts.
      { id: 'plans', label: 'Packages', href: '/vendor/plans', icon: 'Layers' },
      // Notification-rail parity: every tenant user type gets the /notifications home.
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'settings', label: 'Settings', href: '/vendor/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'jobs', label: 'Jobs', href: '/vendor/jobs', icon: 'Briefcase' },
      { id: 'earnings', label: 'Earnings', href: '/vendor/earnings', icon: 'DollarSign' },
      { id: 'portfolio', label: 'Portfolio', href: '/vendor/portfolio', icon: 'Image' },
      { id: 'profile', label: 'Profile', href: '/vendor/settings', icon: 'User' },
    ],
    commandPaletteItems: [
      { id: 'accept-job', label: 'Accept Job', href: '/vendor/jobs' },
      { id: 'upload-photos', label: 'Upload Photos', href: '/vendor/portfolio/upload' },
    ],
  },

  contact: {
    // Contact users should be redirected to /portal/[contactId] - these are fallback links
    sidebarItems: [
      { id: 'overview', label: 'Overview', href: '/portal', icon: 'Home' },
      { id: 'transaction', label: 'My Transaction', href: '/portal', icon: 'FileText' },
      { id: 'documents', label: 'Documents', href: '/portal', icon: 'Folder' },
      { id: 'messages', label: 'Messages', href: '/portal', icon: 'Mail' },
    ],
    topNavItems: [
      { id: 'notifications', label: 'Notifications', icon: 'Bell' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'overview', label: 'Overview', href: '/portal', icon: 'Home' },
      { id: 'transaction', label: 'Transaction', href: '/portal', icon: 'FileText' },
      { id: 'documents', label: 'Documents', href: '/portal', icon: 'Folder' },
      { id: 'messages', label: 'Messages', href: '/portal', icon: 'Mail' },
    ],
    commandPaletteItems: [
      { id: 'contact-agent', label: 'Contact Agent', href: '/portal' },
      { id: 'view-docs', label: 'View Documents', href: '/portal' },
    ],
  },

  compliance_officer: {
    sidebarItems: [
      { id: 'dashboard', label: 'Compliance Command', href: '/dashboard/compliance', icon: 'LayoutGrid' },
      { id: 'violations', label: 'Violations', href: '/compliance/violations', icon: 'AlertTriangle', badgeKey: 'compliance_violations' },
      { id: 'audits', label: 'Audit Logs', href: '/compliance/audits', icon: 'Eye' },
      { id: 'policies', label: 'Policies', href: '/compliance/policies', icon: 'FileText' },
      { id: 'reports', label: 'Reports', href: '/compliance/reports', icon: 'BarChart3' },
      { id: 'compliance-queue', label: 'Compliance Queue', href: '/dashboard/compliance/queue', icon: 'ListChecks' },
      { id: 'comm-intel', label: 'Comm Intelligence', href: '/dashboard/communications/intelligence', icon: 'Brain' },
      { id: 'approvals', label: 'Approvals Queue', href: '/approvals', icon: 'CheckSquare' },
      { id: 'ai-quality', label: 'AI Quality', href: '/dashboard/ai-quality', icon: 'Sparkles' },
      // Tenant-parity fix: "Platform Audit Trail" pointed at the superadmin-gated console —
      // a dead "Forbidden" link for tenant compliance officers. AI Audit is their tenant-scoped
      // audit surface (page allows compliance_officer); /compliance/audits covers the rest above.
      { id: 'ai-audit', label: 'AI Audit', href: '/dashboard/admin/ai-audit', icon: 'Database' },
      // OWNER RULING: "compliance officer needs to see transactions and marketing…
      // the compliance manager is the one that deals with marketing." Both were
      // missing entirely — the officer could audit a deal's paperwork without ever
      // being able to open the deal, and Review Queue, which IS their approval
      // surface for brand and fair-housing review, was unreachable.
      ...TRANSACTION_ITEMS,
      MARKETING_GROUP,
      // Notification-rail parity: every tenant user type gets the /notifications home.
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'settings', label: 'Settings', href: '/compliance/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'AlertTriangle', badgeKey: 'compliance_violations' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/compliance', icon: 'LayoutGrid' },
      { id: 'violations', label: 'Violations', href: '/compliance/violations', icon: 'AlertTriangle' },
      { id: 'audits', label: 'Audits', href: '/compliance/audits', icon: 'Eye' },
      { id: 'reports', label: 'Reports', href: '/compliance/reports', icon: 'BarChart3' },
      { id: 'more', label: 'More', href: '/dashboard/compliance', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'flag-violation', label: 'Flag Violation', href: '/compliance/violations/new' },
      { id: 'generate-report', label: 'Generate Report', href: '/compliance/reports/new' },
      { id: 'comm-intel', label: 'Comm Intelligence', href: '/dashboard/communications/intelligence' },
    ],
  },

  tc: {
    sidebarItems: [
      { id: 'dashboard', label: 'Coordinator Command', href: '/dashboard/coordinator', icon: 'LayoutGrid' },
      { id: 'deals', label: 'Active Deals', href: '/transaction/deals', icon: 'Handshake', badgeKey: 'active_deals' },
      { id: 'checklists', label: 'Checklists', href: '/transaction/checklists', icon: 'CheckSquare' },
      { id: 'documents', label: 'Documents', href: '/transaction/documents', icon: 'Folder' },
      { id: 'vendors', label: 'Vendor Coordination', href: '/transaction/vendors', icon: 'Users' },
      // OWNER RULING: "a tc needs to see compliance and marketing". Neither was
      // reachable. A coordinator whose whole job is clearing what blocks a file
      // could not see the compliance queue that holds the blocks, and could not
      // see the listing marketing they are coordinating.
      // Narrower than the officer's own compliance sidebar on purpose — see
      // COMPLIANCE_ITEMS_FOR_COORDINATION.
      ...COMPLIANCE_ITEMS_FOR_COORDINATION,
      MARKETING_GROUP,
      // Notification-rail parity: every tenant user type gets the /notifications home.
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'settings', label: 'Settings', href: '/transaction/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/coordinator', icon: 'LayoutGrid' },
      { id: 'deals', label: 'Deals', href: '/transaction/deals', icon: 'Handshake' },
      { id: 'checklists', label: 'Checklists', href: '/transaction/checklists', icon: 'CheckSquare' },
      { id: 'vendors', label: 'Vendors', href: '/transaction/vendors', icon: 'Users' },
      { id: 'more', label: 'More', href: '/dashboard/coordinator', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'new-deal', label: 'New Deal', href: '/transaction/deals/new' },
      { id: 'contact-vendor', label: 'Contact Vendor', href: '/transaction/vendors/contact' },
    ],
  },

  lender: {
    sidebarItems: [
      { id: 'dashboard', label: 'Lender Dashboard', href: '/lender/dashboard', icon: 'LayoutGrid' },
      { id: 'pipeline', label: 'Loan Pipeline', href: '/lender/pipeline', icon: 'TrendingUp', badgeKey: 'lender_pipeline_count' },
      // Orphan-route sweep: the assigned-transaction milestone board was unreachable from any nav.
      { id: 'transactions', label: 'Assigned Transactions', href: '/lender/transactions', icon: 'Handshake' },
      { id: 'approvals', label: 'Approvals', href: '/lender/approvals', icon: 'CheckCircle' },
      { id: 'underwriting', label: 'Underwriting', href: '/lender/underwriting', icon: 'FileCheck' },
      { id: 'documents', label: 'Documents', href: '/lender/documents', icon: 'Folder' },
      // Notification-rail parity: every tenant user type gets the /notifications home.
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'settings', label: 'Settings', href: '/lender/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/lender/dashboard', icon: 'LayoutGrid' },
      { id: 'pipeline', label: 'Pipeline', href: '/lender/pipeline', icon: 'TrendingUp' },
      { id: 'approvals', label: 'Approvals', href: '/lender/approvals', icon: 'CheckCircle' },
      { id: 'underwriting', label: 'UW', href: '/lender/underwriting', icon: 'FileCheck' },
      { id: 'more', label: 'More', href: '/lender/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'approve-loan', label: 'Approve Loan', href: '/lender/approvals' },
      { id: 'send-to-uw', label: 'Send to UW', href: '/lender/underwriting' },
    ],
  },

  title_agent: {
    sidebarItems: [
      { id: 'dashboard', label: 'Title Dashboard', href: '/title/dashboard', icon: 'LayoutGrid' },
      { id: 'orders', label: 'Title Orders', href: '/title/orders', icon: 'Package', badgeKey: 'title_open_orders' },
      { id: 'status', label: 'Order Status', href: '/title/status', icon: 'Clock' },
      { id: 'documents', label: 'Title Documents', href: '/title/documents', icon: 'FileText' },
      { id: 'closing', label: 'Closing Schedule', href: '/title/closing', icon: 'Calendar' },
      // Notification-rail parity: every tenant user type gets the /notifications home.
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'settings', label: 'Settings', href: '/title/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/title/dashboard', icon: 'LayoutGrid' },
      { id: 'orders', label: 'Orders', href: '/title/orders', icon: 'Package' },
      { id: 'status', label: 'Status', href: '/title/status', icon: 'Clock' },
      { id: 'closing', label: 'Closing', href: '/title/closing', icon: 'Calendar' },
      { id: 'more', label: 'More', href: '/title/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'new-order', label: 'New Title Order', href: '/title/orders/new' },
      { id: 'schedule-closing', label: 'Schedule Closing', href: '/title/closing/new' },
    ],
  },

  // superadmin — same full access as admin + platform management
  superadmin: {
    sidebarItems: [
      { id: 'platform', label: 'Platform Admin', href: '/dashboard/superadmin/platform', icon: 'ShieldAlert' },
      { id: 'platform-overview', label: 'Platform Overview', href: '/dashboard/superadmin/platform', icon: 'TrendingUp' },
      { id: 'brokerages', label: 'Brokerages', href: '/dashboard/superadmin/brokerages', icon: 'Building2' },
      // Cross-tenant user management lives in the god console's per-brokerage panels.
      { id: 'users', label: 'Users by Brokerage', href: '/dashboard/superadmin/brokerages', icon: 'Users' },
      { id: 'divider1', divider: true },
      { id: 'observability', label: 'Observability', href: '/dashboard/superadmin/observability', icon: 'Radar' },
      { id: 'ai-quality', label: 'AI Quality', href: '/dashboard/ai-quality', icon: 'Sparkles' },
      { id: 'patterns', label: 'Behavioral Patterns', href: '/dashboard/patterns', icon: 'Activity' },
      { id: 'stale', label: 'Stale Queue', href: '/dashboard/stale', icon: 'AlertCircle' },
      { id: 'coordination', label: 'AI Coordination', href: '/dashboard/coordination', icon: 'Network' },
      { id: 'divider2', divider: true },
      { id: 'billing', label: 'Billing Administration', href: '/dashboard/superadmin/subscriptions', icon: 'CreditCard' },
      // Orphan-route sweep (lane G): the subscription-CONTRACT console — where
      // platform staff author the agreement a tenant signs to activate their
      // subscription (m481; listSubscriptionContractTemplatesAction +
      // listTenantContractSignaturesAction, read-gated on the 'billing'
      // capability) — had no nav entry. It belongs beside Billing Administration:
      // same capability, and a tenant cannot activate until it is used.
      { id: 'subscription-contracts', label: 'Subscription Contracts', href: '/dashboard/superadmin/contracts', icon: 'FileSignature' },
      // Orphan-route sweep (lane G): the Deal Room — the presenter's runbook for
      // the flagship sales demo on the sanctioned demo tenant, gated by the
      // superadmin layout plus the 'tenants' capability on both its mutations.
      { id: 'demo-room', label: 'Demo Deal Room', href: '/dashboard/superadmin/demo-room', icon: 'Presentation' },
      { id: 'usage-metrics', label: 'Usage Metrics', href: '/dashboard/admin/usage', icon: 'Activity' },
      { id: 'assignment-rules', label: 'Assignment Rules', href: '/dashboard/admin/assignment-rules', icon: 'GitBranch' },
      { id: 'feature-governance', label: 'Feature Governance', href: '/dashboard/admin/feature-governance', icon: 'Shield' },
      { id: 'workflows', label: 'Workflow Monitor', href: '/workflows', icon: 'Workflow' },
      { id: 'divider3', divider: true },
      // Platform-owned scraping/cron infrastructure — moved off the tenant admin
      // tree; these are the platform's machinery, not a brokerage's concern.
      { id: 'lead-intake', label: 'Lead Intake', href: '/dashboard/admin/lead-intake', icon: 'Inbox' },
      { id: 'scrape-diagnostics', label: 'Scrape Diagnostics', href: '/dashboard/admin/scrape-diagnostics', icon: 'Radar' },
      { id: 'cron-health', label: 'Cron Health', href: '/dashboard/admin/cron-health', icon: 'HeartPulse' },
      { id: 'system-health', label: 'System Health', href: '/dashboard/superadmin/observability', icon: 'Activity' },
      { id: 'ai-audit', label: 'AI Audit', href: '/dashboard/admin/ai-audit', icon: 'Eye' },
      // Platform release/status surface — relocated out of the tenant admin nav (kept reachable here).
      { id: 'whats-new', label: "What's New & Status", href: '/dashboard/whats-new', icon: 'Megaphone' },
      { id: 'system-providers', label: 'API Providers', href: '/dashboard/admin/system/providers', icon: 'Server' },
      { id: 'integrations', label: 'Integrations', href: '/dashboard/superadmin/connectors', icon: 'Plug' },
      { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'platform', label: 'Platform', href: '/dashboard/superadmin/platform', icon: 'ShieldAlert' },
      { id: 'brokerages', label: 'Brokerages', href: '/dashboard/superadmin/brokerages', icon: 'Building2' },
      { id: 'system-health', label: 'System', href: '/dashboard/superadmin/observability', icon: 'Activity' },
      { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'Settings' },
      { id: 'more', label: 'More', href: '/dashboard/admin', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'observability', label: 'Observability Dashboard', href: '/dashboard/superadmin/observability' },
      { id: 'manage-brokerages', label: 'Manage Brokerages', href: '/dashboard/superadmin/brokerages' },
      { id: 'system-health', label: 'View System Health', href: '/dashboard/superadmin/observability' },
      { id: 'ai-quality', label: 'AI Quality', href: '/dashboard/ai-quality' },
      { id: 'patterns', label: 'Behavioral Patterns', href: '/dashboard/patterns' },
    ],
  },

  // team_lead — agent capabilities + team management overlay
  team_lead: {
    sidebarItems: [
      { id: 'briefing', label: 'AI Briefing', href: '/dashboard/briefing', icon: 'Sparkles' },
      { id: 'dashboard', label: 'Team Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'crm', label: 'CRM', href: '/crm', icon: 'Users' },
      { id: 'portal-clients', label: 'Portal Clients', href: '/crm/portal-clients', icon: 'DoorOpen' },
      // ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY — the '/leads'
      // entry was removed from the team_lead block; team leads oversee their
      // team's CONTACTS, the lead desk is broker/admin + platform staff only.
      { id: 'transactions', label: 'Transactions', href: '/dashboard/transactions', icon: 'FileText' },
      { id: 'agent-roster', label: 'My Team', href: '/dashboard/team', icon: 'UserCheck' },
      // Orphan-route sweep (lane G): the TEAM-scope AI Identity Studio was
      // reachable from nothing. It is not a duplicate of the admin block's
      // 'ai-identity' (/dashboard/admin/ai-identity): that one edits the
      // BROKERAGE profile, this one edits the team's override of it (scope="team",
      // scopeId=teams.team_id, with the brokerage profile shown as the parent).
      // Its gate demands a team_id, so this sidebar is the only one it belongs in.
      { id: 'team-ai-identity', label: 'Team AI Identity', href: '/dashboard/team/ai-identity', icon: 'Bot' },
      { id: 'team-heatmap', label: 'Team Heatmap', href: '/dashboard/team-heatmap', icon: 'Map' },
      { id: 'leaderboard', label: 'Leaderboard', href: '/dashboard/motivation', icon: 'Award' },
      { id: 'approvals', label: 'Approvals', href: '/approvals', icon: 'CheckSquare' },
      // Tenant-parity: a team-tier principal (team lead) owns the subscription's
      // operations — Command Center + Monthly Intelligence Report are their surfaces
      // too (both pages already admit team leads via isTenancyPrincipal).
      { id: 'command-center', label: 'AI Command Center', href: '/dashboard/admin/command-center', icon: 'Bot' },
      { id: 'intelligence-report', label: 'Monthly Intelligence Report', href: '/dashboard/intelligence-report', icon: 'Sparkles' },
      { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'market-insights', label: 'Market Insights', href: '/dashboard/market-insights', icon: 'TrendingUp' },
      { id: 'divider1', divider: true },
      {
        id: 'video-tools',
        label: 'Video Tools',
        icon: 'Video',
        children: [
          { id: 'create-video', label: 'Create Video', href: '/dashboard/videos/create' },
          { id: 'twin-studio', label: 'Twin Studio', href: '/dashboard/settings/twin-studio' },
          { id: 'my-videos', label: 'My Videos', href: '/dashboard/videos/library' },
          { id: 'education', label: 'Education', href: '/dashboard/videos/education' },
        ],
      },
      {
        id: 'content',
        label: 'Content Studio',
        icon: 'Palette',
        children: [
          { id: 'marketing-studio', label: 'Marketing Studio', href: '/dashboard/marketing/studio' },
          { id: 'content-os', label: 'Content OS', href: '/dashboard/content' },
          // Nav-parity: these marketing pages exist and are open to the team tier,
          // but were unreachable from the team_lead sidebar.
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
          // Nav-parity: the QR manager was agent-only. The same page narrows a
          // team lead to their OWN team's codes (#191 — teams see only their own
          // board), so this is the team's QR board, not the brokerage's.
          { id: 'qr-codes', label: 'QR Codes', href: '/dashboard/agent/qr-codes' },
          { id: 'newsletters', label: 'Newsletters', href: '/newsletters/templates' },
          { id: 'blog', label: 'Blog Posts', href: '/dashboard/marketing/studio?tab=blog' },
          { id: 'podcast', label: 'Podcast Studio', href: '/dashboard/marketing/podcast' },
          { id: 'seo', label: 'SEO / GEO', href: '/dashboard/marketing/seo' },
          { id: 'video-pages', label: 'Video Pages', href: '/dashboard/marketing/video-pages' },
        ],
      },
      {
        id: 'campaigns',
        label: 'Campaigns',
        icon: 'Megaphone',
        children: [
          { id: 'ads', label: 'Ad Campaigns', href: '/dashboard/campaigns/ads' },
          { id: 'direct-mail', label: 'Direct Mail', href: '/dashboard/campaigns/mail' },
          { id: 'repurpose', label: 'Repurpose Content', href: '/dashboard/campaigns/repurpose' },
          { id: 'roi', label: 'Campaign ROI', href: '/dashboard/campaigns/roi' },
        ],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: 'MessageCircle',
        children: [
          { id: 'outreach', label: 'AI Outreach', href: '/dashboard/communications/outreach' },
          { id: 'sequences', label: 'Automation Sequences', href: '/dashboard/campaigns/sequences' },
          { id: 'intelligence', label: 'Comm Intelligence', href: '/dashboard/communications/intelligence' },
          { id: 'voice-command', label: 'Voice Assistant', href: '/dashboard/voice' },
        ],
      },
      {
        id: 'financials',
        label: 'Financials',
        icon: 'DollarSign',
        children: [
          { id: 'my-financials', label: 'My Financials', href: '/dashboard/financials/agent' },
          { id: 'team-financials', label: 'Team Financials', href: '/dashboard/financials/team' },
        ],
      },
      { id: 'compliance', label: 'Compliance', href: '/dashboard/compliance', icon: 'Shield' },
      { id: 'reports', label: 'Reports', href: '/dashboard/reports', icon: 'BarChart3' },
      {
        id: 'sphere',
        label: 'Sphere of Influence',
        icon: 'Users',
        href: '/lifetime-customers',
        children: [
          { id: 'sphere-all', label: 'All Sphere Contacts', href: '/lifetime-customers' },
          { id: 'sphere-resonance', label: 'Resonance — Life Events', href: '/dashboard/sphere' },
          { id: 'sphere-wealth', label: 'Wealth Opportunities', href: '/dashboard/wealth' },
          { id: 'sphere-referrals', label: 'Referrals', href: '/referrals' },
          { id: 'sphere-reviews', label: 'Reviews & Reputation', href: '/lifetime-customers?tab=reviews' },
          { id: 'sphere-gifting', label: 'Gifting & Milestones', href: '/lifetime-customers?tab=gifting' },
          // Orphan-route sweep: the Gift Studio command center had no inbound nav link.
          { id: 'sphere-gift-studio', label: 'Gift Studio', href: '/dashboard/gifts' },
        ],
      },
      { id: 'settings', label: 'Settings', href: '/dashboard/settings/general', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badgeKey: 'unread_notifications' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'crm', label: 'CRM', href: '/crm', icon: 'Users' },
      { id: 'transactions', label: 'Deals', href: '/dashboard/transactions', icon: 'FileText' },
      { id: 'team', label: 'Team', href: '/dashboard/team', icon: 'UserCheck' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'briefing', label: 'AI Briefing', href: '/dashboard/briefing' },
      { id: 'view-team', label: 'View Team', href: '/dashboard/team' },
      { id: 'team-heatmap', label: 'Team Heatmap', href: '/dashboard/team-heatmap' },
      { id: 'new-contact', label: 'New Contact', href: '/crm/contacts/new' },
      { id: 'video-studio', label: 'Create AI Video', href: '/dashboard/videos/create' },
    ],
  },
}

/**
 * STAFF roles, in the order their navigation is merged.
 *
 * THIS ORDER IS THE POINT. A user's roles arrive from user_role_assignments with
 * NO ordering — the table is UNIQUE on (user_id, role), so the rows come back in
 * whatever order the planner produced. The old resolver took `roles[0]` from that
 * unordered set, which meant the sidebar a multi-role user saw could differ
 * between two logins. Merging in a FIXED precedence removes the arbitrariness:
 * the same role set always produces the same navigation.
 *
 * Widest-governing first, so when two roles both define an item the more
 * responsible role's label/href wins the dedupe.
 */
const STAFF_NAV_PRECEDENCE: readonly UserRole[] = [
  'broker', 'admin', 'team_lead', 'compliance_officer', 'tc', 'isa', 'agent',
] as unknown as readonly UserRole[]

/**
 * EXTERNAL personas. These are people the brokerage works WITH, not staff of it,
 * and their navigation is a portal rather than a workspace.
 *
 * They are deliberately NOT merged into a staff union. Measured on the live
 * database, one account holds BOTH `contact` and `team_lead` — a client who is
 * also a team lead. Merging those would put the staff workspace and the client
 * portal in one sidebar, which is not "one person wearing several business
 * hats"; it is two different relationships to the brokerage in one nav. If a
 * user holds ANY staff role, staff navigation is what they get.
 */
const EXTERNAL_NAV_ROLES: ReadonlySet<string> = new Set([
  'contact', 'vendor', 'lender', 'title_agent',
])

/**
 * The single role to name when a surface genuinely needs ONE (a page-context
 * label, an analytics tag). Resolved by the SAME fixed precedence the navigation
 * merge uses, so "which role am I acting as" and "what can I see" never disagree.
 *
 * Callers must not hand-roll `roles[0]` for this — that is the arbitrary pick
 * this module exists to remove.
 */
export function resolvePrimaryRole(roles: string[] | undefined | null): string {
  const held = new Set(roles ?? [])
  const staff = STAFF_NAV_PRECEDENCE.find((r) => held.has(r as string))
  if (staff) return staff as string
  for (const r of held) if (NAVIGATION_BY_ROLE[r as UserRole]) return r
  return 'contact'
}

/** Merge nav item lists, first occurrence wins. Keyed on id, falling back to
 *  href so two roles listing the same destination under different ids collapse. */
function mergeNavItems(lists: NavItem[][]): NavItem[] {
  const seen = new Set<string>()
  const out: NavItem[] = []
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = item.id || item.href
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

/**
 * The navigation for everything this person is.
 *
 * OWNER'S RULING, which this implements: a solo tenant has two seats — the
 * producing agent, and a second user who carries everything else the business
 * needs (transactions, compliance, support, admin, marketing). Business roles
 * are ASSIGNED to a user, so ONE USER HOLDING SEVERAL ROLES IS THE DESIGNED
 * CASE. The signature already accepted an array; it then read `roles[0]` and
 * threw the rest away, so that second user only ever saw one role's surfaces —
 * the exact capability the seat model exists to provide was unreachable.
 *
 * Unknown role strings are ignored rather than defaulting, so a typo cannot
 * silently widen somebody. A user with no recognised role still lands on the
 * contact portal, as before.
 */
export function getNavigationForRole(role: string | string[]): NavigationConfig {
  const held = new Set(Array.isArray(role) ? role : [role])

  const staff = STAFF_NAV_PRECEDENCE.filter((r) => held.has(r as string))
  if (staff.length > 0) {
    const configs = staff.map((r) => NAVIGATION_BY_ROLE[r]).filter(Boolean)
    if (configs.length === 1) return configs[0]
    return {
      sidebarItems:        mergeNavItems(configs.map((c) => c.sidebarItems)),
      topNavItems:         mergeNavItems(configs.map((c) => c.topNavItems)),
      mobileBottomNav:     mergeNavItems(configs.map((c) => c.mobileBottomNav)),
      commandPaletteItems: mergeNavItems(configs.map((c) => c.commandPaletteItems)),
    }
  }

  // No staff role: a single external persona, unmerged.
  for (const r of held) {
    if (EXTERNAL_NAV_ROLES.has(r) && NAVIGATION_BY_ROLE[r as UserRole]) {
      return NAVIGATION_BY_ROLE[r as UserRole]
    }
  }
  // superadmin and any other non-staff, non-external role still resolve directly.
  for (const r of held) {
    if (NAVIGATION_BY_ROLE[r as UserRole]) return NAVIGATION_BY_ROLE[r as UserRole]
  }
  return NAVIGATION_BY_ROLE.contact
}

// TOMBSTONE (orphan burn-down, lane E): `filterNavItemsByPermissions` DELETED.
//
// It filtered nav items on `NavItem.requiredPermissions`. MEASURED: not one item
// in NAVIGATION_BY_ROLE — 1,100+ lines across every role — ever sets that field.
// The only two occurrences of `requiredPermissions` in this file were inside the
// function itself. So the filter's predicate was `if (!item.requiredPermissions)
// return true` for every item on every call: a no-op by construction, which is
// worse than unwired, because a reviewer reading a call to it would reasonably
// believe navigation was being permission-gated when nothing was being filtered.
//
// SURVIVOR: navigation is gated by ROLE, and that gate is live —
// `getNavigationForRole` (:1175 above), called by
// app/components/layout/app-shell.tsx:145 and rendered by Sidebar, Header and
// MobileBottomNav. It merges every STAFF role a multi-role user holds, deduped
// by id then href in a fixed STAFF_NAV_PRECEDENCE, and holds external personas
// (contact / vendor / lender / title_agent) out of the staff union. That rule,
// its order-independence and the external-persona boundary are proven by
// `npm run test:role-union-nav`.
//
// Nothing merged: the deleted function enforced nothing to carry over. Adding a
// SECOND, permission-based vocabulary over the same surface is also what the
// owner ruling quoted at lib/auth/resolve-user-role.ts:107 forbids — "having
// more than one vocab over the same function or feature is dangerous". If
// per-item permissions are ever genuinely wanted, the work is to author them on
// the items first, against the `Permission` union in lib/security/types.ts:347
// rather than the bare `string[]` this took; a filter with nothing to filter is
// not a head start on that.
//
// `NavItem.requiredPermissions` is left declared in app/types/navigation.ts:22:
// it is an optional field, costs nothing, and removing it belongs with whoever
// decides that question rather than with a burn-down pass.
