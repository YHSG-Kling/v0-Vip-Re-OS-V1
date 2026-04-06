'use server'

import { AUTH_MESSAGES } from '@/app/constants/auth'
import { createClient } from '@/lib/supabase/server'

interface AuthFailure {
  success: false
  error: string
  code?: string
}

interface AuthSuccess {
  success: true
}

interface LoginSuccess extends AuthSuccess {
  user: {
    id: string
    email: string | undefined
  }
  session: {
    accessToken: string
    refreshToken: string
    expiresAt?: number
  }
}

interface CallbackSuccess extends AuthSuccess {
  userId: string
  user: {
    id: string
    email: string | undefined
  }
}

interface RegisterSuccess extends AuthSuccess {
  user: {
    id: string
    email: string | undefined
  } | null
  session: {
    accessToken: string
    refreshToken: string
    expiresAt?: number
  } | null
  emailConfirmationRequired: boolean
}

function mapAuthError(error: unknown, fallback: string): AuthFailure {
  const message = error instanceof Error ? error.message : fallback
  const lower = message.toLowerCase()

  if (lower.includes('invalid login credentials')) {
    return { success: false, error: AUTH_MESSAGES.INVALID_CREDENTIALS, code: 'invalid_credentials' }
  }
  if (lower.includes('email not confirmed')) {
    return { success: false, error: 'Please confirm your email before signing in.', code: 'email_not_confirmed' }
  }
  if (lower.includes('user already registered')) {
    return { success: false, error: AUTH_MESSAGES.EMAIL_EXISTS, code: 'email_exists' }
  }
  if (lower.includes('password')) {
    return { success: false, error: message, code: 'invalid_password' }
  }

  return { success: false, error: message || fallback, code: 'auth_error' }
}

function requireEmail(email: string | undefined | null): string {
  return email ?? ''
}

export async function loginUser(email: string, password: string): Promise<LoginSuccess | AuthFailure> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (error) {
      return mapAuthError(error, AUTH_MESSAGES.SIGN_IN_ERROR)
    }

    if (!data.user || !data.session) {
      return {
        success: false,
        error: 'Login failed. No authenticated session was returned.',
        code: 'missing_session',
      }
    }

    return {
      success: true,
      user: {
        id: data.user.id,
        email: requireEmail(data.user.email),
      },
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at,
      },
    }
  } catch (error) {
    return mapAuthError(error, 'An unexpected error occurred during login.')
  }
}

export async function handleAuthCallback(code: string): Promise<CallbackSuccess | AuthFailure> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      return mapAuthError(error, 'Failed to handle auth callback.')
    }

    if (!data.user) {
      return {
        success: false,
        error: 'No authenticated user returned from callback.',
        code: 'missing_user',
      }
    }

    return {
      success: true,
      userId: data.user.id,
      user: {
        id: data.user.id,
        email: requireEmail(data.user.email),
      },
    }
  } catch (error) {
    return mapAuthError(error, 'Failed to handle auth callback.')
  }
}

export async function signOut(): Promise<AuthSuccess | AuthFailure> {
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut()

    if (error) {
      return mapAuthError(error, AUTH_MESSAGES.SIGN_OUT_ERROR)
    }

    return { success: true }
  } catch (error) {
    return mapAuthError(error, AUTH_MESSAGES.SIGN_OUT_ERROR)
  }
}

export async function getCurrentUser() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()

    if (error || !user) return null
    return user
  } catch {
    return null
  }
}

export async function registerUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string
): Promise<RegisterSuccess | AuthFailure> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
        },
      },
    })

    if (error) {
      return mapAuthError(error, AUTH_MESSAGES.SIGN_UP_ERROR)
    }

    return {
      success: true,
      user: data.user
        ? {
            id: data.user.id,
            email: requireEmail(data.user.email),
          }
        : null,
      session: data.session
        ? {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresAt: data.session.expires_at,
          }
        : null,
      emailConfirmationRequired: !data.session,
    }
  } catch (error) {
    return mapAuthError(error, 'An unexpected error occurred during registration.')
  }
}
