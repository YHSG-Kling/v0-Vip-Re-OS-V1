'use client'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { LayoutGrid, TrendingUp, CheckCircle, FileCheck, Folder, Settings } from 'lucide-react'

const LENDER_NAV = [
  { label: 'Lender Dashboard', href: '/lender/dashboard', icon: LayoutGrid },
  { label: 'Loan Pipeline', href: '/lender/pipeline', icon: TrendingUp },
  { label: 'Approvals', href: '/lender/approvals', icon: CheckCircle },
  { label: 'Underwriting', href: '/lender/underwriting', icon: FileCheck },
  { label: 'Documents', href: '/lender/documents', icon: Folder },
  { label: 'Client Portal', href: '/portal/lender', icon: LayoutGrid },
  { label: 'Settings', href: '/lender/settings', icon: Settings },
]

export default function LenderMenuPage() {
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold">Lender Menu</h1>
      <div className="grid grid-cols-2 gap-3">
        {LENDER_NAV.map((item) => (
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
