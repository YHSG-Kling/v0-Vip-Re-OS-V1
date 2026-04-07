// Complete auth constants for VIP Real Estate OS
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
// ROUTE CONFIGURATIONS (Required by middleware.ts)
// ============================================
export const PUBLIC_ROUTES = [
  '/login',
  '/signup',
  '/auth/callback',
  '/reset-password',
  '/forgot-password',
  '/api/auth',
  '/api/public',
  '/api/open-house',
  '/api/qr',
  '/api/showings/feedback',
  '/api/providers/inbound',
  '/api/billing/webhook',
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
  '/past-clients',
  '/referrals',
  '/referral-partners',
  '/listings',
  '/properties',
  '/contacts',
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
  '/api/heygen',
  '/api/integrations',
  '/api/intelligence',
  '/api/offers',
  '/api/onboarding',
  '/api/track',
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
  ENABLED: process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
  MODE: 'password' as const,
  AUTO_LOGIN: false,
  PASSWORD: process.env.NEXT_PUBLIC_DEMO_PASSWORD || 'Demo@123456',
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
// ROLE DEFINITIONS
// ============================================
export const ROLES = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  BROKER: 'broker',
  MANAGER: 'manager',
  TEAM_LEAD: 'team_lead',
  AGENT: 'agent',
  TC: 'tc',
  BUYER: 'buyer',
  SELLER: 'seller',
  SUPPORT: 'support',
} as const;

// ============================================
// ROLE PERMISSIONS
// ============================================
export const ROLE_PERMISSIONS = {
  superadmin: ['*'], // All permissions
  admin: [
    'manage_users',
    'manage_agents',
    'manage_leads',
    'manage_listings',
    'view_analytics',
    'manage_compliance',
  ],
  broker: [
    'manage_agents',
    'view_all_listings',
    'view_all_leads',
    'approve_listings',
    'view_analytics',
  ],
  manager: [
    'manage_team',
    'view_team_leads',
    'view_team_listings',
    'approve_team_content',
  ],
  team_lead: [
    'manage_agents',
    'view_team_listings',
    'view_team_leads',
  ],
  agent: [
    'manage_own_listings',
    'manage_own_leads',
    'view_own_contacts',
  ],
  tc: [
    'manage_transactions',
    'view_all_transactions',
    'update_transaction_status',
  ],
  buyer: [
    'view_listings',
    'view_saved_properties',
    'contact_agent',
  ],
  seller: [
    'manage_own_listings',
    'view_offers',
    'contact_agent',
  ],
  support: [
    'view_all_tickets',
    'respond_to_support',
    'view_user_accounts',
  ],
};

// ============================================
// SESSION CONFIGURATION
// ============================================
export const SESSION_CONFIG = {
  MAX_AGE: 24 * 60 * 60, // 24 hours
  REFRESH_THRESHOLD: 60 * 60, // 1 hour before expiry
  COOKIE_NAME: 'session',
  SECURE: process.env.NODE_ENV === 'production',
  HTTP_ONLY: true,
  SAME_SITE: 'lax' as const,
};

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
export const AUTH_ERROR_CODES = {
  INVALID_CREDENTIALS: 'invalid_credentials',
  USER_NOT_FOUND: 'user_not_found',
  EMAIL_EXISTS: 'email_exists',
  SESSION_EXPIRED: 'session_expired',
  UNAUTHORIZED: 'unauthorized',
  INVALID_TOKEN: 'invalid_token',
  WEAK_PASSWORD: 'weak_password',
  INVALID_EMAIL: 'invalid_email',
} as const;
