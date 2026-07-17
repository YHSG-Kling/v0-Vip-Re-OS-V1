'use client'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { LayoutGrid, AlertTriangle, Eye, FileText, BarChart3, Shield, CheckSquare, Sparkles, Settings } from 'lucide-react'

const COMPLIANCE_NAV = [
  { label: 'Compliance Command', href: '/dashboard/compliance', icon: LayoutGrid },
  { label: 'Violations', href: '/compliance/violations', icon: AlertTriangle },
  { label: 'Audit Logs', href: '/compliance/audits', icon: Eye },
  { label: 'Policies', href: '/compliance/policies', icon: FileText },
  { label: 'Reports', href: '/compliance/reports', icon: BarChart3 },
  { label: 'Full Compliance Center', href: '/dashboard/compliance', icon: Shield },
  { label: 'Comm Intelligence', href: '/dashboard/communications/intelligence', icon: Eye },
  { label: 'Approvals Queue', href: '/approvals', icon: CheckSquare },
  { label: 'AI Quality', href: '/dashboard/ai-quality', icon: Sparkles },
  { label: 'Platform Audit Trail', href: '/dashboard/superadmin/audit-trail', icon: Eye },
  { label: 'Settings', href: '/compliance/settings', icon: Settings },
]

export default function ComplianceMenuPage() {
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold">Compliance Menu</h1>
      <div className="grid grid-cols-2 gap-3">
        {COMPLIANCE_NAV.map((item) => (
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
