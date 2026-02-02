'use client'

import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { NavItem } from '@/app/types/navigation'
import * as Icons from 'lucide-react'

interface MobileBottomNavProps {
  items: NavItem[]
}

export function MobileBottomNav({ items }: MobileBottomNavProps) {
  const pathname = usePathname()

  const getIcon = (iconName?: string) => {
    if (!iconName) return null
    const IconComponent = (Icons as any)[iconName]
    return IconComponent ? <IconComponent className="w-5 h-5" /> : null
  }

  return (
    <nav className="flex items-center justify-around h-20 bg-white">
      {items.map((item) => {
        if (!item.href) return null
        const isActive = pathname === item.href
        return (
          <Link
            key={item.id}
            href={item.href}
            className={cn(
              'flex flex-col items-center justify-center gap-1 py-2 px-3 rounded-lg transition-colors flex-1',
              isActive ? 'text-blue-700 bg-blue-50' : 'text-gray-600'
            )}
          >
            {getIcon(item.icon)}
            <span className="text-xs font-medium">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
