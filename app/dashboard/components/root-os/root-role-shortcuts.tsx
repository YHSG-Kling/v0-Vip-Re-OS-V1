'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { 
  Home, 
  Users, 
  Target, 
  Calendar, 
  Phone, 
  BarChart3, 
  FileText,
  MessageSquare,
  Sparkles,
  ClipboardCheck,
  Shield,
  Building2,
  DollarSign
} from 'lucide-react'
import Link from 'next/link'

interface QuickAction {
  label: string
  href: string
  icon: typeof Home
  description?: string
}

// Role-specific quick actions that link to real existing routes
const ROLE_SHORTCUTS: Record<string, QuickAction[]> = {
  agent: [
    { label: 'CRM', href: '/crm', icon: Users, description: 'Manage contacts' },
    { label: 'Buyers', href: '/dashboard/buyers', icon: Target, description: 'Active buyers' },
    { label: 'Listings', href: '/dashboard/listings', icon: Home, description: 'Your listings' },
    { label: 'Calendar', href: '/dashboard/calendar', icon: Calendar, description: 'Schedule' },
    { label: 'Inbox', href: '/dashboard/communications/inbox', icon: MessageSquare, description: 'Messages' },
    { label: 'Briefing', href: '/dashboard/briefing', icon: Sparkles, description: 'AI Summary' },
  ],
  broker: [
    { label: 'Agents', href: '/dashboard/brokerage/agents', icon: Users, description: 'Team management' },
    { label: 'Transactions', href: '/dashboard/transactions', icon: FileText, description: 'All deals' },
    { label: 'Analytics', href: '/dashboard/analytics', icon: BarChart3, description: 'Performance' },
    { label: 'Compliance', href: '/dashboard/compliance', icon: Shield, description: 'Review' },
    { label: 'Vendors', href: '/dashboard/vendors', icon: Building2, description: 'Partners' },
    { label: 'Financials', href: '/dashboard/financials', icon: DollarSign, description: 'Revenue' },
  ],
  admin: [
    { label: 'Agents', href: '/dashboard/admin/agents', icon: Users, description: 'Agent roster' },
    { label: 'Transactions', href: '/dashboard/transactions', icon: FileText, description: 'All deals' },
    { label: 'Compliance', href: '/dashboard/compliance', icon: Shield, description: 'Audit' },
    { label: 'System', href: '/dashboard/system', icon: BarChart3, description: 'Health' },
    { label: 'Vendors', href: '/dashboard/vendors', icon: Building2, description: 'Directory' },
    { label: 'Import', href: '/dashboard/admin/import', icon: FileText, description: 'Leads' },
  ],
  tc: [
    { label: 'Pipeline', href: '/dashboard/coordinator', icon: ClipboardCheck, description: 'Active deals' },
    { label: 'Deadlines', href: '/dashboard/coordinator', icon: Calendar, description: 'Due dates' },
    { label: 'Documents', href: '/dashboard/transactions', icon: FileText, description: 'Doc review' },
    { label: 'Compliance', href: '/dashboard/compliance', icon: Shield, description: 'Checklists' },
  ],
  compliance_officer: [
    { label: 'Review Queue', href: '/dashboard/compliance', icon: Shield, description: 'Pending items' },
    { label: 'Transactions', href: '/dashboard/transactions', icon: FileText, description: 'All deals' },
    { label: 'Reports', href: '/compliance/reports', icon: BarChart3, description: 'Compliance' },
  ],
  isa: [
    { label: 'Campaigns', href: '/dashboard/isa', icon: Phone, description: 'Active outreach' },
    { label: 'Queue', href: '/dashboard/isa/campaigns', icon: Users, description: 'Lead queue' },
    { label: 'Voice', href: '/dashboard/voice', icon: Phone, description: 'Call center' },
  ],
  vendor: [
    { label: 'Jobs', href: '/vendor/jobs', icon: ClipboardCheck, description: 'Active jobs' },
    { label: 'Portfolio', href: '/vendor/portfolio', icon: FileText, description: 'Your work' },
    { label: 'Earnings', href: '/vendor/earnings', icon: DollarSign, description: 'Payments' },
  ],
  lender: [
    { label: 'Applications', href: '/lender/dashboard', icon: FileText, description: 'Loan apps' },
    { label: 'Pipeline', href: '/lender/dashboard', icon: BarChart3, description: 'In progress' },
  ],
  title: [
    { label: 'Orders', href: '/title/orders', icon: FileText, description: 'Title orders' },
    { label: 'Closings', href: '/title/closing', icon: Calendar, description: 'Scheduled' },
    { label: 'Documents', href: '/title/documents', icon: FileText, description: 'Doc center' },
  ],
}

interface RootRoleShortcutsProps {
  role: string
}

export function RootRoleShortcuts({ role }: RootRoleShortcutsProps) {
  const shortcuts = ROLE_SHORTCUTS[role] || ROLE_SHORTCUTS.agent

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          Quick Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {shortcuts.map((action) => {
          const Icon = action.icon
          return (
            <Link key={action.href} href={action.href}>
              <Button
                variant="outline"
                className="w-full h-auto py-3 px-3 flex flex-col items-center gap-1 hover:bg-accent"
              >
                <Icon className="h-5 w-5 text-muted-foreground" />
                <span className="text-xs font-medium">{action.label}</span>
              </Button>
            </Link>
          )
        })}
      </CardContent>
    </Card>
  )
}
