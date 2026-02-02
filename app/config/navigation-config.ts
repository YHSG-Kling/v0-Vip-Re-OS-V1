'use strict'

import { UserRole } from '@/app/types/roles'
import { NavigationConfig, NavItem } from '@/app/types/navigation'

export const NAVIGATION_BY_ROLE: Record<UserRole, NavigationConfig> = {
  agent: {
    sidebarItems: [
      { id: 'dashboard', label: 'Dashboard', href: '/agent/dashboard', icon: 'LayoutGrid' },
      { id: 'leads', label: 'My Leads', href: '/agent/leads', icon: 'Zap', badge: { count: 5, color: 'red' } },
      { id: 'contacts', label: 'My Contacts', href: '/agent/contacts', icon: 'Users' },
      { id: 'listings', label: 'My Listings', href: '/agent/listings', icon: 'Home' },
      { id: 'transactions', label: 'Transactions', href: '/agent/transactions', icon: 'FileText' },
      { id: 'divider1', divider: true },
      {
        id: 'campaign',
        label: 'Campaigns',
        icon: 'Megaphone',
        children: [
          { id: 'email', label: 'Email', href: '/agent/campaigns/email' },
          { id: 'sms', label: 'SMS', href: '/agent/campaigns/sms' },
          { id: 'direct-mail', label: 'Direct Mail', href: '/agent/campaigns/direct-mail' },
        ],
      },
      {
        id: 'content',
        label: 'Content Studio',
        icon: 'Palette',
        children: [
          { id: 'newsletter', label: 'Newsletter', href: '/newsletters/templates' },
          { id: 'social', label: 'Social Media', href: '/agent/content/social' },
          { id: 'videos', label: 'Videos', href: '/agent/content/videos' },
          { id: 'blog', label: 'Blog Posts', href: '/agent/content/blog' },
        ],
      },
      { id: 'divider2', divider: true },
      { id: 'coaching', label: 'Training & Coaching', href: '/agent/coaching', icon: 'BookOpen' },
      { id: 'settings', label: 'Settings', href: '/agent/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'search', label: 'Search', icon: 'Search' },
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badge: { count: 3, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/agent/dashboard', icon: 'LayoutGrid' },
      { id: 'leads', label: 'Leads', href: '/agent/leads', icon: 'Zap' },
      { id: 'contacts', label: 'Contacts', href: '/agent/contacts', icon: 'Users' },
      { id: 'listings', label: 'Listings', href: '/agent/listings', icon: 'Home' },
      { id: 'more', label: 'More', href: '/agent/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'quick-contact', label: 'Create Contact', href: '/agent/contacts/new' },
      { id: 'quick-note', label: 'Add Note', href: '/agent/notes/new' },
      { id: 'quick-call', label: 'Make Call', href: '/agent/calls/new' },
      { id: 'quick-email', label: 'Send Email', href: '/agent/emails/new' },
    ],
  },

  broker: {
    sidebarItems: [
      { id: 'dashboard', label: 'Broker Dashboard', href: '/broker/dashboard', icon: 'LayoutGrid' },
      { id: 'team', label: 'My Team', href: '/broker/team', icon: 'Users' },
      { id: 'analytics', label: 'Analytics', href: '/broker/analytics', icon: 'BarChart3' },
      { id: 'transactions', label: 'All Transactions', href: '/broker/transactions', icon: 'FileText' },
      { id: 'divider1', divider: true },
      {
        id: 'financials',
        label: 'Financials',
        icon: 'DollarSign',
        children: [
          { id: 'commissions', label: 'Commissions', href: '/broker/financials/commissions' },
          { id: 'expenses', label: 'Expenses', href: '/broker/financials/expenses' },
          { id: 'payouts', label: 'Agent Payouts', href: '/broker/financials/payouts' },
        ],
      },
      {
        id: 'settings',
        label: 'Brokerage Settings',
        icon: 'Settings',
        children: [
          { id: 'general', label: 'General', href: '/broker/settings/general' },
          { id: 'branding', label: 'Branding', href: '/broker/settings/branding' },
          { id: 'team-mgmt', label: 'Team Management', href: '/broker/settings/teams' },
          { id: 'integrations', label: 'Integrations', href: '/broker/settings/integrations' },
        ],
      },
    ],
    topNavItems: [
      { id: 'search', label: 'Search', icon: 'Search' },
      { id: 'alerts', label: 'Alerts', icon: 'AlertCircle', badge: { count: 2, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'dashboard', label: 'Dashboard', href: '/broker/dashboard', icon: 'LayoutGrid' },
      { id: 'team', label: 'Team', href: '/broker/team', icon: 'Users' },
      { id: 'analytics', label: 'Analytics', href: '/broker/analytics', icon: 'BarChart3' },
      { id: 'financials', label: 'Financials', href: '/broker/financials/commissions', icon: 'DollarSign' },
      { id: 'more', label: 'More', href: '/broker/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'new-agent', label: 'Add Agent', href: '/broker/settings/teams/new-agent' },
      { id: 'view-reports', label: 'View Reports', href: '/broker/analytics' },
    ],
  },

  isa: {
    sidebarItems: [
      { id: 'dashboard', label: 'ISA Dashboard', href: '/isa/dashboard', icon: 'LayoutGrid' },
      { id: 'calling', label: 'Calling', href: '/isa/calling', icon: 'Phone', badge: { count: 12, color: 'red' } },
      { id: 'leads', label: 'Leads', href: '/isa/leads', icon: 'Zap' },
      { id: 'campaigns', label: 'Campaigns', href: '/isa/campaigns', icon: 'Megaphone' },
      { id: 'scripts', label: 'Scripts', href: '/isa/scripts', icon: 'FileText' },
      { id: 'analytics', label: 'My Stats', href: '/isa/analytics', icon: 'BarChart3' },
      { id: 'settings', label: 'Settings', href: '/isa/settings', icon: 'Settings' },
    ],
    topNavItems: [
      { id: 'notifications', label: 'Notifications', icon: 'Bell', badge: { count: 5, color: 'red' } },
      { id: 'profile', label: 'Profile', icon: 'User' },
    ],
    mobileBottomNav: [
      { id: 'calling', label: 'Calling', href: '/isa/calling', icon: 'Phone' },
      { id: 'leads', label: 'Leads', href: '/isa/leads', icon: 'Zap' },
      { id: 'campaigns', label: 'Campaigns', href: '/isa/campaigns', icon: 'Megaphone' },
      { id: 'analytics', label: 'Stats', href: '/isa/analytics', icon: 'BarChart3' },
      { id: 'more', label: 'More', href: '/isa/menu', icon: 'Menu' },
    ],
    commandPaletteItems: [
      { id: 'dial-number', label: 'Dial Number', href: '/isa/calling/dial' },
      { id: 'new-campaign', label: 'New Campaign', href: '/isa/campaigns/new' },
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

  compliance_manager: {
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

  transaction_coordinator: {
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
