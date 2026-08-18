/**
 * ROUTE ALIASES — Centralized redirect map
 * All legacy / alias paths map to their canonical destination.
 * Used by: thin redirect pages, middleware, voice assistant, and any
 * programmatic navigation that may receive an old route.
 */
export const ROUTE_ALIASES: Record<string, string> = {
  '/calendar':                       '/dashboard/calendar',
  '/documents':                      '/dashboard/transactions',
  '/financials':                     '/dashboard/financials/agent',
  '/gifts':                          '/dashboard/referrals',
  '/intelligence':                   '/dashboard/intelligence',
  '/listings':                       '/dashboard/listings',
  '/offers':                         '/crm',
  '/reviews':                        '/dashboard/referrals',
  '/showings':                       '/dashboard/listings',
  '/sphere':                         '/crm',
  '/tasks':                          '/dashboard',
  '/admin/agent-roster':             '/dashboard/admin/users',
  '/admin/ai-audit':                 '/dashboard/admin/ai-audit',
  '/admin/error-handler':            '/dashboard/admin/error-handler',
  '/admin/lead-scraping':            '/dashboard/admin/sla-monitor',
  '/admin/menu':                     '/dashboard/admin',
  '/admin/recruiting-hub':           '/dashboard/recruiting-roi',
  '/admin/usage':                    '/dashboard/admin/usage',
  '/admin/users':                    '/dashboard/admin/users',
  '/dashboard/cma':                  '/dashboard/listings',
  '/dashboard/open-house':           '/dashboard/listings',
  '/dashboard/teams':                '/dashboard/team',
  '/dashboard/admin/automations':    '/dashboard/system',
}

// TOMBSTONE (orphan tranche 3): resolveRoute deleted — a one-line lookup with
// zero consumers (scripts/orphan-route-sweep.ts had already verified this: no
// middleware.ts exists and nothing programmatic called it). The live survivors
// are the literal thin redirect pages that implement every alias above as a
// real route (e.g. app/calendar/page.tsx → redirect('/dashboard/calendar')),
// which is how Next.js actually serves these paths. ROUTE_ALIASES itself stays
// as the documented map those pages mirror.
