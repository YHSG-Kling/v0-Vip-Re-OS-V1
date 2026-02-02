'use strict'

export type AuthStatus = 'idle' | 'loading' | 'success' | 'error' | 'checking'

export interface AuthError {
  message: string
  code?: string
  details?: string
}

export interface SignInRequest {
  email: string
}

export interface SignInResponse {
  success: boolean
  message?: string
  error?: AuthError
}

export interface SessionData {
  user: {
    id: string
    email: string
    created_at: string
  }
  session: {
    access_token: string
    refresh_token: string
    expires_at: number
  }
}

export interface AuthState {
  status: AuthStatus
  user: SessionData['user'] | null
  session: SessionData['session'] | null
  error: AuthError | null
  isAuthenticated: boolean
}

// Magic link message types
export type MagicLinkMessage = 
  | 'check-email'
  | 'link-expired'
  | 'link-used'
  | 'invalid-session'
  | 'session-expired'
  | 'error'

export interface MagicLinkState {
  email?: string
  message: MagicLinkMessage | null
  error?: string
  isLoading: boolean
}

// Session validation
export interface SessionValidation {
  valid: boolean
  userId?: string
  roles?: string[]
  expiresAt?: number
  message?: string
}
