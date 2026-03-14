'use client'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { LayoutGrid, Package, Clock, FileText, Calendar, Settings } from 'lucide-react'

const TITLE_NAV = [
  { label: 'Title Dashboard', href: '/title/dashboard', icon: LayoutGrid },
  { label: 'Title Orders', href: '/title/orders', icon: Package },
  { label: 'Order Status', href: '/title/status', icon: Clock },
  { label: 'Title Documents', href: '/title/documents', icon: FileText },
  { label: 'Closing Schedule', href: '/title/closing', icon: Calendar },
  { label: 'Client Portal', href: '/portal/title', icon: LayoutGrid },
  { label: 'Settings', href: '/title/settings', icon: Settings },
]

export default function TitleMenuPage() {
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold">Title Agent Menu</h1>
      <div className="grid grid-cols-2 gap-3">
        {TITLE_NAV.map((item) => (
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
