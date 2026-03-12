'use strict'

import { UserRole } from '@/app/types/roles'
import { NavigationConfig, NavItem } from '@/app/types/navigation'

export const NAVIGATION_BY_ROLE: Record<UserRole, NavigationConfig> = {
  agent: {
    sidebarItems: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'leads', label: 'My Leads', href: '/dashboard/buyers', icon: 'Zap', badge: { count: 5, color: 'red' } },
      { id: 'contacts', label: 'My Contacts', href: '/contacts', icon: 'Users' },
      { id: 'listings', label: 'My Listings', href: '/dashboard/listings', icon: 'Home' },
      { id: 'transactions', label: 'Transactions', href: '/dashboard/transactions', icon: 'FileText' },
      { id: 'divider1', divider: true },
      {
        id: 'campaign',
        label: 'Campaigns',
        icon: 'Megaphone',
        children: [
          { id: 'email', label: 'Email', href: '/dashboard/campaigns/email' },
          { id: 'sms', label: 'SMS', href: '/dashboard/campaigns/sms' },
          { id: 'direct-mail', label: 'Direct Mail', href: '/dashboard/campaigns/direct-mail' },
        ],
      },
      {
        id: 'content',
        label: 'Content Studio',
        icon: 'Palette',
        children: [
          { id: 'newsletter', label: 'Newsletter', href: '/newsletters/templates' },
          { id: 'social', label: 'Social Media', href: '/dashboard/marketing/social' },
          { id: 'videos', label: 'Videos', href: '/dashboard/marketing/videos' },
          { id: 'blog', label: 'Blog Posts', href: '/dashboard/marketing/blog' },
        ],
      },
      { id: 'divider2', divider: true },
      { id: 'coaching', label: 'Training & Coaching', href: '/dashboard/coaching', icon: 'BookOpen' },
      { id: 'onboarding', label: 'Onboarding', href: '/dashboard/onboarding', icon: 'BookOpen' },
      { id: 'settings', label: 'Settings', href: '/dashboard/settings/general', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'search', label: 'Search', icon: 'Search' },
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badge: { count: 3, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'leads', label: 'Leads', href: '/dashboard/buyers', icon: 'Zap' },
      { id: 'contacts', label: 'Contacts', href: '/contacts', icon: 'Users' },
      { id: 'listings', label: 'Listings', href: '/dashboard/listings', icon: 'Home' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'quick-contact', label: 'Create Contact', href: '/contacts/new' },
      { id: 'quick-note', label: 'Add Note', href: '/dashboard/notes/new' },
      { id: 'quick-call', label: 'Make Call', href: '/dashboard/calls/new' },
      { id: 'quick-email', label: 'Send Email', href: '/dashboard/emails/new' },
    ],
  },

  broker: {
    sidebarItems: [
      { id: 'dashboard', label: 'Broker Dashboard', href: '/dashboard/brokerage', icon: 'LayoutGrid' },
      { id: 'team', label: 'My Team', href: '/dashboard/team', icon: 'Users' },
      { id: 'analytics', label: 'Analytics', href: '/dashboard/analytics', icon: 'BarChart3' },
      { id: 'transactions', label: 'All Transactions', href: '/dashboard/transactions', icon: 'FileText' },
      { id: 'divider1', divider: true },
      {
        id: 'financials',
        label: 'Financials',
        icon: 'DollarSign',
        children: [
          { id: 'commissions', label: 'Commissions', href: '/dashboard/financials/commissions' },
          { id: 'expenses', label: 'Expenses', href: '/dashboard/financials/expenses' },
          { id: 'payouts', label: 'Agent Payouts', href: '/dashboard/financials/payouts' },
        ],
      },
      {
        id: 'settings',
        label: 'Brokerage Settings',
        icon: 'Settings',
        children: [
          { id: 'general', label: 'General', href: '/dashboard/settings/general' },
          { id: 'branding', label: 'Branding', href: '/dashboard/settings/branding' },
          { id: 'team-mgmt', label: 'Team Management', href: '/dashboard/settings/teams' },
          { id: 'integrations', label: 'Integrations', href: '/dashboard/settings/integrations' },
        ],
      },
    ],
    topNavItems: [
      { id: 'search', label: 'Search', icon: 'Search' },
      { id: 'alerts', label: 'Alerts', icon: 'AlertCircle', badge: { count: 2, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/brokerage', icon: 'LayoutGrid' },
      { id: 'team', label: 'Team', href: '/dashboard/team', icon: 'Users' },
      { id: 'analytics', label: 'Analytics', href: '/dashboard/analytics', icon: 'BarChart3' },
      { id: 'financials', label: 'Financials', href: '/dashboard/financials/commissions', icon: 'DollarSign' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'new-agent', label: 'Add Agent', href: '/dashboard/settings/teams/new-agent' },
      { id: 'view-reports', label: 'View Reports', href: '/dashboard/analytics' },
    ],
  },

  isa: {
    sidebarItems: [
      { id: 'dashboard', label: 'ISA Dashboard', href: '/dashboard/isa', icon: 'LayoutGrid' },
      { id: 'calling', label: 'Calling', href: '/dashboard/isa/calling', icon: 'Phone', badge: { count: 12, color: 'red' } },
      { id: 'leads', label: 'Leads', href: '/dashboard/isa/leads', icon: 'Zap' },
      { id: 'campaigns', label: 'Campaigns', href: '/dashboard/isa/campaigns', icon: 'Megaphone' },
      { id: 'scripts', label: 'Scripts', href: '/dashboard/isa/scripts', icon: 'FileText' },
      { id: 'analytics', label: 'My Stats', href: '/dashboard/isa/analytics', icon: 'BarChart3' },
      { id: 'settings', label: 'Settings', href: '/dashboard/settings/general', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badge: { count: 5, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'calling', label: 'Calling', href: '/dashboard/isa/calling', icon: 'Phone' },
      { id: 'leads', label: 'Leads', href: '/dashboard/isa/leads', icon: 'Zap' },
      { id: 'campaigns', label: 'Campaigns', href: '/dashboard/isa/campaigns', icon: 'Megaphone' },
      { id: 'analytics', label: 'Stats', href: '/dashboard/isa/analytics', icon: 'BarChart3' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'dial-number', label: 'Dial Number', href: '/dashboard/isa/calling/dial' },
      { id: 'new-campaign', label: 'New Campaign', href: '/dashboard/isa/campaigns/new' },
    ],
  },

  admin: {
    sidebarItems: [
      { id: 'dashboard', label: 'Admin Dashboard', href: '/admin/dashboard', icon: 'LayoutGrid' },
      { id: 'users', label: 'Users', href: '/admin/users', icon: 'Users' },
      { id: 'brokerages', label: 'Brokerages', href: '/admin/brokerages', icon: 'Building2' },
      { id: 'system', label: 'System Health', href: '/admin/system', icon: 'Activity' },
      { id: 'monitoring', label: 'Monitoring', href: '/admin/monitoring', icon: 'Eye' },
      { id: 'logs', label: 'Audit Logs', href: '/admin/logs', icon: 'FileText' },
      { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'AlertTriangle', badge: { count: 1, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/admin/dashboard', icon: 'LayoutGrid' },
      { id: 'users', label: 'Users', href: '/admin/users', icon: 'Users' },
      { id: 'system', label: 'System', href: '/admin/system', icon: 'Activity' },
      { id: 'monitoring', label: 'Monitor', href: '/admin/monitoring', icon: 'Eye' },
      { id: 'more', label: 'More', href: '/admin/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'view-logs', label: 'View Logs', href: '/admin/logs' },
      { id: 'system-status', label: 'System Status', href: '/admin/system' },
    ],
  },

  vendor: {
    sidebarItems: [
      { id: 'dashboard', label: 'Dashboard', href: '/vendor/dashboard', icon: 'LayoutGrid' },
      { id: 'jobs', label: 'Jobs', href: '/vendor/jobs', icon: 'Briefcase', badge: { count: 2, color: 'blue' } },
      { id: 'portfolio', label: 'Portfolio', href: '/vendor/portfolio', icon: 'Image' },
      { id: 'earnings', label: 'Earnings', href: '/vendor/earnings', icon: 'DollarSign' },
      { id: 'settings', label: 'Settings', href: '/vendor/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badge: { count: 1, color: 'blue' } },
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
    sidebarItems: [
      { id: 'overview', label: 'Overview', href: '/contact/portal', icon: 'Home' },
      { id: 'transaction', label: 'My Transaction', href: '/contact/transaction', icon: 'FileText' },
      { id: 'documents', label: 'Documents', href: '/contact/documents', icon: 'Folder' },
      { id: 'messages', label: 'Messages', href: '/contact/messages', icon: 'Mail' },
      { id: 'settings', label: 'Settings', href: '/contact/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'notifications', label: 'Notifications', icon: 'Bell' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'overview', label: 'Overview', href: '/contact/portal', icon: 'Home' },
      { id: 'transaction', label: 'Transaction', href: '/contact/transaction', icon: 'FileText' },
      { id: 'documents', label: 'Documents', href: '/contact/documents', icon: 'Folder' },
      { id: 'messages', label: 'Messages', href: '/contact/messages', icon: 'Mail' },
    ],
    commandPaletteItems: [
      { id: 'contact-agent', label: 'Contact Agent', href: '/contact/messages/new' },
      { id: 'view-docs', label: 'View Documents', href: '/contact/documents' },
    ],
  },

  compliance_officer: {
    sidebarItems: [
      { id: 'dashboard', label: 'Compliance Dashboard', href: '/compliance/dashboard', icon: 'LayoutGrid' },
      { id: 'violations', label: 'Violations', href: '/compliance/violations', icon: 'AlertTriangle', badge: { count: 2, color: 'red' } },
      { id: 'audits', label: 'Audit Logs', href: '/compliance/audits', icon: 'Eye' },
      { id: 'policies', label: 'Policies', href: '/compliance/policies', icon: 'FileText' },
      { id: 'reports', label: 'Reports', href: '/compliance/reports', icon: 'BarChart3' },
      { id: 'settings', label: 'Settings', href: '/compliance/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'AlertTriangle', badge: { count: 2, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/compliance/dashboard', icon: 'LayoutGrid' },
      { id: 'violations', label: 'Violations', href: '/compliance/violations', icon: 'AlertTriangle' },
      { id: 'audits', label: 'Audits', href: '/compliance/audits', icon: 'Eye' },
      { id: 'reports', label: 'Reports', href: '/compliance/reports', icon: 'BarChart3' },
      { id: 'more', label: 'More', href: '/compliance/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'flag-violation', label: 'Flag Violation', href: '/compliance/violations/new' },
      { id: 'generate-report', label: 'Generate Report', href: '/compliance/reports/new' },
    ],
  },

  tc: {
    sidebarItems: [
      { id: 'dashboard', label: 'Coordinator Dashboard', href: '/transaction/dashboard', icon: 'LayoutGrid' },
      { id: 'deals', label: 'Active Deals', href: '/transaction/deals', icon: 'Handshake', badge: { count: 8, color: 'red' } },
      { id: 'checklists', label: 'Checklists', href: '/transaction/checklists', icon: 'CheckSquare' },
      { id: 'documents', label: 'Documents', href: '/transaction/documents', icon: 'Folder' },
      { id: 'vendors', label: 'Vendor Coordination', href: '/transaction/vendors', icon: 'Users' },
      { id: 'settings', label: 'Settings', href: '/transaction/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badge: { count: 4, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/transaction/dashboard', icon: 'LayoutGrid' },
      { id: 'deals', label: 'Deals', href: '/transaction/deals', icon: 'Handshake' },
      { id: 'checklists', label: 'Checklists', href: '/transaction/checklists', icon: 'CheckSquare' },
      { id: 'vendors', label: 'Vendors', href: '/transaction/vendors', icon: 'Users' },
      { id: 'more', label: 'More', href: '/transaction/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'new-deal', label: 'New Deal', href: '/transaction/deals/new' },
      { id: 'contact-vendor', label: 'Contact Vendor', href: '/transaction/vendors/contact' },
    ],
  },

  lender: {
    sidebarItems: [
      { id: 'dashboard', label: 'Lender Dashboard', href: '/lender/dashboard', icon: 'LayoutGrid' },
      { id: 'pipeline', label: 'Loan Pipeline', href: '/lender/pipeline', icon: 'TrendingUp', badge: { count: 12, color: 'blue' } },
      { id: 'approvals', label: 'Approvals', href: '/lender/approvals', icon: 'CheckCircle' },
      { id: 'underwriting', label: 'Underwriting', href: '/lender/underwriting', icon: 'FileCheck' },
      { id: 'documents', label: 'Documents', href: '/lender/documents', icon: 'Folder' },
      { id: 'settings', label: 'Settings', href: '/lender/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badge: { count: 3, color: 'red' } },
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
      { id: 'orders', label: 'Title Orders', href: '/title/orders', icon: 'Package', badge: { count: 5, color: 'blue' } },
      { id: 'status', label: 'Order Status', href: '/title/status', icon: 'Clock' },
      { id: 'documents', label: 'Title Documents', href: '/title/documents', icon: 'FileText' },
      { id: 'closing', label: 'Closing Schedule', href: '/title/closing', icon: 'Calendar' },
      { id: 'settings', label: 'Settings', href: '/title/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badge: { count: 2, color: 'red' } },
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
      { id: 'platform', label: 'Platform Admin', href: '/admin/platform', icon: 'ShieldAlert' },
      { id: 'brokerages', label: 'Brokerages', href: '/admin/brokerages', icon: 'Building2' },
      { id: 'users', label: 'All Users', href: '/admin/users', icon: 'Users' },
      { id: 'system-health', label: 'System Health', href: '/admin/system-health', icon: 'Activity' },
      { id: 'ai-audit', label: 'AI Audit', href: '/admin/ai-audit', icon: 'Eye' },
      { id: 'integrations', label: 'Integrations', href: '/admin/integrations', icon: 'Plug' },
      { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell' },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'platform', label: 'Platform', href: '/admin/platform', icon: 'ShieldAlert' },
      { id: 'brokerages', label: 'Brokerages', href: '/admin/brokerages', icon: 'Building2' },
      { id: 'system-health', label: 'System', href: '/admin/system-health', icon: 'Activity' },
      { id: 'settings', label: 'Settings', href: '/admin/settings', icon: 'Settings' },
      { id: 'more', label: 'More', href: '/admin/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'manage-brokerages', label: 'Manage Brokerages', href: '/admin/brokerages' },
      { id: 'system-health', label: 'View System Health', href: '/admin/system-health' },
    ],
  },

  // team_lead — agent capabilities + team management overlay
  team_lead: {
    sidebarItems: [
      { id: 'dashboard', label: 'Team Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'crm', label: 'CRM', href: '/contacts', icon: 'Users' },
      { id: 'transactions', label: 'Transactions', href: '/dashboard/transactions', icon: 'FileText' },
      { id: 'lead-intelligence', label: 'Lead Intelligence', href: '/dashboard/lead-intelligence', icon: 'Brain' },
      { id: 'agent-roster', label: 'My Team', href: '/dashboard/team', icon: 'UserCheck' },
      { id: 'financials', label: 'Financials', href: '/dashboard/financials', icon: 'DollarSign' },
      { id: 'compliance', label: 'Compliance', href: '/dashboard/compliance', icon: 'CheckCircle' },
      { id: 'content-studio', label: 'Content Studio', href: '/dashboard/marketing', icon: 'Palette' },
      { id: 'settings', label: 'Settings', href: '/dashboard/settings/general', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'alerts', label: 'Alerts', icon: 'Bell', badge: { count: 3, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard/agent', icon: 'LayoutGrid' },
      { id: 'crm', label: 'CRM', href: '/contacts', icon: 'Users' },
      { id: 'transactions', label: 'Deals', href: '/dashboard/transactions', icon: 'FileText' },
      { id: 'team', label: 'Team', href: '/dashboard/team', icon: 'UserCheck' },
      { id: 'more', label: 'More', href: '/dashboard', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'view-team', label: 'View Team', href: '/dashboard/team' },
      { id: 'new-contact', label: 'New Contact', href: '/contacts/new' },
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
