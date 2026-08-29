/**
 * ROUTE ALIASES — Centralized redirect map
 * All legacy / alias paths map to their canonical destination.
 * Used by: thin redirect pages, middleware, voice assistant, and any
 * programmatic navigation that may receive an old route.
 */
// ── RE-MEASURED AGAINST THE PAGES IT CLAIMS TO MIRROR (2026-08-29) ───────────
//
// The tombstone below rules that this map STAYS, as documentation of what the
// thin redirect pages do. Nothing imports it — which is exactly why it had gone
// stale without anyone noticing: a documented map that disagrees with the code
// is worse than no map, because it reads as checked (CLAUDE.md §2).
//
// Every entry was compared against app/<path>/page.tsx, comment-stripped, with
// stubs distinguished from real pages BY SHAPE (a stub has no data access and no
// JSX — the first cut of this check just took each page's first `redirect(` call
// and reported two live pages as "drifted stubs" because their first redirect is
// the auth bounce to /login). Result: 23 aliases · 20 stubs agreed · 1 stub had
// drifted · 2 were not aliases at all any more. All three are corrected here:
//
//   · '/documents' claimed '/dashboard/transactions'; app/documents/page.tsx has
//     redirected to '/dashboard/documents' since that surface was built, and
//     that route exists. The map was pointing at the wrong destination.
//   · '/offers' and '/dashboard/admin/automations' are REMOVED, not repointed:
//     both are now FULL PAGES at the alias path itself (the Offers-In-Progress
//     board absorbed from the retired /api/dashboard/data offers branch, and the
//     admin automations page with its run ledger). Listing a live page as an
//     alias that should be redirected away is an instruction to break it.
//
// The half still missing is the GUARD: nothing holds this map and those pages in
// agreement, so the next drift is silent again. See the lane K4 report.
export const ROUTE_ALIASES: Record<string, string> = {
  '/calendar':                       '/dashboard/calendar',
  '/documents':                      '/dashboard/documents',
  '/financials':                     '/dashboard/financials/agent',
  '/gifts':                          '/dashboard/referrals',
  '/intelligence':                   '/dashboard/intelligence',
  '/listings':                       '/dashboard/listings',
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
}

// TOMBSTONE (orphan tranche 3): resolveRoute deleted — a one-line lookup with
// zero consumers (scripts/orphan-route-sweep.ts had already verified this: no
// middleware.ts exists and nothing programmatic called it). The live survivors
// are the literal thin redirect pages that implement every alias above as a
// real route (e.g. app/calendar/page.tsx → redirect('/dashboard/calendar')),
// which is how Next.js actually serves these paths. ROUTE_ALIASES itself stays
// as the documented map those pages mirror.
