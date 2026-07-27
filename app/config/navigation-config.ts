'use strict'

import { UserRole } from '@/app/types/roles'
import { NavigationConfig, NavItem } from '@/app/types/navigation'

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
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'brand-voice', label: 'BrandVoice Profile', href: '/dashboard/marketing/studio/brand-voice' },
          { id: 'newsletter-templates', label: 'Newsletter Templates', href: '/newsletters' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
          { id: 'lead-magnets', label: 'Lead Magnets', href: '/dashboard/agent/lead-magnets' },
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
          { id: 'sphere-referrals', label: 'Referrals', href: '/lifetime-customers?tab=referrals' },
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
      { id: 'goals', label: 'My Goals', href: '/dashboard/goals', icon: 'Target' },
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
          { id: 'settings-integrations', label: 'Integrations', href: '/dashboard/settings/integrations' },
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
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
          // Nav-parity: agents and team leads could reach Newsletters; the broker could not.
          { id: 'newsletter-templates', label: 'Newsletter Templates', href: '/newsletters' },
          { id: 'lead-magnets', label: 'Lead Magnets', href: '/dashboard/admin/lead-magnets' },
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
          { id: 'sphere-referrals', label: 'Referrals', href: '/lifetime-customers?tab=referrals' },
          { id: 'sphere-reviews', label: 'Reviews & Reputation', href: '/lifetime-customers?tab=reviews' },
          { id: 'sphere-gifting', label: 'Gifting & Milestones', href: '/lifetime-customers?tab=gifting' },
          // Orphan-route sweep: the Gift Studio command center had no inbound nav link.
          { id: 'sphere-gift-studio', label: 'Gift Studio', href: '/dashboard/gifts' },
        ],
      },
      { id: 'leaderboard', label: 'Leaderboard', href: '/dashboard/leaderboard', icon: 'Award' },
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
          { id: 'team-mgmt', label: 'Team Management', href: '/dashboard/settings/teams' },
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
      // Orphan-route sweep: onboarding-step editor was unreachable from any nav.
      { id: 'onboarding-steps', label: 'Onboarding Steps', href: '/dashboard/admin/onboarding-steps', icon: 'ListChecks' },
      { id: 'education', label: 'Education Content', href: '/dashboard/admin/education', icon: 'GraduationCap' },
      { id: 'brokerage-fees', label: 'Brokerage Fees', href: '/dashboard/admin/fees', icon: 'DollarSign' },
      { id: 'phone-settings', label: 'Phone & ISA Voice', href: '/dashboard/admin/phone-settings', icon: 'Phone' },
      { id: 'ai-call-setup', label: 'AI Call Handling', href: '/dashboard/onboarding/ai-call-setup', icon: 'PhoneCall' },
      { id: 'assignment-rules', label: 'Assignment Rules', href: '/dashboard/admin/assignment-rules', icon: 'GitBranch' },
      { id: 'forms', label: 'Forms Manager', href: '/dashboard/admin/forms', icon: 'FileText' },
      { id: 'knowledge', label: 'Knowledge Base', href: '/dashboard/admin/knowledge', icon: 'BookOpen' },
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
          { id: 'brokerage-pnl', label: 'Brokerage P&L', href: '/dashboard/admin/brokerage-pnl', icon: 'TrendingUp' },
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
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
          { id: 'newsletter-templates', label: 'Newsletter Templates', href: '/newsletters' },
          { id: 'lead-magnets', label: 'Lead Magnets', href: '/dashboard/admin/lead-magnets' },
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
      // Orphan-route sweep: per-state required-document settings were unreachable from any nav.
      { id: 'required-documents', label: 'Required Documents', href: '/dashboard/settings/required-documents', icon: 'FileCheck' },
      // Feature Governance is PLATFORM-owned (enrollment flags aren't tenant-editable) —
      // it lives in the superadmin tree, not the brokerage admin's sidebar. (2026-07 walkthrough)
      { id: 'workflows', label: 'Workflow Monitor', href: '/workflows', icon: 'Workflow' },
      { id: 'video-analytics', label: 'Video Analytics', href: '/dashboard/videos/analytics', icon: 'Video' },
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
      { id: 'team-heatmap', label: 'Team Heatmap', href: '/dashboard/team-heatmap', icon: 'Map' },
      { id: 'leaderboard', label: 'Leaderboard', href: '/dashboard/leaderboard', icon: 'Award' },
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
          // Nav-parity: these marketing pages exist and are open to the team tier,
          // but were unreachable from the team_lead sidebar.
          { id: 'marketing-review', label: 'Review Queue', href: '/dashboard/marketing/review' },
          { id: 'social-dashboard', label: 'Social Dashboard', href: '/dashboard/social' },
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
          { id: 'sphere-referrals', label: 'Referrals', href: '/lifetime-customers?tab=referrals' },
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

export function getNavigationForRole(role: string | string[]): NavigationConfig {
  const roles = Array.isArray(role) ? role : [role]
  const primaryRole = roles[0]
  return NAVIGATION_BY_ROLE[primaryRole as UserRole] || NAVIGATION_BY_ROLE.contact
}

export function filterNavItemsByPermissions(items: NavItem[], userPermissions: string[]): NavItem[] {
  return items.filter((item) => {
    if (!item.requiredPermissions) return true
    return item.requiredPermissions.some((perm) => userPermissions.includes(perm))
  })
}
