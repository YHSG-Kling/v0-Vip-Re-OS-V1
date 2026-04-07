'use client'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { LayoutGrid, Handshake, CheckSquare, Folder, Users, Settings } from 'lucide-react'

const TC_NAV = [
  { label: 'Coordinator Command', href: '/dashboard/coordinator', icon: LayoutGrid },
  { label: 'Active Deals', href: '/transaction/deals', icon: Handshake },
  { label: 'Checklists', href: '/transaction/checklists', icon: CheckSquare },
  { label: 'Documents', href: '/transaction/documents', icon: Folder },
  { label: 'Vendor Coordination', href: '/transaction/vendors', icon: Users },
  { label: 'Full Coordination', href: '/dashboard/coordination', icon: LayoutGrid },
  { label: 'Approvals', href: '/approvals', icon: CheckSquare },
  { label: 'Settings', href: '/transaction/settings', icon: Settings },
]

export default function TransactionMenuPage() {
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold">TC Menu</h1>
      <div className="grid grid-cols-2 gap-3">
        {TC_NAV.map((item) => (
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
