'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import { NavigationConfig } from '@/app/types/navigation'
import { UserContext } from '@/app/types/roles'
import { GlobalSearch } from './global-search'
import { UserMenu } from './user-menu'
import { NotificationBell } from './notification-bell'
import { Menu } from 'lucide-react'

interface HeaderProps {
  navigation: NavigationConfig
  userContext: UserContext
}

export function Header({ navigation, userContext }: HeaderProps) {
  return (
    <header className="border-b border-gray-200 bg-white h-16 flex items-center justify-between px-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" className="lg:hidden">
          <Menu className="w-5 h-5 text-gray-700" />
        </Button>
      </div>
      <div className="flex-1 max-w-md">
        <GlobalSearch />
      </div>
      <div className="flex items-center gap-2">
        <NotificationBell />
        <UserMenu userContext={userContext} />
      </div>
    </header>
  )
}
