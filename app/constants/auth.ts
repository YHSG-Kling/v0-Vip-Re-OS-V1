// Complete auth constants for the platform
// This file exports everything your codebase needs

// ============================================
// AUTH MESSAGES (Required by app/actions/auth.ts)
// ============================================
export const AUTH_MESSAGES = {
  SIGN_IN_SUCCESS: 'Successfully signed in',
  SIGN_IN_ERROR: 'Failed to sign in',
  SIGN_UP_SUCCESS: 'Account created successfully',
  SIGN_UP_ERROR: 'Failed to create account',
  SIGN_OUT_SUCCESS: 'Successfully signed out',
  SIGN_OUT_ERROR: 'Failed to sign out',
  MAGIC_LINK_SENT: 'Magic link sent to your email',
  MAGIC_LINK_ERROR: 'Failed to send magic link',
  SESSION_EXPIRED: 'Your session has expired',
  UNAUTHORIZED: 'Unauthorized access',
  INVALID_CREDENTIALS: 'Invalid email or password',
  USER_NOT_FOUND: 'User not found',
  EMAIL_EXISTS: 'Email already in use',
  PASSWORD_TOO_WEAK: 'Password must be at least 8 characters',
  INVALID_EMAIL: 'Invalid email address',
};

// ============================================
// ROUTE CONFIGURATIONS (enforced by the edge middleware in proxy.ts)
// ============================================
//
// PUBLIC is evaluated BEFORE PROTECTED, so a public entry wins. Two
// consequences worth remembering:
//   - `/api/auth` makes every handler under it internet-reachable with no
//     session. Anything added there authorises itself or it is open.
//   - an entry for a path that does not exist is worse than no entry: it reads
//     as a deliberate exemption for a page nobody can find.
//
// MATCHING (lane 88E, production-readiness audit). A PUBLIC entry now matches
// on a PATH-SEGMENT boundary (`/v` serves `/v` and `/v/<slug>`, never
// `/vendor/dashboard`); a PROTECTED entry keeps the loose `startsWith` (an
// over-match there fails CLOSED — a redirect to /login — which is the safe
// direction). Measured before the change: the loose public match made 17 page
// routes public by accident — /listings/** through '/listing', and /vendor/**
// and /video-assistant through '/v' — every one of them also under a PROTECTED
// prefix, so the proxy's redirect convenience silently stopped applying to the
// agent listings board and the whole vendor portal. The one page that NEEDED
// the accident (/vendor-invite/[token], token-gated in its own page) is now
// listed by name. classifyProxyPath below is the ONE decision proxy.ts runs.

/**
 * SESSIONLESS DOORS UNDER A PROTECTED PREFIX (lane 88E). Each of these is
 * called by something that can NEVER carry a Supabase session cookie — a
 * provider's servers, an out-of-process companion, an anonymous visitor, or a
 * server-side self-call — and each authorises ITSELF in its own route file.
 * Before this list, every one sat under '/api/voice', '/api/did', '/api/forms',
 * '/api/intelligence' or '/api/admin' in PROTECTED_ROUTES, so proxy.ts
 * answered the provider with a 307 to /login and the route never ran:
 *   · every inbound call, status callback, turn, recording and warm-transfer
 *     whisper Twilio posts (inbound voice was dead on a real deploy);
 *   · the D-ID Agents custom-LLM callback (the live avatar had no brain);
 *   · the public lead-capture form's submit (app/forms/[slug]/FormRenderer.tsx
 *     posts it anonymously — every form fill was lost);
 *   · the ConversationRelay companion's plan call, the service-to-service
 *     intelligence doors, and the scrape-diagnostics self-call.
 * scripts/proxy-sessionless-doors-guard.ts derives the population (every
 * app/api route under a PROTECTED prefix with no session gate, every contracted
 * webhook path, every cron-registry target) and fails when one of them would
 * be redirected, and when an entry here names a route that does not verify
 * its caller.
 */
export const SESSIONLESS_API_DOORS = [
  // Twilio: X-Twilio-Signature (inbound/status/turn/outbound/recording) or the
  // timing-safe token our own dial authored (whisper, intelligence).
  '/api/voice/twilio',
  // ConversationRelay companion (tools/relay-companion): x-relay-secret = RELAY_SHARED_SECRET.
  '/api/voice/relay',
  // D-ID Agents LLM provider callback: Basic/Bearer DID_CUSTOM_LLM_KEY.
  '/api/did/custom-llm',
  // Anonymous public form POST; the form row (slug, is_active) names the tenant.
  '/api/forms/submit',
  // Service-to-service doors: INTERNAL_API_SECRET (x-internal-secret / Bearer).
  '/api/intelligence/classify',
  '/api/intelligence/coordinate',
  '/api/intelligence/kb/embed',
  '/api/intelligence/memory/update',
  // Server-side self-call from app/actions/admin/run-scrape-test.ts: verifyCronAuth.
  '/api/admin/scrape-test',
];

export const PUBLIC_ROUTES = [
  ...SESSIONLESS_API_DOORS,
  // Token-gated vendor invitation landing (the invitee has no account yet).
  // Public only by ACCIDENT before lane 88E ('/v' loose-prefix match).
  '/vendor-invite',
  // Token-gated shared-document landing (app/documents/shared/[token] — the
  // share links are for people outside the tenant; the token is the gate).
  // Named here BEFORE '/documents' joins PROTECTED_ROUTES (lane 90A), since
  // classifyProxyPath answers public first and the alias prefix would
  // otherwise 307 every share link to /login.
  '/documents/shared',
  '/login',
  '/signup',
  '/auth/callback',
  // The landing page for a Supabase password-reset email. Necessarily public:
  // the recovery session arrives in the URL fragment, which the edge never
  // sees, so a session check here would bounce every valid reset link.
  '/auth/reset-password-confirm',
  '/api/auth',
  '/api/public',
  '/api/open-house',
  '/api/qr',
  '/api/showings/feedback',
  '/api/providers/inbound',
  '/api/billing/webhook',
  // ── The visitor-tracking routes, moved OUT of PROTECTED_ROUTES ─────
  //
  // `/api/track` holds exactly three routes — `pixel`, `identify` and `dwell`
  // (the pagehide time-on-page beacon, added 2026-09-01) — and ALL of them
  // are fired by an anonymous stranger on a BROKERAGE'S OWN WEBSITE, from a
  // snippet the brokerage pastes there. None reads a session; all use the
  // service client, and the pixel route's own first line states the rule:
  // "Pixel fire = anonymous visit record only. NOT consent. NOT lead creation."
  //
  // It sat in PROTECTED_ROUTES under the heading "API routes requiring session
  // auth", so proxy.ts:158 matched the `/api/track` prefix and redirected every
  // anonymous hit to /login. A 307 to a login page is not an error anyone sees:
  // the <img> just never loads and the beacon is discarded, so the failure was
  // completely silent at both ends.
  //
  // THAT IS WHY THE EARLIER FIX DID NOT WORK. A previous wave found the snippet
  // pointing at a RELATIVE `/api/track/pixel` — resolving against the
  // installer's own domain — and made it absolute. Correct, and still dead,
  // because the absolute URL then landed on this gate. `website_visitors` holds
  // 0 rows to this day (live count on hrvaqgvukzxfskkcrwbt, 2026-08-26), which
  // is consistent with a pixel that has never once been allowed to fire.
  //
  // Publishing the prefix is what these routes were written for, and it is
  // not a widening of anything real: an authenticated caller was never possible
  // here. All are hardened for the traffic they now actually receive — see the
  // header of app/api/track/identify/route.ts for the tenant, filter-grammar
  // and enumeration-oracle findings that came with wiring its caller (the
  // dwell route inherits all three).
  '/api/track',
  // ── Public page routes (no auth required) ────────────────────────
  '/portal/login',
  '/portal/lender',
  '/portal/title',
  '/portal/vendor',
  // The seller-facing pre-listing landing page the drip emails out. The
  // recipient is a PROSPECT who has not hired the agent yet and has no portal
  // login, so /portal is protected but this one child is not — same shape as
  // /portal/login above. PUBLIC_ROUTES is matched (startsWith) BEFORE
  // PROTECTED_ROUTES in proxy.ts, so this entry is what lets the link resolve
  // at all. Access is not "open": app/portal/listing-plan/[id]/page.tsx refuses
  // unless a human stamped listing_presentations.delivery_approved_at, and it
  // renders no financials. Removing this line silently 302s every seller who
  // clicks "Open your listing plan" to /login.
  '/portal/listing-plan',
  '/home-value',
  '/open-house',
  '/showings/feedback',
  '/listing',
  '/qr',
  '/forms',
  // ── Wave 39 GEO — public video landing pages + AI-search discovery ──
  '/v',
  '/llms.txt',
  '/robots.txt',
  '/sitemap.xml',
];

export const PROTECTED_ROUTES = [
  // ── Core dashboard + data routes ─────────────────────────────────
  '/dashboard',
  '/portal',
  '/admin',
  // ── Protected page routes (auth required) ────────────────────────
  '/settings',
  '/journey',
  '/leads',
  '/analytics',
  '/compliance',
  '/approvals',
  '/notifications',
  '/crm',
  '/content-studio',
  '/credit-pipeline',
  '/workflows',
  '/social-planner',
  '/video-assistant',
  '/lifetime-customers',
  '/referrals',
  '/referral-partners',
  '/listings',
  '/properties',
  '/crm/contacts',
  '/transactions',
  '/mobile',
  '/seed',
  '/academy',
  '/newsletters',
  '/showings',
  '/lender',
  '/title',
  '/vendor',
  '/transaction',
  // ── Thin alias pages (lane 90A, 89D P1-6) ───────────────────────────
  // Each of these is a one-line `redirect()` page into a protected surface
  // (app/routes-compatibility.ts ROUTE_ALIASES documents the map). They sat
  // OUTSIDE this list, so the edge passed a sessionless request through and
  // the page itself answered 200 + its redirect — a crawler nuisance, not a
  // leak (the page reads nothing). Listed so the edge answers 307 → /login
  // like every other protected prefix. '/documents/shared' stays public above.
  '/calendar',
  '/documents',
  '/financials',
  '/gifts',
  '/intelligence',
  '/onboarding',
  '/past-clients',
  '/reviews',
  '/sphere',
  '/support',
  '/tasks',
  // ── API routes requiring session auth ────────────────────────────
  '/api/contacts',
  '/api/leads',
  '/api/listings',
  '/api/transactions',
  '/api/accounting',
  '/api/admin',
  '/api/ai',
  '/api/approvals',
  '/api/behavior',
  '/api/dashboard',
  '/api/forms',
  '/api/did',
  '/api/integrations',
  '/api/intelligence',
  '/api/offers',
  '/api/onboarding',
  // '/api/track' MOVED to PUBLIC_ROUTES — see the note there. It holds only the
  // anonymous visitor pixel and the identify + dwell beacons (three routes),
  // none of which a session can ever accompany; gating it here redirected
  // every hit to /login.
  '/api/video-scripts',
  '/api/video',
  '/api/videos',
  '/api/voice',
  // ── Public routes stay outside (QR, webhook, token-gated handled internally) ──
  // /api/open-house/attend   — intentionally public
  // /api/qr/scan            — intentionally public
  // /api/qr/submit          — intentionally public
  // /api/showings/feedback  — token-gated inside
  // /api/providers/inbound  — webhook signature inside
];

/** A PUBLIC entry matches its own path and its children — never a sibling
 *  that merely shares the spelling ('/v' ≠ '/vendor'). A trailing-slash or
 *  file-like entry ('/llms.txt') is matched the same way. */
export function publicRouteMatches(pathname: string, route: string): boolean {
  if (pathname === route) return true
  return pathname.startsWith(route.endsWith('/') ? route : `${route}/`)
}

/**
 * THE ONE PROXY ROUTE DECISION (proxy.ts §2 + §4 run exactly this):
 *   'public'    — pass through, no session read;
 *   'protected' — a missing session redirects to /login;
 *   'open'      — neither list names it (the route authorises itself).
 * PUBLIC wins over PROTECTED. Pure — safe for guards.
 */
export function classifyProxyPath(pathname: string): 'public' | 'protected' | 'open' {
  if (PUBLIC_ROUTES.some((route) => publicRouteMatches(pathname, route))) return 'public'
  if (PROTECTED_ROUTES.some((route) => pathname.startsWith(route))) return 'protected'
  return 'open'
}

// ============================================
// DEMO MODE CONFIGURATION
// ============================================
export const DEMO_CONFIG = {
  // HARD production gate (pre-launch security audit): demo sign-in can NEVER
  // be enabled on the production deployment, even if the flag ships by
  // accident — the repo carries the demo credentials in plain text.
  ENABLED: process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.VERCEL_ENV !== 'production',
  MODE: 'password' as const,
  AUTO_LOGIN: false,
  PASSWORD: process.env.NEXT_PUBLIC_DEMO_PASSWORD || 'Demo@123456',
  // The tenant every demo account is provisioned into (#204). This is the live
  // demo brokerage ("VIP Premier Realty") the seed flows and run-vip-re-os
  // skill already key on. demoSignIn verifies this row EXISTS before creating
  // any account and refuses otherwise — an account without users.brokerage_id
  // is invisible to every tenant-scoped surface and RLS policy, which is worse
  // than no account at all.
  BROKERAGE_ID: 'b0000000-0000-0000-0000-000000000001',
};

// ============================================
// DEMO USERS (20 Real Estate Personas)
// ============================================
export const DEMO_USERS = [
  // Agents (5)
  {
    id: '1',
    email: 'agent1@vipos.com',
    password: 'Demo@123456',
    firstName: 'Sarah',
    lastName: 'Johnson',
    role: 'agent',
    agency: 'VIP Real Estate Group',
    specialization: 'Luxury Homes',
    state: 'CA',
  },
  {
    id: '2',
    email: 'agent2@vipos.com',
    password: 'Demo@123456',
    firstName: 'Michael',
    lastName: 'Chen',
    role: 'agent',
    agency: 'VIP Real Estate Group',
    specialization: 'Commercial',
    state: 'TX',
  },
  {
    id: '3',
    email: 'agent3@vipos.com',
    password: 'Demo@123456',
    firstName: 'Jennifer',
    lastName: 'Martinez',
    role: 'agent',
    agency: 'VIP Real Estate Group',
    specialization: 'Residential',
    state: 'FL',
  },
  {
    id: '4',
    email: 'agent4@vipos.com',
    password: 'Demo@123456',
    firstName: 'David',
    lastName: 'Patel',
    role: 'agent',
    agency: 'VIP Real Estate Group',
    specialization: 'Investment',
    state: 'NY',
  },
  {
    id: '5',
    email: 'agent5@vipos.com',
    password: 'Demo@123456',
    firstName: 'Amanda',
    lastName: 'Williams',
    role: 'agent',
    agency: 'VIP Real Estate Group',
    specialization: 'Relocation',
    state: 'CO',
  },

  // Team Leads (2)
  {
    id: '6',
    email: 'lead1@vipos.com',
    password: 'Demo@123456',
    firstName: 'Robert',
    lastName: 'Thompson',
    role: 'team_lead',
    agency: 'VIP Real Estate Group',
    specialization: 'Team Management',
    state: 'CA',
  },
  {
    id: '7',
    email: 'lead2@vipos.com',
    password: 'Demo@123456',
    firstName: 'Lisa',
    lastName: 'Anderson',
    role: 'team_lead',
    agency: 'VIP Real Estate Group',
    specialization: 'Team Management',
    state: 'TX',
  },

  // Brokers (2)
  {
    id: '8',
    email: 'broker1@vipos.com',
    password: 'Demo@123456',
    firstName: 'James',
    lastName: 'Wilson',
    role: 'broker',
    agency: 'VIP Real Estate Group',
    specialization: 'Brokerage',
    state: 'CA',
  },
  {
    id: '9',
    email: 'broker2@vipos.com',
    password: 'Demo@123456',
    firstName: 'Patricia',
    lastName: 'Davis',
    role: 'broker',
    agency: 'VIP Real Estate Group',
    specialization: 'Brokerage',
    state: 'NY',
  },

  // Managers (1)
  {
    id: '10',
    email: 'manager1@vipos.com',
    password: 'Demo@123456',
    firstName: 'Richard',
    lastName: 'Brown',
    role: 'manager',
    agency: 'VIP Real Estate Group',
    specialization: 'Operations',
    state: 'CA',
  },

  // Transaction Coordinators (2)
  {
    id: '11',
    email: 'tc1@vipos.com',
    password: 'Demo@123456',
    firstName: 'Karen',
    lastName: 'Miller',
    role: 'tc',
    agency: 'VIP Real Estate Group',
    specialization: 'Transactions',
    state: 'CA',
  },
  {
    id: '12',
    email: 'tc2@vipos.com',
    password: 'Demo@123456',
    firstName: 'Thomas',
    lastName: 'Moore',
    role: 'tc',
    agency: 'VIP Real Estate Group',
    specialization: 'Transactions',
    state: 'TX',
  },

  // Clients - Buyers (2)
  {
    id: '13',
    email: 'buyer1@vipos.com',
    password: 'Demo@123456',
    firstName: 'John',
    lastName: 'Smith',
    role: 'buyer',
    agency: 'VIP Real Estate Group',
    specialization: 'First-Time Buyer',
    state: 'CA',
  },
  {
    id: '14',
    email: 'buyer2@vipos.com',
    password: 'Demo@123456',
    firstName: 'Emily',
    lastName: 'Taylor',
    role: 'buyer',
    agency: 'VIP Real Estate Group',
    specialization: 'Luxury Buyer',
    state: 'FL',
  },

  // Clients - Sellers (2)
  {
    id: '15',
    email: 'seller1@vipos.com',
    password: 'Demo@123456',
    firstName: 'Margaret',
    lastName: 'Jackson',
    role: 'seller',
    agency: 'VIP Real Estate Group',
    specialization: 'Home Seller',
    state: 'NY',
  },
  {
    id: '16',
    email: 'seller2@vipos.com',
    password: 'Demo@123456',
    firstName: 'Charles',
    lastName: 'White',
    role: 'seller',
    agency: 'VIP Real Estate Group',
    specialization: 'Investment Property',
    state: 'TX',
  },

  // Admins (2)
  {
    id: '17',
    email: 'admin1@vipos.com',
    password: 'Demo@123456',
    firstName: 'Christopher',
    lastName: 'Harris',
    role: 'admin',
    agency: 'VIP Real Estate Group',
    specialization: 'System Admin',
    state: 'CA',
  },
  {
    id: '18',
    email: 'admin2@vipos.com',
    password: 'Demo@123456',
    firstName: 'Jessica',
    lastName: 'Clark',
    role: 'admin',
    agency: 'VIP Real Estate Group',
    specialization: 'System Admin',
    state: 'CA',
  },

  // Support (1)
  {
    id: '19',
    email: 'support@vipos.com',
    password: 'Demo@123456',
    firstName: 'Daniel',
    lastName: 'Lewis',
    role: 'support',
    agency: 'VIP Real Estate Group',
    specialization: 'Support',
    state: 'CA',
  },

  // Super Admin (1)
  {
    id: '20',
    email: 'superadmin@vipos.com',
    password: 'Demo@123456',
    firstName: 'William',
    lastName: 'Walker',
    role: 'superadmin',
    agency: 'VIP Real Estate Group',
    specialization: 'Super Admin',
    state: 'CA',
  },
];

// ============================================
// ROLE DEFINITIONS — DELETED (lead-visibility consolidation)
// ============================================
//
// TOMBSTONE. `ROLES` and `ROLE_PERMISSIONS` lived here and are DELETED.
// SURVIVOR: lib/security/permission-matrix.ts:125 `ROLE_PERMISSIONS` (and
// :19 `ROLE_HIERARCHY` for the scope half).
//
// WHY THIS ONE WAS THE DUPLICATE AND NOT THE SURVIVOR:
//   · CALLERS. Measured with scripts/strip-comments.ts over every file that
//     imports this module: `@/app/constants/auth` is imported exactly twice —
//     app/actions/demo-auth.ts takes { DEMO_USERS, DEMO_CONFIG, AUTH_MESSAGES }
//     and proxy.ts takes { PROTECTED_ROUTES, PUBLIC_ROUTES }. NEITHER name was
//     imported anywhere. The survivor is read by lib/auth/permissions-client.ts:72,
//     lib/security/role-manager.ts:9 and the admin user-edit form at
//     app/dashboard/admin/users/[userId]/user-edit-form.tsx:165.
//   · VOCABULARY. This copy carried a `manager` role and `buyer`/`seller` roles
//     that are not users.user_type values at all (users_user_type_check admits
//     fourteen, none of them these), and its permission strings were a SECOND
//     spelling of the survivor's — 'view_all_leads' here vs 'leads:view_all'
//     there. Two spellings of one permission is the §6 defect: no scorer can
//     match a writer across them, and a reader consulting this copy would have
//     graded a real role against names nothing else uses.
//
// THE RECONCILIATION THE LEAD RULING NEEDED, recorded where it was asked for:
// this copy gave `team_lead` a 'view_team_leads' permission — the right IDEA,
// the wrong vocabulary and no enforcement behind it. The survivor gives
// team_lead 'leads:view' / 'leads:view_all' (lib/security/permission-matrix.ts:318)
// and ROLE_HIERARCHY already records `canViewData: 'team'` for the same role
// (:95). Under the owner's ruling — "if team tier subscriptions, they don't
// have a broker in the subscription so the team lead can see leads" — those two
// now agree with the code that enforces them: the ADMISSION is
// lib/auth/lead-visibility.ts#LEAD_DESK_USER_TYPES and the SCOPE is
// LeadRowScope, whose team branch is exactly `canViewData: 'team'`. The
// catalogue describes; lib/auth/lead-visibility.ts decides. Neither restates
// the other, and nothing enforces this deleted third spelling.


// ============================================
// SESSION CONFIGURATION
// ============================================
// TOMBSTONE (§1.3, 2026-08-27): `SESSION_CONFIG` deleted — it configured a
// hand-rolled 'session' cookie that no code ever set or read. Sessions are
// BUILT ANOTHER WAY: Supabase SSR auth cookies via lib/supabase/server.ts /
// lib/supabase/client.ts, whose lifetimes are provider-managed.

// ============================================
// PASSWORD REQUIREMENTS
// ============================================
export const PASSWORD_REQUIREMENTS = {
  MIN_LENGTH: 8,
  REQUIRE_UPPERCASE: true,
  REQUIRE_LOWERCASE: true,
  REQUIRE_NUMBERS: true,
  REQUIRE_SPECIAL: true,
};

// ============================================
// AUTH ERROR CODES
// ============================================
// TOMBSTONE (§1.3, 2026-08-27): `AUTH_ERROR_CODES` deleted — a parallel error
// vocabulary no reader or writer ever compared against (repo-wide, zero literal
// matches outside this file). Auth errors are BUILT ANOTHER WAY: supabase-js
// AuthError codes/messages surfaced by app/actions/auth.ts (AuthActionResult).
