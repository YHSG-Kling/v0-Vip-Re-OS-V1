'use client'

import React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth/client'
import { Sidebar } from './sidebar'
import { Header } from './header'
import { MobileBottomNav } from './mobile-bottom-nav'
import { getNavigationForRole } from '@/app/config/navigation-config'
import { Loader2 } from 'lucide-react'

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { user, userContext, isLoading } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  // Routes that have their own layout - bypass AppShell completely
  const bypassRoutes = ['/auth', '/login', '/signup', '/portal', '/settings', '/open-house', '/qr']
  const shouldBypass = bypassRoutes.some(route => pathname.startsWith(route))
  
  if (shouldBypass) {
    return <>{children}</>
  }

  // Hide mobile bottom nav on wizard/create flows to prevent interference
  const hideBottomNav = pathname.includes('/videos/create') || pathname.includes('/wizard')

  // Show loading state while auth is being determined
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Redirect to login if not authenticated (instead of returning null)
  if (!user || !userContext) {
    // Only redirect if we're on a protected route
    if (typeof window !== 'undefined' && !pathname.startsWith('/login')) {
      router.push('/login')
    }
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
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

        {!hideBottomNav && (
          <div className="lg:hidden fixed bottom-0 left-0 right-0 border-t border-gray-200 bg-white">
            <MobileBottomNav items={navigation.mobileBottomNav} />
          </div>
        )}
      </div>
    </div>
  )
}
