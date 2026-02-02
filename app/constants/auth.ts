'use strict'

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
]
