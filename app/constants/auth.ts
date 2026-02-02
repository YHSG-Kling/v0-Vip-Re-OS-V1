export const AUTH_CONFIG = {
  SESSION_DURATION: 24 * 60 * 60 * 1000, // 24 hours
  REFRESH_BUFFER: 5 * 60 * 1000, // Refresh 5 mins before expiry
  MAGIC_LINK_EXPIRY: 24 * 60 * 60, // 24 hours in seconds
  
  COOKIE_CONFIG: {
    name: 'sb-auth-token',
    maxAge: 24 * 60 * 60, // 24 hours
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  },
}

export const AUTH_MESSAGES = {
  SIGN_IN_SENT: 'Magic link sent! Check your email to sign in.',
  CHECK_EMAIL: 'Check your email for the sign-in link.',
  LINK_EXPIRED: 'This sign-in link has expired. Please request a new one.',
  LINK_USED: 'This link has already been used. Please sign in normally.',
  INVALID_SESSION: 'Your session is invalid. Please sign in again.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  ERROR: 'An error occurred. Please try again.',
  INVALID_EMAIL: 'Please enter a valid email address.',
  USER_NOT_FOUND: 'No account found with this email.',
  NO_ROLE: 'Your account does not have an assigned role. Contact support.',
  SERVER_ERROR: 'Server error. Please try again later.',
}

export const AUTH_ROUTES = {
  LOGIN: '/login',
  CALLBACK: '/auth/callback',
  LOGOUT: '/auth/logout',
  DASHBOARD: '/agent/dashboard', // Default after login
  REDIRECT_BY_ROLE: {
    agent: '/agent/dashboard',
    broker: '/broker/dashboard',
    isa: '/isa/dashboard',
    admin: '/admin/dashboard',
    vendor: '/vendor/dashboard',
    contact: '/contact/portal',
    compliance_manager: '/compliance/dashboard',
    transaction_coordinator: '/transaction/dashboard',
    lender: '/lender/dashboard',
    title_agent: '/title/dashboard',
  },
}

export const PROTECTED_ROUTES = [
  '/agent',
  '/broker',
  '/isa',
  '/admin',
  '/vendor',
  '/contact',
  '/compliance',
  '/transaction',
  '/lender',
  '/title',
  '/dashboard',
  '/newsletters',
]

export const PUBLIC_ROUTES = [
  '/login',
  '/auth/callback',
  '/auth/logout',
  '/auth/error',
]// Add at top level, alongside existing constants

export const DEMO_CONFIG = {
  ENABLED: process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'yes',
  // Demo users use hardcoded password 'DEMO_USER' (as in your password_hash field)
  DEMO_PASSWORD: 'DEMO_USER',
}

// Your actual demo users from Supabase
export const DEMO_USERS = [
  // AGENTS
  {
    email: 'agent1@vipos.com',
    name: 'Michael Chen',
    role: 'agent' as const,
    description: 'Real estate agent',
  },
  {
    email: 'agent2@vipos.com',
    name: 'Jessica Martinez',
    role: 'agent' as const,
    description: 'Real estate agent',
  },
  {
    email: 'teamlead@vipos.com',
    name: 'David Williams',
    role: 'agent' as const,
    description: 'Team lead / Senior agent',
  },

  // BROKER
  {
    email: 'broker@vipos.com',
    name: 'Sarah Johnson',
    role: 'broker' as const,
    description: 'Brokerage owner',
  },

  // ADMIN
  {
    email: 'admin@vipos.com',
    name: 'Admin User',
    role: 'admin' as const,
    description: 'System administrator',
  },

  // TRANSACTION COORDINATOR
  {
    email: 'tc@vipos.com',
    name: 'Tom Wilson',
    role: 'transaction_coordinator' as const,
    description: 'Transaction coordinator',
  },

  // COMPLIANCE MANAGER
  {
    email: 'compliance@vipos.com',
    name: 'Lisa Anderson',
    role: 'compliance_manager' as const,
    description: 'Compliance manager',
  },

  // CONTACTS (Different personas)
  {
    email: 'buyer_ftb@vipos.com',
    name: 'Emma Thompson',
    role: 'contact' as const,
    description: 'Buyer - First time homebuyer',
  },
  {
    email: 'buyer_luxury@vipos.com',
    name: 'Robert Park',
    role: 'contact' as const,
    description: 'Buyer - Luxury market',
  },
  {
    email: 'buyer_relocating@vipos.com',
    name: 'Jennifer Chen',
    role: 'contact' as const,
    description: 'Buyer - Relocating professional',
  },
  {
    email: 'seller_motivated@vipos.com',
    name: 'James Rodriguez',
    role: 'contact' as const,
    description: 'Seller - Motivated seller',
  },
  {
    email: 'seller_downsizing@vipos.com',
    name: 'Margaret Douglas',
    role: 'contact' as const,
    description: 'Seller - Downsizing',
  },
  {
    email: 'investor_commercial@vipos.com',
    name: 'David Lee',
    role: 'contact' as const,
    description: 'Investor - Commercial',
  },
  {
    email: 'investor_residential@vipos.com',
    name: 'Patricia Murphy',
    role: 'contact' as const,
    description: 'Investor - Residential',
  },

  // LENDER
  {
    email: 'lender@vipos.com',
    name: 'Kevin Banks',
    role: 'lender' as const,
    description: 'Mortgage lender',
  },

  // TITLE OFFICER
  {
    email: 'title@vipos.com',
    name: 'Susan Legal',
    role: 'title_agent' as const,
    description: 'Title company officer',
  },

  // ADDITIONAL VENDOR ROLES (Not in our 10 main roles - treat as vendors)
  {
    email: 'inspector@vipos.com',
    name: 'Mark Quality',
    role: 'vendor' as const,
    description: 'Home inspector',
  },
  {
    email: 'appraiser@vipos.com',
    name: 'Nancy Value',
    role: 'vendor' as const,
    description: 'Real estate appraiser',
  },
  {
    email: 'escrow@vipos.com',
    name: 'Richard Escrow',
    role: 'vendor' as const,
    description: 'Escrow officer',
  },

  // VENDOR
  {
    email: 'vendor@vipos.com',
    name: 'Victor Services',
    role: 'vendor' as const,
    description: 'Service vendor',
  },
]
