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

/**
 * Resolve a potentially aliased path to its canonical destination.
 * Returns the canonical route, or the original path if no alias exists.
 */
export function resolveRoute(path: string): string {
  return ROUTE_ALIASES[path] ?? path
}
