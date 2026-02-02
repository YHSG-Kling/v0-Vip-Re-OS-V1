'use server'

import { createClient } from '@/lib/supabase/server'
import { SignInRequest, SignInResponse, SessionValidation } from '@/app/types/auth'
import { AUTH_MESSAGES } from '@/app/constants/auth'

// Sign in with magic link
export async function signInWithMagicLink(
  request: SignInRequest
): Promise<SignInResponse> {
  try {
    // Validate email
    if (!request.email || !isValidEmail(request.email)) {
      return {
        success: false,
        error: {
          message: AUTH_MESSAGES.INVALID_EMAIL,
          code: 'invalid_email',
        },
      }
    }

    const supabase = await createClient()

    // Send magic link
    const { error } = await supabase.auth.signInWithOtp({
      email: request.email,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
        shouldCreateUser: false, // Don't auto-create users
      },
    })

    if (error) {
      return {
        success: false,
        error: {
          message: error.message || AUTH_MESSAGES.SERVER_ERROR,
          code: error.code,
          details: error.status?.toString(),
        },
      }
    }

    return {
      success: true,
      message: AUTH_MESSAGES.SIGN_IN_SENT,
    }
  } catch (err) {
    console.error('Sign in error:', err)
    return {
      success: false,
      error: {
        message: AUTH_MESSAGES.SERVER_ERROR,
        code: 'unknown_error',
      },
    }
  }
}

// Handle auth callback (after user clicks magic link)
export async function handleAuthCallback(
  code: string
): Promise<SignInResponse> {
  try {
    const supabase = await createClient()

    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      if (error.message?.includes('expired')) {
        return {
          success: false,
          error: {
            message: AUTH_MESSAGES.LINK_EXPIRED,
            code: 'expired_link',
          },
        }
      }
      if (error.message?.includes('used')) {
        return {
          success: false,
          error: {
            message: AUTH_MESSAGES.LINK_USED,
            code: 'used_link',
          },
        }
      }

      return {
        success: false,
        error: {
          message: error.message || AUTH_MESSAGES.SERVER_ERROR,
          code: error.code,
        },
      }
    }

    // Verify user has a role
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return {
        success: false,
        error: {
          message: AUTH_MESSAGES.INVALID_SESSION,
          code: 'no_user',
        },
      }
    }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .limit(1)
      .single()

    if (!roleData) {
      return {
        success: false,
        error: {
          message: AUTH_MESSAGES.NO_ROLE,
          code: 'no_role',
        },
      }
    }

    return {
      success: true,
      message: 'Authentication successful',
    }
  } catch (err) {
    console.error('Auth callback error:', err)
    return {
      success: false,
      error: {
        message: AUTH_MESSAGES.SERVER_ERROR,
        code: 'unknown_error',
      },
    }
  }
}

// Sign out user
export async function signOut(): Promise<{ success: boolean }> {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut()
    return { success: true }
  } catch (err) {
    console.error('Sign out error:', err)
    return { success: false }
  }
}

// Get current session
export async function getCurrentSession(): Promise<SessionValidation> {
  try {
    const supabase = await createClient()
    const { data: { session }, error } = await supabase.auth.getSession()

    if (error || !session) {
      return {
        valid: false,
        message: AUTH_MESSAGES.INVALID_SESSION,
      }
    }

    // Check if session is expired
    const expiresAt = session.expires_at ? session.expires_at * 1000 : 0
    if (Date.now() > expiresAt) {
      return {
        valid: false,
        message: AUTH_MESSAGES.SESSION_EXPIRED,
      }
    }

    // Get user roles
    const { data: rolesData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', session.user.id)

    const roles = rolesData?.map((r) => r.role) || []

    return {
      valid: true,
      userId: session.user.id,
      roles,
      expiresAt,
    }
  } catch (err) {
    console.error('Get session error:', err)
    return {
      valid: false,
      message: AUTH_MESSAGES.SERVER_ERROR,
    }
  }
}

// Helper function
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email) && email.length <= 254
}
