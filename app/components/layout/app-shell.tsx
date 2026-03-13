'use client'

import React from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/lib/auth/client'
import { Sidebar } from './sidebar'
import { Header } from './header'
import { MobileBottomNav } from './mobile-bottom-nav'
import { getNavigationForRole } from '@/app/config/navigation-config'

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { user, userContext } = useAuth()
  const pathname = usePathname()

  if (
    pathname.startsWith('/auth') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/portal')
  ) {
    return <>{children}</>
  }

  if (!user || !userContext) {
    return null
  }

  const primaryRole = userContext.roles[0]
  const navigation = getNavigationForRole(primaryRole)

  return (
    <div className="flex h-screen bg-white">
      <div className="hidden lg:flex w-64 border-r border-gray-200 bg-white">
        <Sidebar navigation={navigation} userContext={userContext} />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <Header navigation={navigation} userContext={userContext} />

        <main className="flex-1 overflow-auto pb-20 lg:pb-0 bg-white">
          <div className="h-full">{children}</div>
        </main>

        <div className="lg:hidden fixed bottom-0 left-0 right-0 border-t border-gray-200 bg-white">
          <MobileBottomNav items={navigation.mobileBottomNav} />
        </div>
      </div>
    </div>
  )
}
