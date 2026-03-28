'use client'

import React, { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth/client'
import { Sidebar } from './sidebar'
import { Header } from './header'
import { MobileBottomNav } from './mobile-bottom-nav'
import { getNavigationForRole } from '@/app/config/navigation-config'
import { Loader2 } from 'lucide-react'
import { InternalAIAssistant } from '@/app/components/shared/internal-ai-assistant'

// Staff roles that are allowed to see the internal AI assistant.
// Contacts, vendor-portal-only, and unknown roles must NOT see it.
const STAFF_AI_ROLES = new Set([
  'agent',
  'broker',
  'admin',
  'tc',
  'transaction_coordinator',
  'lender',
  'vendor',
  'title',
  'coordinator',
  'staff',
])

const AUTH_TIMEOUT_MS = 8_000

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { user, userContext, isLoading } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  // Track whether the 8-second auth timeout has fired
  const [authTimedOut, setAuthTimedOut] = useState(false)

  // Routes that have their own layout - bypass AppShell completely
  const bypassRoutes = ['/auth', '/login', '/signup', '/portal', '/settings', '/open-house', '/qr']
  const shouldBypass = bypassRoutes.some(route => pathname.startsWith(route))

  // 8-second timeout: if still loading after 8s, surface an actionable error
  // instead of spinning forever.
  useEffect(() => {
    if (!isLoading) {
      setAuthTimedOut(false)
      return
    }
    const timer = setTimeout(() => setAuthTimedOut(true), AUTH_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [isLoading])

  // Handle redirect in useEffect to avoid setState during render
  const needsAuth = !isLoading && !user && !userContext && !shouldBypass && !pathname.startsWith('/login')

  useEffect(() => {
    if (needsAuth) {
      router.push('/login')
    }
  }, [needsAuth, router])

  if (shouldBypass) {
    return <>{children}</>
  }

  // Hide mobile bottom nav on wizard/create flows to prevent interference
  const hideBottomNav = pathname.includes('/videos/create') || pathname.includes('/wizard')

  // Show loading state while auth is being determined
  if (isLoading) {
    // Auth has taken too long — show actionable fallback instead of infinite spinner
    if (authTimedOut) {
      return (
        <div className="flex flex-col items-center justify-center h-screen gap-4 bg-background">
          <p className="text-sm text-muted-foreground">Taking longer than expected&hellip;</p>
          <button
            onClick={() => router.push('/login')}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Back to Login
          </button>
        </div>
      )
    }

    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Show loading while redirecting to login
  if (!user || !userContext) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const primaryRole = userContext.roles[0]
  const navigation = getNavigationForRole(primaryRole)

  // Only staff roles may see the Internal AI Assistant
  const showAIAssistant = STAFF_AI_ROLES.has(primaryRole?.toLowerCase?.() ?? '')

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

      {/* Internal AI Assistant — staff roles only */}
      {showAIAssistant && <InternalAIAssistant role={primaryRole} />}
    </div>
  )
}
