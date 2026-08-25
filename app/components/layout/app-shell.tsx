'use client'

import React, { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useAuth } from '@/lib/auth/client'
import { Sidebar } from './sidebar'
import { Header } from './header'
import { MobileBottomNav } from './mobile-bottom-nav'
import { getNavigationForRole, resolvePrimaryRole } from '@/app/config/navigation-config'
import { Loader2, X } from 'lucide-react'
import { PageContextAssistant } from '@/app/components/shared/page-context-assistant'
import { CommandPalette } from '@/app/components/command-palette'
import { ShellProvider, useShell } from './shell-context'
import { UnifiedInboxSlideOut } from './unified-inbox-slideout'
import { ImpersonationBanner } from './impersonation-banner'
import { FloatingVoiceFAB } from './floating-voice-fab'
import { VoiceAssistantOverlay } from '@/app/components/features/agent-assistant/voice-assistant-overlay'
import type { BadgeCounts } from '@/app/types/navigation'
import type { NavigationConfig } from '@/app/types/navigation'
import type { UserContext } from '@/app/types/roles'

const badgeFetcher = (url: string) => fetch(url).then((r) => r.json())

// Staff roles that may see the internal AI assistant.
// This MUST stay in sync with STAFF_ROLES in lib/kernel/helpers.ts.
// Contacts, vendor-portal-only, and unknown roles must NOT see it.
const STAFF_AI_ROLES = new Set([
  'agent',
  'broker',
  'broker_admin',
  'admin',
  'superadmin',
  'tc',
  'transaction_coordinator',
  'compliance_officer',
  'team_lead',
  'team_member',
  'lender',
  'vendor',
  'title',
  'isa',
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

  // Fetch live badge counts — only after auth resolves and user has a session.
  // Refreshes on each navigation (revalidateOnFocus) and every 60 seconds.
  const { data: badgeCounts } = useSWR<Partial<BadgeCounts>>(
    user ? '/api/dashboard/badge-counts' : null,
    badgeFetcher,
    { refreshInterval: 60_000, revalidateOnFocus: true }
  )

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

  // If no user session — the useEffect above will redirect to /login.
  // Render a brief spinner while that redirect fires rather than blank screen.
  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // userContext should always be set when user is set (after useAuth fix).
  // Fallback to 'agent' role if it ever arrives null to prevent crash.
  // EVERY role this person holds, not the first one.
  //
  // This used to read `userContext?.roles?.[0]`. The roles array comes from
  // user_role_assignments, which is UNIQUE on (user_id, role) and returns rows
  // in no particular order — so `[0]` was an ARBITRARY pick, and the second seat
  // of a solo tenant (the user carrying transactions, compliance, support, admin
  // and marketing) saw exactly one of those surfaces, chosen by the planner.
  // getNavigationForRole now merges them in a fixed precedence.
  const heldRoles: UserContext['roles'] =
    userContext?.roles?.length ? userContext.roles : (['agent'] as UserContext['roles'])
  const navigation = getNavigationForRole(heldRoles)
  // Where a surface genuinely needs ONE role name, it comes from the shared
  // precedence — never from heldRoles[0], which is unordered.
  const primaryRole = resolvePrimaryRole(heldRoles)

  // Build a safe userContext for components — if null, create a minimal one
  const safeUserContext = userContext ?? {
    id: user.id,
    email: user.email ?? '',
    firstName: '',
    lastName: '',
    roles: heldRoles,
  }

  // Only staff roles may see the Internal AI Assistant
  // ANY staff role qualifies. Testing only the primary role hid the assistant
  // from a multi-role user whose precedence-winning role happened not to be on
  // the staff-AI list, even though another role they hold is.
  const showAIAssistant = heldRoles.some((r) => STAFF_AI_ROLES.has(String(r).toLowerCase()))

  return (
    <ShellProvider>
      <div className="flex h-screen bg-white">
        {/* Desktop sidebar — hidden below lg breakpoint */}
        <div className="hidden lg:flex w-64 border-r border-gray-200 bg-white">
          <Sidebar navigation={navigation} userContext={safeUserContext} badgeCounts={badgeCounts} />
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <Header navigation={navigation} userContext={safeUserContext} />

          {/* Staff "act as tenant" banner — visible only during an active impersonation. */}
          <ImpersonationBanner />

          <main className="flex-1 overflow-auto pb-20 lg:pb-0 bg-white">
            <div className="h-full">{children}</div>
          </main>

          {!hideBottomNav && (
            <div className="lg:hidden fixed bottom-0 left-0 right-0 border-t border-gray-200 bg-white">
              <MobileBottomNav items={navigation.mobileBottomNav} />
            </div>
          )}
        </div>

        {/* Mobile sidebar drawer — slide-in from left, toggled by hamburger */}
        <MobileSidebarDrawer
          navigation={navigation}
          userContext={safeUserContext}
          badgeCounts={badgeCounts}
        />

        {/* Internal AI Assistant — staff roles only.
            PageContextAssistant derives { contactId, listingId, transactionId, offerId }
            from the URL so the copilot is always context-aware. */}
        {showAIAssistant && (
          <PageContextAssistant
            role={primaryRole}
            userId={safeUserContext.id}
          />
        )}

        {/* Cmd+K Command Palette — available to all authenticated users */}
        <CommandPalette />

        {/* Universal Shell — unified inbox slide-out (press U or click header inbox button) */}
        <ShellInboxOutlet />

        {/* ONE floating assistant surface (consolidation 2026-07): the typed
            InternalAIAssistant above IS the ask+voice brain (text chat + browser
            STT), launched from its own FAB. The premium ElevenLabs voice is the
            second, access-gated tier below. The redundant text-chat FAB
            (FloatingChatFAB, which merely re-opened the assistant) was removed.
            The visual D-ID avatar deliberately does NOT mount here — the agent
            doesn't want to see/hear their own clone (uncanny valley); customers
            see it in their portal via PortalChatLauncher. */}

        {/* Premium voice tier — the ElevenLabs Conversational AI mic + overlay,
            access-gated (getVoiceAssistantAccess); shows only when voice is enabled. */}
        {showAIAssistant && <FloatingVoiceFAB />}
        {showAIAssistant && <VoiceAssistantOverlay />}
      </div>
    </ShellProvider>
  )
}

function ShellInboxOutlet() {
  const { inboxOpen, setInboxOpen } = useShell()
  return <UnifiedInboxSlideOut open={inboxOpen} onOpenChange={setInboxOpen} />
}

interface MobileSidebarDrawerProps {
  navigation: NavigationConfig
  userContext: UserContext
  badgeCounts?: Partial<BadgeCounts>
}

function MobileSidebarDrawer({ navigation, userContext, badgeCounts }: MobileSidebarDrawerProps) {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useShell()
  const pathname = usePathname()

  // Close drawer on navigation
  useEffect(() => {
    setMobileSidebarOpen(false)
  }, [pathname, setMobileSidebarOpen])

  if (!mobileSidebarOpen) return null

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 lg:hidden"
      onClick={() => setMobileSidebarOpen(false)}
    >
      {/* Dim overlay */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Drawer panel — stop click propagation so clicks inside don't close */}
      <div
        className="absolute left-0 top-0 h-full w-72 bg-white shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-end p-3 border-b">
          <button
            onClick={() => setMobileSidebarOpen(false)}
            className="p-1.5 rounded hover:bg-gray-100 transition-colors"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5 text-gray-600" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <Sidebar navigation={navigation} userContext={userContext} badgeCounts={badgeCounts} />
        </div>
      </div>
    </div>
  )
}
