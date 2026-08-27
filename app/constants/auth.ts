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
// Matching is `pathname.startsWith(route)` and PUBLIC is evaluated BEFORE
// PROTECTED, so a public prefix wins. Two consequences worth remembering:
//   - `/api/auth` makes every handler under it internet-reachable with no
//     session. Anything added there authorises itself or it is open.
//   - an entry for a path that does not exist is worse than no entry: it reads
//     as a deliberate exemption for a page nobody can find.
export const PUBLIC_ROUTES = [
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
  // ── The visitor-tracking pair, moved OUT of PROTECTED_ROUTES ─────
  //
  // `/api/track` holds exactly two routes — `pixel` and `identify` — and BOTH
  // are fired by an anonymous stranger on a BROKERAGE'S OWN WEBSITE, from a
  // snippet the brokerage pastes there. Neither reads a session; both use the
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
  // Publishing the prefix is what the two routes were written for, and it is
  // not a widening of anything real: an authenticated caller was never possible
  // here. Both are hardened for the traffic they now actually receive — see the
  // header of app/api/track/identify/route.ts for the tenant, filter-grammar
  // and enumeration-oracle findings that came with wiring its caller.
  '/api/track',
  // ── Public page routes (no auth required) ────────────────────────
  '/portal/login',
  '/portal/lender',
  '/portal/title',
  '/portal/vendor',
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
  // anonymous visitor pixel and the identify beacon, neither of which a session
  // can ever accompany; gating it here redirected every hit to /login.
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
// SURVIVOR: lib/security/permission-matrix.ts:102 `ROLE_PERMISSIONS` (and
// :34 `ROLE_HIERARCHY` for the scope half).
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
// team_lead 'leads:view' / 'leads:view_all' (lib/security/permission-matrix.ts:250)
// and ROLE_HIERARCHY already records `canViewData: 'team'` for the same role
// (:72). Under the owner's ruling — "if team tier subscriptions, they don't
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
