'use client'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import {
  LayoutGrid, Brain, Users, FileText, BookOpen, CheckSquare, DollarSign,
  BarChart3, Shield, Workflow, CreditCard, Activity, HeartPulse, Eye, Sparkles, AlertTriangle, Settings, Bot
} from 'lucide-react'

const ADMIN_FULL_NAV = [
  { label: 'AI Briefing', href: '/dashboard/briefing', icon: Sparkles },
  { label: 'Command Center', href: '/dashboard/admin/command-center', icon: Bot },
  { label: 'Admin Dashboard', href: '/dashboard/admin', icon: LayoutGrid },
  { label: 'Lead Intelligence', href: '/leads', icon: Brain },
  { label: 'Agent Onboarding', href: '/dashboard/admin/onboarding', icon: Users },
  { label: 'Assignment Rules', href: '/dashboard/admin/assignment-rules', icon: FileText },
  { label: 'Forms Manager', href: '/dashboard/admin/forms', icon: FileText },
  { label: 'Knowledge Base', href: '/dashboard/admin/knowledge', icon: BookOpen },
  { label: 'Approvals', href: '/approvals', icon: CheckSquare },
  { label: 'Analytics', href: '/analytics', icon: BarChart3 },
  { label: 'AI Quality', href: '/dashboard/ai-quality', icon: Sparkles },
  { label: 'Team Heatmap', href: '/dashboard/team-heatmap', icon: BarChart3 },
  { label: 'Behavioral Patterns', href: '/dashboard/patterns', icon: Activity },
  { label: 'AI Coordination', href: '/dashboard/coordination', icon: Brain },
  { label: 'Comm Intelligence', href: '/dashboard/communications/intelligence', icon: Eye },
  { label: 'Team Financials', href: '/dashboard/financials/team', icon: DollarSign },
  { label: 'Compliance', href: '/dashboard/compliance', icon: Shield },
  { label: 'Workflows', href: '/workflows', icon: Workflow },
  { label: 'Billing', href: '/admin/billing', icon: CreditCard },
  { label: 'Usage Metrics', href: '/admin/usage', icon: Activity },
  { label: 'System Health', href: '/admin/system-health', icon: HeartPulse },
  { label: 'Audit Trail', href: '/admin/audit-trail', icon: Eye },
  { label: 'AI Audit', href: '/admin/ai-audit', icon: Sparkles },
  { label: 'Error Handler', href: '/admin/error-handler', icon: AlertTriangle },
  { label: 'Settings', href: '/settings', icon: Settings },
]

export default function AdminMenuPage() {
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold">Admin Menu</h1>
      <div className="grid grid-cols-2 gap-3">
        {ADMIN_FULL_NAV.map((item) => (
          <Link key={item.href} href={item.href}>
            <Card className="hover:shadow-md transition-shadow">
              <CardContent className="p-3 flex items-center gap-2">
                <item.icon className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium">{item.label}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
