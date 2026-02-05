'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { NavigationConfig, NavItem } from '@/app/types/navigation'
import { UserContext } from '@/app/types/roles'
import { ChevronDown } from 'lucide-react'
import * as Icons from 'lucide-react'

interface SidebarProps {
  navigation: NavigationConfig
  userContext: UserContext
}

export function Sidebar({ navigation, userContext }: SidebarProps) {
  const pathname = usePathname()
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())

  const toggleExpanded = (itemId: string) => {
    const newExpanded = new Set(expandedItems)
    if (newExpanded.has(itemId)) {
      newExpanded.delete(itemId)
    } else {
      newExpanded.add(itemId)
    }
    setExpandedItems(newExpanded)
  }

  const getIcon = (iconName?: string) => {
    if (!iconName) return null
    const IconComponent = (Icons as any)[iconName]
    return IconComponent ? <IconComponent className="w-4 h-4" /> : null
  }

  const renderNavItem = (item: NavItem, depth = 0) => {
    if (item.divider) {
      return <div key={item.id} className="my-2 border-t border-gray-200" />
    }

    const isActive = item.href && pathname === item.href
    const hasChildren = item.children && item.children.length > 0
    const isExpanded = expandedItems.has(item.id)

    return (
      <div key={item.id}>
        <div className={cn('flex items-center', depth > 0 && 'pl-4')}>
          {hasChildren && (
            <button onClick={() => toggleExpanded(item.id)} className="p-1 hover:bg-gray-100 rounded">
              <ChevronDown className={cn('w-4 h-4 transition-transform text-gray-600', isExpanded && 'rotate-180')} />
            </button>
          )}

          {item.href ? (
            <Link
              href={item.href}
              className={cn(
                'flex-1 flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                isActive ? 'bg-blue-50 text-blue-700 border-l-4 border-blue-600' : 'text-gray-700 hover:bg-gray-100'
              )}
            >
              {getIcon(item.icon)}
              <span>{item.label}</span>
              {item.badge && (
                <span className={cn('ml-auto px-2 py-1 rounded text-xs font-semibold', item.badge.color === 'red' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700')}>
                  {item.badge.count}
                </span>
              )}
            </Link>
          ) : (
            <button onClick={() => toggleExpanded(item.id)} className="flex-1 flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors text-gray-700 hover:bg-gray-100">
              {getIcon(item.icon)}
              <span>{item.label}</span>
            </button>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div className="ml-2">
            {item.children!.map((child) => renderNavItem(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <nav className="flex-1 overflow-y-auto p-4 space-y-1">
      <div className="px-3 py-4 mb-6 border-b border-gray-200">
        <h1 className="text-lg font-bold text-gray-900">VIP Agents</h1>
        <p className="text-xs text-gray-600">{userContext.first_name} {userContext.last_name}</p>
      </div>
      {navigation.sidebarItems.map((item) => renderNavItem(item))}
    </nav>
  )
}
